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
    const r = await fetch(
      'https://services.leadconnectorhq.com/contacts/9iN90WxhM6BsFhijkGBg',
      { headers }
    );
    const data = await r.json();
    const contact = data.contact || data;

    return res.status(200).json({
      name: contact.firstName + ' ' + contact.lastName,
      customFields: contact.customFields || []
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
