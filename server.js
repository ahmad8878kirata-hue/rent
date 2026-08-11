const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const h = require('./helpers');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '12345';
const SESSION_SECRET = process.env.SESSION_SECRET || 'rent-admin-secret-2026';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = 'rent_session';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/logo', express.static(path.join(__dirname, 'logo')));

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads', 'devices');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename(req, file, cb) {
    const ext = (path.extname(file.originalname) || '.jpg').toLowerCase();
    cb(null, `device-${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  }
});

function imageFilter(req, file, cb) {
  const mt = (file.mimetype || '').toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp|bmp|avif|heic|heif|pjpeg|jfif|x-png|svg\+xml)$/.test(mt)) return cb(null, true);
  const ext = (path.extname(file.originalname) || '').toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.jfif', '.gif', '.webp', '.bmp', '.avif', '.heic', '.heif'].includes(ext)) return cb(null, true);
  return cb(new Error('نوع الملف غير مدعوم. يُسمح فقط بالصور PNG و JPG و GIF و WebP وغيرها من صيغ الصور.'));
}

const upload = multer({ storage, fileFilter: imageFilter, limits: { fileSize: 20 * 1024 * 1024 } });

const dbFileStorage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, os.tmpdir());
  },
  filename(req, file, cb) {
    const ext = (path.extname(file.originalname) || '.db').toLowerCase();
    cb(null, `installments-import-${Date.now()}${ext}`);
  }
});

function dbFileFilter(req, file, cb) {
  return cb(null, true);
}

const dbFileUpload = multer({ storage: dbFileStorage, fileFilter: dbFileFilter, limits: { fileSize: 500 * 1024 * 1024 } });

app.use((req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

/* ==================== AUTH ==================== */

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((pair) => {
    const i = pair.indexOf('=');
    if (i > -1) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  });
  return out;
}

function signSession(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS }))
    .toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  return payload + '.' + sig;
}

function verifySession(token) {
  if (!token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data.u === ADMIN_USER ? data.u : null;
  } catch (e) {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token && verifySession(token) === ADMIN_USER) return next();
  const wantsJson = req.path.indexOf('/api/') === 0 ||
    (req.headers.accept && req.headers.accept.indexOf('application/json') === 0);
  if (wantsJson) return res.status(401).json({ error: 'غير مصرح بالوصول، يرجى تسجيل الدخول' });
  return res.redirect('/rent');
}

function toNum(v) {
  if (v == null) return NaN;
  const s = String(v)
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d))
    .replace(/[^\d.]/g, '');
  if (s === '' || s === '.' || s === '-') return NaN;
  return parseFloat(s);
}

function toInt(v) {
  const n = toNum(v);
  return isNaN(n) ? NaN : Math.trunc(n);
}

const ACTIVE = {
  dashboard: 'dashboard',
  addCustomer: 'addCustomer',
  customers: 'customers',
  customerDetail: 'customers',
  payment: 'payment',
  reports: 'reports',
  settings: 'settings',
  notifications: 'notifications'
};

function baseVars(active, extra) {
  return Object.assign({ active, helpers: h }, extra || {});
}

/* ==================== PAGE ROUTES ==================== */

app.get('/', (req, res) => {
  const settings = h.getSettings();
  const devices = h.getCatalogDevices();
  const availableCount = devices.reduce((s, d) => s + Math.max(0, d.stock), 0);
  const minMonthly = devices.length ? Math.min(...devices.map((d) => d.monthlyAmount)) : 0;
  res.render('home', { helpers: h, settings, devices, deviceCount: devices.length, availableCount, minMonthly });
});

app.get('/rent', (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token && verifySession(token) === ADMIN_USER) return res.redirect('/rent/dashboard');
  res.render('rent-login', { helpers: h, title: 'تسجيل الدخول' });
});

app.post('/rent/login', (req, res) => {
  const b = req.body || {};
  const username = (b.username || '').trim();
  const password = (b.password || '').trim();
  if (username === ADMIN_USER && password === ADMIN_PASSWORD) {
    res.cookie(SESSION_COOKIE, signSession(username), {
      httpOnly: true,
      sameSite: 'lax',
      maxAge: SESSION_TTL_MS
    });
    return res.json({ ok: true, redirect: '/rent/dashboard' });
  }
  return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
});

const adminRouter = express.Router();
adminRouter.use(requireAdmin);

adminRouter.get('/logout', (req, res) => {
  res.clearCookie(SESSION_COOKIE);
  res.redirect('/rent');
});

adminRouter.get('/dashboard', (req, res) => {
  res.render('dashboard', baseVars(ACTIVE.dashboard, h.getDashboardStats()));
});

adminRouter.get('/customers', (req, res) => {
  const q = (req.query.q || '').trim();
  const filter = req.query.filter || 'all';
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = 8;

  let where = '';
  const params = [];
  if (q) {
    where += 'WHERE c.name LIKE ? OR c.phone LIKE ? OR c.national_id LIKE ?';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (filter !== 'all') {
    where += where ? ' AND ' : 'WHERE ';
    if (filter === 'finished') {
      where += 'cu.status = \'finished\'';
    } else if (filter === 'overdue') {
      where += `EXISTS (SELECT 1 FROM installments i WHERE i.contract_id = cu.id AND i.status = 'overdue')`;
    } else {
      where += `cu.status = 'active' AND NOT EXISTS (SELECT 1 FROM installments i WHERE i.contract_id = cu.id AND i.status = 'overdue')`;
    }
  }

  const totalRows = db.prepare(`
    SELECT COUNT(DISTINCT cu.customer_id) c
    FROM customers c JOIN contracts cu ON cu.customer_id = c.id
    ${where}
  `).get(...params).c;
  const totalPages = Math.max(1, Math.ceil(totalRows / perPage));
  const offset = (page - 1) * perPage;

  const rows = db.prepare(`
    SELECT cu.id contract_id, c.*
    FROM customers c JOIN contracts cu ON cu.customer_id = c.id
    ${where}
    GROUP BY c.id
    ORDER BY c.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, perPage, offset);

  const customers = rows.map((r) => {
    const s = h.getCustomerSummary(r.id);
    return Object.assign(r, s);
  });

  res.render('customers', baseVars(ACTIVE.customers, {
    customers,
    q,
    filter,
    page,
    totalPages,
    totalRows,
    settings: h.getSettings(),
    startItem: totalRows === 0 ? 0 : offset + 1,
    endItem: Math.min(offset + perPage, totalRows)
  }));
});

