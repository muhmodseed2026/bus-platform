'use strict';
/* منصة مشرفي حركة الباصات: الواجهة. كل النصوص تُدرج بـ textContent لمنع حقن الأكواد. */

const $ = (s, el = document) => el.querySelector(s);
let me = null;
let alertCount = 0;

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v !== null && v !== undefined)).toString();
const fmt = (n) => (n === null || n === undefined || n === '' ? '—' : Number(n).toLocaleString('en'));
const num = (n) => h('span', { class: 'num' }, fmt(n));
const dt = (d) => h('span', { class: 'num' }, d || '—');

async function api(method, url, body) {
  const opt = { method, credentials: 'same-origin' };
  if (method !== 'GET') { opt.headers = { 'Content-Type': 'application/json' }; opt.body = JSON.stringify(body || {}); }
  const r = await fetch(url, opt);
  let data = {};
  try { data = await r.json(); } catch { /* not json */ }
  if (r.status === 401 && !url.endsWith('/login')) { showLogin(); throw new Error('انتهت الجلسة. سجّل الدخول مرة أخرى.'); }
  if (!r.ok) throw new Error(data.error || 'حصل خطأ غير متوقع');
  return data;
}

let toastTimer;
function toast(msg, isError) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), isError ? 5000 : 2500);
}
const isAdmin = () => me && me.role === 'admin';
const daysLeft = (d) => Math.round((Date.parse(d) - Date.parse(me.today)) / 864e5);
const monthStart = () => me.today.slice(0, 8) + '01';

/* ------------------------------------------------------------- login/logout */
function showLogin() {
  me = null;
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#loginForm').password.value = '';
  $('#loginForm').username.focus();
}
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target, err = $('#loginError');
  err.textContent = '';
  try {
    await api('POST', '/api/login', { username: f.username.value, password: f.password.value });
    await boot();
  } catch (ex) { err.textContent = ex.message; }
});
$('#btnLogout').addEventListener('click', async () => { try { await api('POST', '/api/logout'); } catch { /* ignore */ } showLogin(); });
$('#btnPassword').addEventListener('click', () => openForm({
  title: 'تغيير كلمة السر',
  fields: [
    { name: 'current', label: 'كلمة السر الحالية', type: 'password', required: true, wide: true },
    { name: 'next', label: 'كلمة السر الجديدة', type: 'password', required: true, wide: true, hint: '8 أحرف على الأقل' },
  ],
  onSubmit: async (v) => { await api('POST', '/api/me/password', v); toast('تم تغيير كلمة السر'); },
}));

/* ---------------------------------------------------------------- dialogs */
function openForm({ title, fields, values = {}, submitLabel = 'حفظ', onSubmit }) {
  const dlg = h('dialog', { class: 'modal' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const inputs = {}, labels = {}, infos = {};
  const grid = h('div', { class: 'fgrid' });
  for (const f of fields) {
    let input;
    const id = 'f_' + f.name;
    if (f.type === 'select') {
      input = h('select', { id }, (f.options || []).map((o) => h('option', { value: o.value }, o.label)));
      input.value = values[f.name] === null || values[f.name] === undefined ? (f.options[0] ? f.options[0].value : '') : String(values[f.name]);
    } else if (f.type === 'textarea') {
      input = h('textarea', { id, rows: 3 });
      input.value = values[f.name] ?? '';
    } else {
      input = h('input', { id, type: f.type || 'text', inputmode: f.type === 'number' ? 'numeric' : null, autocomplete: f.type === 'password' ? 'new-password' : 'off' });
      input.value = values[f.name] ?? '';
      if (f.dir) input.setAttribute('dir', f.dir);
    }
    if (f.required) input.required = true;
    if (f.readonly) input.disabled = true;
    inputs[f.name] = input;
    if (f.info) infos[f.name] = h('small', { class: 'info', 'aria-live': 'polite' });
    labels[f.name] = h('label', { class: 'field' + (f.wide ? ' wide' : ''), for: id }, h('span', {}, f.label + (f.required ? ' *' : '')), input, f.hint ? h('small', {}, f.hint) : null, infos[f.name]);
    grid.append(labels[f.name]);
  }
  const refresh = () => {
    for (const f of fields) {
      if (f.showIf) labels[f.name].hidden = !f.showIf((k) => inputs[k].value);
      if (f.info) infos[f.name].textContent = f.info((k) => inputs[k].value);
    }
  };
  grid.addEventListener('change', refresh);
  refresh();
  const submit = h('button', { class: 'btn primary', type: 'submit' }, submitLabel);
  const form = h('form', { method: 'dialog' },
    h('header', {}, h('h2', {}, title)), grid, err,
    h('footer', {}, submit, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'إلغاء')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const out = {};
    for (const f of fields) if (!f.readonly && !(f.showIf && labels[f.name].hidden)) out[f.name] = inputs[f.name].value;
    submit.disabled = true;
    try { await onSubmit(out); dlg.close(); }
    catch (ex) { err.textContent = ex.message; }
    finally { submit.disabled = false; }
  });
  dlg.append(form);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  const first = grid.querySelector('input:not([disabled]),select,textarea');
  if (first) first.focus();
}

/* -------------------------------------------------------------- table bits */
function table(cols, rows, emptyText, foot) {
  if (!rows.length) return h('div', { class: 'tablewrap' }, h('p', { class: 'empty' }, emptyText || 'لا توجد بيانات.'));
  return h('div', { class: 'tablewrap' }, h('table', {},
    h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, cols.map((c) => h('td', { class: c.cls || '' }, c.render ? c.render(r) : (r[c.key] ?? '—')))))),
    foot ? h('tfoot', {}, foot) : null));
}
function expiry(date) {
  if (!date) return h('span', { class: 'muted' }, '—');
  const d = daysLeft(date);
  if (d < 0) return h('span', {}, h('span', { class: 'num' }, date), ' ', h('span', { class: 'badge overdue' }, 'منتهية'));
  if (d <= 7) return h('span', {}, h('span', { class: 'num' }, date), ' ', h('span', { class: 'badge urgent' }, `بعد ${d} يوم`));
  if (d <= 30) return h('span', {}, h('span', { class: 'num' }, date), ' ', h('span', { class: 'badge soon' }, `بعد ${d} يوم`));
  return h('span', { class: 'num' }, date);
}
const STATUS = { active: 'يعمل', maintenance: 'في الصيانة', stopped: 'متوقف' };
const KIND = { maintenance: 'صيانة', oil: 'تغيير زيت' };
const opts = (obj) => Object.entries(obj).map(([value, label]) => ({ value, label }));
function field(label, ...ctrl) { return h('label', { class: 'field' }, h('span', {}, label), ...ctrl); }
function selectEl(name, options, value = '') {
  const s = h('select', { name }, options.map((o) => h('option', { value: o.value }, o.label)));
  s.value = value;
  return s;
}
function pageHead(title, sub, ...actions) {
  return h('div', { class: 'pagehead' }, h('div', {}, h('h1', {}, title), sub ? h('p', { class: 'muted', style: 'margin:.2rem 0 0' }, sub) : null), h('div', { class: 'actions' }, actions));
}

