module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey = process.env.GHL_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'not_configured' });

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Version': '2021-07-28',
    'Content-Type': 'application/json'
  };

  try {
    // Fetch Brandon's opportunity directly by opportunity ID
    const r = await fetch(
      'https://services.leadconnectorhq.com/opportunities/BeuWkJ1vhPjiml4aeL04',
      { headers }
    );
    const data = await r.json();
    const opp = data.opportunity || data;

    return res.status(200).json({
      name: opp.contact?.name || opp.name,
      customFields: opp.customFields || []
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
