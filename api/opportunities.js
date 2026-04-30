// Helper to pause between batches to avoid rate limiting
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Simple in-memory cache — 5 minute TTL
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CACHE_VERSION = '2'; // bump this to invalidate cache on deploy

module.exports = async function handler(req, res) {
  // Return cached data if fresh (unless ?refresh=1 is passed)
  const forceRefresh = req.query && req.query.refresh === '1';
  if (!forceRefresh && cache && cache._v === CACHE_VERSION && (Date.now() - cacheTime) < CACHE_TTL) {
    res.setHeader('X-Cache', 'HIT');
    return res.status(200).json(cache);
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey      = process.env.GHL_API_KEY;
  const locationId  = process.env.GHL_LOCATION_ID;
  const pipelineId  = process.env.GHL_PIPELINE_ID;
  const coachingId  = process.env.GHL_COACHING_PIPELINE_ID; // Coaches & Members pipeline

  if (!apiKey || !locationId || !pipelineId) {
    return res.status(500).json({ error: 'not_configured' });
  }

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Version': '2021-07-28',
    'Content-Type': 'application/json'
  };

  try {
    // 1. Fetch pipeline stage names for retention pipeline
    let stageMap = {};
    try {
      const plRes = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${locationId}`, { headers });
      if (plRes.ok) {
        const plData = await plRes.json();
        const pipelines = plData.pipelines || [];
        const ourPipeline = pipelines.find(p => p.id === pipelineId);
        if (ourPipeline && ourPipeline.stages) {
          ourPipeline.stages.forEach(s => { stageMap[s.id] = s.name; });
        }
      }
    } catch(e) {}

    // 2. Fetch all retention opportunities
    let all = [], page = 1, hasMore = true;
    while (hasMore) {
      const url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&page=${page}&limit=100`;
      const r = await fetch(url, { headers });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        return res.status(r.status).json({ error: e.message || `GHL error ${r.status}` });
      }
      const data = await r.json();
      const opps = data.opportunities || [];
      all = all.concat(opps);
      const total = (data.meta || {}).total || 0;
      if (all.length >= total || opps.length === 0) hasMore = false;
      else page++;
    }

    // 3. Fetch contact details to get consultantcoach field
    const contactIds = [...new Set(all.map(o => o.contact?.id || o.contactId).filter(Boolean))];
    const contactMap = {};
    for (let i = 0; i < contactIds.length; i += 5) {
      const batch = contactIds.slice(i, i + 5);
      await Promise.all(batch.map(async (contactId) => {
        try {
          const cRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers });
          if (cRes.ok) {
            const cData = await cRes.json();
            const contact = cData.contact || cData;
            const customFields = contact.customFields || contact.customField || [];
            // Consultant/Coach field ID: RPp9VJnvNS0rVABGKkqC
            const consultantField = customFields.find(f => f.id === 'RPp9VJnvNS0rVABGKkqC');
            // Program field ID: FtAQKtjJ9IkPUjhz1AyR
            const programField = customFields.find(f => f.id === 'FtAQKtjJ9IkPUjhz1AyR');
            // Helper to extract value from contact custom field
            const cfVal = (f) => {
              if (!f) return null;
              const v = f.fieldValue || f.value;
              return Array.isArray(v) ? (v[0] || null) : (v || null);
            };

            // Find all relevant fields from contact
            const exitDateCF     = customFields.find(f => f.id === 'gEIzAUmEul1aOS1sTvBf');
            const exitReasonCF   = customFields.find(f => f.id === '9ZR6rfSnZhPydvQCL00c');
            const dateRetainedCF = customFields.find(f => f.id === '72LmzM8l0hTIqRRSeXob');
            const feeAppliedCF   = customFields.find(f => f.id === '8kGSmIraKjNPCLBiliRx');

            // Convert date timestamps from contact fields
            const getDateVal = (f) => {
              if (!f) return null;
              const ts = f.fieldValueDate || f.fieldValue || f.value;
              if (ts && !isNaN(ts)) return new Date(Number(ts)).toISOString().split('T')[0];
              return ts || null;
            };

            contactMap[contactId] = {
              consultant:            cfVal(consultantField),
              program:               cfVal(programField),
              exit_date:             getDateVal(exitDateCF),
              primary_exit_reason:   cfVal(exitReasonCF),
              date_confirm_retained: getDateVal(dateRetainedCF),
              fee_support_applied:   cfVal(feeAppliedCF)
            };
          }
        } catch(e) {}
      }));
      // Small delay between batches to avoid rate limiting
      if (i + 5 < contactIds.length) await sleep(200);
    }

    // 4. Fetch Coaches & Members pipeline data (if configured)
    // Pipeline stages are named after the consultant, so stage name = consultant name
    let coachingMap = {};
    if (coachingId) {
      try {
        // Fetch coaching pipeline stage names
        let coachStageMap = {};
        try {
          const plRes = await fetch(`https://services.leadconnectorhq.com/opportunities/pipelines?locationId=${locationId}`, { headers });
          if (plRes.ok) {
            const plData = await plRes.json();
            const pipelines = plData.pipelines || [];
            const coachPipeline = pipelines.find(p => p.id === coachingId);
            if (coachPipeline && coachPipeline.stages) {
              coachPipeline.stages.forEach(s => { coachStageMap[s.id] = s.name; });
            }
          }
        } catch(e) {}

        // Fetch all coaching opportunities
        let coachOpps = [], cp = 1, cHasMore = true;
        while (cHasMore) {
          const url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${coachingId}&page=${cp}&limit=100`;
          const r = await fetch(url, { headers });
          if (!r.ok) { cHasMore = false; break; }
          const data = await r.json();
          const opps = data.opportunities || [];
          coachOpps = coachOpps.concat(opps);
          const total = (data.meta || {}).total || 0;
          if (coachOpps.length >= total || opps.length === 0) cHasMore = false;
          else cp++;
        }

        // Group by stage name (which = consultant name)
        for (const o of coachOpps) {
          const consultantName = coachStageMap[o.pipelineStageId] || coachStageMap[o.stageId] || 'Unassigned';
          if (!coachingMap[consultantName]) coachingMap[consultantName] = { total: 0, exited: 0 };
          coachingMap[consultantName].total++;
          const stageName = (coachStageMap[o.pipelineStageId] || '').toLowerCase();
          if (stageName.includes('exit') || stageName.includes('cancel') || stageName.includes('lost') || stageName.includes('churned')) {
            coachingMap[consultantName].exited++;
          }
        }
      } catch(e) {}
    }

    // 5. Parse retention opportunities
    const parsed = all.map(o => {
      const contactId = o.contact?.id || o.contactId;
      const stageName = stageMap[o.pipelineStageId] ||
                        stageMap[o.stageId] ||
                        o.pipelineStage?.name ||
                        field(o, 'retention_stage') ||
                        o.status || '';
      // Two-stage lookup: opportunity fields first, contact fields as fallback
      const cm = contactMap[contactId] || {};
      const program      = field(o, 'program')               || cm.program               || null;
      const exitDate     = field(o, 'exit_date')             || cm.exit_date             || null;
      const exitReason   = field(o, 'primary_exit_reason')   || cm.primary_exit_reason   || null;
      const dateRetained = field(o, 'date_confirm_retained') || cm.date_confirm_retained || null;
      const feeApplied   = field(o, 'fee_support_applied')   || cm.fee_support_applied   || 'No';
      const feeAmount    = parseFloat(field(o, 'fee_support_amount') || cm.fee_support_amount || 0);

      return {
        name:                  o.contact?.name || o.name || 'Unknown',
        program:               program,
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

    const result = { opportunities: parsed, coachingMap };
    result._v = CACHE_VERSION;
    cache = result;
    cacheTime = Date.now();
    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

function getMemberValue(program, customFieldValue, monetaryValue) {
  // If a custom field value is explicitly set, use that first
  var custom = parseFloat(customFieldValue || monetaryValue || 0);
  if (!isNaN(custom) && custom > 0) return custom;
  // Otherwise fall back to program-based pricing
  var p = (program || '').toLowerCase();
  if (p.includes('business academy')) return 2300;
  if (p.includes('elevate')) return 1200;
  return 0;
}

// Opportunity custom field IDs (hardcoded from GHL API inspection)
const OPP_FIELDS = {
  program:               'CkXgGyUIxQUUKeU1vx6J',   // confirmed from Anna Cooper-Hall
  primary_exit_reason:   'qmfXwZmMNKlmo1fEFVAy',   // confirmed from Brandon Hardwicke
  exit_date:             'gEIzAUmEul1aOS1sTvBf',   // confirmed from Anna Cooper-Hall (Jun 27 2026)
  date_confirm_retained: '72LmzM8l0hTIqRRSeXob',   // created/confirmed date
  retention_stage:       'hCPQHkOAcpTlykOtqAUx',   // confirmed from Brandon Hardwicke
  // fee_support_applied, fee_support_amount, member_value - add IDs when confirmed
};

function field(opp, key) {
  const fields = opp.customFields || opp.customField || [];
  // First try by hardcoded ID
  const fieldId = OPP_FIELDS[key];
  let f = fieldId ? fields.find(f => f.id === fieldId) : null;
  // Fall back to key/fieldKey matching
  if (!f) f = fields.find(f => f.key === key || f.fieldKey === key || f.id === key);
  if (!f) return null;
  // Handle date timestamps (GHL returns ms timestamps for date fields)
  if (f.type === 'date' || f.fieldValueDate) {
    const ts = f.fieldValueDate || f.value;
    if (ts && !isNaN(ts)) {
      return new Date(Number(ts)).toISOString().split('T')[0];
    }
  }
  // Handle array fields (dropdowns)
  if (f.fieldValueArray && f.fieldValueArray.length > 0) return f.fieldValueArray[0];
  // Handle string fields
  const val = f.fieldValueString || f.fieldValue || f.value;
  if (Array.isArray(val)) return val[0] || null;
  return val || null;
}