/* ---------------------------------------------------------------- lookups */
async function lookups() {
  const [b, d, u] = await Promise.all([api('GET', '/api/buses'), api('GET', '/api/drivers'), api('GET', '/api/users')]);
  return {
    buses: b.rows, drivers: d.rows,
    supervisors: u.users.filter((x) => x.active !== 0 && x.role !== 'admin' || x.id === me.id),
  };
}
const busDesc = (x) => [x.make, x.model].filter(Boolean).join(' ');
const busOpts = (L, blank) => [...(blank ? [{ value: '', label: blank }] : []), ...L.buses.map((x) => ({
  value: x.id, label: x.plate + (busDesc(x) ? ` (${busDesc(x)})` : '') + (isAdmin() ? ` — ${x.supervisor_name}` : ''),
}))];
const driverOpts = (L, blank) => [...(blank ? [{ value: '', label: blank }] : []), ...L.drivers.filter((x) => x.active).map((x) => ({ value: x.id, label: x.name }))];
const supOpts = (L, blank) => [...(blank ? [{ value: '', label: blank }] : []), ...L.supervisors.map((x) => ({ value: x.id, label: x.name }))];

/* ---------------------------------------------------------- attachments UI */
async function openFiles(kind, id, title) {
  const dlg = h('dialog', { class: 'modal' });
  const list = h('ul', { class: 'filelist' });
  const err = h('p', { class: 'form-error', role: 'alert' });
  const picker = h('input', { type: 'file', accept: 'image/jpeg,image/png,image/webp,application/pdf', id: 'filepick' });
  async function load() {
    const { rows } = await api('GET', `/api/attachments?${qs({ owner_kind: kind, owner_id: id })}`);
    list.replaceChildren(...(rows.length ? rows.map((f) => h('li', {},
      h('a', { href: `/api/attachments/${f.id}/file`, target: '_blank', rel: 'noopener' }, f.filename),
      h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
        if (!confirm('حذف هذا الملف؟')) return;
        try { await api('DELETE', `/api/attachments/${f.id}`); await load(); } catch (ex) { err.textContent = ex.message; }
      } }, 'حذف'))) : [h('li', { class: 'muted' }, 'لا توجد ملفات مرفوعة بعد. ارفع صورة الاستمارة أو ملف PDF.')]));
  }
  picker.addEventListener('change', async () => {
    const file = picker.files[0];
    if (!file) return;
    err.textContent = '';
    if (file.size > 5 * 1024 * 1024) { err.textContent = 'حجم الملف أكبر من 5 ميجا'; picker.value = ''; return; }
    const data = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(file); });
    try { await api('POST', '/api/attachments', { owner_kind: kind, owner_id: id, filename: file.name, mime: file.type, data }); toast('تم رفع الملف'); await load(); }
    catch (ex) { err.textContent = ex.message; }
    picker.value = '';
  });
  dlg.append(h('div', { class: 'modal-body' },
    h('header', {}, h('h2', {}, title)),
    field('رفع ملف جديد', picker, h('small', {}, 'صورة (JPG أو PNG) أو PDF، حتى 5 ميجا')),
    err, list,
    h('footer', {}, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'إغلاق'))));
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  await load();
}

