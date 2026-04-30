const crypto = require('crypto');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const correctPasscode = process.env.DASHBOARD_PASSCODE;
  if (!correctPasscode) return res.status(500).json({ error: 'Server not configured' });

  const { passcode } = req.body || {};
  if (!passcode) return res.status(400).json({ error: 'Passcode required' });

  // Constant-time comparison to prevent timing attacks
  const a = Buffer.from(passcode);
  const b = Buffer.from(correctPasscode);
  const match = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!match) {
    return res.status(401).json({ error: 'Incorrect passcode' });
  }

  // Generate a signed token: base64(expiry + "." + hmac)
  const secret = process.env.DASHBOARD_SECRET || correctPasscode;
  const expires = Date.now() + (24 * 60 * 60 * 1000); // 24 hours
  const payload = String(expires);
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const token = Buffer.from(`${payload}.${hmac}`).toString('base64');

  return res.status(200).json({ token, expires });
};
