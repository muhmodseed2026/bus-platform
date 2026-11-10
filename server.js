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
let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch { console.error('هذه المنصة تحتاج Node.js 22.13 أو أحدث (الإصدار الحالي ' + process.version + '). حدّث إصدار Node في الاستضافة.'); process.exit(1); }

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const APP_TZ = process.env.APP_TZ || 'Asia/Riyadh';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SESSION_DAYS = 7;
const MAX_UPLOAD = 5 * 1024 * 1024;

/* DATABASE_URL (اختياري): مسار ملف SQLite فقط، مثل sqlite:///var/data/platform.db (مطلق) أو sqlite:data/platform.db (نسبي).
 * لو لم يُحدَّد يُستخدم DATA_DIR/platform.db كما كان. المرفقات تبقى في DATA_DIR/uploads. */
function dbPathFromEnv() {
  const raw = (process.env.DATABASE_URL || '').trim();
  if (!raw) return path.join(DATA_DIR, 'platform.db');
  const m = raw.match(/^sqlite:(.*)$/i);
  if (!m) { console.error('DATABASE_URL يدعم ملفات SQLite فقط، بصيغة مثل sqlite:///var/data/platform.db'); process.exit(1); }
  let p = m[1].replace(/^\/\//, '').split(/[?#]/)[0];
  try { p = decodeURIComponent(p); } catch { /* اتركه كما هو */ }
  if (process.platform === 'win32') p = p.replace(/^\/([A-Za-z]:)/, '$1');
  if (!p || /^\/*:memory:$/.test(p)) { console.error('DATABASE_URL يجب أن يحدد مسار ملف، مثل sqlite:///var/data/platform.db'); process.exit(1); }
  return path.resolve(p);
}
const DB_PATH = dbPathFromEnv();
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
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
  /* الرقم التسلسلي الفارغ يُعامل كغير موجود، ولو وُجد تكرار قديم لا نوقف الإقلاع: نكتفي بتحذير ونمنع التكرار الجديد من التطبيق */
  db.exec("UPDATE buses SET serial_no=NULL WHERE serial_no IS NOT NULL AND TRIM(serial_no)=''");
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_buses_serial ON buses(serial_no)'); }
  catch (e) {
    const dups = db.prepare('SELECT serial_no, COUNT(*) c FROM buses WHERE serial_no IS NOT NULL GROUP BY serial_no HAVING c>1').all();
    console.warn('تحذير: أرقام تسلسلية مكررة بين الباصات، صحّحها من صفحة الباصات:', dups.map((d) => `${d.serial_no} (${d.c})`).join('، '));
    db.exec('CREATE INDEX IF NOT EXISTS idx_buses_serial_nu ON buses(serial_no)');
  }
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
try {
  const dir = path.join(DATA_DIR, 'uploads');
  const known = new Set(db.prepare('SELECT stored FROM attachments').all().map((r) => r.stored));
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (/^[0-9a-f]{32}\.(jpg|png|webp|pdf)$/.test(f) && !known.has(f)) { fs.rmSync(path.join(dir, f), { force: true }); n++; }
  }
  if (n) console.log(`تم حذف ${n} ملف يتيم من المرفقات`);
} catch (e) { console.warn('تعذّر تنظيف المرفقات اليتيمة (لا يؤثر على التشغيل):', e.message); }

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
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  const { salt, hash } = hashPassword(pw);
  db.prepare("INSERT INTO users(name,username,pass_hash,salt,role) VALUES ('المدير','admin',?,?,'admin')").run(hash, salt);
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
    cols: [['name', 'اسم السائق'], ['national_id', 'رقم الهوية'], ['phone', 'الجوال'], ['license_no', 'رقم الرخصة'],
      ['license_expiry', 'انتهاء الرخصة'], ['form_no', 'رقم استمارة السائق'], ['form_expiry', 'انتهاء استمارة السائق'],
      ['bus_plate', 'لوحة الباص المفوض عليه'], ['bus_make', 'ماركة الباص'], ['bus_model', 'موديل الباص'], ['bus_serial', 'الرقم التسلسلي للباص'],
      ['active', 'الحالة', (v) => ACTIVE[v] || v], ['supervisor_name', 'المشرف'], ['notes', 'ملاحظات']],
  },
  trips: {
    table: 'trips', dated: true, fields: {
      date: { t: 'date', req: 1, label: 'التاريخ', noFuture: 1 },
      bus_id: { t: 'ref', ref: 'buses', req: 1, label: 'الباص' },
      driver_id: { t: 'ref', ref: 'drivers', label: 'السائق' },
      trips_count: { t: 'int', req: 1, min: 0, max: 1000, label: 'عدد الرحلات' },
      odometer_start: { t: 'int', label: 'عداد البداية' },
      odometer_end: { t: 'int', label: 'عداد النهاية' },
      odometer_reset: { t: 'bool', def: 0, adminOnly: 1, label: 'استبدال العداد' },
      notes: { t: 'text', max: 1000, label: 'ملاحظات' },
    },
    cols: [['date', 'التاريخ'], ['bus_plate', 'الباص'], ['driver_name', 'السائق'], ['trips_count', 'عدد الرحلات'],
      ['odometer_start', 'عداد البداية'], ['odometer_end', 'عداد النهاية'],
      ['km', 'المسافة (كم)', null, (r) => (r.odometer_start != null && r.odometer_end != null ? r.odometer_end - r.odometer_start : null)],
      ['supervisor_name', 'المشرف'], ['notes', 'ملاحظات']],
  },
  maintenance: {
    table: 'maintenance', dated: true, fields: {
      date: { t: 'date', req: 1, label: 'التاريخ', noFuture: 1 },
      bus_id: { t: 'ref', ref: 'buses', req: 1, label: 'الباص' },
      kind: { t: 'enum', vals: Object.keys(KIND), req: 1, label: 'النوع' },
      description: { t: 'text', max: 500, label: 'الوصف' },
      odometer: { t: 'int', label: 'قراءة العداد' },
      odometer_reset: { t: 'bool', def: 0, adminOnly: 1, label: 'استبدال العداد' },
      liters: { t: 'num', label: 'عدد اللترات' },
      cost: { t: 'num', label: 'التكلفة' },
      next_oil_km: { t: 'int', label: 'الزيت القادم عند' },
      notes: { t: 'text', max: 1000, label: 'ملاحظات' },
    },
    cols: [['date', 'التاريخ'], ['bus_plate', 'الباص'], ['kind', 'النوع', (v) => KIND[v] || v], ['description', 'الوصف'],
      ['odometer', 'قراءة العداد'], ['liters', 'عدد اللترات'], ['cost', 'التكلفة'], ['next_oil_km', 'الزيت القادم عند'], ['supervisor_name', 'المشرف'], ['notes', 'ملاحظات']],
  },
};

const LIST_SQL = {
  buses: `SELECT x.*, u.name AS supervisor_name FROM buses x LEFT JOIN users u ON u.id=x.supervisor_id`,
  drivers: `SELECT x.*, u.name AS supervisor_name, b.plate AS bus_plate, b.make AS bus_make, b.model AS bus_model, b.serial_no AS bus_serial FROM drivers x
            LEFT JOIN users u ON u.id=x.supervisor_id LEFT JOIN buses b ON b.id=x.bus_id`,
  trips: `SELECT x.*, u.name AS supervisor_name, b.plate AS bus_plate, d.name AS driver_name FROM trips x
          LEFT JOIN users u ON u.id=x.supervisor_id LEFT JOIN buses b ON b.id=x.bus_id LEFT JOIN drivers d ON d.id=x.driver_id`,
  maintenance: `SELECT x.*, u.name AS supervisor_name, b.plate AS bus_plate FROM maintenance x
                LEFT JOIN users u ON u.id=x.supervisor_id LEFT JOIN buses b ON b.id=x.bus_id`,
};

/* كل قائمة تعرض اسم فرع المشرف المسؤول عن السجل */
for (const k of Object.keys(LIST_SQL)) {
  LIST_SQL[k] = LIST_SQL[k]
    .replace('u.name AS supervisor_name', 'u.name AS supervisor_name, br.name AS branch_name')
    .replace('LEFT JOIN users u ON u.id=x.supervisor_id', 'LEFT JOIN users u ON u.id=x.supervisor_id LEFT JOIN branches br ON br.id=u.branch_id');
}

const isAdmin = (u) => u.role === 'admin';
const canAccess = (u, row) => isAdmin(u) || row.supervisor_id === u.id;