/* ----------------------------------------------------------- generic CRUD */
function crudPage(cfg) {
  return async function render(view) {
    const L = await lookups();
    const state = cfg.defaults ? cfg.defaults() : {};
    const out = h('div', {});
    const filterBox = h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); load(); } });
    const result = h('div', {});
    const fdefs = cfg.filters(L);
    const ctrls = {};
    for (const f of fdefs) {
      const el = f.type === 'select' ? selectEl(f.name, f.options, state[f.name] || '') : h('input', { name: f.name, type: f.type || 'text', value: state[f.name] || '', placeholder: f.placeholder || null });
      ctrls[f.name] = el;
      filterBox.append(field(f.label, el));
    }
    filterBox.append(h('button', { class: 'btn', type: 'submit' }, 'عرض'));
    const params = () => Object.fromEntries(fdefs.map((f) => [f.name, ctrls[f.name].value]));

    async function openEdit(row) {
      const L2 = await lookups();
      openForm({
        title: row ? `تعديل ${cfg.noun}` : cfg.addLabel,
        fields: cfg.fields(L2, row),
        values: row || cfg.newValues?.() || {},
        onSubmit: async (v) => {
          if (row) await api('PUT', `/api/${cfg.entity}/${row.id}`, v);
          else await api('POST', `/api/${cfg.entity}`, v);
          toast('تم الحفظ');
          await refreshAlerts();
          load();
        },
      });
    }
    async function load() {
      result.replaceChildren(h('p', { class: 'muted' }, 'جارٍ التحميل…'));
      try {
        const { rows } = await api('GET', `/api/${cfg.entity}?${qs(params())}`);
        const cols = cfg.columns(rows).concat([{ label: '', cls: 'acts', render: (r) => [
          h('button', { class: 'btn small', type: 'button', onclick: () => openEdit(r) }, 'تعديل'),
          cfg.files ? h('button', { class: 'btn small', type: 'button', onclick: () => openFiles(cfg.files, r.id, `مرفقات: ${r.plate || r.name}`) }, 'المرفقات') : null,
          isAdmin() ? h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
            if (!confirm(`حذف هذا ${cfg.noun} نهائياً؟`)) return;
            try { await api('DELETE', `/api/${cfg.entity}/${r.id}`); toast('تم الحذف'); load(); } catch (ex) { toast(ex.message, true); }
          } }, 'حذف') : null,
        ] }]);
        result.replaceChildren(...[table(cols, rows, cfg.empty), rows.length >= 500 ? h('p', { class: 'muted' }, 'تم عرض أحدث 500 سجل. ضيّق الفترة أو صدّر إلى Excel لرؤية الباقي.') : null].filter(Boolean));
      } catch (ex) { result.replaceChildren(h('p', { class: 'form-error' }, ex.message)); }
    }
    out.append(
      pageHead(cfg.title, cfg.sub,
        h('a', { class: 'btn noprint', href: '#', onclick: (e) => { e.preventDefault(); location.href = `/api/${cfg.entity}?${qs({ ...params(), format: 'xlsx' })}`; } }, 'تصدير Excel'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => openEdit(null) }, cfg.addLabel)),
      ...(fdefs.length ? [filterBox] : []), result);
    view.replaceChildren(out);
    load();
  };
}

const PAGES = {};

PAGES.trips = crudPage({
  entity: 'trips', title: 'حركة الباصات', sub: 'سجّل عدد الرحلات وقراءات العداد لكل باص.', noun: 'التسجيل', addLabel: 'تسجيل حركة',
  defaults: () => ({ from: monthStart() }),
  filters: (L) => [
    { name: 'from', label: 'من', type: 'date' }, { name: 'to', label: 'إلى', type: 'date' },
    { name: 'bus_id', label: 'الباص', type: 'select', options: busOpts(L, 'كل الباصات') },
    ...(isAdmin() ? [{ name: 'supervisor_id', label: 'المشرف', type: 'select', options: supOpts(L, 'كل المشرفين') }] : []),
  ],
  columns: () => [
    { label: 'التاريخ', render: (r) => dt(r.date) }, { label: 'الباص', key: 'bus_plate' }, { label: 'السائق', key: 'driver_name' },
    { label: 'الرحلات', render: (r) => num(r.trips_count) },
    { label: 'العداد', render: (r) => (r.odometer_start != null || r.odometer_end != null ? h('span', {}, num(r.odometer_start), ' ← ', num(r.odometer_end)) : '—') },
    { label: 'المسافة (كم)', render: (r) => num(r.odometer_start != null && r.odometer_end != null ? r.odometer_end - r.odometer_start : null) },
    ...(isAdmin() ? [{ label: 'المشرف', key: 'supervisor_name' }] : []),
    { label: 'ملاحظات', key: 'notes', cls: 'sub' },
  ],
  newValues: () => ({ date: me.today }),
  fields: (L, row) => [
    { name: 'date', label: 'التاريخ', type: 'date', required: true },
    { name: 'bus_id', label: 'الباص', type: 'select', required: true, options: busOpts(L) },
    { name: 'driver_id', label: 'السائق', type: 'select', options: driverOpts(L, '— بدون —') },
    { name: 'trips_count', label: 'عدد الرحلات', type: 'number', required: true },
    { name: 'odometer_start', label: 'عداد البداية', type: 'number' },
    { name: 'odometer_end', label: 'عداد النهاية', type: 'number' },
    ...(isAdmin() ? [{ name: 'supervisor_id', label: 'مسجّل باسم المشرف', type: 'select', options: supOpts(L), wide: true }] : []),
    { name: 'notes', label: 'ملاحظات', type: 'textarea', wide: true },
  ],
  empty: 'لا توجد حركة مسجّلة في هذه الفترة. اضغط «تسجيل حركة» لإضافة أول تسجيل.',
});

