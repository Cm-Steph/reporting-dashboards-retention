// Helper to pause between batches to avoid rate limiting
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// In-memory cache with 15 minute TTL
let cache = null;
let cacheTime = 0;
let backgroundRefreshing = false;
const CACHE_TTL = 15 * 60 * 1000; // 15 minutes
const CACHE_VERSION = '4';

const crypto = require('crypto');

function verifyToken(token) {
  try {
    const secret = process.env.DASHBOARD_SECRET || process.env.DASHBOARD_PASSCODE;
    if (!secret || !token) return false;
    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [payload, hmac] = decoded.split('.');
    if (!payload || !hmac) return false;
    const expectedHmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac))) return false;
    return Date.now() <= parseInt(payload);
  } catch(e) { return false; }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Verify auth token
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.replace('Bearer ', '');
  if (!verifyToken(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const apiKey     = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  const pipelineId = process.env.GHL_PIPELINE_ID;
  const coachingId = process.env.GHL_COACHING_PIPELINE_ID;

  if (!apiKey || !locationId || !pipelineId) {
    return res.status(500).json({ error: 'not_configured' });
  }

  const forceRefresh = req.query && req.query.refresh === '1';
  const cacheValid = cache && cache._v === CACHE_VERSION && (Date.now() - cacheTime) < CACHE_TTL;

  // Serve cached data immediately, trigger background refresh if stale
  if (!forceRefresh && cacheValid) {
    res.setHeader('X-Cache', 'HIT');
    // If cache is older than 10 mins, kick off background refresh
    if (!backgroundRefreshing && (Date.now() - cacheTime) > 10 * 60 * 1000) {
      backgroundRefreshing = true;
      fetchAllData(apiKey, locationId, pipelineId, coachingId)
        .then(result => { cache = result; cache._v = CACHE_VERSION; cacheTime = Date.now(); })
        .catch(() => {})
        .finally(() => { backgroundRefreshing = false; });
    }
    return res.status(200).json(cache);
  }

  // No valid cache — fetch fresh data
  try {
    const result = await fetchAllData(apiKey, locationId, pipelineId, coachingId);
    result._v = CACHE_VERSION;
    cache = result;
    cacheTime = Date.now();
    res.setHeader('X-Cache', 'MISS');
    return res.status(200).json(result);
  } catch (err) {
    // If we have stale cache, return it rather than failing
    if (cache) {
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json(cache);
    }
    return res.status(500).json({ error: err.message });
  }
};

async function fetchAllData(apiKey, locationId, pipelineId, coachingId) {
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Version': '2021-07-28',
    'Content-Type': 'application/json'
  };

  // 1. Fetch pipeline stage names + retention opps + coaching opps IN PARALLEL
  const [stageMap, all, coachStageMap, coachOpps] = await Promise.all([
    fetchStageMap(pipelineId, locationId, headers),
    fetchAllOpps(pipelineId, locationId, headers),
    coachingId ? fetchStageMap(coachingId, locationId, headers) : Promise.resolve({}),
    coachingId ? fetchAllOpps(coachingId, locationId, headers) : Promise.resolve([])
  ]);

  // 2. Fetch contact details for consultant/program fields
  // Only fetch unique contact IDs across both pipelines
  const allContactIds = [...new Set([
    ...all.map(o => o.contact?.id || o.contactId),
    ...coachOpps.map(o => o.contact?.id || o.contactId)
  ].filter(Boolean))];

  const contactMap = await fetchContacts(allContactIds, headers);

  // 3. Build coaching map from stage names
  const coachingMap = {};
  for (const o of coachOpps) {
    const consultantName = coachStageMap[o.pipelineStageId] || coachStageMap[o.stageId] || 'Unassigned';
    if (!coachingMap[consultantName]) coachingMap[consultantName] = { total: 0, exited: 0 };
    coachingMap[consultantName].total++;
    const sn = (coachStageMap[o.pipelineStageId] || '').toLowerCase();
    if (sn.includes('exit') || sn.includes('cancel') || sn.includes('lost') || sn.includes('churn')) {
      coachingMap[consultantName].exited++;
    }
  }

  // 4. Parse retention opportunities
  const parsed = all.map(o => {
    const contactId = o.contact?.id || o.contactId;
    const stageName = stageMap[o.pipelineStageId] || stageMap[o.stageId] ||
                      o.pipelineStage?.name || field(o, 'retention_stage') || o.status || '';
    const cm = contactMap[contactId] || {};
    const program      = field(o, 'program')               || cm.program               || null;
    const exitDate     = field(o, 'exit_date')             || cm.exit_date             || null;
    const exitReason   = field(o, 'primary_exit_reason')   || cm.primary_exit_reason   || null;
    const dateRetained = field(o, 'date_confirm_retained') || cm.date_confirm_retained || null;
    const feeApplied   = field(o, 'fee_support_applied')   || cm.fee_support_applied   || 'No';
    const feeAmount    = parseFloat(field(o, 'fee_support_amount') || cm.fee_support_amount || 0);

    return {
      name:                  o.contact?.name || o.name || 'Unknown',
      program,
      status:                o.status || '',
      retention_stage:       stageName,
      member_value:          getMemberValue(program || '', field(o, 'member_value') || cm.member_value, o.monetaryValue),
      fee_support_applied:   feeApplied,
      fee_support_amount:    feeAmount,
      primary_exit_reason:   exitReason,
      exit_date:             exitDate,
      date_confirm_retained: dateRetained,
      consultant:            cm.consultant || o.assignedTo?.name || 'Unassigned',
      createdAt:             o.createdAt || ''
    };
  });

  return { opportunities: parsed, coachingMap };
}