adminRouter.get('/customers/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const summary = h.getCustomerSummary(id);
  if (!summary) return res.status(404).render('404', baseVars(null, {}));

  const payments = db.prepare(`
    SELECT p.* FROM payments p WHERE p.customer_id = ? ORDER BY p.payment_date DESC, p.id DESC
  `).all(id);

  res.render('customer-detail', baseVars(ACTIVE.customerDetail, Object.assign(summary, {
    payments,
    settings: h.getSettings()
  })));
});

adminRouter.get('/customers/:id/payments', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const summary = h.getCustomerSummary(id);
  if (!summary) return res.status(404).json({ error: 'العميل غير موجود' });
  res.json({ due: h.getCurrentDueForCustomer(id) });
});

adminRouter.get('/customers/:id/print', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const summary = h.getCustomerSummary(id);
  if (!summary) return res.status(404).render('404', baseVars(null, {}));
  res.render('contract', Object.assign({ helpers: h, settings: h.getSettings() }, summary));
});

adminRouter.get('/add-customer', (req, res) => {
  const deviceTypes = db.prepare('SELECT * FROM device_types ORDER BY id').all();
  res.render('add-customer', baseVars(ACTIVE.addCustomer, {
    deviceTypes,
    settings: h.getSettings()
  }));
});

adminRouter.get('/register-payment', (req, res) => {
  const customerId = parseInt(req.query.customer, 10);
  const installmentId = parseInt(req.query.installment, 10);
  let customer = null;
  let due = null;
  let contract = null;
  if (customerId) {
    customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
    const summary = h.getCustomerSummary(customerId);
    contract = summary && summary.contract;
    due = summary && summary.installments.find((i) => i.id === installmentId) || h.getCurrentDueForCustomer(customerId);
  }
  res.render('register-payment', baseVars(ACTIVE.payment, {
    customer,
    due,
    contract,
    settings: h.getSettings(),
    q: customer ? customer.name : ''
  }));
});

