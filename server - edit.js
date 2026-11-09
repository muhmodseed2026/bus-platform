'use strict';
/*
 * منصة مشرفي حركة الباصات
 * خادم بدون أي مكتبات خارجية: Node 22+ فقط (node:sqlite, node:crypto, node:zlib).
 */
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
const db = new DatabaseSync(path.join(DATA_DIR, 'platform.db'));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

/* ------------------------------------------------------------------ schema */
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE,
  pass_hash TEXT NOT NULL, salt TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'supervisor',
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS sessions(
  token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
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
CREATE TABLE IF NOT EXISTS attachments(
  id INTEGER PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id INTEGER NOT NULL, filename TEXT NOT NULL,
  mime TEXT NOT NULL, stored TEXT NOT NULL, size INTEGER NOT NULL, uploaded_by INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY, ts TEXT NOT NULL DEFAULT (datetime('now')), user_id INTEGER, action TEXT NOT NULL,
  entity TEXT, ref_id INTEGER, detail TEXT);
CREATE TABLE IF NOT EXISTS branches(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, notes TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS idx_trips_date ON trips(date);
CREATE INDEX IF NOT EXISTS idx_trips_sup ON trips(supervisor_id);
CREATE INDEX IF NOT EXISTS idx_maint_bus ON maintenance(bus_id);
CREATE INDEX IF NOT EXISTS idx_att_owner ON attachments(owner_kind, owner_id);
`);
/* ترقية قواعد البيانات القديمة: أعمدة الماركة والرقم التسلسلي للباص */
{
  const have = db.prepare('PRAGMA table_info(buses)').all().map((c) => c.name);
  for (const col of ['make', 'serial_no']) if (!have.includes(col)) db.exec(`ALTER TABLE buses ADD COLUMN ${col} TEXT`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_buses_serial ON buses(serial_no)');
  /* ترقية: فرع المشرف + عدد لترات الوقود */
  const addCol = (table, col, def) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  };
  addCol('users', 'branch_id', 'INTEGER REFERENCES branches(id)');
  addCol('maintenance', 'liters', 'REAL');
  /* ترقية: علامة «استبدال العداد» (تبدأ عندها سلسلة قراءات جديدة للباص) */
  addCol('trips', 'odometer_reset', 'INTEGER NOT NULL DEFAULT 0');
  addCol('maintenance', 'odometer_reset', 'INTEGER NOT NULL DEFAULT 0');
  db.exec('CREATE INDEX IF NOT EXISTS idx_trips_bus ON trips(bus_id, date)');
}

/* تنظيف الملفات اليتيمة في مجلد المرفقات (ملفات بدون سجل في القاعدة بسبب فشل سابق) */
{
  const dir = path.join(DATA_DIR, 'uploads');
  const known = new Set(db.prepare('SELECT stored FROM attachments').all().map((r) => r.stored));
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (/^[0-9a-f]{32}\.(jpg|png|webp|pdf)$/.test(f) && !known.has(f)) { fs.rmSync(path.join(dir, f), { force: true }); n++; }
  }
  if (n) console.log(`تم حذف ${n} ملف يتيم من المرفقات`);
}

/* ----------------------------------------------------------------- helpers */
const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: APP_TZ }).format(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const intOrNull = (v) => (v !== undefined && v !== '' && Number.isInteger(Number(v)) ? Number(v) : null);
/* يحوّل الأرقام العربية (٠١٢) إلى أرقام لاتينية عشان الإدخال من أي لوحة مفاتيح يشتغل */
const normDigits = (s) => String(s).replace(/[٠-٩]/g, (d) => d.charCodeAt(0) - 0x660).replace(/[۰-۹]/g, (d) => d.charCodeAt(0) - 0x6F0);

function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(pw, user) {
  const a = Buffer.from(hashPassword(pw, user.salt).hash, 'hex');
  const b = Buffer.from(user.pass_hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function audit(user, action, entity, refId, detail) {
  db.prepare('INSERT INTO audit(user_id,action,entity,ref_id,detail) VALUES (?,?,?,?,?)')
    .run(user ? user.id : null, action, entity || null, refId || null, detail ? String(detail).slice(0, 300) : null);
}

/* first run: create the admin account */
if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
  const pw = "IbnRoshd2026";
  const { salt, hash } = hashPassword(pw);
  db.prepare("INSERT OR REPLACE INTO users(name,username,pass_hash,hash,salt,role) VALUES ('المدير','admin',?,?,?,'admin')").run(hash, salt);
  console.log('\n==============================================');
  console.log(' تم إنشاء حساب المدير لأول مرة');
  console.log('   اسم المستخدم : admin');
  console.log('   كلمة السر    : ' + pw);
  console.log(' غيّر كلمة السر بعد أول دخول.');
  console.log('==============================================\n');
}

/* -------------------------------------------------------------- entity config */
const STATUS = { active: 'يعمل', maintenance: 'في الصيانة', stopped: 'متوقف' };
const KIND = { maintenance: 'صيانة', oil: 'تغيير زيت', fuel: 'وقود' };
const ACTIVE = { 1: 'على رأس العمل', 0: 'موقوف' };

const ENT = {
  buses: {
    table: 'buses', fields: {
      plate: { t: 'text', req: 1, max: 30, label: 'رقم اللوحة' },
      fleet_no: { t: 'text', max: 30, label: 'رقم الباص' },
      make: { t: 'text', max: 60, label: 'ماركة الباص' },
      model: { t: 'text', max: 60, label: 'الموديل' },
      serial_no: { t: 'text', max: 60, label: 'الرقم التسلسلي' },
      capacity: { t: 'int', min: 1, max: 200, label: 'السعة' },
      reg_form_no: { t: 'text', max: 40, label: 'رقم استمارة المركبة' },
      reg_expiry: { t: 'date', label: 'انتهاء الاستمارة' },
      inspection_due: { t: 'date', label: 'موعد الفحص الدوري' },
      status: { t: 'enum', vals: Object.keys(STATUS), def: 'active', label: 'الحالة' },
      notes: { t: 'text', max: 1000, label: 'ملاحظات' },
    },
    cols: [['plate', 'رقم اللوحة'], ['fleet_no', 'رقم الباص'], ['make', 'ماركة الباص'], ['model', 'الموديل'], ['serial_no', 'الرقم التسلسلي'], ['capacity', 'السعة'],
      ['reg_form_no', 'رقم استمارة المركبة'], ['reg_expiry', 'انتهاء الاستمارة'], ['inspection_due', 'ميعاد الفحص الدوري'],
      ['status', 'الحالة', (v) => STATUS[v] || v], ['supervisor_name', 'المشرف'], ['notes', 'ملاحظات']],
  },
  drivers: {
    table: 'drivers', fields: {
      name: { t: 'text', req: 1, max: 100, label: 'اسم السائق' },
      national_id: { t: 'text', req: 1, max: 15, digits: 1, re: /^\d{8,15}$/, msg: 'أرقام فقط (من 8 إلى 15 رقماً)', label: 'رقم الهوية' },
      phone: { t: 'text', req: 1, max: 16, digits: 1, re: /^\+?\d{7,15}$/, msg: 'اكتب رقم الجوال بالأرقام فقط', label: 'رقم الجوال' },
      license_no: { t: 'text', max: 40, label: 'رقم الرخصة' },
      license_expiry: { t: 'date', label: 'انتهاء الرخصة' },
      form_no: { t: 'text', max: 40, label: 'رقم استمارة السائق' },
      form_expiry: { t: 'date', label: 'انتهاء استمارة السائق' },
      bus_id: { t: 'ref', ref: 'buses', label: 'الباص المفوض عليه' },
      active: { t: 'bool', def: 1, label: 'الحالة' },
      notes: { t: 'text', max: 1000, label: 'ملاحظات' },
    },