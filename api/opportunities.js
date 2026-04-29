// Helper to pause between batches to avoid rate limiting
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Simple in-memory cache — 5 minute TTL
let cache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

module.exports = async function handler(req, res) {
  // Return cached data if fresh (unless ?refresh=1 is passed)
  const forceRefresh = req.query && req.query.refresh === '1';
  if (!forceRefresh && cache && (Date.now() - cacheTime) < CACHE_TTL) {
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
            contactMap[contactId] = {
              consultant: consultantField
                ? (Array.isArray(consultantField.value) ? consultantField.value[0] : consultantField.value) || null
                : null,
              program: programField
                ? (Array.isArray(programField.value) ? programField.value[0] : programField.value) || null
                : null
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
      return {
        name:                  o.contact?.name || o.name || 'Unknown',

        status:                o.status || '',
        retention_stage:       stageName,
        member_value:          getMemberValue((contactMap[contactId] && contactMap[contactId].program) || field(o, 'program') || ''),
        fee_support_applied:   field(o, 'fee_support_applied') || 'No',
        fee_support_amount:    parseFloat(field(o, 'fee_support_amount') || 0),
        primary_exit_reason:   field(o, 'primary_exit_reason') || null,
        exit_date:             field(o, 'exit_date') || null,
        date_confirm_retained: field(o, 'date_confirm_retained') || null,
        consultant:            (contactMap[contactId] && contactMap[contactId].consultant) || o.assignedTo?.name || 'Unassigned',
        program:               (contactMap[contactId] && contactMap[contactId].program) || field(o, 'program') || null,
        createdAt:             o.createdAt || ''
      };
    });

    const result = { opportunities: parsed, coachingMap };
    cache = result;
    cacheTime = Date.now();
    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

function getMemberValue(program) {
  var p = (program || '').toLowerCase();
  if (p.includes('business academy')) return 2300;
  if (p.includes('elevate')) return 1200;
  return 0;
}

function field(opp, key) {
  const f = (opp.customFields || []).find(f => f.key === key || f.fieldKey === key);
  return f ? (f.fieldValue || f.value || null) : null;
}