adminRouter.get('/register-payment/search', (req, res) => {
  const q = (req.query.q || '').trim();
  let customers = [];
  if (q) {
    const like = `%${q}%`;
    customers = db.prepare(`
      SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? OR national_id LIKE ? LIMIT 8
    `).all(like, like, like);
  }
  res.json(customers);
});

adminRouter.get('/register-payment/customer/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  const due = h.getCurrentDueForCustomer(id);
  const summary = h.getCustomerSummary(id);
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });
  res.json({ customer: c, due, contract: summary && summary.contract });
});

adminRouter.get('/reports', (req, res) => {
  res.render('reports', baseVars(ACTIVE.reports, h.getReportsData()));
});

adminRouter.get('/settings', (req, res) => {
  const settings = h.getSettings();
  const deviceTypes = db.prepare('SELECT * FROM device_types ORDER BY id').all();
  const users = db.prepare('SELECT * FROM users ORDER BY id').all();
  const catalogDevices = h.getCatalogDevices();
  res.render('settings', baseVars(ACTIVE.settings, { settings, deviceTypes, users, catalogDevices }));
});

adminRouter.get('/notifications', (req, res) => {
  const filter = req.query.filter || 'all';
  let rows;
  if (filter === 'unread') {
    rows = db.prepare('SELECT * FROM notifications WHERE is_read = 0 ORDER BY created_at DESC, id DESC').all();
  } else if (filter === 'overdue') {
    rows = db.prepare("SELECT * FROM notifications WHERE type = 'overdue' ORDER BY created_at DESC, id DESC").all();
  } else {
    rows = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC, id DESC').all();
  }
  const unreadCount = db.prepare('SELECT COUNT(*) c FROM notifications WHERE is_read = 0').get().c;
  const list = rows.map((n) => {
    if (n.related_customer_id) {
      const c = db.prepare('SELECT name FROM customers WHERE id = ?').get(n.related_customer_id);
      n.customer_name = c ? c.name : null;
    }
    return n;
  });
  res.render('notifications', baseVars(ACTIVE.notifications, { notifications: list, filter, unreadCount }));
});

/* ==================== MOUNT ADMIN APP ==================== */

app.use('/rent', adminRouter);

/* ==================== POST / API ROUTES ==================== */

app.use('/api', requireAdmin);