PAGES.maintenance = crudPage({
  entity: 'maintenance', title: 'الصيانة والزيت', sub: 'سجّل كل صيانة أو تغيير زيت مع قراءة العداد وموعد الزيت القادم.', noun: 'السجل', addLabel: 'تسجيل صيانة / زيت',
  defaults: () => ({}),
  filters: (L) => [
    { name: 'from', label: 'من', type: 'date' }, { name: 'to', label: 'إلى', type: 'date' },
    { name: 'bus_id', label: 'الباص', type: 'select', options: busOpts(L, 'كل الباصات') },
    { name: 'kind', label: 'النوع', type: 'select', options: [{ value: '', label: 'الكل' }, ...opts(KIND)] },
    ...(isAdmin() ? [{ name: 'supervisor_id', label: 'المشرف', type: 'select', options: supOpts(L, 'كل المشرفين') }] : []),
  ],
  columns: () => [
    { label: 'التاريخ', render: (r) => dt(r.date) }, { label: 'الباص', key: 'bus_plate' },
    { label: 'النوع', render: (r) => KIND[r.kind] }, { label: 'الوصف', key: 'description' },
    { label: 'العداد', render: (r) => num(r.odometer) }, { label: 'التكلفة', render: (r) => num(r.cost) },
    { label: 'الزيت القادم عند', render: (r) => num(r.next_oil_km) },
    ...(isAdmin() ? [{ label: 'المشرف', key: 'supervisor_name' }] : []),
  ],
  newValues: () => ({ date: me.today, kind: 'oil' }),
  fields: (L) => [
    { name: 'date', label: 'التاريخ', type: 'date', required: true },
    { name: 'bus_id', label: 'الباص', type: 'select', required: true, options: busOpts(L) },
    { name: 'kind', label: 'النوع', type: 'select', required: true, options: [{ value: 'oil', label: KIND.oil }, { value: 'maintenance', label: KIND.maintenance }] },
    { name: 'odometer', label: 'قراءة العداد الآن', type: 'number' },
    { name: 'next_oil_km', label: 'تغيير الزيت القادم عند (كم)', type: 'number', showIf: (g) => g('kind') === 'oil', hint: 'مثال: لو العداد 120000 والزيت كل 10000 اكتب 130000' },
    { name: 'cost', label: 'التكلفة', type: 'number' },
    ...(isAdmin() ? [{ name: 'supervisor_id', label: 'مسجّل باسم المشرف', type: 'select', options: supOpts(L), wide: true }] : []),
    { name: 'description', label: 'الوصف', type: 'textarea', wide: true },
  ],
  empty: 'لا توجد سجلات صيانة أو زيت. اضغط «تسجيل صيانة / زيت» لإضافة أول سجل.',
});

PAGES.drivers = crudPage({
  entity: 'drivers', title: 'السائقون', sub: 'بيانات السائق والباص المفوض عليه والرخصة واستمارة السائق.', noun: 'السائق', addLabel: 'إضافة سائق', files: 'driver',
  filters: () => [{ name: 'q', label: 'بحث', placeholder: 'الاسم أو الهوية أو الجوال أو لوحة الباص' }],
  columns: () => [
    { label: 'الاسم', key: 'name' },
    { label: 'رقم الهوية', render: (r) => dt(r.national_id) },
    { label: 'رقم الجوال', render: (r) => dt(r.phone) },
    { label: 'الباص المفوض عليه', render: (r) => (r.bus_plate ? h('div', {},
      h('strong', {}, r.bus_plate),
      busDesc({ make: r.bus_make, model: r.bus_model }) ? h('div', {}, busDesc({ make: r.bus_make, model: r.bus_model })) : null,
      r.bus_serial ? h('div', { class: 'subline' }, 'الرقم التسلسلي: ', h('span', { class: 'num' }, r.bus_serial)) : null) : h('span', { class: 'muted' }, 'غير محدد')) },
    { label: 'الرخصة', render: (r) => h('div', {}, r.license_no ? h('div', { class: 'num' }, r.license_no) : null, expiry(r.license_expiry)) },
    { label: 'استمارة السائق', render: (r) => h('div', {}, r.form_no ? h('div', { class: 'num' }, r.form_no) : null, expiry(r.form_expiry)) },
    { label: 'الحالة', render: (r) => h('span', { class: 'badge ' + (r.active ? 'ok' : 'none') }, r.active ? 'على رأس العمل' : 'موقوف') },
    ...(isAdmin() ? [{ label: 'المشرف', key: 'supervisor_name' }] : []),
  ],
  newValues: () => ({ active: 1 }),
  fields: (L) => [
    { name: 'name', label: 'اسم السائق', required: true, wide: true },
    { name: 'national_id', label: 'رقم الهوية', dir: 'ltr', required: true, hint: 'أرقام فقط' },
    { name: 'phone', label: 'رقم الجوال', dir: 'ltr', required: true, hint: 'مثال: 0501234567' },
    { name: 'bus_id', label: 'الباص المفوض عليه (رقم اللوحة)', type: 'select', options: busOpts(L, '— غير محدد —'), wide: true,
      info: (g) => { const b = L.buses.find((x) => String(x.id) === String(g('bus_id'))); return b ? `الماركة: ${b.make || '—'}   |   الموديل: ${b.model || '—'}   |   الرقم التسلسلي: ${b.serial_no || '—'}` : ''; } },
    { name: 'license_no', label: 'رقم الرخصة', dir: 'ltr' }, { name: 'license_expiry', label: 'انتهاء الرخصة', type: 'date' },
    { name: 'form_no', label: 'رقم استمارة السائق', dir: 'ltr' }, { name: 'form_expiry', label: 'انتهاء استمارة السائق', type: 'date' },
    { name: 'active', label: 'الحالة', type: 'select', options: [{ value: '1', label: 'على رأس العمل' }, { value: '0', label: 'موقوف' }] },
    ...(isAdmin() ? [{ name: 'supervisor_id', label: 'المشرف المسؤول', type: 'select', options: supOpts(L), wide: true }] : []),
    { name: 'notes', label: 'ملاحظات', type: 'textarea', wide: true },
  ],
  empty: 'لا يوجد سائقون مسجّلون. اضغط «إضافة سائق» لتسجيل أول سائق.',
});

