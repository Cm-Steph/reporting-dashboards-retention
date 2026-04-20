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

    // 2. Fetch first page of opportunities only (for debug)
    const url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&page=1&limit=5`;
    const r = await fetch(url, { headers });
    const data = await r.json();
    const firstOpp = (data.opportunities || [])[0] || {};
    const contactId = firstOpp.contact?.id || firstOpp.contactId;

    // 3. Fetch the first contact in full to see all fields
    let contactDebug = {};
    if (contactId) {
      const cRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers });
      if (cRes.ok) {
        const cData = await cRes.json();
        contactDebug = cData.contact || cData;
      }
    }

    return res.status(200).json({
      debug: true,
      firstOppContactId: contactId,
      firstOppName: firstOpp.contact?.name,
      contactFields: {
        customFields: contactDebug.customFields || contactDebug.customField || [],
        allKeys: Object.keys(contactDebug)
      }
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