app.post('/api/customers', (req, res) => {
  const b = req.body || {};
  const name = (b.fullName || '').trim();
  const phone = (b.phone || '').trim();
  const nationalId = (b.nationalId || '').trim();
  const fullPrice = toNum(b.fullPrice);
  const startDate = b.startDate;
  const deviceType = b.deviceType || '';
  const deviceModel = (b.deviceModel || '').trim();

  if (!name || !phone || !fullPrice || isNaN(fullPrice) || fullPrice <= 0 || !startDate || !deviceModel) {
    return res.status(400).json({ error: 'يرجى تعبئة جميع الحقول المطلوبة' });
  }

  const insertCustomer = db.prepare(`
    INSERT INTO customers (name, phone, national_id, country, city, district, street, building)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = insertCustomer.run(
    name, phone, nationalId,
    (b.country || '').trim(), (b.city || '').trim(), (b.district || '').trim(),
    (b.street || '').trim(), (b.building || '').trim()
  );
  const customerId = info.lastInsertRowid;

  const deviceName = deviceType;
  db.createContractAndInstallments(customerId, deviceName, deviceModel, fullPrice, startDate);

  h.addNotification('system', 'عميل جديد', `تم إضافة العميل ${name} وإصدار عقد جديد بنجاح.`, customerId);
  res.json({ ok: true, id: customerId, redirect: `/rent/customers/${customerId}` });
});

app.delete('/api/customers/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });
  db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  res.json({ ok: true, name: c.name });
});

app.post('/api/payments', (req, res) => {
  const b = req.body || {};
  const customerId = parseInt(b.customerId, 10);
  const installmentId = parseInt(b.installmentId, 10);
  const contractId = parseInt(b.contractId, 10);
  const amount = toNum(b.amount);
  const paymentDate = b.paymentDate;
  const method = b.method || 'cash';

  const inst = db.prepare('SELECT * FROM installments WHERE id = ?').get(installmentId);
  if (!inst || inst.contract_id !== contractId) {
    return res.status(400).json({ error: 'بيانات القسط غير صحيحة' });
  }
  if (!amount || isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: 'المبلغ المدفوع غير صالح' });
  }
  const due = h.getCurrentDueForCustomer(customerId);
  if (!due) return res.status(400).json({ error: 'لا يوجد أقساط مستحقة لهذا العميل' });
  const maxAmount = inst.amount - inst.paid_amount;
  if (amount > maxAmount + 0.01) {
    return res.status(400).json({ error: `المبلغ المدفوع يتجاوز المتبقي من القسط (${maxAmount.toFixed(2)})` });
  }

  db.prepare('UPDATE installments SET paid_amount = paid_amount + ?, status = ? WHERE id = ?')
    .run(amount, inst.status === 'overdue' ? 'paid' : (inst.paid_amount + amount >= inst.amount ? 'paid' : 'unpaid'), installmentId);
  db.prepare('INSERT INTO payments (contract_id, installment_id, customer_id, amount, payment_date, method) VALUES (?, ?, ?, ?, ?, ?)')
    .run(contractId, installmentId, customerId, amount, paymentDate, method);

  const unpaid = db.prepare('SELECT COUNT(*) c FROM installments WHERE contract_id = ? AND status != \'paid\'').get(contractId).c;
  if (unpaid === 0) db.prepare('UPDATE contracts SET status = \'finished\' WHERE id = ?').run(contractId);

  h.addNotification('system', 'دفعة مسجلة', `تم تسجيل دفعة بقيمة ${h.fmtMoney(amount, h.getSettings().currency)} للعميل.`, customerId);
  res.json({ ok: true, redirect: `/rent/customers/${customerId}` });
});

app.post('/api/settings', (req, res) => {
  const b = req.body || {};
  const interest = toNum(b.default_interest_rate);
  const months = toInt(b.default_months);
  const down = toNum(b.down_payment_percent);
  const currency = (b.currency || 'ر.س').trim();

  if (isNaN(interest) || interest < 0) return res.status(400).json({ error: 'نسبة الفائدة غير صالحة' });
  if (isNaN(months) || months <= 0) return res.status(400).json({ error: 'عدد الأشهر غير صالح' });
  if (isNaN(down) || down < 0 || down > 100) return res.status(400).json({ error: 'نسبة الدفعة المقدمة غير صالحة' });

  db.prepare('UPDATE settings SET default_interest_rate = ?, default_months = ?, down_payment_percent = ?, currency = ? WHERE id = 1')
    .run(interest, months, down, currency);
  res.json({ ok: true });
});

app.post('/api/device-types', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'الاسم مطلوب' });
  const existing = db.prepare('SELECT id FROM device_types WHERE name = ?').get(name);
  if (existing) return res.status(400).json({ error: 'نوع الجهاز موجود مسبقاً' });
  const info = db.prepare('INSERT INTO device_types (name) VALUES (?)').run(name);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.delete('/api/device-types/:id', (req, res) => {
  db.prepare('DELETE FROM device_types WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

function parseDevicePayload(b) {
  const name = (b.name || '').trim();
  const brand = (b.brand || '').trim();
  const category = (b.category || '').trim();
  const description = (b.description || '').trim();
  const icon = (b.icon || 'smartphone').trim();
  const color = (b.color || 'from-emerald-500 to-teal-600').trim();
  const price = toNum(b.price);
  const interest_rate = toNum(b.interest_rate);
  const months = toInt(b.months);
  const down_payment_percent = toNum(b.down_payment_percent);
  const stock = toInt(b.stock) || 0;
  const featured = b.featured ? 1 : 0;
  return { name, brand, category, description, icon, color, price, interest_rate, months, down_payment_percent, stock, featured };
}

function validateDevicePayload(p) {
  if (!p.name) return 'اسم الجهاز مطلوب';
  if (isNaN(p.price) || p.price <= 0) return 'السعر غير صالح';
  if (isNaN(p.interest_rate) || p.interest_rate < 0) return 'نسبة الفائدة غير صالحة';
  if (isNaN(p.months) || p.months <= 0) return 'عدد الأشهر غير صالح';
  if (isNaN(p.down_payment_percent) || p.down_payment_percent < 0 || p.down_payment_percent > 100) return 'نسبة الدفعة الأولى غير صالحة';
  if (isNaN(p.stock) || p.stock < 0) return 'المخزون غير صالح';
  return null;
}

app.get('/api/catalog-devices', (req, res) => {
  res.json(h.getCatalogDevices());
});

app.post('/api/catalog-devices', (req, res) => {
  const p = parseDevicePayload(req.body || {});
  const err = validateDevicePayload(p);
  if (err) return res.status(400).json({ error: err });
  const info = db.prepare(`
    INSERT INTO catalog_devices (name, brand, category, description, icon, color, price, interest_rate, months, down_payment_percent, stock, featured)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(p.name, p.brand, p.category, p.description, p.icon, p.color, p.price, p.interest_rate, p.months, p.down_payment_percent, p.stock, p.featured);
  res.json({ ok: true, id: info.lastInsertRowid });
});

app.put('/api/catalog-devices/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT id FROM catalog_devices WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'الجهاز غير موجود' });
  const p = parseDevicePayload(req.body || {});
  const err = validateDevicePayload(p);
  if (err) return res.status(400).json({ error: err });
  db.prepare(`
    UPDATE catalog_devices SET name = ?, brand = ?, category = ?, description = ?, icon = ?, color = ?,
      price = ?, interest_rate = ?, months = ?, down_payment_percent = ?, stock = ?, featured = ?
    WHERE id = ?
  `).run(p.name, p.brand, p.category, p.description, p.icon, p.color, p.price, p.interest_rate, p.months, p.down_payment_percent, p.stock, p.featured, id);
  res.json({ ok: true, id });
});