PAGES.buses = crudPage({
  entity: 'buses', title: 'الباصات', sub: 'بيانات كل باص واستمارة السيارة وموعد الفحص الدوري.', noun: 'الباص', addLabel: 'إضافة باص', files: 'bus',
  filters: () => [
    { name: 'q', label: 'بحث', placeholder: 'اللوحة أو الماركة أو الرقم التسلسلي' },
    { name: 'status', label: 'الحالة', type: 'select', options: [{ value: '', label: 'الكل' }, ...opts(STATUS)] },
  ],
  columns: () => [
    { label: 'اللوحة', key: 'plate' }, { label: 'رقم الباص', key: 'fleet_no' }, { label: 'الماركة', key: 'make' }, { label: 'الموديل', key: 'model' },
    { label: 'الرقم التسلسلي', render: (r) => dt(r.serial_no) },
    { label: 'السعة', render: (r) => num(r.capacity) },
    { label: 'استمارة السيارة', render: (r) => h('div', {}, r.reg_form_no ? h('div', { class: 'num' }, r.reg_form_no) : null, expiry(r.reg_expiry)) },
    { label: 'الفحص الدوري', render: (r) => expiry(r.inspection_due) },
    { label: 'الحالة', render: (r) => h('span', { class: 'badge ' + (r.status === 'active' ? 'ok' : r.status === 'maintenance' ? 'soon' : 'none') }, STATUS[r.status]) },
    ...(isAdmin() ? [{ label: 'المشرف', key: 'supervisor_name' }] : []),
  ],
  newValues: () => ({ status: 'active' }),
  fields: (L) => [
    { name: 'plate', label: 'رقم اللوحة', required: true }, { name: 'fleet_no', label: 'رقم الباص' },
    { name: 'make', label: 'ماركة الباص', hint: 'مثال: تويوتا' }, { name: 'model', label: 'الموديل', hint: 'مثال: كوستر 2022' },
    { name: 'serial_no', label: 'الرقم التسلسلي', dir: 'ltr' }, { name: 'capacity', label: 'السعة (راكب)', type: 'number' },
    { name: 'reg_form_no', label: 'رقم استمارة السيارة', dir: 'ltr' }, { name: 'reg_expiry', label: 'انتهاء الاستمارة', type: 'date' },
    { name: 'inspection_due', label: 'موعد الفحص الدوري القادم', type: 'date' },
    { name: 'status', label: 'الحالة', type: 'select', options: opts(STATUS) },
    ...(isAdmin() ? [{ name: 'supervisor_id', label: 'المشرف المسؤول', type: 'select', options: supOpts(L), wide: true }] : []),
    { name: 'notes', label: 'ملاحظات', type: 'textarea', wide: true },
  ],
  empty: 'لا توجد باصات مسجّلة. اضغط «إضافة باص» لتسجيل أول باص، وبعدها تقدر تسجّل حركته.',
});

/* --------------------------------------------------------------- dashboard */
function odometer(n) {
  const digits = String(n).padStart(4, '0').split('');
  const box = h('div', { class: 'odo', role: 'img', 'aria-label': String(n) }, digits.map((d) => h('span', { 'aria-hidden': 'true' }, '0')));
  const finalDigits = digits;
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const set = (v) => { const s = String(Math.round(v)).padStart(finalDigits.length, '0'); [...box.children].forEach((c, i) => (c.textContent = s[i] || '0')); };
  if (reduce || n === 0) set(n);
  else { const t0 = performance.now(); const step = (t) => { const k = Math.min(1, (t - t0) / 800); set(n * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); }; requestAnimationFrame(step); }
  return box;
}
const ALERT_TXT = (a) => (a.type === 'oil'
  ? (a.km_left <= 0 ? `متأخر ${fmt(Math.abs(a.km_left))} كم` : `باقي ${fmt(a.km_left)} كم`)
  : (a.days_left < 0 ? `منتهية منذ ${fmt(-a.days_left)} يوم` : a.days_left === 0 ? 'تنتهي اليوم' : `تنتهي بعد ${fmt(a.days_left)} يوم`));
