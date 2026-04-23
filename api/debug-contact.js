module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey = process.env.GHL_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'not_configured' });
  }

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Version': '2021-07-28',
    'Content-Type': 'application/json'
  };

  try {
    const contactRes = await fetch(
      'https://services.leadconnectorhq.com/contacts/GgxGiNCnh6YlGHon8T5l',
      { headers }
    );
    const contactData = await contactRes.json();
    const contact = contactData.contact || contactData;

    return res.status(200).json({
      contactName: contact.firstName + ' ' + contact.lastName,
      customFields: contact.customFields || []
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
