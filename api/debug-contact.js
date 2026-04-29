module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey     = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  const pipelineId = process.env.GHL_PIPELINE_ID;

  if (!apiKey) return res.status(500).json({ error: 'not_configured' });

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Version': '2021-07-28',
    'Content-Type': 'application/json'
  };

  try {
    // Search all opportunities for Ben Bissett
    let all = [], page = 1, hasMore = true;
    while (hasMore) {
      const r = await fetch(
        `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&page=${page}&limit=100`,
        { headers }
      );
      const data = await r.json();
      const opps = data.opportunities || [];
      all = all.concat(opps);
      const total = (data.meta || {}).total || 0;
      if (all.length >= total || opps.length === 0) hasMore = false;
      else page++;
    }

    const ben = all.find(o => (o.contact?.name || '').toLowerCase().includes('ben bissett'));
    if (!ben) return res.status(200).json({ error: 'Ben Bissett not found', total: all.length });

    return res.status(200).json({
      name: ben.contact?.name,
      status: ben.status,
      pipelineStageId: ben.pipelineStageId,
      customFields: ben.customFields || []
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
