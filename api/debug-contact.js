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
    // Find Ben's opportunity directly by contact ID
    const r = await fetch(
      `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&contact_id=9iN90WxhM6BsFhijkGBg&limit=5`,
      { headers }
    );
    const data = await r.json();
    const opp = (data.opportunities || [])[0];

    if (!opp) return res.status(200).json({ error: 'No opportunity found for this contact', data });

    return res.status(200).json({
      name: opp.contact?.name,
      status: opp.status,
      pipelineStageId: opp.pipelineStageId,
      customFields: opp.customFields || []
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
