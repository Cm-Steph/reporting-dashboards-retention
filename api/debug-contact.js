module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

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
    // Search for Joe Keain specifically
    const searchRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${locationId}&query=Joe+Keain&limit=5`,
      { headers }
    );
    const searchData = await searchRes.json();
    const contacts = searchData.contacts || [];
    const joe = contacts[0];

    if (!joe) {
      return res.status(200).json({ error: 'Joe Keain not found', searchData });
    }

    // Fetch full contact
    const contactRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/${joe.id}`,
      { headers }
    );
    const contactData = await contactRes.json();
    const contact = contactData.contact || contactData;

    return res.status(200).json({
      contactId: joe.id,
      contactName: contact.firstName + ' ' + contact.lastName,
      customFields: contact.customFields || []
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
