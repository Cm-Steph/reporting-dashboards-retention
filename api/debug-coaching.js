module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');

  const apiKey     = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  const coachingId = process.env.GHL_COACHING_PIPELINE_ID;

  if (!apiKey || !locationId || !coachingId) {
    return res.status(500).json({ 
      error: 'not_configured',
      has_api_key: !!apiKey,
      has_location_id: !!locationId,
      has_coaching_id: !!coachingId
    });
  }

  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Version': '2021-07-28',
    'Content-Type': 'application/json'
  };

  try {
    // Fetch first page of coaching pipeline
    const url = `https://services.leadconnectorhq.com/opportunities/search?location_id=${locationId}&pipeline_id=${coachingId}&page=1&limit=10`;
    const r = await fetch(url, { headers });
    const data = await r.json();
    const opps = data.opportunities || [];
    const total = (data.meta || {}).total || 0;

    if (!opps.length) {
      return res.status(200).json({ error: 'No opportunities found in coaching pipeline', coachingId, data });
    }

    // Fetch contact for first opp to check consultant field
    const firstOpp = opps[0];
    const contactId = firstOpp.contact?.id || firstOpp.contactId;
    let contactFields = [];

    if (contactId) {
      const cRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers });
      if (cRes.ok) {
        const cData = await cRes.json();
        const contact = cData.contact || cData;
        contactFields = contact.customFields || [];
      }
    }

    // Find the consultant field (RPp9VJnvNS0rVABGKkqC)
    const consultantField = contactFields.find(f => f.id === 'RPp9VJnvNS0rVABGKkqC');

    return res.status(200).json({
      coachingPipelineId: coachingId,
      totalOppsInPipeline: total,
      firstOppName: firstOpp.contact?.name,
      firstOppContactId: contactId,
      consultantFieldValue: consultantField ? consultantField.value : 'NOT FOUND',
      allCustomFieldIds: contactFields.map(f => ({ id: f.id, value: f.value }))
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
