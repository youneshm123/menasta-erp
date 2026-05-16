const https = require('https');

function formatPhone(phone) {
  if (!phone) return null;
  let p = phone.replace(/\D/g, '');
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0')) p = '212' + p.slice(1);
  if (!p.startsWith('212')) p = '212' + p;
  return p + '@c.us';
}

async function sendWhatsApp(phone, message) {
  const instanceId = process.env.GREENAPI_INSTANCE;
  const token      = process.env.GREENAPI_TOKEN;
  if (!instanceId || !token) throw new Error('WhatsApp non configuré');

  const chatId = formatPhone(phone);
  if (!chatId) throw new Error('Numéro de téléphone invalide');

  const body = JSON.stringify({ chatId, message });
  const url  = `https://api.green-api.com/waInstance${instanceId}/sendMessage/${token}`;

  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = { sendWhatsApp, formatPhone };
