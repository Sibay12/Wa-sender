require('dotenv').config();
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3000;
const DEFAULT_CC = process.env.DEFAULT_COUNTRY_CODE || '91';
const MIN_DELAY = Number(process.env.MIN_DELAY_SEC || 20);
const MAX_DELAY = Number(process.env.MAX_DELAY_SEC || 45);
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;
const AUTH_ON = !!(AUTH_USER && AUTH_PASS);
if (process.env.RENDER && !AUTH_ON) { console.error('AUTH_USER and AUTH_PASS are required on Render'); process.exit(1); }
process.on('unhandledRejection', (e) => console.error('Unhandled:', e && e.message));

const app = express();
app.set('trust proxy', 1);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
app.use(express.json());
const started = Date.now();

// ---------- Health check (public, used by uptime pingers) ----------
app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp: wa.status, uptime_sec: Math.floor((Date.now() - started) / 1000) }));

// ---------- Login (cookie session) ----------
const sign = (v) => crypto.createHmac('sha256', process.env.SESSION_SECRET || AUTH_PASS || 'dev').update(v).digest('hex');
const hash = (v) => crypto.createHash('sha256').update(String(v)).digest();
const same = (a, b) => crypto.timingSafeEqual(hash(a), hash(b));
const makeToken = () => { const exp = String(Date.now() + 7 * 864e5); return exp + '.' + sign(exp); };
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  return !!(exp && sig && Number(exp) > Date.now() && same(sig, sign(exp)));
}
function getCookie(req, name) {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}
const loggedIn = (req) => !AUTH_ON || validToken(getCookie(req, 'session'));
const attempts = new Map();

app.post('/api/login', (req, res) => {
  const a = attempts.get(req.ip) || { n: 0, until: 0 };
  if (a.until > Date.now()) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { username = '', password = '' } = req.body || {};
  if (AUTH_ON && same(username, AUTH_USER) && same(password, AUTH_PASS)) {
    attempts.delete(req.ip);
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `session=${makeToken()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800${secure}`);
    return res.json({ ok: true });
  }
  a.n++; if (a.n >= 5) { a.until = Date.now() + 10 * 60 * 1000; a.n = 0; }
  attempts.set(req.ip, a);
  res.status(401).json({ error: 'Incorrect username or password.' });
});
app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'session=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});
app.get('/login', (req, res) => loggedIn(req) ? res.redirect('/') : res.sendFile(path.join(__dirname, 'public', 'login.html')));

app.use((req, res, next) => {
  if (loggedIn(req)) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Please log in.' });
  res.redirect('/login');
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------- WhatsApp connection ----------
const wa = { status: 'stopped', qr: null, info: null, error: null };
let client = null;
let manualStop = false;

function buildClient() {
  const c = new Client({
    authStrategy: new LocalAuth({ dataPath: process.env.SESSION_PATH || './session' }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    }
  });
  c.on('qr', async (qr) => { if (client !== c) return; wa.status = 'qr'; wa.qr = await QRCode.toDataURL(qr, { margin: 1, width: 300 }); });
  c.on('authenticated', () => { if (client !== c) return; wa.status = 'authenticating'; wa.qr = null; });
  c.on('ready', () => { if (client !== c) return; wa.status = 'ready'; wa.qr = null; wa.error = null; wa.info = c.info && c.info.wid ? c.info.wid.user : null; });
  c.on('auth_failure', () => { if (client !== c) return; wa.status = 'stopped'; wa.error = 'Authentication failed. Please connect again.'; });
  c.on('disconnected', async (reason) => {
    if (client !== c) return;
    client = null; wa.status = 'stopped'; wa.qr = null; wa.info = null; wa.error = 'Disconnected: ' + reason;
    try { await c.destroy(); } catch (e) {}
    if (!manualStop) setTimeout(connect, 5000);
  });
  return c;
}
async function connect() {
  if (client) return;
  manualStop = false; wa.status = 'starting'; wa.error = null; wa.qr = null;
  const c = client = buildClient();
  try { await c.initialize(); }
  catch (e) {
    if (client === c) { client = null; wa.status = 'stopped'; wa.error = 'Could not start WhatsApp: ' + e.message; }
    try { await c.destroy(); } catch (x) {}
  }
}
async function disconnect(unlink) {
  manualStop = true;
  const c = client; client = null;
  wa.status = 'stopped'; wa.qr = null; wa.info = null; wa.error = null;
  if (!c) return;
  try { if (unlink) await c.logout(); } catch (e) {}
  try { await c.destroy(); } catch (e) {}
}
connect();

// ---------- Sending job ----------
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
      if (!client || wa.status !== 'ready') throw new Error('WhatsApp is not connected');
      const id = await client.getNumberId(row.phone);
      if (!id) throw new Error('Number is not on WhatsApp');
      await client.sendMessage(id._serialized, row.message);
      row.status = 'sent';
    } catch (e) { row.status = 'failed'; row.error = e.message; }
    if (!job.stop && job.rows.some((r) => r.status === 'pending')) {
      await sleep((MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY)) * 1000);
    }
  }
  job.running = false;
}

