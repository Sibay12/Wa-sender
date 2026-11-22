const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3000;
const DEFAULT_CC = process.env.DEFAULT_COUNTRY_CODE || '91';
const MIN_DELAY = Number(process.env.MIN_DELAY_SEC || 20);
const MAX_DELAY = Number(process.env.MAX_DELAY_SEC || 45);

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
app.use(express.json());

// ---------- Password (Basic Auth) ----------
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;
if (process.env.RENDER && (!AUTH_USER || !AUTH_PASS)) {
  console.error('AUTH_USER aur AUTH_PASS set karna zaroori hai');
  process.exit(1);
}
if (AUTH_USER && AUTH_PASS) {
  app.use((req, res, next) => {
    const h = req.headers.authorization || '';
    const [u, ...rest] = Buffer.from(h.replace('Basic ', ''), 'base64').toString().split(':');
    if (u === AUTH_USER && rest.join(':') === AUTH_PASS) return next();
    res.set('WWW-Authenticate', 'Basic realm="WA Sender"').status(401).send('Login chahiye');
  });
}
app.use(express.static('public'));

// ---------- WhatsApp connection ----------
const wa = { status: 'starting', qr: null };
const client = new Client({
  authStrategy: new LocalAuth({ dataPath: process.env.SESSION_PATH || './session' }),
  puppeteer: { headless: true, executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] }
});
client.on('qr', async (qr) => { wa.status = 'qr'; wa.qr = await QRCode.toDataURL(qr); });
client.on('ready', () => { wa.status = 'ready'; wa.qr = null; });
client.on('auth_failure', () => { wa.status = 'auth_failure'; });
client.on('disconnected', () => { wa.status = 'disconnected'; client.initialize(); });
client.initialize();

// ---------- Job queue ----------
let job = { running: false, stop: false, rows: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (k) => String(k).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

function cleanPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (d.length === 10) d = DEFAULT_CC + d;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

function fill(template, data) {
  let missing = null;
  const text = template.replace(/\{(\w+)\}/g, (m, key) => {
    const v = data[key.toLowerCase()];
    if (v === undefined || v === '') { missing = key; return m; }
    return v;
  });
  return { text, missing };
}

async function runJob() {
  job.running = true; job.stop = false;
  for (const row of job.rows) {
    if (job.stop) break;
    if (row.status !== 'pending') continue;
    try {
      if (wa.status !== 'ready') throw new Error('WhatsApp connected nahi hai');
      const id = await client.getNumberId(row.phone);
      if (!id) throw new Error('Number WhatsApp par nahi hai');
      await client.sendMessage(id._serialized, row.message);
      row.status = 'sent';
    } catch (e) {
      row.status = 'failed'; row.error = e.message;
    }
    if (job.rows.some((r) => r.status === 'pending') && !job.stop) {
      await sleep((MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY)) * 1000);
    }
  }
  job.running = false;
}

// ---------- API ----------
app.get('/api/status', (req, res) => {
  const c = { sent: 0, failed: 0, pending: 0 };
  job.rows.forEach((r) => c[r.status]++);
  res.json({ wa, running: job.running, counts: c, rows: job.rows });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (job.running) return res.status(400).json({ error: 'Pehle wala job chal raha hai' });
  if (!req.file) return res.status(400).json({ error: 'Excel file chuniye' });
  const template = (req.body.template || '').trim();
  if (!template) return res.status(400).json({ error: 'Message likhiye' });

  const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
  const raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  const rows = raw.map((r) => {
    const data = {};
    Object.keys(r).forEach((k) => (data[norm(k)] = String(r[k]).trim()));
    return data;
  });
  if (!rows.length) return res.status(400).json({ error: 'Excel khaali hai' });

  const keys = Object.keys(rows[0]);
  const nameKey = keys.find((k) => k.includes('business')) || keys.find((k) => k.includes('name'));
  const phoneKey = keys.find((k) => /mobile|phone|number|whatsapp/.test(k));
  if (!nameKey || !phoneKey) {
    return res.status(400).json({ error: 'Columns chahiye: Business Name aur Mobile Number' });
  }

  const seen = new Set();
  job.rows = rows.map((data) => {
    data.business_name = data[nameKey];
    const phone = cleanPhone(data[phoneKey]);
    const base = { name: data.business_name, phone: phone || data[phoneKey], status: 'pending', error: '' };
    if (!phone) return { ...base, status: 'failed', error: 'Number galat hai' };
    if (seen.has(phone)) return { ...base, status: 'failed', error: 'Duplicate number' };
    seen.add(phone);
    const { text, missing } = fill(template, data);
    if (missing) return { ...base, status: 'failed', error: `Column "${missing}" Excel mein nahi hai` };
    return { ...base, phone, message: text };
  });

  runJob();
  res.json({ ok: true, total: job.rows.length });
});

app.post('/api/stop', (req, res) => { job.stop = true; res.json({ ok: true }); });

app.listen(PORT, () => console.log(`Chal raha hai: http://localhost:${PORT}`));
