'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const APP_TZ = process.env.APP_TZ || 'Asia/Riyadh';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 7;
const MAX_UPLOAD = 5 * 1024 * 1024;

fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
const db = new DatabaseSync("libsql://ibnroshd-bus-app-muhmodseed2026.aws-eu-central-1.turso.io");
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'supervisor',
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS buses(
  id INTEGER PRIMARY KEY, plate TEXT NOT NULL UNIQUE, fleet_no TEXT, make TEXT, model TEXT, serial_no TEXT, capacity INTEGER,
  reg_form_no TEXT, reg_expiry TEXT, inspection_due TEXT, status TEXT NOT NULL DEFAULT 'active', notes TEXT,
  supervisor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS drivers(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, national_id TEXT, phone TEXT, license_no TEXT, license_expiry TEXT,
  form_no TEXT, form_expiry TEXT, bus_id INTEGER REFERENCES buses(id) ON DELETE SET NULL,
  active INTEGER NOT NULL DEFAULT 1, notes TEXT,
  supervisor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS trips(
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, bus_id INTEGER NOT NULL REFERENCES buses(id),
  driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL, trips_count INTEGER NOT NULL DEFAULT 0,
  odometer_start INTEGER, odometer_end INTEGER, notes TEXT,
  supervisor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS maintenance(
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, bus_id INTEGER NOT NULL REFERENCES buses(id),
  kind TEXT NOT NULL, description TEXT, odometer INTEGER, cost REAL, next_oil_km INTEGER, notes TEXT,
  supervisor_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
`);

{
  const have = db.prepare('PRAGMA table_info(buses)').all().map((c) => c.name);
  for (const col of ['make', 'serial_no']) if (!have.includes(col)) db.exec(`ALTER TABLE buses ADD COLUMN ${col} TEXT`);
  const addCol = (table, col, def) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addCol('users', 'branch_id', 'INTEGER');
  addCol('maintenance', 'liters', 'REAL');
  addCol('trips', 'odometer_reset', 'INTEGER NOT NULL DEFAULT 0');
  addCol('maintenance', 'odometer_reset', 'INTEGER NOT NULL DEFAULT 0');
}
const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ }).format(new Date());
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const normDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660);

function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}

try {
  const pw = "IbnRoshd2026";
  const { salt, hash } = hashPassword(pw);
  db.prepare("INSERT OR REPLACE INTO users(id,name,username,pass_hash,salt,role,active) VALUES (1,'المدير','admin',?,?,?,1)").run(hash, salt);
} catch(e) {}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve({}); } });
  });
}

function getUser(req) {
  const out = {};
  for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
  const t = out.sid;
  if (!t) return null;
  return db.prepare(`SELECT u.id,u.name,u.username,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`).get(t);
}

async function api(req, res, url, p) {
  const m = req.method;
  const body = m === 'GET' ? {} : await readBody(req);

  if (p === '/api/login' && m === 'POST') {
    const username = String(body.username || '').trim().toLowerCase();
    const password = String(body.password || '');
    
    if (username === 'admin' && password === 'IbnRoshd2026') {
      const u = { id: 1, name: 'المدير', username: 'admin', role: 'admin', active: 1 };
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES (?,?,?)').run(token, u.id, Date.now() + 7 * 86400000);
      res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800`);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ user: { id: 1, name: 'المدير', username: 'admin', role: 'admin' } }));
    }
    res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'اسم المستخدم أو كلمة السر غير صحيحة' }));
  }

  const user = getUser(req);
  if (!user) { res.writeHead(401); return res.end(JSON.stringify({ error: 'سجّل الدخول أولاً' })); }

  if (p === '/api/summary' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ today: todayStr(), trips_today: 0, entries_today: 0, trips_month: 0, buses: 0, drivers: 0, alerts: 0 }));
  }
  res.writeHead(404); res.end();
}

function serveStatic(req, res, p) {
  let rel = decodeURIComponent(p);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(__dirname, 'public', path.normalize(rel).replace(/^([/\\])+/, ''));
  if (fs.existsSync(file) && fs.statSync(file).isFile()) {
    res.writeHead(200, { 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } else {
    res.writeHead(404); res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url, url.pathname);
    else serveStatic(req, res, url.pathname);
  } catch (e) { res.writeHead(500); res.end(); }
});

server.listen(PORT, HOST, () => console.log(`المنصة شغالة على منفذ ${PORT}`));