// ---------- API ----------
app.get('/api/status', (req, res) => {
  const counts = { sent: 0, failed: 0, pending: 0 };
  job.rows.forEach((r) => counts[r.status]++);
  res.json({ wa, running: job.running, counts, rows: job.rows.map(({ name, phone, status, error }) => ({ name, phone, status, error })), uptime: Math.floor((Date.now() - started) / 1000) });
});
app.post('/api/connect', (req, res) => { connect(); res.json({ ok: true }); });
app.post('/api/disconnect', async (req, res) => { await disconnect(!!(req.body && req.body.unlink)); res.json({ ok: true }); });
app.post('/api/stop', (req, res) => { job.stop = true; res.json({ ok: true }); });
app.post('/api/clear', (req, res) => { if (!job.running) job.rows = []; res.json({ ok: true }); });

app.post('/api/start', upload.single('file'), (req, res) => {
  if (job.running) return res.status(400).json({ error: 'A job is already running.' });
  if (wa.status !== 'ready') return res.status(400).json({ error: 'WhatsApp is not connected. Click Connect first.' });
  if (!req.file) return res.status(400).json({ error: 'Please choose an Excel file.' });
  const template = (req.body.template || '').trim();
  if (!template) return res.status(400).json({ error: 'Please write a message.' });

  let raw;
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    raw = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } catch (e) { return res.status(400).json({ error: 'Could not read the file. Use .xlsx, .xls or .csv.' }); }
  const rows = raw.map((r) => { const d = {}; Object.keys(r).forEach((k) => (d[norm(k)] = String(r[k]).trim())); return d; });
  if (!rows.length) return res.status(400).json({ error: 'The file is empty.' });

  const keys = Object.keys(rows[0]);
  const nameKey = keys.find((k) => k.includes('business')) || keys.find((k) => k.includes('name'));
  const phoneKey = keys.find((k) => /mobile|phone|number|whatsapp/.test(k));
  if (!nameKey || !phoneKey) return res.status(400).json({ error: 'Columns required: Business Name and Mobile Number.' });

  const seen = new Set();
  job.rows = rows.map((data) => {
    data.business_name = data[nameKey];
    const phone = cleanPhone(data[phoneKey]);
    const base = { name: data.business_name, phone: phone || data[phoneKey], status: 'pending', error: '' };
    if (!phone) return { ...base, status: 'failed', error: 'Invalid number' };
    if (seen.has(phone)) return { ...base, status: 'failed', error: 'Duplicate number' };
    seen.add(phone);
    const { text, missing } = fill(template, data);
    if (missing) return { ...base, status: 'failed', error: `Column "${missing}" not found in file` };
    return { ...base, phone, message: text };
  });
  runJob();
  res.json({ ok: true, total: job.rows.length });
});

// ---------- Keep-alive: ping own /health (set PUBLIC_URL, or Render sets RENDER_EXTERNAL_URL) ----------
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
if (PUBLIC_URL) setInterval(() => fetch(PUBLIC_URL.replace(/\/$/, '') + '/health').catch(() => {}), 10 * 60 * 1000);

app.listen(PORT, () => console.log(`Running on http://localhost:${PORT}`));
