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
const KIND = { maintenance: 'صيانة', oil: 'تغيير زيت' };
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
      reg_form_no: { t: 'text', max: 40, label: 'رقم استمارة السيارة' },
      reg_expiry: { t: 'date', label: 'انتهاء الاستمارة' },
      inspection_due: { t: 'date', label: 'موعد الفحص الدوري' },
      status: { t: 'enum', vals: Object.keys(STATUS), def: 'active', label: 'الحالة' },
      notes: { t: 'text', max: 1000, label: 'ملاحظات' },
    },
    cols: [['plate', 'رقم اللوحة'], ['fleet_no', 'رقم الباص'], ['make', 'ماركة الباص'], ['model', 'الموديل'], ['serial_no', 'الرقم التسلسلي'], ['capacity', 'السعة'],
      ['reg_form_no', 'رقم استمارة السيارة'], ['reg_expiry', 'انتهاء الاستمارة'], ['inspection_due', 'موعد الفحص الدوري'],
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
      cost: { t: 'num', label: 'التكلفة' },
      next_oil_km: { t: 'int', label: 'الزيت القادم عند' },
      notes: { t: 'text', max: 1000, label: 'ملاحظات' },
    },
    cols: [['date', 'التاريخ'], ['bus_plate', 'الباص'], ['kind', 'النوع', (v) => KIND[v] || v], ['description', 'الوصف'],
      ['odometer', 'قراءة العداد'], ['cost', 'التكلفة'], ['next_oil_km', 'الزيت القادم عند'], ['supervisor_name', 'المشرف'], ['notes', 'ملاحظات']],
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

const isAdmin = (u) => u.role === 'admin';
const canAccess = (u, row) => isAdmin(u) || row.supervisor_id === u.id;

function dbError(e) {
  const m = String(e.message);
  if (/serial_no/.test(m)) return 'الرقم التسلسلي مسجل من قبل لباص آخر';
  if (/UNIQUE/.test(m)) return 'رقم اللوحة مسجل من قبل';
  if (/FOREIGN KEY/.test(m)) return 'لا يمكن الحذف لأن عليه سجلات مرتبطة. غيّر حالته إلى "متوقف" بدل الحذف.';
  throw e;
}

