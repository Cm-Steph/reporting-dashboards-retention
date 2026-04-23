module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey    = process.env.GHL_API_KEY;
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
    // Get first opportunity to find a contact ID
    const oppRes = await fetch(
      `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}&page=1&limit=1`,
      { headers }
    );
    const oppData = await oppRes.json();
    const firstOpp = (oppData.opportunities || [])[0] || {};
    const contactId = firstOpp.contact?.id || firstOpp.contactId;

    if (!contactId) {
      return res.status(200).json({ error: 'No contact ID found on first opportunity', firstOpp });
    }

    // Fetch the full contact
    const contactRes = await fetch(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      { headers }
    );
    const contactData = await contactRes.json();
    const contact = contactData.contact || contactData;

    // Return everything so we can see the exact structure
    return res.status(200).json({
      contactId,
      contactName: contact.name,
      customFields: contact.customFields || contact.customField || [],
      allContactKeys: Object.keys(contact),
      rawContact: contact
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