function dbError(e) {
  const m = String(e.message);
  if (/serial_no/.test(m)) return 'الرقم التسلسلي مسجل من قبل لباص آخر';
  if (/branches\.name/.test(m)) return 'اسم الفرع مسجل من قبل';
  if (/UNIQUE/.test(m)) return 'رقم اللوحة مسجل من قبل';
  if (/FOREIGN KEY/.test(m)) return 'لا يمكن الحذف لأن عليه سجلات مرتبطة. غيّر حالته إلى "متوقف" بدل الحذف.';
  throw e;
}

/* ------------------------------------------------------- odometer sequence
 * لكل باص سلسلة قراءات (من الحركة والصيانة) يجب ألا تنقص مع الزمن:
 *  - قراءة أي يوم لا تقل عن أعلى قراءة في الأيام السابقة، ولا تزيد عن أقل قراءة في الأيام اللاحقة.
 *  - حركتان لنفس الباص في نفس اليوم لا يجوز أن يتداخل مدى عداديهما.
 *  - تصحيح قراءة سابقة: عدّل السجل نفسه، والتحقق يقارنه بجيرانه فقط.
 *  - استبدال العداد: المدير يعلّم السجل بـ «استبدال العداد» فتبدأ سلسلة جديدة من ذلك اليوم
 *    ولا تُقارَن قراءاتها بما قبلها.
 */
const MAX_TRIP_KM = Number(process.env.MAX_TRIP_KM) || 3000;

function busOdoEvents(busId, skip) {
  const ev = [];
  const push = (table, r, vals) => {
    const v = vals.filter((x) => x !== null && x !== undefined);
    if (!v.length || (skip && skip.table === table && skip.id === r.id)) return;
    ev.push({ table, id: r.id, date: r.date, lo: Math.min(...v), hi: Math.max(...v), reset: !!r.odometer_reset, interval: vals.length === 2 && v.length === 2 });
  };
  for (const r of db.prepare('SELECT id,date,odometer_start,odometer_end,odometer_reset FROM trips WHERE bus_id=?').all(busId)) push('trips', r, [r.odometer_start, r.odometer_end]);
  for (const r of db.prepare('SELECT id,date,odometer,odometer_reset FROM maintenance WHERE bus_id=?').all(busId)) push('maintenance', r, [r.odometer]);
  return ev;
}
/* رقم السلسلة لتاريخ معيّن = عدد تواريخ الاستبدال التي وقعت في ذلك اليوم أو قبله */
const odoSegmenter = (events) => {
  const resets = [...new Set(events.filter((e) => e.reset).map((e) => e.date))];
  return (date) => resets.filter((r) => r <= date).length;
};
const fmtKm = (n) => Number(n).toLocaleString('en-US');
const RESET_HINT = ' إذا كان العداد قد استُبدل أو أُعيد ضبطه فاطلب من المدير تسجيل هذه القراءة بخيار «استبدال العداد»، وإذا كانت القراءة السابقة هي الخاطئة فعدّلها أولاً.';

function checkOdometerSequence(table, out, existing, user) {
  const vals = table === 'trips' ? [out.odometer_start, out.odometer_end] : [out.odometer];
  const v = vals.filter((x) => x !== null && x !== undefined);
  const wasReset = !!(existing && existing.odometer_reset);
  const resetChanged = !!existing && (wasReset !== !!out.odometer_reset || (wasReset && existing.date !== out.date) || (wasReset && existing.bus_id !== out.bus_id));
  const others = busOdoEvents(out.bus_id, existing ? { table, id: existing.id } : null);

  /* لو غُيّر مكان علامة الاستبدال أو أُلغيت: تُفحص السلسلة كلها لأن قراءات أخرى ستتأثر */
  if (resetChanged) {
    const mine = v.length ? [{ table, id: existing ? existing.id : 0, date: out.date, lo: Math.min(...v), hi: Math.max(...v), reset: !!out.odometer_reset }] : [];
    const c = timelineConflict([...others, ...mine]);
    if (c) return `لا يمكن تغيير علامة «استبدال العداد» لأن قراءات هذا الباص ستتعارض: ${c}`;
  }
  if (!v.length) return null;

  const me = { date: out.date, lo: Math.min(...v), hi: Math.max(...v), reset: !!out.odometer_reset, interval: vals.length === 2 && v.length === 2 };
  const seg = odoSegmenter([...others, me]);
  const mySeg = seg(me.date);
  const same = others.filter((o) => seg(o.date) === mySeg);

  let prev = null, next = null;
  for (const o of same) {
    if (o.date < me.date && (!prev || o.hi > prev.hi)) prev = o;
    if (o.date > me.date && (!next || o.lo < next.lo)) next = o;
    if (o.date === me.date && me.interval && o.interval && table === 'trips' && o.table === 'trips' && me.lo < o.hi && me.hi > o.lo)
      return `الحركة تتداخل مع حركة أخرى لنفس الباص في نفس اليوم (عداد ${fmtKm(o.lo)} ← ${fmtKm(o.hi)}). راجع قراءات البداية والنهاية.`;
  }
  if (prev && me.lo < prev.hi)
    return `قراءة العداد (${fmtKm(me.lo)}) أقل من قراءة سابقة لنفس الباص (${fmtKm(prev.hi)} بتاريخ ${prev.date}).${RESET_HINT}`;
  if (next && me.hi > next.lo)
    return `قراءة العداد (${fmtKm(me.hi)}) أكبر من قراءة لاحقة لنفس الباص (${fmtKm(next.lo)} بتاريخ ${next.date}).${RESET_HINT}`;
  return null;
}

/* يفحص سلسلة قراءات كاملة ويرجع وصف أول تعارض أو null */
function timelineConflict(events) {
  const seg = odoSegmenter(events);
  const sorted = [...events].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const maxBefore = new Map();
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j].date === sorted[i].date) j++;
    const group = sorted.slice(i, j);
    for (const e of group) {
      const m = maxBefore.get(seg(e.date));
      if (m && e.lo < m.hi) return `قراءة ${fmtKm(e.lo)} بتاريخ ${e.date} أقل من قراءة ${fmtKm(m.hi)} بتاريخ ${m.date}`;
    }
    for (const e of group) {
      const s = seg(e.date), m = maxBefore.get(s);
      if (!m || e.hi > m.hi) maxBefore.set(s, e);
    }
    i = j;
  }
  return null;
}

/* كل التعارضات الموجودة في بيانات باص (للتقرير): قراءة أقل من سابقة، حركتان متداخلتان، مسافة غير معقولة */
function odometerIssues(busId) {
  const ev = busOdoEvents(busId, null).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const seg = odoSegmenter(ev), issues = [], maxBefore = new Map();
  const rec = (e) => ({ record: e.table === 'trips' ? 'حركة' : 'صيانة/وقود', record_id: e.id, table: e.table, date: e.date });
  let i = 0;
  while (i < ev.length) {
    let j = i;
    while (j < ev.length && ev[j].date === ev[i].date) j++;
    const group = ev.slice(i, j);
    for (const e of group) {
      const m = maxBefore.get(seg(e.date));
      if (m && e.lo < m.hi) issues.push({ ...rec(e), problem: 'قراءة أقل من قراءة سابقة', reading: e.lo, other_reading: m.hi, other_date: m.date });
      if (e.interval && e.hi - e.lo > MAX_TRIP_KM) issues.push({ ...rec(e), problem: 'مسافة أكبر من الحد المعقول', reading: e.hi, other_reading: e.lo, other_date: e.date });
    }
    for (let a = 0; a < group.length; a++) for (let b = a + 1; b < group.length; b++) {
      const x = group[a], y = group[b];
      if (x.table === 'trips' && y.table === 'trips' && x.interval && y.interval && x.lo < y.hi && x.hi > y.lo)
        issues.push({ ...rec(y), problem: 'حركة تتداخل مع حركة أخرى في نفس اليوم', reading: y.lo, other_reading: x.lo, other_date: x.date });
    }
    for (const e of group) { const s = seg(e.date), m = maxBefore.get(s); if (!m || e.hi > m.hi) maxBefore.set(s, e); }
    i = j;
  }
  return issues;
}

/* العداد الحالي للباص = آخر قراءة في السلسلة الأخيرة (بعد آخر استبدال للعداد) */
function currentKm(busId) {
  const ev = busOdoEvents(busId, null);
  if (!ev.length) return 0;
  const lastReset = ev.filter((e) => e.reset).reduce((m, e) => (e.date > m ? e.date : m), '');
  const cur = ev.filter((e) => e.date >= lastReset);
  const lastDate = cur.reduce((m, e) => (e.date > m ? e.date : m), '');
  return Math.max(...cur.filter((e) => e.date === lastDate).map((e) => e.hi));
}

