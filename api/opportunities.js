module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey     = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  const pipelineId = process.env.GHL_PIPELINE_ID;

  if (!apiKey || !locationId || !pipelineId) {
    return res.status(500).json({ error: 'not_configured' });
  }

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Version': '2021-07-28',
    'Content-Type': 'application/json'
  };

  // If ?debug=contact is passed, return raw contact data for first opportunity
  if (req.query && req.query.debug === 'contact') {
    try {
      const url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&page=1&limit=1`;
      const r = await fetch(url, { headers });
      const data = await r.json();
      const firstOpp = (data.opportunities || [])[0] || {};
      const contactId = firstOpp.contact?.id || firstOpp.contactId;
      if (!contactId) return res.status(200).json({ error: 'no contact id found', firstOpp });
      const cRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers });
      const cData = await cRes.json();
      return res.status(200).json({ contactId, rawContact: cData });
    } catch(err) {
      return res.status(500).json({ error: err.message });
    }
  }

  try {
    // 1. Fetch pipeline stage names
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

    // 2. Fetch all opportunities
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

    // 3. Fetch contact details in batches to get consultantcoach
    const contactIds = [...new Set(all.map(o => o.contact?.id || o.contactId).filter(Boolean))];
    const contactMap = {};

    for (let i = 0; i < contactIds.length; i += 10) {
      const batch = contactIds.slice(i, i + 10);
      await Promise.all(batch.map(async (contactId) => {
        try {
          const cRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers });
          if (cRes.ok) {
            const cData = await cRes.json();
            const contact = cData.contact || cData;
            const customFields = contact.customFields || contact.customField || [];
            // Try every possible variation of the field key
            const consultantField = customFields.find(f => {
              const k = (f.key || f.fieldKey || f.id || '').toLowerCase();
              return k === 'consultantcoach' ||
                     k === 'consultant_coach' ||
                     k === 'consultant' ||
                     k.includes('consultant');
            });
            contactMap[contactId] = consultantField
              ? (consultantField.fieldValue || consultantField.value || null)
              : null;
          }
        } catch(e) {}
      }));
    }

    // 4. Parse and return
    const parsed = all.map(o => {
      const contactId = o.contact?.id || o.contactId;
      const stageName = stageMap[o.pipelineStageId] ||
                        stageMap[o.stageId] ||
                        o.pipelineStage?.name ||
                        field(o, 'retention_stage') ||
                        o.status || '';
      return {
        name:                  o.contact?.name || o.name || 'Unknown',
        program:               field(o, 'program'),
        status:                o.status || '',
        retention_stage:       stageName,
        member_value:          parseFloat(field(o, 'member_value') || o.monetaryValue || 0),
        fee_support_applied:   field(o, 'fee_support_applied') || 'No',
        fee_support_amount:    parseFloat(field(o, 'fee_support_amount') || 0),
        primary_exit_reason:   field(o, 'primary_exit_reason') || null,
        exit_date:             field(o, 'exit_date') || null,
        date_confirm_retained: field(o, 'date_confirm_retained') || null,
        consultant:            contactMap[contactId] || o.assignedTo?.name || 'Unassigned',
        createdAt:             o.createdAt || ''
      };
    });

    return res.status(200).json({ opportunities: parsed });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

function field(opp, key) {
  const f = (opp.customFields || []).find(f => f.key === key || f.fieldKey === key);
  return f ? (f.fieldValue || f.value || null) : null;
}