const SEV = { overdue: ['overdue', 'عاجل'], urgent: ['urgent', 'قريب جداً'], soon: ['soon', 'قريب'] };

async function refreshAlerts() {
  try { alertCount = (await api('GET', '/api/summary')).alerts; } catch { return; }
  const c = $('#nav .count');
  if (c) { c.textContent = fmt(alertCount); c.hidden = !alertCount; }
}

PAGES.dashboard = async function (view) {
  const [s, al] = await Promise.all([api('GET', '/api/summary'), api('GET', '/api/alerts')]);
  alertCount = s.alerts;
  const alertTable = table([
    { label: 'التنبيه', render: (a) => `${a.label}: ${a.subject}` },
    { label: 'الموعد', render: (a) => h('span', { class: 'badge ' + SEV[a.severity][0] }, ALERT_TXT(a)) },
  ], al.rows.slice(0, 6), 'لا توجد تنبيهات. كل الأوراق سارية.');
  const board = isAdmin() ? table([
    { label: 'المشرف', key: 'name' },
    { label: 'اليوم', render: (r) => h('span', { class: 'badge ' + (r.entries ? 'ok' : 'soon') }, r.entries ? 'سجّل' : 'لم يسجّل بعد') },
    { label: 'الرحلات', render: (r) => num(r.trips) },
    { label: 'آخر تسجيل', render: (r) => (r.last_at ? h('span', { class: 'num' }, new Date(r.last_at.replace(' ', 'T') + 'Z').toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })) : '—') },
  ], s.board, 'لم تُضف حسابات مشرفين بعد. أضفهم من صفحة «المشرفون».') : null;

  view.replaceChildren(
    pageHead('لوحة اليوم', s.today, h('button', { class: 'btn primary', type: 'button', onclick: () => { location.hash = '#/trips'; } }, 'تسجيل حركة')),
    h('div', { class: 'hero' },
      h('div', { class: 'counter' },
        h('div', { class: 'label' }, isAdmin() ? 'رحلات اليوم لكل المشرفين' : 'رحلاتك اليوم'),
        odometer(s.trips_today),
        h('div', { class: 'foot' }, s.entries_today ? `من ${fmt(s.entries_today)} تسجيل` : 'لم يُسجَّل شيء اليوم بعد')),
      h('div', { class: 'facts' },
        h('div', { class: 'fact' }, h('b', {}, fmt(s.trips_month)), h('span', {}, 'رحلات هذا الشهر')),
        h('div', { class: 'fact' }, h('b', {}, fmt(s.buses)), h('span', {}, 'باصات تعمل')),
        h('div', { class: 'fact' }, h('b', {}, fmt(s.drivers)), h('span', {}, 'سائقون على رأس العمل')),
        h('a', { class: 'fact' + (s.alerts ? ' hot' : ''), href: '#/alerts' }, h('b', {}, fmt(s.alerts)), h('span', {}, 'تنبيهات تحتاج متابعة')))),
    h('div', { class: 'cols' },
      h('section', {}, h('h2', { class: 'section-title' }, 'أقرب التنبيهات', h('a', { href: '#/alerts' }, 'عرض الكل')), alertTable),
      board ? h('section', {}, h('h2', { class: 'section-title' }, 'تسجيل المشرفين اليوم'), board) : null));
};

/* ------------------------------------------------------------------ alerts */
PAGES.alerts = async function (view) {
  const { rows } = await api('GET', '/api/alerts');
  view.replaceChildren(
    pageHead('التنبيهات', 'أوراق منتهية أو تنتهي خلال 30 يوماً، وباصات اقترب موعد زيتها.'),
    table([
      { label: 'الأولوية', render: (a) => h('span', { class: 'badge ' + SEV[a.severity][0] }, SEV[a.severity][1]) },
      { label: 'البند', key: 'label' }, { label: 'الباص / السائق', key: 'subject' },
      { label: 'الموعد', render: (a) => (a.type === 'oil' ? h('span', {}, ALERT_TXT(a)) : h('span', {}, h('span', { class: 'num' }, a.due), ' — ', ALERT_TXT(a))) },
      ...(isAdmin() ? [{ label: 'المشرف', key: 'supervisor_name' }] : []),
      { label: '', cls: 'acts', render: (a) => h('a', { class: 'btn small', href: a.owner === 'bus' ? '#/buses' : '#/drivers' }, a.owner === 'bus' ? 'فتح الباصات' : 'فتح السائقين') },
    ], rows, 'لا توجد تنبيهات. كل الأوراق سارية وكل الباصات سليمة.'));
};

