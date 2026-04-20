module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey     = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  const pipelineId = process.env.GHL_PIPELINE_ID;

  if (!apiKey || !locationId || !pipelineId) {
    return res.status(500).json({
      error: 'not_configured',
      missing: {
        GHL_API_KEY:     !apiKey,
        GHL_LOCATION_ID: !locationId,
        GHL_PIPELINE_ID: !pipelineId
      }
    });
  }

  try {
    let all = [], page = 1, hasMore = true;

    while (hasMore) {
      const url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&page=${page}&limit=100`;
      const r = await fetch(url, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Version': '2021-07-28',
          'Content-Type': 'application/json'
        }
      });

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

    const parsed = all.map(o => ({
      name:                  o.contact?.name || o.name || 'Unknown',
      program:               field(o, 'program'),
      status:                o.status || '',
      retention_stage:       field(o, 'retention_stage') || o.status || '',
      customer_status:       field(o, 'customer_status') || '',
      member_value:          parseFloat(field(o, 'member_value') || o.monetaryValue || 0),
      fee_support_applied:   field(o, 'fee_support_applied') || 'No',
      fee_support_amount:    parseFloat(field(o, 'fee_support_amount') || 0),
      primary_exit_reason:   field(o, 'primary_exit_reason') || null,
      exit_date:             field(o, 'exit_date') || null,
      date_confirm_retained: field(o, 'date_confirm_retained') || null,
      consultant:            o.assignedTo?.name || field(o, 'consultant') || 'Unassigned',
      createdAt:             o.createdAt || ''
    }));

    return res.status(200).json({ opportunities: parsed });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

function field(opp, key) {
  const f = (opp.customFields || []).find(f => f.key === key || f.fieldKey === key);
  return f ? (f.fieldValue || f.value || null) : null;
}