// Fetch all pages of opportunities for a pipeline
async function fetchAllOpps(pipelineId, locationId, headers) {
  let all = [], page = 1, hasMore = true;
  while (hasMore) {
    const url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&page=${page}&limit=100`;
    const r = await fetch(url, { headers });
    if (!r.ok) { hasMore = false; break; }
    const data = await r.json();
    const opps = data.opportunities || [];
    all = all.concat(opps);
    const total = (data.meta || {}).total || 0;
    if (all.length >= total || opps.length === 0) hasMore = false;
    else page++;
  }
  return all;
}

// Fetch stage name map for a pipeline
async function fetchStageMap(pipelineId, locationId, headers) {
  try {
    const r = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${locationId}`, { headers });
    if (!r.ok) return {};
    const data = await r.json();
    const pipeline = (data.pipelines || []).find(p => p.id === pipelineId);
    if (!pipeline || !pipeline.stages) return {};
    const map = {};
    pipeline.stages.forEach(s => { map[s.id] = s.name; });
    return map;
  } catch(e) { return {}; }
}

// Fetch contacts in batches of 10 with 100ms delay
async function fetchContacts(contactIds, headers) {
  const contactMap = {};
  for (let i = 0; i < contactIds.length; i += 10) {
    const batch = contactIds.slice(i, i + 10);
    await Promise.all(batch.map(async (contactId) => {
      try {
        const r = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers });
        if (!r.ok) return;
        const data = await r.json();
        const contact = data.contact || data;
        const cf = contact.customFields || [];

        const cfVal = (id) => {
          const f = cf.find(f => f.id === id);
          if (!f) return null;
          if (f.fieldValueArray && f.fieldValueArray.length > 0) return f.fieldValueArray[0];
          const v = f.fieldValueString || f.fieldValue || f.value;
          return Array.isArray(v) ? (v[0] || null) : (v || null);
        };

        const getDateVal = (id) => {
          const f = cf.find(f => f.id === id);
          if (!f) return null;
          const ts = f.fieldValueDate || f.fieldValue || f.value;
          if (ts && !isNaN(ts)) return new Date(Number(ts)).toISOString().split('T')[0];
          return ts || null;
        };

        contactMap[contactId] = {
          consultant:            cfVal('RPp9VJnvNS0rVABGKkqC'),
          program:               cfVal('FtAQKtjJ9IkPUjhz1AyR'),
          exit_date:             getDateVal('gEIzAUmEul1aOS1sTvBf'),
          primary_exit_reason:   cfVal('9ZR6rfSnZhPydvQCL00c'),
          date_confirm_retained: getDateVal('72LmzM8l0hTIqRRSeXob'),
          fee_support_applied:   cfVal('8kGSmIraKjNPCLBiliRx')
        };
      } catch(e) {}
    }));
    if (i + 10 < contactIds.length) await sleep(100); // reduced from 200ms to 100ms
  }
  return contactMap;
}

// Opportunity custom field IDs
const OPP_FIELDS = {
  program:               'CkXgGyUIxQUUKeU1vx6J',
  primary_exit_reason:   'qmfXwZmMNKlmo1fEFVAy',
  exit_date:             'gEIzAUmEul1aOS1sTvBf',
  date_confirm_retained: '72LmzM8l0hTIqRRSeXob',
  retention_stage:       'hCPQHkOAcpTlykOtqAUx'
};

function field(opp, key) {
  const fields = opp.customFields || [];
  const fieldId = OPP_FIELDS[key];
  let f = fieldId ? fields.find(f => f.id === fieldId) : null;
  if (!f) f = fields.find(f => f.key === key || f.fieldKey === key || f.id === key);
  if (!f) return null;
  if (f.type === 'date' || f.fieldValueDate) {
    const ts = f.fieldValueDate || f.value;
    if (ts && !isNaN(ts)) return new Date(Number(ts)).toISOString().split('T')[0];
  }
  if (f.fieldValueArray && f.fieldValueArray.length > 0) return f.fieldValueArray[0];
  const val = f.fieldValueString || f.fieldValue || f.value;
  if (Array.isArray(val)) return val[0] || null;
  return val || null;
}

function getMemberValue(program, customFieldValue, monetaryValue) {
  const custom = parseFloat(customFieldValue || monetaryValue || 0);
  if (!isNaN(custom) && custom > 0) return custom;
  const p = (program || '').toLowerCase();
  if (p.includes('business academy')) return 2300;
  if (p.includes('elevate')) return 1200;
  return 0;
}