/* ----------------------------------------------------------------- reports */
PAGES.reports = async function (view) {
  const L = await lookups();
  let tab = 'traffic';
  const box = h('div', {});
  const TABS = { traffic: 'حركة الباصات', maintenance: 'الصيانة والزيت', oil: 'حالة الزيت' };
  const tabs = h('div', { class: 'tabs', role: 'group', 'aria-label': 'نوع التقرير' });
  const result = h('div', {});
  const controls = h('form', { class: 'filters', onsubmit: (e) => { e.preventDefault(); run(); } });
  const printhead = h('div', { class: 'printhead' });
  let ctl = {};
  function currentParams() { return Object.fromEntries(Object.entries(ctl).map(([k, el]) => [k, el.value])); }

  function drawControls() {
    ctl = {};
    controls.replaceChildren();
    const add = (name, label, el) => { ctl[name] = el; controls.append(field(label, el)); };
    if (tab !== 'oil') {
      add('from', 'من', h('input', { type: 'date', name: 'from', value: monthStart() }));
      add('to', 'إلى', h('input', { type: 'date', name: 'to', value: me.today }));
      add('bus_id', 'الباص', selectEl('bus_id', busOpts(L, 'كل الباصات')));
      if (isAdmin()) add('supervisor_id', 'المشرف', selectEl('supervisor_id', supOpts(L, 'كل المشرفين')));
    }
    if (tab === 'traffic') add('by', 'تجميع حسب', selectEl('by', [{ value: 'day', label: 'اليوم' }, { value: 'month', label: 'الشهر' }, { value: 'bus', label: 'الباص' }, { value: 'supervisor', label: 'المشرف' }], 'day'));
    if (tab === 'maintenance') add('kind', 'النوع', selectEl('kind', [{ value: '', label: 'الكل' }, ...opts(KIND)]));
    controls.append(h('button', { class: 'btn primary', type: 'submit' }, 'عرض التقرير'));
  }
  async function run() {
    const p = currentParams();
    result.replaceChildren(h('p', { class: 'muted' }, 'جارٍ التحميل…'));
    const range = tab === 'oil' ? `حتى ${me.today}` : `من ${p.from || 'البداية'} إلى ${p.to || me.today}`;
    printhead.replaceChildren(h('img', { class: 'print-logo', src: 'logo.png', alt: 'شعار ابن رشد التعليمية القابضة' }),
      h('div', {}, h('h1', {}, TABS[tab]), h('div', {}, `${range} — أعدّه: ${me.name} — ${me.today}`)));
    try {
      const data = await api('GET', `/api/reports/${tab}?${qs(p)}`);
      if (tab === 'traffic') {
        result.replaceChildren(table([
          { label: data.group_label, render: (r) => (p.by === 'day' || p.by === 'month' ? dt(r.k) : r.k) },
          { label: 'عدد التسجيلات', render: (r) => num(r.records) }, { label: 'عدد الرحلات', render: (r) => num(r.trips) }, { label: 'المسافة (كم)', render: (r) => num(r.km) },
        ], data.rows, 'لا توجد حركة في هذه الفترة.',
        h('tr', {}, h('td', {}, 'الإجمالي'), h('td', {}, num(data.totals.records)), h('td', {}, num(data.totals.trips)), h('td', {}, num(data.totals.km)))));
      } else if (tab === 'maintenance') {
        result.replaceChildren(table([
          { label: 'التاريخ', render: (r) => dt(r.date) }, { label: 'الباص', key: 'bus_plate' }, { label: 'النوع', render: (r) => KIND[r.kind] },
          { label: 'الوصف', key: 'description' }, { label: 'العداد', render: (r) => num(r.odometer) }, { label: 'التكلفة', render: (r) => num(r.cost) },
          { label: 'المشرف', key: 'supervisor_name' },
        ], data.rows, 'لا توجد سجلات صيانة في هذه الفترة.',
        h('tr', {}, h('td', { colspan: 5 }, `الإجمالي: ${fmt(data.totals.records)} سجل، منها ${fmt(data.totals.oil)} تغيير زيت`), h('td', {}, num(data.totals.cost)), h('td', {}))));
      } else {
        const S = { overdue: ['overdue', 'متأخر'], soon: ['soon', 'قريب'], ok: ['ok', 'سليم'], unknown: ['none', 'لا توجد بيانات'] };
        result.replaceChildren(table([
          { label: 'الباص', key: 'plate' }, { label: 'المشرف', key: 'supervisor_name' },
          { label: 'آخر تغيير', render: (r) => dt(r.last_oil_date) },
          { label: 'العداد الحالي', render: (r) => num(r.current_km) }, { label: 'الزيت القادم عند', render: (r) => num(r.next_oil_km) },
          { label: 'المتبقي (كم)', render: (r) => num(r.km_left) },
          { label: 'الحالة', render: (r) => h('span', { class: 'badge ' + S[r.state][0] }, S[r.state][1]) },
        ], data.rows, 'لا توجد باصات مسجّلة.'));
      }
    } catch (ex) { result.replaceChildren(h('p', { class: 'form-error' }, ex.message)); }
  }
  function drawTabs() {
    tabs.replaceChildren(...Object.entries(TABS).map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(k === tab), onclick: () => { tab = k; drawTabs(); drawControls(); run(); } }, label)));
  }
  view.replaceChildren(box);
  box.append(
    pageHead('التقارير', 'اختر نوع التقرير والفترة، ثم اعرضه أو صدّره.',
      h('button', { class: 'btn', type: 'button', onclick: () => { location.href = `/api/reports/${tab}?${qs({ ...currentParams(), format: 'xlsx' })}`; } }, 'تصدير Excel'),
      h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'طباعة / حفظ PDF')),
    tabs, controls, printhead, result);
  drawTabs(); drawControls(); run();
};