app.delete('/api/catalog-devices/:id', (req, res) => {
  db.prepare('DELETE FROM catalog_devices WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

app.post('/api/catalog-devices/:id/images', upload.array('images', 8), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT id FROM catalog_devices WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'الجهاز غير موجود' });
  const files = req.files || [];
  if (files.length === 0) return res.status(400).json({ error: 'لم يتم اختيار أي صورة' });
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM device_images WHERE device_id = ?').get(id).m;
  const ins = db.prepare('INSERT INTO device_images (device_id, url, sort_order) VALUES (?, ?, ?)');
  const saved = [];
  files.forEach((f, i) => {
    const url = '/uploads/devices/' + f.filename;
    const info = ins.run(id, url, maxOrder + i + 1);
    saved.push({ id: info.lastInsertRowid, url });
  });
  res.json({ ok: true, images: saved });
});

app.delete('/api/catalog-devices/:id/images/:imgId', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const imgId = parseInt(req.params.imgId, 10);
  const img = db.prepare('SELECT * FROM device_images WHERE id = ? AND device_id = ?').get(imgId, id);
  if (!img) return res.status(404).json({ error: 'الصورة غير موجودة' });
  db.prepare('DELETE FROM device_images WHERE id = ?').run(imgId);
  try {
    const filePath = path.join(__dirname, 'public', img.url);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) { /* ignore */ }
  res.json({ ok: true });
});

app.post('/api/users', (req, res) => {
  const b = req.body || {};
  const name = (b.name || '').trim();
  const email = (b.email || '').trim();
  const role = b.role || 'موظف مبيعات';
  if (!name || !email) return res.status(400).json({ error: 'الاسم والبريد مطلوبان' });
  try {
    const info = db.prepare('INSERT INTO users (name, email, role, status) VALUES (?, ?, ?, \'active\')').run(name, email, role);
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: 'البريد الإلكتروني مستخدم مسبقاً' });
  }
});