function validate(cfg, input, existing, user) {
  const out = {};
  const today = todayStr();
  for (const [name, f] of Object.entries(cfg.fields)) {
    let v = name in input ? input[name] : existing ? existing[name] : undefined;
    if (f.t === 'bool') {
      /* الحقول الخاصة بالمدير: غير المدير لا يستطيع تغييرها (تبقى قيمتها القديمة) */
      if (f.adminOnly && !isAdmin(user)) { out[name] = existing ? (existing[name] ?? 0) : (f.def ?? 0); continue; }
      out[name] = v === undefined || v === null || v === '' ? (f.def ?? 0) : (v === true || v === 1 || v === '1' ? 1 : 0);
      continue;
    }
    if (typeof v === 'string') v = v.trim();
    if (typeof v === 'string' && (f.t === 'date' || f.t === 'int' || f.t === 'num' || f.digits)) v = normDigits(v);
    if (typeof v === 'string' && f.digits) v = v.replace(/[\s-]/g, '');
    if (v === undefined || v === '' || v === null) {
      if (f.def !== undefined && !f.req) v = f.def;
      else if (f.req) return { error: `حقل "${f.label}" مطلوب` };
      else { out[name] = null; continue; }
    }
    const bad = (why) => ({ error: `قيمة "${f.label}" غير صحيحة${why ? ': ' + why : ''}` });
    switch (f.t) {
      case 'text':
        v = String(v);
        if (v.length > (f.max || 200)) return bad('أطول من المسموح');
        if (f.re && !f.re.test(v)) return bad(f.msg);
        break;
      case 'date':
        if (!isDate(v) || v < '2000-01-01') return bad('استخدم صيغة سنة-شهر-يوم');
        if (f.noFuture && v > addDays(today, 1)) return bad('التاريخ في المستقبل');
        break;
      case 'int': v = Number(v); if (!Number.isInteger(v) || v < (f.min ?? 0) || v > (f.max ?? 100000000)) return bad(); break;
      case 'num': v = Number(v); if (!Number.isFinite(v) || v < 0 || v > 1e9) return bad(); break;
      case 'enum': if (!f.vals.includes(v)) return bad(); break;
      case 'ref': {
        v = Number(v); if (!Number.isInteger(v)) return bad();
        const row = db.prepare(`SELECT supervisor_id FROM ${f.ref} WHERE id=?`).get(v);
        if (!row) return bad('غير موجود');
        if (!canAccess(user, row)) return { error: `"${f.label}" ليس ضمن بياناتك` };
        break;
      }
    }
    out[name] = v;
  }
  if (out.odometer_start != null && out.odometer_end != null && out.odometer_end < out.odometer_start)
    return { error: 'عداد النهاية أقل من عداد البداية' };
  if (out.odometer_start != null && out.odometer_end != null && out.odometer_end - out.odometer_start > MAX_TRIP_KM)
    return { error: `المسافة في تسجيل واحد (${out.odometer_end - out.odometer_start} كم) أكبر من الحد المعقول (${MAX_TRIP_KM} كم). راجع قراءتي العداد.` };
  if (cfg.table === 'buses' && out.serial_no) {
    const dup = db.prepare('SELECT id FROM buses WHERE serial_no=? AND id!=?').get(out.serial_no, existing ? existing.id : 0);
    if (dup) return { error: 'الرقم التسلسلي مسجل من قبل لباص آخر' };
  }
  if (cfg.table === 'trips' || cfg.table === 'maintenance') {
    const e = checkOdometerSequence(cfg.table, out, existing, user);
    if (e) return { error: e };
  }
  if (cfg.table === 'maintenance' && out.kind === 'fuel' && (out.liters === null || out.liters === undefined))
    return { error: 'اكتب عدد اللترات لتسجيل الوقود' };
  return { values: out };
}