/* ------------------------------------------------------------------- users */
PAGES.users = async function (view) {
  if (!isAdmin()) { location.hash = '#/dashboard'; return; }
  const { users } = await api('GET', '/api/users');
  const roleTxt = { admin: 'مدير', supervisor: 'مشرف' };
  const edit = (u) => openForm({
    title: u ? `تعديل: ${u.name}` : 'إضافة مشرف',
    values: u || { role: 'supervisor', active: 1 },
    fields: [
      { name: 'name', label: 'الاسم', required: true, wide: true },
      ...(u ? [] : [{ name: 'username', label: 'اسم المستخدم (إنجليزي)', required: true, dir: 'ltr', hint: 'حروف وأرقام بدون مسافات' }]),
      { name: 'password', label: u ? 'كلمة سر جديدة' : 'كلمة السر', type: 'password', required: !u, hint: u ? 'اتركها فارغة بدون تغيير' : '8 أحرف على الأقل' },
      { name: 'role', label: 'الدور', type: 'select', options: [{ value: 'supervisor', label: 'مشرف' }, { value: 'admin', label: 'مدير' }] },
      ...(u ? [{ name: 'active', label: 'الحالة', type: 'select', options: [{ value: '1', label: 'نشط' }, { value: '0', label: 'موقوف' }] }] : []),
    ],
    onSubmit: async (v) => {
      if (u) { const body = { name: v.name, role: v.role, active: v.active === '1' }; if (v.password) body.password = v.password; await api('PUT', `/api/users/${u.id}`, body); }
      else await api('POST', '/api/users', v);
      toast('تم الحفظ'); PAGES.users(view);
    },
  });
  view.replaceChildren(
    pageHead('المشرفون', 'أنشئ حساباً لكل مشرف وسلّمه اسم المستخدم وكلمة السر. أنت وحدك ترى بيانات الجميع.', h('button', { class: 'btn primary', type: 'button', onclick: () => edit(null) }, 'إضافة مشرف')),
    table([
      { label: 'الاسم', key: 'name' }, { label: 'اسم المستخدم', render: (u) => h('span', { class: 'num' }, u.username) },
      { label: 'الدور', render: (u) => roleTxt[u.role] },
      { label: 'الحالة', render: (u) => h('span', { class: 'badge ' + (u.active ? 'ok' : 'none') }, u.active ? 'نشط' : 'موقوف') },
      { label: '', cls: 'acts', render: (u) => h('button', { class: 'btn small', type: 'button', onclick: () => edit(u) }, 'تعديل') },
    ], users));
};

/* ------------------------------------------------------------------- audit */
PAGES.audit = async function (view) {
  if (!isAdmin()) { location.hash = '#/dashboard'; return; }
  const { rows } = await api('GET', '/api/audit');
  const A = { create: 'إضافة', update: 'تعديل', delete: 'حذف', login: 'دخول', login_failed: 'محاولة دخول فاشلة', upload: 'رفع ملف', delete_file: 'حذف ملف', change_password: 'تغيير كلمة السر' };
  const E = { buses: 'الباصات', drivers: 'السائقون', trips: 'الحركة', maintenance: 'الصيانة', users: 'المستخدمون' };
  view.replaceChildren(
    pageHead('سجل العمليات', 'آخر 300 عملية: من أضاف أو عدّل أو حذف.'),
    table([
      { label: 'الوقت', render: (r) => h('span', { class: 'num' }, new Date(r.ts.replace(' ', 'T') + 'Z').toLocaleString('en-GB', { hour12: false })) },
      { label: 'المستخدم', render: (r) => r.user_name || '—' }, { label: 'العملية', render: (r) => A[r.action] || r.action },
      { label: 'القسم', render: (r) => E[r.entity] || '—' }, { label: 'التفاصيل', key: 'detail', cls: 'sub' },
    ], rows, 'لا توجد عمليات مسجّلة.'));
};

/* ------------------------------------------------------------------ router */
const NAV = [
  ['dashboard', 'لوحة اليوم'], ['trips', 'الحركة'], ['maintenance', 'الصيانة والزيت'], ['drivers', 'السائقون'], ['buses', 'الباصات'],
  ['reports', 'التقارير'], ['alerts', 'التنبيهات'], ['users', 'المشرفون', true], ['audit', 'سجل العمليات', true],
];
function drawNav(current) {
  $('#nav').replaceChildren(...NAV.filter((n) => !n[2] || isAdmin()).map(([k, label]) => h('a', { href: '#/' + k, 'aria-current': k === current ? 'page' : null },
    label, k === 'alerts' ? h('span', { class: 'count', hidden: !alertCount }, fmt(alertCount)) : null)));
}
async function route() {
  if (!me) return;
  const key = (location.hash.match(/^#\/(\w+)/) || [])[1];
  const page = PAGES[key] ? key : 'dashboard';
  drawNav(page);
  const view = $('#view');
  try { await PAGES[page](view); drawNav(page); }
  catch (ex) { view.replaceChildren(h('p', { class: 'form-error' }, ex.message)); }
  document.title = (NAV.find((n) => n[0] === page) || [0, 'المنصة'])[1] + ' — مشرفو الحركة';
}
window.addEventListener('hashchange', () => { route(); window.scrollTo(0, 0); });

async function boot() {
  try {
    const r = await api('GET', '/api/me');
    me = { ...r.user, today: r.today };
  } catch { showLogin(); return; }
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#whoami').textContent = me.name;
  $('#roleLabel').textContent = isAdmin() ? 'المدير' : 'مشرف حركة';
  try { alertCount = (await api('GET', '/api/summary')).alerts; } catch { /* ignore */ }
  route();
}
boot();