function validate(cfg, input, existing, user) {
  const out = {};
  const today = todayStr();
  for (const [name, f] of Object.entries(cfg.fields)) {
    let v = name in input ? input[name] : existing ? existing[name] : undefined;
    if (f.t === 'bool') { out[name] = v === undefined || v === null || v === '' ? (f.def ?? 0) : (v === true || v === 1 || v === '1' ? 1 : 0); continue; }
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
  return { values: out };
}

/* ------------------------------------------------------------ list / query */
function listEntity(user, entity, q, forExport) {
  const cfg = ENT[entity];
  const where = [], args = [];
  if (!isAdmin(user)) { where.push('x.supervisor_id=?'); args.push(user.id); }
  else if (intOrNull(q.supervisor_id) !== null) { where.push('x.supervisor_id=?'); args.push(intOrNull(q.supervisor_id)); }
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
      (SELECT next_oil_km FROM maintenance m WHERE m.bus_id=b.id AND m.kind='oil' ORDER BY date DESC, id DESC LIMIT 1) AS next_oil_km,
      MAX(COALESCE((SELECT MAX(odometer_end) FROM trips t WHERE t.bus_id=b.id),0),
          COALESCE((SELECT MAX(odometer) FROM maintenance m WHERE m.bus_id=b.id),0)) AS current_km
    FROM buses b LEFT JOIN users u ON u.id=b.supervisor_id ${scope} ORDER BY b.plate`).all(...args);
  return rows.map((r) => {
    const left = r.next_oil_km != null ? r.next_oil_km - r.current_km : null;
    return { ...r, km_left: left, state: left === null ? 'unknown' : left <= 0 ? 'overdue' : left <= 500 ? 'soon' : 'ok' };
  });
}

function getAlerts(user, days = 30) {
  const today = todayStr(), limit = addDays(today, days), out = [];
  const sc = isAdmin(user) ? '' : ' AND x.supervisor_id=?';
  const a = isAdmin(user) ? [] : [user.id];
  const docs = [
    ['bus', 'buses', 'reg_expiry', 'استمارة السيارة', 'x.plate', "x.status!='stopped'"],
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
};
function trafficReport(user, q) {
  const g = GROUPS[q.by] || GROUPS.day;
  const where = [], args = [];
  if (!isAdmin(user)) { where.push('x.supervisor_id=?'); args.push(user.id); }
  else if (intOrNull(q.supervisor_id) !== null) { where.push('x.supervisor_id=?'); args.push(intOrNull(q.supervisor_id)); }
  if (intOrNull(q.bus_id) !== null) { where.push('x.bus_id=?'); args.push(intOrNull(q.bus_id)); }
  if (isDate(q.from)) { where.push('x.date>=?'); args.push(q.from); }
  if (isDate(q.to)) { where.push('x.date<=?'); args.push(q.to); }
  const rows = db.prepare(`SELECT ${g.sel} AS k, COUNT(*) AS records, COALESCE(SUM(x.trips_count),0) AS trips,
      COALESCE(SUM(CASE WHEN x.odometer_start IS NOT NULL AND x.odometer_end IS NOT NULL THEN x.odometer_end-x.odometer_start ELSE 0 END),0) AS km
    FROM trips x JOIN users u ON u.id=x.supervisor_id JOIN buses b ON b.id=x.bus_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} GROUP BY k ORDER BY k ${g === GROUPS.day || g === GROUPS.month ? 'DESC' : ''}`).all(...args);
  const totals = rows.reduce((t, r) => ({ records: t.records + r.records, trips: t.trips + r.trips, km: t.km + r.km }), { records: 0, trips: 0, km: 0 });
  return { group_label: g.label, rows, totals };
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
  const cols = ENT[entity].cols;
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
const clientIp = (req) => (process.env.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress;

const ALLOWED_MIME = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' };

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
    if (!isAdmin(user)) {
      return sendJson(res, 200, { users: [{ id: user.id, name: user.name }] });
    }
    return sendJson(res, 200, { users: db.prepare('SELECT id,name,username,role,active,created_at FROM users ORDER BY role, name').all() });
  }
  if (p === '/api/users' && m === 'POST') {
    if (!isAdmin(user)) return fail(res, 403, 'للمدير فقط');
    const name = String(body.name || '').trim(), username = String(body.username || '').trim().toLowerCase();
    const role = body.role === 'admin' ? 'admin' : 'supervisor';
    if (!name) return fail(res, 400, 'الاسم مطلوب');
    if (!/^[a-z0-9_.-]{3,30}$/.test(username)) return fail(res, 400, 'اسم المستخدم 3 إلى 30 حرفاً إنجليزياً أو أرقاماً (بدون مسافات)');
    if (String(body.password || '').length < 8) return fail(res, 400, 'كلمة السر أقل من 8 أحرف');
    const { salt, hash } = hashPassword(String(body.password));
    try {
      const r = db.prepare('INSERT INTO users(name,username,pass_hash,salt,role) VALUES (?,?,?,?,?)').run(name, username, hash, salt, role);
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
    db.prepare('UPDATE users SET name=?, role=?, active=? WHERE id=?').run(name, role, active, id);
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

  /* ---- entities ---- */
  if ((mt = p.match(/^\/api\/(buses|drivers|trips|maintenance)(?:\/(\d+))?$/))) {
    const entity = mt[1], id = mt[2] ? Number(mt[2]) : null;
    if (m === 'GET' && !id) {
      const rows = listEntity(user, entity, q, q.format === 'xlsx');
      if (q.format === 'xlsx') return entityXlsx(res, entity, rows, { buses: 'الباصات', drivers: 'السائقون', trips: 'الحركة', maintenance: 'الصيانة والزيت' }[entity]);
      return sendJson(res, 200, { rows });
    }
    if (m === 'GET' && id) {
      const row = getOne(entity, id);
      if (!row) return fail(res, 404, 'السجل غير موجود');
      if (!canAccess(user, row)) return fail(res, 403, 'غير مسموح');
      return sendJson(res, 200, { row });
    }
    if (m === 'POST' && !id) {
      const r = createEntity(user, entity, body);
      return r.error ? fail(res, r.status || 400, r.error) : sendJson(res, 201, r);
    }
    if (m === 'PUT' && id) {
      const r = updateEntity(user, entity, id, body);
      return r.error ? fail(res, r.status || 400, r.error) : sendJson(res, 200, r);
    }
    if (m === 'DELETE' && id) {
      if (!isAdmin(user)) return fail(res, 403, 'الحذف للمدير فقط');
      const t = db.prepare(`SELECT * FROM ${ENT[entity].table} WHERE id=?`).get(id);
      if (!t) return fail(res, 404, 'السجل غير موجود');
      try {
        db.prepare(`DELETE FROM ${ENT[entity].table} WHERE id=?`).run(id);
      } catch (e) { return fail(res, 400, dbError(e)); }
      if (entity === 'buses' || entity === 'drivers') {
        const kind = entity === 'buses' ? 'bus' : 'driver';
        for (const a of db.prepare('SELECT * FROM attachments WHERE owner_kind=? AND owner_id=?').all(kind, id)) fs.rmSync(path.join(DATA_DIR, 'uploads', a.stored), { force: true });
        db.prepare('DELETE FROM attachments WHERE owner_kind=? AND owner_id=?').run(kind, id);
      }
      audit(user, 'delete', entity, id, t.plate || t.name || t.date);
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
    const ext = ALLOWED_MIME[body.mime];
    if (!ext) return fail(res, 400, 'المسموح صور (JPG, PNG, WEBP) أو PDF فقط');
    const buf = Buffer.from(String(body.data || ''), 'base64');
    if (!buf.length) return fail(res, 400, 'الملف فارغ');
    if (buf.length > MAX_UPLOAD) return fail(res, 400, 'حجم الملف أكبر من 5 ميجا');
    const stored = crypto.randomBytes(16).toString('hex') + ext;
    fs.writeFileSync(path.join(DATA_DIR, 'uploads', stored), buf);
    const name = String(body.filename || 'ملف').replace(/[\\/\r\n]/g, '_').slice(0, 120);
    const r = db.prepare('INSERT INTO attachments(owner_kind,owner_id,filename,mime,stored,size,uploaded_by) VALUES (?,?,?,?,?,?,?)').run(kind, id, name, body.mime, stored, buf.length, user.id);
    audit(user, 'upload', kind === 'bus' ? 'buses' : 'drivers', id, name);
    return sendJson(res, 201, { id: Number(r.lastInsertRowid) });
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
      fs.rmSync(path.join(DATA_DIR, 'uploads', path.basename(a.stored)), { force: true });
      db.prepare('DELETE FROM attachments WHERE id=?').run(a.id);
      audit(user, 'delete_file', a.owner_kind === 'bus' ? 'buses' : 'drivers', a.owner_id, a.filename);
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
    };
    if (isAdmin(user)) {
      out.board = db.prepare(`SELECT u.id,u.name, COUNT(t.id) AS entries, COALESCE(SUM(t.trips_count),0) AS trips, MAX(t.created_at) AS last_at
        FROM users u LEFT JOIN trips t ON t.supervisor_id=u.id AND t.date=? WHERE u.role='supervisor' AND u.active=1
        GROUP BY u.id ORDER BY u.name`).all(today);
    }
    return sendJson(res, 200, out);
  }
  if (p === '/api/alerts' && m === 'GET') return sendJson(res, 200, { rows: getAlerts(user, intOrNull(q.days) || 30) });

  if (p === '/api/reports/traffic' && m === 'GET') {
    const r = trafficReport(user, q);
    if (q.format === 'xlsx') {
      const rows = r.rows.map((x) => [x.k, x.records, x.trips, x.km]);
      rows.push(['الإجمالي', r.totals.records, r.totals.trips, r.totals.km]);
      return sendXlsx(res, 'تقرير-الحركة-' + todayStr(), 'تقرير الحركة', [r.group_label, 'عدد التسجيلات', 'عدد الرحلات', 'المسافة (كم)'], rows);
    }
    return sendJson(res, 200, r);
  }
  if (p === '/api/reports/maintenance' && m === 'GET') {
    const rows = listEntity(user, 'maintenance', q, true);
    const totals = { records: rows.length, cost: rows.reduce((s, r) => s + (r.cost || 0), 0), oil: rows.filter((r) => r.kind === 'oil').length };
    if (q.format === 'xlsx') {
      const cols = ENT.maintenance.cols;
      const data = rows.map((r) => cols.map((c) => (c[2] ? c[2](r[c[0]]) : r[c[0]])));
      data.push(['الإجمالي', '', '', '', '', totals.cost, '', '', '']);
      return sendXlsx(res, 'تقرير-الصيانة-' + todayStr(), 'الصيانة والزيت', cols.map((c) => c[1]), data);
    }
    return sendJson(res, 200, { rows, totals });
  }
  if (p === '/api/reports/oil' && m === 'GET') {
    const rows = oilStatus(user);
    if (q.format === 'xlsx') {
      const S = { overdue: 'متأخر', soon: 'قريب', ok: 'سليم', unknown: 'لا توجد بيانات' };
      return sendXlsx(res, 'حالة-الزيت-' + todayStr(), 'حالة الزيت',
        ['الباص', 'المشرف', 'آخر تغيير', 'عداد آخر تغيير', 'الزيت القادم عند', 'العداد الحالي', 'المتبقي (كم)', 'الحالة'],
        rows.map((r) => [r.plate, r.supervisor_name, r.last_oil_date, r.last_oil_odo, r.next_oil_km, r.current_km, r.km_left, S[r.state]]));
    }
    return sendJson(res, 200, { rows });
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
