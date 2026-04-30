const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const { token } = req.body || {};
  if (!token) return res.status(401).json({ valid: false });

  try {
    const secret = process.env.DASHBOARD_SECRET || process.env.DASHBOARD_PASSCODE;
    if (!secret) return res.status(500).json({ valid: false });

    const decoded = Buffer.from(token, 'base64').toString('utf8');
    const [payload, hmac] = decoded.split('.');
    if (!payload || !hmac) return res.status(401).json({ valid: false });

    // Verify HMAC
    const expectedHmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    const valid = crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac));
    if (!valid) return res.status(401).json({ valid: false });

    // Check expiry
    const expires = parseInt(payload);
    if (Date.now() > expires) return res.status(401).json({ valid: false, reason: 'expired' });

    return res.status(200).json({ valid: true });
  } catch(e) {
    return res.status(401).json({ valid: false });
  }
};
