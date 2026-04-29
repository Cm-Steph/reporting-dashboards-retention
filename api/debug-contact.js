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
    // Get first few opportunities and show their raw customFields
    const r = await fetch(
      `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&page=1&limit=5`,
      { headers }
    );
    const data = await r.json();
    const opps = data.opportunities || [];

    // Show custom fields for first opp that has some
    const withFields = opps.find(o => (o.customFields || []).length > 0) || opps[0] || {};

    return res.status(200).json({
      oppName: withFields.contact?.name,
      oppStatus: withFields.status,
      oppPipelineStageId: withFields.pipelineStageId,
      customFields: withFields.customFields || [],
      allOppKeys: Object.keys(withFields)
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