/* ------------------------------------------------------------ list / query */
function listEntity(user, entity, q, forExport) {
  const cfg = ENT[entity];
  const where = [], args = [];
  if (!isAdmin(user)) { where.push('x.supervisor_id=?'); args.push(user.id); }
  else if (intOrNull(q.supervisor_id) !== null) { where.push('x.supervisor_id=?'); args.push(intOrNull(q.supervisor_id)); }
  if (isAdmin(user) && intOrNull(q.branch_id) !== null) { where.push('u.branch_id=?'); args.push(intOrNull(q.branch_id)); }
  if (entity !== 'buses' && intOrNull(q.bus_id) !== null) { where.push('x.bus_id=?'); args.push(intOrNull(q.bus_id)); }
  if (entity === 'trips' && intOrNull(q.driver_id) !== null) { where.push('x.driver_id=?'); args.push(intOrNull(q.driver_id)); }
  if (cfg.dated) {
    if (isDate(q.from)) { where.push('x.date>=?'); args.push(q.from); }
    if (isDate(q.to)) { where.push('x.date<=?'); args.push(q.to); }
  }
  if (entity === 'maintenance' && KIND[q.kind]) { where.push('x.kind=?'); args.push(q.kind); }
  if (entity === 'buses' && STATUS[q.status]) { where.push('x.status=?'); args.push(q.status); }
  if (q.q && entity === 'buses') { where.push('(x.plate LIKE ? OR x.fleet_no LIKE ? OR x.serial_no LIKE ? OR x.make LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  if (q.q && entity === 'drivers') { where.push('(x.name LIKE ? OR x.national_id LIKE ? OR x.phone LIKE ? OR b.plate LIKE ?)'); args.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }
  const order = cfg.dated ? 'x.date DESC, x.id DESC' : entity === 'buses' ? 'x.plate' : 'x.name';
  const limit = forExport ? 50000 : Math.min(Number(q.limit) || 500, 2000);
  const sql = `${LIST_SQL[entity]} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ${limit}`;
  return db.prepare(sql).all(...args);
}
const getOne = (entity, id) => db.prepare(`${LIST_SQL[entity]} WHERE x.id=?`).get(id);

function createEntity(user, entity, body) {
  const cfg = ENT[entity];
  const v = validate(cfg, body, null, user);
  if (v.error) return v;
  let sup = user.id;
  if (isAdmin(user) && body.supervisor_id) {
    const s = db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(intOrNull(body.supervisor_id));
    if (!s) return { error: 'المشرف غير موجود' };
    sup = s.id;
  }
  const cols = Object.keys(v.values);
  try {
    const r = db.prepare(`INSERT INTO ${cfg.table} (${cols.join(',')},supervisor_id) VALUES (${cols.map(() => '?').join(',')},?)`)
      .run(...cols.map((c) => v.values[c]), sup);
    audit(user, 'create', entity, r.lastInsertRowid, summary(entity, v.values));
    return { id: Number(r.lastInsertRowid) };
  } catch (e) { return { error: dbError(e) }; }
}
function updateEntity(user, entity, id, body) {
  const cfg = ENT[entity];
  const existing = db.prepare(`SELECT * FROM ${cfg.table} WHERE id=?`).get(id);
  if (!existing) return { status: 404, error: 'السجل غير موجود' };
  if (!canAccess(user, existing)) return { status: 403, error: 'غير مسموح' };
  const v = validate(cfg, body, existing, user);
  if (v.error) return v;
  let sup = existing.supervisor_id;
  if (isAdmin(user) && body.supervisor_id) {
    const s = db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(intOrNull(body.supervisor_id));
    if (!s) return { error: 'المشرف غير موجود' };
    sup = s.id;
  }
  const cols = Object.keys(v.values);
  try {
    db.prepare(`UPDATE ${cfg.table} SET ${cols.map((c) => c + '=?').join(',')}, supervisor_id=?, updated_at=datetime('now') WHERE id=?`)
      .run(...cols.map((c) => v.values[c]), sup, id);
    audit(user, 'update', entity, id, summary(entity, v.values));
    return { id };
  } catch (e) { return { error: dbError(e) }; }
}
function parseBranchId(v) {
  if (v === undefined || v === null || v === '') return { id: null };
  const id = intOrNull(v);
  if (id === null || !db.prepare('SELECT 1 FROM branches WHERE id=?').get(id)) return { error: 'الفرع غير موجود' };
  return { id };
}
const SETTING_KEYS = ['traffic_officer', 'logistics_officer'];
function getSettings() {
  const out = Object.fromEntries(SETTING_KEYS.map((k) => [k, '']));
  for (const r of db.prepare('SELECT key,value FROM settings').all()) if (r.key in out) out[r.key] = r.value;
  return out;
}
/* توقيعات التقارير: اليمين = مشرف الفرع، اليسار = مسؤول الخدمات اللوجستية (من الإعدادات).
 * مشرف الفرع يُحدَّد من نطاق التقرير نفسه: مشرف يرى بياناته فقط ← هو نفسه؛ المدير مع فلتر مشرف ← ذلك المشرف؛
 * المدير مع فلتر فرع ← المشرفون النشطون في الفرع؛ بدون فلتر ← يُترك الاسم فارغاً للتوقيع باليد. */
function signersFor(user, scope) {
  const out = { branch_supervisor: '', branch: '', logistics_officer: getSettings().logistics_officer || '' };
  const one = (id) => db.prepare('SELECT u.name, br.name AS branch FROM users u LEFT JOIN branches br ON br.id=u.branch_id WHERE u.id=?').get(id);
  let supId = null;
  if (!isAdmin(user)) supId = user.id;
  else if (scope.supervisor_id != null) supId = scope.supervisor_id;
  if (supId !== null) {
    const r = one(supId);
    if (r) { out.branch_supervisor = r.name; out.branch = r.branch || ''; }
  } else if (isAdmin(user) && scope.branch_id != null) {
    const br = db.prepare('SELECT name FROM branches WHERE id=?').get(scope.branch_id);
    if (br) {
      out.branch = br.name;
      out.branch_supervisor = db.prepare("SELECT name FROM users WHERE branch_id=? AND role='supervisor' AND active=1 ORDER BY name").all(scope.branch_id).map((x) => x.name).join(' / ');
    }
  }
  return out;
}
const reportScope = (q) => ({ supervisor_id: intOrNull(q.supervisor_id), branch_id: intOrNull(q.branch_id) });

/* يضيف باصاً جديداً ثم يحفظ السائق المربوط به في عملية واحدة: لو فشل أي منهما لا يُحفظ شيء */
function withNewBus(user, body, run) {
  const nb = body.new_bus;
  if (!nb || typeof nb !== 'object' || !String(nb.plate || '').trim()) return run(body);
  db.exec('BEGIN');
  try {
    const rb = createEntity(user, 'buses', { ...nb, supervisor_id: body.supervisor_id });
    if (rb.error) { db.exec('ROLLBACK'); return { error: 'بيانات الباص الجديد: ' + rb.error }; }
    const r = run({ ...body, bus_id: rb.id });
    if (r.error) { db.exec('ROLLBACK'); return r; }
    db.exec('COMMIT');
    return { ...r, bus_id: rb.id };
  } catch (e) { try { db.exec('ROLLBACK'); } catch { /* already closed */ } throw e; }
}
function summary(entity, v) {
  return v.plate || v.name || [v.date, v.trips_count != null ? v.trips_count + ' رحلة' : KIND[v.kind]].filter(Boolean).join(' ');
}

/* ------------------------------------------------------------ alerts / oil */
function oilStatus(user) {
  const args = [];
  let scope = "WHERE b.status!='stopped'";
  if (!isAdmin(user)) { scope += ' AND b.supervisor_id=?'; args.push(user.id); }
  const rows = db.prepare(`
    SELECT b.id AS bus_id, b.plate, u.name AS supervisor_name,
      (SELECT date FROM maintenance m WHERE m.bus_id=b.id AND m.kind='oil' ORDER BY date DESC, id DESC LIMIT 1) AS last_oil_date,
      (SELECT odometer FROM maintenance m WHERE m.bus_id=b.id AND m.kind='oil' ORDER BY date DESC, id DESC LIMIT 1) AS last_oil_odo,
      (SELECT next_oil_km FROM maintenance m WHERE m.bus_id=b.id AND m.kind='oil' ORDER BY date DESC, id DESC LIMIT 1) AS next_oil_km
    FROM buses b LEFT JOIN users u ON u.id=b.supervisor_id ${scope} ORDER BY b.plate`).all(...args);
  return rows.map((r) => {
    const current_km = currentKm(r.bus_id);
    const left = r.next_oil_km != null ? r.next_oil_km - current_km : null;
    return { ...r, current_km, km_left: left, state: left === null ? 'unknown' : left <= 0 ? 'overdue' : left <= 500 ? 'soon' : 'ok' };
  });
}

function getAlerts(user, days = 30) {
  const today = todayStr(), limit = addDays(today, days), out = [];
  const sc = isAdmin(user) ? '' : ' AND x.supervisor_id=?';
  const a = isAdmin(user) ? [] : [user.id];
  const docs = [
    ['bus', 'buses', 'reg_expiry', 'استمارة المركبة', 'x.plate', "x.status!='stopped'"],
    ['bus', 'buses', 'inspection_due', 'الفحص الدوري', 'x.plate', "x.status!='stopped'"],
    ['driver', 'drivers', 'license_expiry', 'رخصة السائق', 'x.name', 'x.active=1'],
    ['driver', 'drivers', 'form_expiry', 'استمارة السائق', 'x.name', 'x.active=1'],
  ];
  for (const [owner, table, col, label, subj, cond] of docs) {
    const rows = db.prepare(`SELECT x.id, ${subj} AS subject, x.${col} AS due, u.name AS supervisor_name
      FROM ${table} x LEFT JOIN users u ON u.id=x.supervisor_id
      WHERE x.${col} IS NOT NULL AND x.${col}<=? AND ${cond}${sc} ORDER BY x.${col}`).all(limit, ...a);
    for (const r of rows) {
      const left = Math.round((Date.parse(r.due) - Date.parse(today)) / 86400000);
      out.push({ type: 'doc', owner, owner_id: r.id, label, subject: r.subject, due: r.due, days_left: left,
        severity: left < 0 ? 'overdue' : left <= 7 ? 'urgent' : 'soon', supervisor_name: r.supervisor_name });
    }
  }
  for (const o of oilStatus(user)) {
    if (o.state === 'overdue' || o.state === 'soon') {
      out.push({ type: 'oil', owner: 'bus', owner_id: o.bus_id, label: 'تغيير الزيت', subject: o.plate, km_left: o.km_left,
        severity: o.state === 'overdue' ? 'overdue' : 'soon', supervisor_name: o.supervisor_name });
    }
  }
  const rank = { overdue: 0, urgent: 1, soon: 2 };
  return out.sort((x, y) => rank[x.severity] - rank[y.severity] || (x.days_left ?? 0) - (y.days_left ?? 0));
}

/* ----------------------------------------------------------------- reports */
const GROUPS = {
  supervisor: { sel: 'u.name', label: 'المشرف' },
  bus: { sel: 'b.plate', label: 'الباص' },
  day: { sel: 'x.date', label: 'اليوم' },
  month: { sel: "substr(x.date,1,7)", label: 'الشهر' },
  branch: { sel: "COALESCE(br.name,'بدون فرع')", label: 'الفرع' },
};
function trafficReport(user, q) {
  const g = GROUPS[q.by] || GROUPS.day;
  const where = [], args = [];
  if (!isAdmin(user)) { where.push('x.supervisor_id=?'); args.push(user.id); }
  else if (intOrNull(q.supervisor_id) !== null) { where.push('x.supervisor_id=?'); args.push(intOrNull(q.supervisor_id)); }
  if (isAdmin(user) && intOrNull(q.branch_id) !== null) { where.push('u.branch_id=?'); args.push(intOrNull(q.branch_id)); }
  if (intOrNull(q.bus_id) !== null) { where.push('x.bus_id=?'); args.push(intOrNull(q.bus_id)); }
  if (isDate(q.from)) { where.push('x.date>=?'); args.push(q.from); }
  if (isDate(q.to)) { where.push('x.date<=?'); args.push(q.to); }
  const rows = db.prepare(`SELECT ${g.sel} AS k, COUNT(*) AS records, COALESCE(SUM(x.trips_count),0) AS trips,
      COALESCE(SUM(CASE WHEN x.odometer_start IS NOT NULL AND x.odometer_end IS NOT NULL THEN x.odometer_end-x.odometer_start ELSE 0 END),0) AS km
    FROM trips x JOIN users u ON u.id=x.supervisor_id JOIN buses b ON b.id=x.bus_id LEFT JOIN branches br ON br.id=u.branch_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY k ORDER BY k ${g === GROUPS.day || g === GROUPS.month ? 'DESC' : ''}`).all(...args);
  const totals = rows.reduce((t, r) => ({ records: t.records + r.records, trips: t.trips + r.trips, km: t.km + r.km }), { records: 0, trips: 0, km: 0 });
  return { group_label: g.label, rows, totals };
}

/* تقرير حالة باص واحد: بيانات الباص + ملخص الفترة + سجلات الحركة والوقود والزيت والصيانة */
function busReport(user, id, q) {
  const bus = getOne('buses', id);
  if (!bus) return { status: 404, error: 'الباص غير موجود' };
  if (!canAccess(user, bus)) return { status: 403, error: 'غير مسموح' };
  const from = isDate(q.from) ? q.from : null, to = isDate(q.to) ? q.to : null;
  const rng = (from ? ' AND x.date>=?' : '') + (to ? ' AND x.date<=?' : '');
  const rargs = [from, to].filter(Boolean);
  const trips = db.prepare(`SELECT x.date, x.trips_count, x.odometer_start, x.odometer_end, x.notes, d.name AS driver_name
      FROM trips x LEFT JOIN drivers d ON d.id=x.driver_id WHERE x.bus_id=?${rng} ORDER BY x.date, x.id`).all(id, ...rargs)
    .map((t) => ({ ...t, km: t.odometer_start != null && t.odometer_end != null ? t.odometer_end - t.odometer_start : null }));
  const logs = db.prepare(`SELECT x.date, x.kind, x.description, x.odometer, x.liters, x.cost, x.next_oil_km
      FROM maintenance x WHERE x.bus_id=?${rng} ORDER BY x.date, x.id`).all(id, ...rargs);
  const fuel = logs.filter((l) => l.kind === 'fuel'), oil = logs.filter((l) => l.kind === 'oil'), maint = logs.filter((l) => l.kind === 'maintenance');
  const sum = (arr, f) => arr.reduce((s, x) => s + (Number(x[f]) || 0), 0);
  const totals = {
    trips: sum(trips, 'trips_count'), km: sum(trips, 'km'), days: new Set(trips.map((t) => t.date)).size,
    fuel_count: fuel.length, fuel_liters: sum(fuel, 'liters'), fuel_cost: sum(fuel, 'cost'),
    oil_count: oil.length, oil_cost: sum(oil, 'cost'), maint_count: maint.length, maint_cost: sum(maint, 'cost'),
  };
  totals.total_cost = totals.fuel_cost + totals.oil_cost + totals.maint_cost;
  const lastOil = db.prepare("SELECT date, odometer, next_oil_km FROM maintenance WHERE bus_id=? AND kind='oil' ORDER BY date DESC, id DESC LIMIT 1").get(id);
  const curKm = currentKm(id);
  const oil_status = lastOil ? {
    last_date: lastOil.date, last_odometer: lastOil.odometer, next_km: lastOil.next_oil_km, current_km: curKm,
    km_left: lastOil.next_oil_km != null ? lastOil.next_oil_km - curKm : null,
  } : null;
  const drivers = db.prepare('SELECT name, phone, national_id FROM drivers WHERE bus_id=? AND active=1 ORDER BY name').all(id);
  return { bus, drivers, today: todayStr(), period: { from, to }, trips, fuel, oil, maintenance: maint, totals, oil_status, officers: getSettings(), signers: signersFor(user, { supervisor_id: bus.supervisor_id }), prepared_by: user.name };
}

/* ---------------------------------------------------------- xlsx (no deps) */
const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
function colName(i) { let s = '', n = i + 1; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
function zipStore(files) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name), raw = Buffer.from(f.data), comp = zlib.deflateRawSync(raw), crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x21, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(0, 12); ch.writeUInt16LE(0x21, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp); centrals.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function makeXlsx(sheetName, headers, rows) {
  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  let sd = '<row r="1">' + headers.map((h, i) => `<c r="${colName(i)}1" t="inlineStr" s="1"><is><t>${xmlEsc(h)}</t></is></c>`).join('') + '</row>';
  rows.forEach((r, ri) => {
    sd += `<row r="${ri + 2}">` + r.map((v, i) => {
      if (v === null || v === undefined || v === '') return '';
      const ref = colName(i) + (ri + 2);
      if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
    }).join('') + '</row>';
  });
  const cols = '<cols>' + headers.map((h, i) => `<col min="${i + 1}" max="${i + 1}" width="${Math.min(40, Math.max(14, String(h).length + 6))}" customWidth="1"/>`).join('') + '</cols>';
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const files = [
    { name: '[Content_Types].xml', data: head + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', data: head + `<workbook xmlns="${NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEsc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: head + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>' },
    { name: 'xl/styles.xml', data: head + `<styleSheet xmlns="${NS}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2B705"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    { name: 'xl/worksheets/sheet1.xml', data: head + `<worksheet xmlns="${NS}"><sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>${cols}<sheetData>${sd}</sheetData></worksheet>` },
  ];
  return zipStore(files);
}
function sendXlsx(res, filename, sheetName, headers, rows) {
  const buf = makeXlsx(sheetName, headers, rows);
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}.xlsx`,
    'Content-Length': buf.length, 'Cache-Control': 'no-store',
  });
  res.end(buf);
}
function entityXlsx(res, entity, rows, title) {
  const cols = ENT[entity].cols.slice();
  const si = cols.findIndex((c) => c[0] === 'supervisor_name');
  if (si >= 0) cols.splice(si, 0, ['branch_name', 'الفرع']);
  sendXlsx(res, `${title}-${todayStr()}`, title, cols.map((c) => c[1]),
    rows.map((r) => cols.map((c) => (c[3] ? c[3](r) : c[2] ? c[2](r[c[0]]) : r[c[0]]))));
}

/* ------------------------------------------------------------------ server */
const sendJson = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
};
const fail = (res, status, msg) => sendJson(res, status, { error: msg });

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('big'), { status: 413 })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('json'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function parseCookies(req) {
  const out = {};
  for (const p of (req.headers.cookie || '').split(';')) { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
  return out;
}
function getUser(req) {
  const t = parseCookies(req).sid;
  if (!t) return null;
  const row = db.prepare(`SELECT u.id,u.name,u.username,u.role,u.active,s.expires FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`).get(t);
  if (!row || row.expires < Date.now() || !row.active) return null;
  return row;
}
const publicUser = (u) => ({ id: u.id, name: u.name, username: u.username, role: u.role });

const loginFails = new Map();
/* خلف وسيط الاستضافة (Render وغيرها) كل المستخدمين يظهرون بنفس العنوان، فنقرأ العنوان الحقيقي من الترويسة */
const TRUST_PROXY = process.env.TRUST_PROXY || process.env.RENDER;
const clientIp = (req) => (TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress;

/* يتعرّف على نوع الملف من محتواه (الترويسة والنهاية) ويرفض الملفات التالفة أو المنتحلة */
function sniffFile(buf) {
  const ascii = (s, e) => buf.subarray(s, e).toString('latin1');
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    const hasFrame = [0xc0, 0xc1, 0xc2].some((m) => buf.includes(Buffer.from([0xff, m])));
    if (!hasFrame || !buf.includes(Buffer.from([0xff, 0xd9]))) return { error: 'ملف JPG تالف أو ناقص' };
    return { mime: 'image/jpeg', ext: '.jpg' };
  }
  if (buf.length >= 33 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (ascii(12, 16) !== 'IHDR' || buf.readUInt32BE(16) === 0 || buf.readUInt32BE(20) === 0 || ascii(buf.length - 8, buf.length - 4) !== 'IEND')
      return { error: 'ملف PNG تالف أو ناقص' };
    return { mime: 'image/png', ext: '.png' };
  }
  if (buf.length >= 20 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    if (buf.readUInt32LE(4) + 8 > buf.length) return { error: 'ملف WEBP تالف أو ناقص' };
    return { mime: 'image/webp', ext: '.webp' };
  }
  if (buf.subarray(0, 1024).includes('%PDF-')) {
    if (!buf.subarray(Math.max(0, buf.length - 2048)).includes('%%EOF')) return { error: 'ملف PDF تالف أو ناقص' };
    return { mime: 'application/pdf', ext: '.pdf' };
  }
  return { error: 'المسموح صور (JPG, PNG, WEBP) أو PDF فقط، ومحتوى الملف ليس من هذه الأنواع' };
}

async function api(req, res, url, p) {
  const m = req.method;
  const q = Object.fromEntries(url.searchParams);
  if (m !== 'GET' && !String(req.headers['content-type'] || '').includes('application/json')) return fail(res, 415, 'نوع الطلب غير مدعوم');
  const body = m === 'GET' ? {} : await readBody(req);

  /* ---- auth ---- */
  if (p === '/api/login' && m === 'POST') {
    const username = String(body.username || '').trim().toLowerCase();
    const key = clientIp(req) + '|' + username;
    const f = loginFails.get(key);
    if (f && f.until > Date.now()) return fail(res, 429, 'محاولات كثيرة. حاول مرة أخرى بعد عدة دقائق.');
    const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username);
    if (!u || !checkPassword(String(body.password || ''), u)) {
      const n = (f ? f.n : 0) + 1;
      loginFails.set(key, { n, until: n >= 5 ? Date.now() + 5 * 60000 : 0 });
      audit(null, 'login_failed', 'users', null, username);
      return fail(res, 401, 'اسم المستخدم أو كلمة السر غير صحيحة');
    }
    loginFails.delete(key);
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES (?,?,?)').run(token, u.id, Date.now() + SESSION_DAYS * 86400000);
    const secure = process.env.SECURE_COOKIES || req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}`);
    audit(u, 'login', 'users', u.id);
    return sendJson(res, 200, { user: publicUser(u) });
  }

  const user = getUser(req);
  if (!user) return fail(res, 401, 'سجّل الدخول أولاً');

  if (p === '/api/logout' && m === 'POST') {
    db.prepare('DELETE FROM sessions WHERE token=?').run(parseCookies(req).sid);
    res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/me' && m === 'GET') return sendJson(res, 200, { user: publicUser(user), today: todayStr() });
  if (p === '/api/me/password' && m === 'POST') {
    const u = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
    if (!checkPassword(String(body.current || ''), u)) return fail(res, 400, 'كلمة السر الحالية غير صحيحة');
    if (String(body.next || '').length < 8) return fail(res, 400, 'كلمة السر الجديدة أقل من 8 أحرف');
    const { salt, hash } = hashPassword(String(body.next));
    db.prepare('UPDATE users SET pass_hash=?, salt=? WHERE id=?').run(hash, salt, user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=? AND token!=?').run(user.id, parseCookies(req).sid);
    audit(user, 'change_password', 'users', user.id);
    return sendJson(res, 200, { ok: true });
  }

  /* ---- users (admin) ---- */
  let mt;
  if (p === '/api/users' && m === 'GET') {
    const sel = `SELECT u.id,u.name,u.username,u.role,u.active,u.created_at,u.branch_id,br.name AS branch_name
      FROM users u LEFT JOIN branches br ON br.id=u.branch_id`;
    if (!isAdmin(user)) {
      const self = db.prepare(`${sel} WHERE u.id=?`).get(user.id);
      return sendJson(res, 200, { users: [{ id: self.id, name: self.name, branch_id: self.branch_id, branch_name: self.branch_name }] });
    }
    return sendJson(res, 200, { users: db.prepare(`${sel} ORDER BY u.role, u.name`).all() });
  }
  if (p === '/api/users' && m === 'POST') {
    if (!isAdmin(user)) return fail(res, 403, 'للمدير فقط');
    const name = String(body.name || '').trim(), username = String(body.username || '').trim().toLowerCase();
    const role = body.role === 'admin' ? 'admin' : 'supervisor';
    if (!name) return fail(res, 400, 'الاسم مطلوب');
    if (!/^[a-z0-9_.-]{3,30}$/.test(username)) return fail(res, 400, 'اسم المستخدم 3 إلى 30 حرفاً إنجليزياً أو أرقاماً (بدون مسافات)');
    if (String(body.password || '').length < 8) return fail(res, 400, 'كلمة السر أقل من 8 أحرف');
    const pb = parseBranchId(body.branch_id);
    if (pb.error) return fail(res, 400, pb.error);
    const { salt, hash } = hashPassword(String(body.password));
    try {
      const r = db.prepare('INSERT INTO users(name,username,pass_hash,salt,role,branch_id) VALUES (?,?,?,?,?,?)').run(name, username, hash, salt, role, pb.id);
      audit(user, 'create', 'users', r.lastInsertRowid, name);
      return sendJson(res, 201, { id: Number(r.lastInsertRowid) });
    } catch (e) { if (/UNIQUE/.test(e.message)) return fail(res, 400, 'اسم المستخدم مستخدم من قبل'); throw e; }
  }
  if ((mt = p.match(/^\/api\/users\/(\d+)$/)) && m === 'PUT') {
    if (!isAdmin(user)) return fail(res, 403, 'للمدير فقط');
    const id = Number(mt[1]);
    const t = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    if (!t) return fail(res, 404, 'المستخدم غير موجود');
    const name = body.name !== undefined ? String(body.name).trim() : t.name;
    const role = body.role !== undefined ? (body.role === 'admin' ? 'admin' : 'supervisor') : t.role;
    const active = body.active !== undefined ? (body.active ? 1 : 0) : t.active;
    if (!name) return fail(res, 400, 'الاسم مطلوب');
    if ((role !== 'admin' || !active) && t.role === 'admin' && t.active) {
      const others = db.prepare("SELECT COUNT(*) c FROM users WHERE role='admin' AND active=1 AND id!=?").get(id).c;
      if (!others) return fail(res, 400, 'لازم يفضل مدير واحد نشط على الأقل');
    }
    let branchId = t.branch_id;
    if ('branch_id' in body) {
      const pb = parseBranchId(body.branch_id);
      if (pb.error) return fail(res, 400, pb.error);
      branchId = pb.id;
    }
    db.prepare('UPDATE users SET name=?, role=?, active=?, branch_id=? WHERE id=?').run(name, role, active, branchId, id);
    if (body.password) {
      if (String(body.password).length < 8) return fail(res, 400, 'كلمة السر أقل من 8 أحرف');
      const { salt, hash } = hashPassword(String(body.password));
      db.prepare('UPDATE users SET pass_hash=?, salt=? WHERE id=?').run(hash, salt, id);
    }
    if (!active || body.password) db.prepare('DELETE FROM sessions WHERE user_id=?').run(id);
    audit(user, 'update', 'users', id, name + (body.password ? ' (كلمة سر جديدة)' : '') + (!active ? ' (موقوف)' : ''));
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/audit' && m === 'GET') {
    if (!isAdmin(user)) return fail(res, 403, 'للمدير فقط');
    return sendJson(res, 200, { rows: db.prepare(`SELECT a.id,a.ts,a.action,a.entity,a.ref_id,a.detail,u.name AS user_name
      FROM audit a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 300`).all() });
  }

  /* ---- branches / settings / backup ---- */
  if (p === '/api/branches' && m === 'GET') {
    const rows = db.prepare(`SELECT br.id, br.name, br.notes, (SELECT COUNT(*) FROM users u WHERE u.branch_id=br.id AND u.active=1) AS supervisors
      FROM branches br ${isAdmin(user) ? '' : 'WHERE br.id=(SELECT branch_id FROM users WHERE id=?)'} ORDER BY br.name`).all(...(isAdmin(user) ? [] : [user.id]));
    return sendJson(res, 200, { rows });
  }
  if (p === '/api/branches' && m === 'POST') {
    if (!isAdmin(user)) return fail(res, 403, 'للمدير فقط');
    const name = String(body.name || '').trim(), notes = String(body.notes || '').trim().slice(0, 500);
    if (!name) return fail(res, 400, 'اسم الفرع مطلوب');
    if (name.length > 80) return fail(res, 400, 'اسم الفرع أطول من المسموح');
    try {
      const r = db.prepare('INSERT INTO branches(name,notes) VALUES (?,?)').run(name, notes || null);
      audit(user, 'create', 'branches', r.lastInsertRowid, name);
      return sendJson(res, 201, { id: Number(r.lastInsertRowid) });
    } catch (e) { return fail(res, 400, dbError(e)); }
  }
  if ((mt = p.match(/^\/api\/branches\/(\d+)$/)) && (m === 'PUT' || m === 'DELETE')) {
    if (!isAdmin(user)) return fail(res, 403, 'للمدير فقط');
    const bid = Number(mt[1]);
    const br = db.prepare('SELECT * FROM branches WHERE id=?').get(bid);
    if (!br) return fail(res, 404, 'الفرع غير موجود');
    if (m === 'PUT') {
      const name = body.name !== undefined ? String(body.name).trim() : br.name;
      const notes = body.notes !== undefined ? String(body.notes).trim().slice(0, 500) : br.notes;
      if (!name) return fail(res, 400, 'اسم الفرع مطلوب');
      if (name.length > 80) return fail(res, 400, 'اسم الفرع أطول من المسموح');
      try { db.prepare('UPDATE branches SET name=?, notes=? WHERE id=?').run(name, notes || null, bid); }
      catch (e) { return fail(res, 400, dbError(e)); }
      audit(user, 'update', 'branches', bid, name);
      return sendJson(res, 200, { ok: true });
    }
    if (db.prepare('SELECT COUNT(*) c FROM users WHERE branch_id=?').get(bid).c)
      return fail(res, 400, 'لا يمكن حذف فرع عليه مشرفون. انقل المشرفين لفرع آخر أولاً.');
    db.prepare('DELETE FROM branches WHERE id=?').run(bid);
    audit(user, 'delete', 'branches', bid, br.name);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/settings' && m === 'GET') return sendJson(res, 200, getSettings());
  if (p === '/api/settings' && m === 'PUT') {
    if (!isAdmin(user)) return fail(res, 403, 'للمدير فقط');
    for (const k of SETTING_KEYS) {
      if (!(k in body)) continue;
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(body[k] ?? '').trim().slice(0, 100));
    }
    audit(user, 'update', 'settings', null, 'أسماء الموقّعين على التقارير');
    return sendJson(res, 200, getSettings());
  }
  if (p === '/api/backup' && m === 'GET') {
    if (!isAdmin(user)) return fail(res, 403, 'للمدير فقط');
    const tmp = path.join(DATA_DIR, `backup-${crypto.randomBytes(6).toString('hex')}.db`);
    try {
      db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      const buf = fs.readFileSync(tmp);
      audit(user, 'backup', null, null, `${buf.length} bytes`);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'no-store',
        'Content-Disposition': `attachment; filename="backup.db"; filename*=UTF-8''${encodeURIComponent('نسخة-المنصة-' + todayStr())}.db`,
      });
      return res.end(buf);
    } finally { fs.rmSync(tmp, { force: true }); }
  }

  /* ---- entities ---- */
  if ((mt = p.match(/^\/api\/(buses|drivers|trips|maintenance)(?:\/(\d+))?$/))) {
    const entity = mt[1], id = mt[2] ? Number(mt[2]) : null;
    if (m === 'GET' && !id) {
      const rows = listEntity(user, entity, q, q.format === 'xlsx');
      if (q.format === 'xlsx') return entityXlsx(res, entity, rows, { buses: 'الباصات', drivers: 'السائقون', trips: 'الحركة', maintenance: 'الصيانة والزيت والوقود' }[entity]);
      return sendJson(res, 200, { rows });
    }
    if (m === 'GET' && id) {
      const row = getOne(entity, id);
      if (!row) return fail(res, 404, 'السجل غير موجود');
      if (!canAccess(user, row)) return fail(res, 403, 'غير مسموح');
      return sendJson(res, 200, { row });
    }
    if (m === 'POST' && !id) {
      const r = entity === 'drivers' ? withNewBus(user, body, (b) => createEntity(user, entity, b)) : createEntity(user, entity, body);
      return r.error ? fail(res, r.status || 400, r.error) : sendJson(res, 201, r);
    }
    if (m === 'PUT' && id) {
      const r = entity === 'drivers' ? withNewBus(user, body, (b) => updateEntity(user, entity, id, b)) : updateEntity(user, entity, id, body);
      return r.error ? fail(res, r.status || 400, r.error) : sendJson(res, 200, r);
    }
    if (m === 'DELETE' && id) {
      if (!isAdmin(user)) return fail(res, 403, 'الحذف للمدير فقط');
      const t = db.prepare(`SELECT * FROM ${ENT[entity].table} WHERE id=?`).get(id);
      if (!t) return fail(res, 404, 'السجل غير موجود');
      /* حذف سجل علّمه المدير «استبدال العداد» قد يكشف تعارضاً بين القراءات قبله وبعده */
      if (t.odometer_reset) {
        const left = busOdoEvents(t.bus_id, { table: ENT[entity].table, id });
        const c = timelineConflict(left);
        if (c) return fail(res, 400, `لا يمكن حذف سجل «استبدال العداد» لأن قراءات الباص ستتعارض: ${c}`);
      }
      /* السجل والمرفقات وسجل العمليات في عملية واحدة، ثم تُحذف الملفات الفعلية بعد نجاحها */
      const files = [];
      db.exec('BEGIN');
      try {
        db.prepare(`DELETE FROM ${ENT[entity].table} WHERE id=?`).run(id);
        if (entity === 'buses' || entity === 'drivers') {
          const kind = entity === 'buses' ? 'bus' : 'driver';
          for (const a of db.prepare('SELECT stored FROM attachments WHERE owner_kind=? AND owner_id=?').all(kind, id)) files.push(a.stored);
          db.prepare('DELETE FROM attachments WHERE owner_kind=? AND owner_id=?').run(kind, id);
        }
        audit(user, 'delete', entity, id, t.plate || t.name || t.date);
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch { /* already closed */ }
        return fail(res, 400, dbError(e));
      }
      for (const f of files) fs.rmSync(path.join(DATA_DIR, 'uploads', path.basename(f)), { force: true });
      return sendJson(res, 200, { ok: true });
    }
  }

  /* ---- attachments ---- */
  if (p === '/api/attachments' && m === 'GET') {
    const kind = q.owner_kind === 'driver' ? 'driver' : 'bus', id = intOrNull(q.owner_id);
    const owner = db.prepare(`SELECT supervisor_id FROM ${kind === 'bus' ? 'buses' : 'drivers'} WHERE id=?`).get(id);
    if (!owner) return fail(res, 404, 'غير موجود');
    if (!canAccess(user, owner)) return fail(res, 403, 'غير مسموح');
    return sendJson(res, 200, { rows: db.prepare('SELECT id,filename,mime,size,created_at FROM attachments WHERE owner_kind=? AND owner_id=? ORDER BY id DESC').all(kind, id) });
  }
  if (p === '/api/attachments' && m === 'POST') {
    const kind = body.owner_kind === 'driver' ? 'driver' : 'bus', id = intOrNull(body.owner_id);
    const owner = db.prepare(`SELECT supervisor_id FROM ${kind === 'bus' ? 'buses' : 'drivers'} WHERE id=?`).get(id);
    if (!owner) return fail(res, 404, 'غير موجود');
    if (!canAccess(user, owner)) return fail(res, 403, 'غير مسموح');
    /* 1) فحص النص المرسل قبل فك ترميزه */
    const b64 = typeof body.data === 'string' ? body.data : '';
    if (!b64) return fail(res, 400, 'الملف فارغ');
    if (b64.length > Math.ceil(MAX_UPLOAD / 3) * 4) return fail(res, 400, 'حجم الملف أكبر من 5 ميجا');
    if (b64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return fail(res, 400, 'الملف غير صالح (ترميز غير سليم)');
    const buf = Buffer.from(b64, 'base64');
    if (!buf.length) return fail(res, 400, 'الملف فارغ');
    if (buf.length > MAX_UPLOAD) return fail(res, 400, 'حجم الملف أكبر من 5 ميجا');
    /* 2) نوع الملف الحقيقي يُحدَّد من محتواه، ولا يُعتمد على ما أرسله المتصفح */
    const kindInfo = sniffFile(buf);
    if (kindInfo.error) return fail(res, 400, kindInfo.error);
    if (body.mime && body.mime !== kindInfo.mime) return fail(res, 400, 'نوع الملف لا يطابق محتواه الحقيقي');
    const name = String(body.filename || 'ملف').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 120);
    /* 3) نكتب الملف ثم السجل في عملية واحدة؛ لو فشل أي جزء نحذف الملف ونلغي السجل فلا يبقى شيء معلّق */
    const stored = crypto.randomBytes(16).toString('hex') + kindInfo.ext;
    const target = path.join(DATA_DIR, 'uploads', stored);
    try {
      fs.writeFileSync(target, buf, { flag: 'wx' });
      db.exec('BEGIN');
      const r = db.prepare('INSERT INTO attachments(owner_kind,owner_id,filename,mime,stored,size,uploaded_by) VALUES (?,?,?,?,?,?,?)').run(kind, id, name, kindInfo.mime, stored, buf.length, user.id);
      audit(user, 'upload', kind === 'bus' ? 'buses' : 'drivers', id, name);
      db.exec('COMMIT');
      return sendJson(res, 201, { id: Number(r.lastInsertRowid) });
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* no open transaction */ }
      fs.rmSync(target, { force: true });
      console.error('upload failed:', e);
      return fail(res, 500, 'تعذّر حفظ الملف ولم يُرفع شيء. حاول مرة أخرى.');
    }
  }
  if ((mt = p.match(/^\/api\/attachments\/(\d+)(\/file)?$/))) {
    const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(Number(mt[1]));
    if (!a) return fail(res, 404, 'غير موجود');
    const owner = db.prepare(`SELECT supervisor_id FROM ${a.owner_kind === 'bus' ? 'buses' : 'drivers'} WHERE id=?`).get(a.owner_id);
    if (!owner || !canAccess(user, owner)) return fail(res, 403, 'غير مسموح');
    if (mt[2] && m === 'GET') {
      const file = path.join(DATA_DIR, 'uploads', path.basename(a.stored));
      if (!fs.existsSync(file)) return fail(res, 404, 'الملف مفقود');
      res.writeHead(200, { 'Content-Type': a.mime, 'Content-Length': a.size, 'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}`, 'Cache-Control': 'private, no-store' });
      return fs.createReadStream(file).pipe(res);
    }
    if (!mt[2] && m === 'DELETE') {
      if (!isAdmin(user) && a.uploaded_by !== user.id) return fail(res, 403, 'غير مسموح');
      /* السجل أولاً ثم الملف: لو فشل الحذف من القاعدة يبقى الملف والسجل معاً، ولو فشل حذف الملف يُنظَّف عند التشغيل القادم */
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
        audit(user, 'delete_file', a.owner_kind === 'bus' ? 'buses' : 'drivers', a.owner_id, a.filename);
        db.exec('COMMIT');
      } catch (e) { try { db.exec('ROLLBACK'); } catch { /* closed */ } throw e; }
      try { fs.rmSync(path.join(DATA_DIR, 'uploads', path.basename(a.stored)), { force: true }); } catch (e) { console.error('file cleanup failed:', e.message); }
      return sendJson(res, 200, { ok: true });
    }
  }

  /* ---- dashboard, alerts, reports ---- */
  if (p === '/api/summary' && m === 'GET') {
    const today = todayStr(), monthStart = today.slice(0, 7) + '-01';
    const sc = isAdmin(user) ? '' : ' AND supervisor_id=?', a = isAdmin(user) ? [] : [user.id];
    const t = db.prepare(`SELECT COALESCE(SUM(trips_count),0) s, COUNT(*) c FROM trips WHERE date=?${sc}`).get(today, ...a);
    const mo = db.prepare(`SELECT COALESCE(SUM(trips_count),0) s FROM trips WHERE date>=? AND date<=?${sc}`).get(monthStart, today, ...a);
    const out = {
      today, trips_today: t.s, entries_today: t.c, trips_month: mo.s,
      buses: db.prepare(`SELECT COUNT(*) c FROM buses WHERE status!='stopped'${sc}`).get(...a).c,
      drivers: db.prepare(`SELECT COUNT(*) c FROM drivers WHERE active=1${sc}`).get(...a).c,
      alerts: getAlerts(user).length,
      supervisors_total: isAdmin(user) ? db.prepare("SELECT COUNT(*) c FROM users WHERE role='supervisor' AND active=1").get().c : undefined,
    };
    if (isAdmin(user)) {
      out.board = db.prepare(`SELECT u.id,u.name, br.name AS branch_name, COUNT(t.id) AS entries, COALESCE(SUM(t.trips_count),0) AS trips, MAX(t.created_at) AS last_at
        FROM users u LEFT JOIN branches br ON br.id=u.branch_id LEFT JOIN trips t ON t.supervisor_id=u.id AND t.date=?
        WHERE u.role='supervisor' AND u.active=1
        GROUP BY u.id ORDER BY br.name, u.name`).all(today);
      out.setup = {
        branches: db.prepare('SELECT COUNT(*) c FROM branches').get().c,
        supervisors: out.supervisors_total,
        buses: db.prepare('SELECT COUNT(*) c FROM buses').get().c,
        drivers: db.prepare('SELECT COUNT(*) c FROM drivers').get().c,
      };
    }
    return sendJson(res, 200, out);
  }
  if (p === '/api/alerts' && m === 'GET') return sendJson(res, 200, { rows: getAlerts(user, intOrNull(q.days) || 30) });
  if ((mt = p.match(/^\/api\/reports\/bus\/(\d+)$/)) && m === 'GET') {
    const r = busReport(user, Number(mt[1]), q);
    return r.error ? fail(res, r.status || 400, r.error) : sendJson(res, 200, r);
  }

  if (p === '/api/reports/traffic' && m === 'GET') {
    const r = trafficReport(user, q);
    if (q.format === 'xlsx') {
      const rows = r.rows.map((x) => [x.k, x.records, x.trips, x.km]);
      rows.push(['الإجمالي', r.totals.records, r.totals.trips, r.totals.km]);
      return sendXlsx(res, 'تقرير-الحركة-' + todayStr(), 'تقرير الحركة', [r.group_label, 'عدد التسجيلات', 'عدد الرحلات', 'المسافة (كم)'], rows);
    }
    return sendJson(res, 200, { ...r, signers: signersFor(user, reportScope(q)) });
  }
  if (p === '/api/reports/maintenance' && m === 'GET') {
    const rows = listEntity(user, 'maintenance', q, true);
    const totals = {
      records: rows.length, cost: rows.reduce((s, r) => s + (r.cost || 0), 0), oil: rows.filter((r) => r.kind === 'oil').length,
      fuel: rows.filter((r) => r.kind === 'fuel').length, liters: rows.reduce((s, r) => s + (r.liters || 0), 0),
    };
    if (q.format === 'xlsx') {
      const cols = ENT.maintenance.cols;
      const data = rows.map((r) => cols.map((c) => (c[2] ? c[2](r[c[0]]) : r[c[0]])));
      const total = cols.map(() => '');
      total[0] = 'الإجمالي';
      total[cols.findIndex((c) => c[0] === 'liters')] = totals.liters;
      total[cols.findIndex((c) => c[0] === 'cost')] = totals.cost;
      data.push(total);
      return sendXlsx(res, 'تقرير-الصيانة-' + todayStr(), 'الصيانة والزيت والوقود', cols.map((c) => c[1]), data);
    }
    return sendJson(res, 200, { rows, totals, signers: signersFor(user, reportScope(q)) });
  }
  if (p === '/api/reports/odometer' && m === 'GET') {
    if (!isAdmin(user)) return fail(res, 403, 'للمدير فقط');
    const rows = [];
    for (const b of db.prepare('SELECT id,plate FROM buses ORDER BY plate').all())
      for (const x of odometerIssues(b.id)) rows.push({ bus_id: b.id, plate: b.plate, ...x });
    if (q.format === 'xlsx')
      return sendXlsx(res, 'فحص-العدادات-' + todayStr(), 'فحص العدادات', ['الباص', 'نوع السجل', 'التاريخ', 'المشكلة', 'القراءة', 'القراءة المقابلة', 'تاريخها'],
        rows.map((r) => [r.plate, r.record, r.date, r.problem, r.reading, r.other_reading, r.other_date]));
    return sendJson(res, 200, { rows });
  }
  if (p === '/api/reports/oil' && m === 'GET') {
    const rows = oilStatus(user);
    if (q.format === 'xlsx') {
      const S = { overdue: 'متأخر', soon: 'قريب', ok: 'سليم', unknown: 'لا توجد بيانات' };
      return sendXlsx(res, 'حالة-الزيت-' + todayStr(), 'حالة الزيت',
        ['الباص', 'المشرف', 'آخر تغيير', 'عداد آخر تغيير', 'الزيت القادم عند', 'العداد الحالي', 'المتبقي (كم)', 'الحالة'],
        rows.map((r) => [r.plate, r.supervisor_name, r.last_oil_date, r.last_oil_odo, r.next_oil_km, r.current_km, r.km_left, S[r.state]]));
    }
    return sendJson(res, 200, { rows, signers: signersFor(user, {}) });
  }

  return fail(res, 404, 'غير موجود');
}

/* ------------------------------------------------------------------ static */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, p) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'غير مسموح');
  let rel = decodeURIComponent(p);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^([/\\])+/, ''));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('الصفحة غير موجودة');
  }
  const ext = path.extname(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await api(req, res, url, url.pathname);
    else serveStatic(req, res, url.pathname);
  } catch (e) {
    if (e.status) return fail(res, e.status, e.status === 413 ? 'الحجم أكبر من المسموح' : 'طلب غير صالح');
    console.error(e);
    if (!res.headersSent) fail(res, 500, 'حصل خطأ في الخادم');
    else res.end();
  }
});
server.listen(PORT, HOST, () => console.log(`المنصة شغالة على http://localhost:${PORT}`));