app.put('/api/users/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const b = req.body || {};
  const role = b.role || db.prepare('SELECT role FROM users WHERE id = ?').get(id).role;
  const status = b.status || db.prepare('SELECT status FROM users WHERE id = ?').get(id).status;
  db.prepare('UPDATE users SET role = ?, status = ? WHERE id = ?').run(role, status, id);
  res.json({ ok: true });
});

app.delete('/api/users/:id', (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

app.post('/api/notifications/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(parseInt(req.params.id, 10));
  res.json({ ok: true });
});

app.post('/api/notifications/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1').run();
  res.json({ ok: true });
});

app.post('/api/customers/:id/reminder', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
  if (!c) return res.status(404).json({ error: 'العميل غير موجود' });
  h.addNotification('upcoming', 'تذكير سداد', `تم إرسال تذكير سداد للعميل ${c.name}.`, id);
  res.json({ ok: true });
});

app.post('/api/reminders/bulk', (req, res) => {
  const overdue = h.getOverdueCustomers();
  const ids = new Set(overdue.map((o) => o.customer_id));
  ids.forEach((cid) => {
    const c = db.prepare('SELECT name FROM customers WHERE id = ?').get(cid);
    h.addNotification('upcoming', 'تذكير جماعي', `تم إرسال تذكير سداد للعميل ${c ? c.name : ''}.`, cid);
  });
  res.json({ ok: true, count: ids.size });
});

app.get('/api/database/export', (req, res) => {
  try {
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const filePath = path.join(os.tmpdir(), `installments-backup-${stamp}.db`);
    db.backupDatabase(filePath);
    res.download(filePath, `installments-backup-${stamp}.db`, (err) => {
      fs.unlink(filePath, () => {});
    });
  } catch (e) {
    res.status(500).json({ error: 'فشل إنشاء النسخة الاحتياطية: ' + (e.message || 'خطأ غير معروف') });
  }
});

app.post('/api/database/import', dbFileUpload.single('dbFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'لم يتم اختيار ملف قاعدة بيانات' });
  const tmp = req.file.path;
  const ext = (path.extname(req.file.originalname || '') || '').toLowerCase();
  if (!['.db', '.sqlite', '.sqlite3', '.db3'].includes(ext)) {
    fs.unlink(tmp, () => {});
    return res.status(400).json({ error: 'الملف يجب أن يكون نسخة قاعدة بيانات بامتداد db أو sqlite أو sqlite3' });
  }
  try {
    if (!db.validateDatabaseFile(tmp)) {
      fs.unlink(tmp, () => {});
      return res.status(400).json({ error: 'الملف المحدد ليس قاعدة بيانات SQLite صالحة' });
    }
    const preBackup = db.restoreDatabase(tmp);
    fs.unlink(tmp, () => {});
    res.json({ ok: true, backup: preBackup });
  } catch (e) {
    fs.unlink(tmp, () => {});
    res.status(500).json({ error: 'فشل استعادة قاعدة البيانات: ' + (e.message || 'خطأ غير معروف') });
  }
});

app.get('/api/reports/export', (req, res) => {
  const overdue = h.getOverdueCustomers();
  const settings = h.getSettings();
  let csv = 'اسم العميل,رقم التواصل,المبلغ المتأخر,أيام التأخير,تاريخ الاستحقاق\n';
  overdue.forEach((o) => {
    const amount = `${o.amount.toFixed(2)} ${settings.currency}`;
    csv += `"${o.customer_name}","${o.phone}","${amount}",${Math.round(o.late_days)},${o.due_date}\n`;
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="overdue-report.csv"');
  res.send('\uFEFF' + csv);
});

app.use((err, req, res, next) => {
  if (req.path.indexOf('/api/') === 0) {
    const message = err instanceof multer.MulterError ? 'خطأ في رفع الملف: ' + err.message : (err.message || 'حدث خطأ');
    return res.status(400).json({ error: message });
  }
  return next(err);
});

app.use((req, res) => {
  res.status(404).render('404', baseVars(null, {}));
});

app.listen(PORT, () => {
  console.log(`نظام إدارة الأقساط يعمل على: http://localhost:${PORT}`);
});
