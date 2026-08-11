const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'installments.db');
const BACKUP_DIR = path.join(__dirname, 'backups');

let conn = null;

function openConnection() {
  conn = new Database(DB_PATH);
  conn.pragma('journal_mode = WAL');
  conn.pragma('foreign_keys = ON');
}

function initSchema() {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      default_interest_rate REAL NOT NULL DEFAULT 15,
      default_months INTEGER NOT NULL DEFAULT 5,
      down_payment_percent REAL NOT NULL DEFAULT 50,
      currency TEXT NOT NULL DEFAULT 'ر.س'
    );

    CREATE TABLE IF NOT EXISTS device_types (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      role TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      password TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      national_id TEXT,
      country TEXT,
      city TEXT,
      district TEXT,
      street TEXT,
      building TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      device_name TEXT NOT NULL,
      device_model TEXT NOT NULL,
      full_price REAL NOT NULL,
      down_payment REAL NOT NULL,
      financed_amount REAL NOT NULL,
      interest_rate REAL NOT NULL,
      months INTEGER NOT NULL,
      monthly_amount REAL NOT NULL,
      total_payable REAL NOT NULL,
      start_date TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS installments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      installment_number INTEGER NOT NULL,
      due_date TEXT NOT NULL,
      amount REAL NOT NULL,
      paid_amount REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'unpaid',
      UNIQUE(contract_id, installment_number)
    );

    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contract_id INTEGER NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      installment_id INTEGER REFERENCES installments(id) ON DELETE SET NULL,
      customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      payment_date TEXT NOT NULL,
      method TEXT NOT NULL DEFAULT 'cash',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      related_customer_id INTEGER REFERENCES customers(id) ON DELETE CASCADE,
      created_at TEXT DEFAULT (datetime('now')),
      is_read INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS catalog_devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      brand TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      icon TEXT NOT NULL DEFAULT 'smartphone',
      color TEXT NOT NULL DEFAULT 'from-emerald-500 to-teal-600',
      price REAL NOT NULL,
      interest_rate REAL NOT NULL DEFAULT 15,
      months INTEGER NOT NULL DEFAULT 5,
      down_payment_percent REAL NOT NULL DEFAULT 50,
      stock INTEGER NOT NULL DEFAULT 0,
      featured INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS device_images (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL REFERENCES catalog_devices(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function createContractAndInstallments(customerId, deviceName, deviceModel, fullPrice, startDate, opts) {
  const s = conn.prepare('SELECT * FROM settings WHERE id = 1').get();
  const downPercent = opts && opts.down_payment_percent != null ? opts.down_payment_percent : s.down_payment_percent;
  const interestRate = opts && opts.interest_rate != null ? opts.interest_rate : s.default_interest_rate;
  const months = opts && opts.months != null ? opts.months : s.default_months;

  const totalWithInterest = round2(fullPrice * (1 + interestRate / 100));
  const downPayment = round2(totalWithInterest * downPercent / 100);
  const financedAmount = round2(totalWithInterest - downPayment);
  const monthly = round2(financedAmount / months);
  const totalPayable = totalWithInterest;

  const insert = conn.prepare(`
    INSERT INTO contracts (customer_id, device_name, device_model, full_price, down_payment,
      financed_amount, interest_rate, months, monthly_amount, total_payable, start_date, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `);
  const res = insert.run(customerId, deviceName, deviceModel, fullPrice, downPayment, financedAmount, interestRate, months, monthly, totalPayable, startDate);
  const contractId = res.lastInsertRowid;

  // Record the first payment (down payment) collected at contract signing
  conn.prepare(`
    INSERT INTO payments (contract_id, installment_id, customer_id, amount, payment_date, method)
    VALUES (?, NULL, ?, ?, ?, 'cash')
  `).run(contractId, customerId, downPayment, startDate);

  const insInst = conn.prepare(`
    INSERT INTO installments (contract_id, installment_number, due_date, amount, status)
    VALUES (?, ?, ?, ?, 'unpaid')
  `);
  const start = new Date(startDate);
  for (let i = 1; i <= months; i++) {
    const due = new Date(start);
    due.setMonth(due.getMonth() + i);
    const dueStr = due.toISOString().slice(0, 10);
    insInst.run(contractId, i, dueStr, monthly);
  }

  return contractId;
}

function registerPayment(customerId, contractId, installmentId, amount, paymentDate, method) {
  const insInstallment = conn.prepare(`
    UPDATE installments
    SET paid_amount = paid_amount + ?, status = ?
    WHERE id = ?
  `);

  const insertPayment = conn.prepare(`
    INSERT INTO payments (contract_id, installment_id, customer_id, amount, payment_date, method)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const pmt = insertPayment.run(contractId, installmentId, customerId, amount, paymentDate, method);

  let installment = conn.prepare('SELECT * FROM installments WHERE id = ?').get(installmentId);
  const newPaid = round2(installment.paid_amount + amount);
  const status = newPaid >= installment.amount ? 'paid' : 'unpaid';
  insInstallment.run(newPaid, status, installmentId);
  installment = conn.prepare('SELECT * FROM installments WHERE id = ?').get(installmentId);

  const unpaidCount = conn.prepare('SELECT COUNT(*) c FROM installments WHERE contract_id = ? AND status != \'paid\'').get(contractId).c;
  if (unpaidCount === 0) {
    conn.prepare('UPDATE contracts SET status = \'finished\' WHERE id = ?').run(contractId);
  }

  return { paymentId: pmt.lastInsertRowid, installment };
}

function syncOverdueStatus() {
  const today = new Date().toISOString().slice(0, 10);
  conn.prepare(`
    UPDATE installments
    SET status = 'overdue'
    WHERE status = 'unpaid' AND due_date < ?
  `).run(today);
}

function ensureSettings() {
  const s = conn.prepare('SELECT * FROM settings WHERE id = 1').get();
  if (!s) {
    conn.prepare('INSERT INTO settings (id, default_interest_rate, default_months, down_payment_percent, currency) VALUES (1, 15, 5, 50, \'ر.س\')').run();
  }
}

function seedIfEmpty() {
  const count = conn.prepare('SELECT COUNT(*) c FROM customers').get().c;
  if (count > 0) return;

  const deviceTypes = ['هاتف ذكي (Apple)', 'هاتف ذكي (Samsung)', 'حاسوب محمول', 'جهاز لوحي'];
  const insDT = conn.prepare('INSERT INTO device_types (name) VALUES (?)');
  deviceTypes.forEach((n) => insDT.run(n));

  const users = [
    ['أحمد محمود', 'ahmed@system.local', 'مدير نظام', 'active'],
    ['سارة كمال', 'sara@system.local', 'موظف مبيعات', 'active'],
    ['خالد عمر', 'khaled@system.local', 'محاسب', 'inactive']
  ];
  const insUser = conn.prepare('INSERT INTO users (name, email, role, status) VALUES (?, ?, ?, ?)');
  users.forEach((u) => insUser.run(...u));

  const insCustomer = conn.prepare(`
    INSERT INTO customers (name, phone, national_id, country, city, district, street, building)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const seedCustomers = [
    ['أحمد محمود عبد الله', '050 123 4567', '1029384756', 'السعودية', 'الرياض', 'حي الياسمين', 'شارع العليا', '12', 'هاتف ذكي (Apple)', 'iPhone 14 Pro', 4500],
    ['سارة خالد النعيمي', '055 987 6543', '2093847561', 'السعودية', 'جدة', 'حي السلامة', 'شارع الأمير سلطان', '45', 'هاتف ذكي (Samsung)', 'Samsung S23 Ultra', 5200],
    ['عمر حسن الفلاسي', '052 333 4444', '3071829405', 'السعودية', 'الدمام', 'حي النور', 'شارع الملك فهد', '88', 'حاسوب محمول', 'MacBook Air M2', 4800],
    ['فاطمة علي سعيد', '053 222 1111', '4102938475', 'السعودية', 'الرياض', 'حي الملقا', 'شارع التحلية', '3', 'هاتف ذكي (Apple)', 'iPhone 15 Pro', 5200],
    ['خالد إبراهيم حسن', '054 444 5555', '5091827364', 'السعودية', 'مكة', 'حي العوالي', 'شارع إبراهيم الخليل', '22', 'هاتف ذكي (Samsung)', 'Galaxy A54', 1200],
    ['سارة منصور القحطاني', '056 777 8888', '6081726354', 'السعودية', 'الرياض', 'حي النرجس', 'شارع أنس بن مالك', '7', 'جهاز لوحي', 'iPad Air M2', 3400],
    ['محمود عبد الرحمن', '057 111 2222', '7051625343', 'السعودية', 'جدة', 'حي الروضة', 'شارع صاري', '19', 'هاتف ذكي (Samsung)', 'Galaxy Z Flip 5', 3800],
    ['ليلى ناصر الدين', '058 999 0000', '8091827365', 'السعودية', 'الرياض', 'حي الورود', 'شارع التخصصي', '31', 'هاتف ذكي (Apple)', 'iPhone 13', 3000],
    ['يوسف العتيبي', '059 123 7890', '9039284756', 'السعودية', 'الطائف', 'حي السداد', 'شارع شهار', '56', 'هاتف ذكي (Xiaomi)', 'Redmi Note 13', 900],
    ['نورة العلي العمري', '050 987 1234', '1011121314', 'السعودية', 'الرياض', 'حي الياسمين', 'شارع الأمير محمد بن سلمان', '9', 'حاسوب محمول', 'Lenovo ThinkPad', 3500]
  ];

  const contracts = [];
  let firstDate = new Date('2023-10-15');

  seedCustomers.forEach((c, i) => {
    const info = insCustomer.run(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]);
    const customerId = info.lastInsertRowid;
    const start = new Date(firstDate);
    start.setDate(start.getDate() + i * 37);
    const startStr = start.toISOString().slice(0, 10);
    const contractId = createContractAndInstallments(customerId, c[8], c[9], c[10], startStr);
    contracts.push({ contractId, customerId, name: c[0], startStr });
  });

  function payInstallment(contractId, installmentNumber, daysOffset, method) {
    const inst = conn.prepare('SELECT * FROM installments WHERE contract_id = ? AND installment_number = ?').get(contractId, installmentNumber);
    if (!inst) return;
    const customerId = conn.prepare('SELECT customer_id FROM contracts WHERE id = ?').get(contractId).customer_id;
    const pmtDate = new Date(inst.due_date);
    pmtDate.setDate(pmtDate.getDate() + daysOffset);
    registerPayment(customerId, contractId, inst.id, inst.amount, pmtDate.toISOString().slice(0, 10), method);
  }

  // Customer 3 (عمر حسن): fully finished 10/10 installments
  const c3 = contracts[2];
  for (let n = 1; n <= 10; n++) payInstallment(c3.contractId, n, -3, 'cash');

  // Customer 1 (أحمد): 3 of 12 paid
  [1, 2, 3].forEach((n) => payInstallment(contracts[0].contractId, n, -2, 'cash'));

  // Customer 2 (سارة خالد): 6 of 12 paid, but overdue
  [1, 2, 3, 4, 5, 6].forEach((n) => payInstallment(contracts[1].contractId, n, -5, 'bank_transfer'));

  // Customer 7 (محمود): overdue by 15 days
  [1, 2].forEach((n) => payInstallment(contracts[6].contractId, n, -10, 'cash'));

  // Customer 8 (ليلى): overdue 10 days
  [1, 2, 3].forEach((n) => payInstallment(contracts[7].contractId, n, -4, 'bank_transfer'));

  // Customer 9 (يوسف): overdue 8 days
  [1, 2, 3, 4].forEach((n) => payInstallment(contracts[8].contractId, n, -6, 'cash'));

  // Customer 4 (فاطمة): 2 paid
  [1, 2].forEach((n) => payInstallment(contracts[3].contractId, n, -1, 'bank_transfer'));

  // Customer 10 (نورة): 1 paid
  [1].forEach((n) => payInstallment(contracts[9].contractId, n, -2, 'cash'));

  syncOverdueStatus();

  // Seed notifications
  const insNotif = conn.prepare(`
    INSERT INTO notifications (type, title, message, related_customer_id, created_at, is_read)
    VALUES (?, ?, ?, ?, ?, 0)
  `);
  const mk = (daysAgo) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toISOString().slice(0, 10);
  };
  insNotif.run('overdue', 'قسط متأخر: محمود عبد الرحمن', 'الدفعة الشهرية بقيمة 850 ر.س مستحقة منذ تاريخ ولم يتم سدادها.', 7, mk(1));
  insNotif.run('upcoming', 'استحقاق قريب: سارة منصور', 'القسط الشهري للجهاز بقيمة 567 ر.س.', 5, mk(2));
  insNotif.run('upcoming', 'استحقاق قريب: أحمد محمود', 'قسط شهري بقيمة 575 ر.س يستحق قريباً.', 1, mk(3));
  insNotif.run('system', 'تحديث النظام', 'تم تحديث سياسات الحساب الآلي للغرامات. يرجى مراجعة الإعدادات.', null, mk(4));
}

function seedDevicesIfEmpty() {
  const count = conn.prepare('SELECT COUNT(*) c FROM catalog_devices').get().c;
  if (count > 0) return;

  const ins = conn.prepare(`
    INSERT INTO catalog_devices (name, brand, category, description, icon, color, price, interest_rate, months, down_payment_percent, stock, featured)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const devices = [
    ['iPhone 15 Pro', 'Apple', 'هاتف ذكي', 'أحدث إصدارات آبل مع كاميرا احترافية وشريحة A17 Pro وأداء استثنائي.', 'smartphone', 'from-slate-700 to-slate-900', 5200, 15, 12, 20, 5, 1],
    ['iPhone 13', 'Apple', 'هاتف ذكي', 'هاتف موثوق بأداء قوي وكاميرا ممتازة وسعر مناسب.', 'smartphone', 'from-slate-500 to-slate-700', 3000, 15, 12, 20, 7, 1],
    ['Galaxy S23 Ultra', 'Samsung', 'هاتف ذكي', 'أقوى هواتف سامسونج بشاشة كبيرة وقلم S Pen وكاميرا 200 ميجابكسل.', 'smartphone', 'from-indigo-500 to-purple-700', 4800, 15, 12, 20, 4, 1],
    ['Galaxy A54', 'Samsung', 'هاتف ذكي', 'هاتف اقتصادي ممتاز بتصميم عصري وأداء متوازن للاستخدام اليومي.', 'smartphone', 'from-sky-500 to-blue-700', 1200, 15, 6, 30, 10, 0],
    ['Galaxy Z Flip 5', 'Samsung', 'هاتف ذكي', 'هاتف قابل للطي بتصميم أنيق وشاشة خارجية عملية.', 'smartphone', 'from-fuchsia-500 to-pink-600', 3800, 15, 12, 20, 3, 1],
    ['Redmi Note 13', 'Xiaomi', 'هاتف ذكي', 'قيمة ممتازة مقابل السعر مع بطارية ضخمة وشاشة AMOLED.', 'smartphone', 'from-amber-500 to-orange-600', 900, 15, 6, 30, 12, 0],
    ['MacBook Air M2', 'Apple', 'حاسوب محمول', 'خفيف وقوي مع شريحة M2 وبطارية تدوم طوال اليوم.', 'laptop_mac', 'from-zinc-500 to-zinc-800', 4800, 15, 12, 20, 3, 1],
    ['Lenovo ThinkPad', 'Lenovo', 'حاسوب محمول', 'جهاز أعمال موثوق بلوحة مفاتيح مريحة وأداء احترافي.', 'laptop_chromebook', 'from-neutral-600 to-neutral-900', 3500, 15, 12, 20, 6, 0],
    ['iPad Air M2', 'Apple', 'جهاز لوحي', 'جهاز لوحي أنيق بشاشة رائعة ودعم لقلم Apple Pencil.', 'tablet_mac', 'from-teal-500 to-emerald-700', 3400, 15, 12, 20, 5, 1],
    ['Galaxy Watch 6', 'Samsung', 'ساعة ذكية', 'ساعة ذكية بتتبع صحي متقدم وشاشة ساطعة وتصميم أنيق.', 'watch', 'from-cyan-500 to-teal-600', 1100, 15, 6, 20, 8, 0],
    ['Sony WH-1000XM5', 'Sony', 'سماعات', 'أفضل سماعات عازلة للضوضاء مع جودة صوت استثنائية.', 'headphones', 'from-slate-600 to-slate-900', 950, 15, 6, 30, 9, 0]
  ];

  devices.forEach((d) => ins.run(...d));
}

function reloadDatabase() {
  if (conn) {
    try { conn.close(); } catch (e) { /* ignore */ }
  }
  conn = null;
  openConnection();
  initSchema();
  ensureSettings();
  syncOverdueStatus();
}

function backupDatabase(destPath) {
  const safe = String(destPath).replace(/'/g, "''");
  conn.exec(`VACUUM INTO '${safe}'`);
  return destPath;
}

function validateDatabaseFile(filePath) {
  try {
    const check = new Database(filePath, { readonly: true });
    const result = check.pragma('integrity_check', { simple: true });
    check.close();
    return result === 'ok';
  } catch (e) {
    return false;
  }
}

function restoreDatabase(srcPath) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  const preBackup = path.join(BACKUP_DIR, `auto-backup-${stamp}.db`);
  backupDatabase(preBackup);

  if (conn) {
    try { conn.close(); } catch (e) { /* ignore */ }
  }
  conn = null;

  fs.copyFileSync(srcPath, DB_PATH);
  [DB_PATH + '-wal', DB_PATH + '-shm'].forEach((f) => {
    try { fs.unlinkSync(f); } catch (e) { /* ignore */ }
  });

  openConnection();
  initSchema();
  ensureSettings();
  syncOverdueStatus();
  return preBackup;
}

const proxy = new Proxy({}, {
  get(target, prop) {
    if (prop === 'createContractAndInstallments') return createContractAndInstallments;
    if (prop === 'registerPayment') return registerPayment;
    if (prop === 'syncOverdueStatus') return syncOverdueStatus;
    if (prop === 'reloadDatabase') return reloadDatabase;
    if (prop === 'backupDatabase') return backupDatabase;
    if (prop === 'validateDatabaseFile') return validateDatabaseFile;
    if (prop === 'restoreDatabase') return restoreDatabase;
    if (prop === 'isConnected') return !!conn;
    if (conn && typeof conn[prop] === 'function') return conn[prop].bind(conn);
    if (conn) return conn[prop];
    return undefined;
  }
});

openConnection();
initSchema();
ensureSettings();
seedIfEmpty();
seedDevicesIfEmpty();
syncOverdueStatus();

module.exports = proxy;
