const db = require('./db');

function round2(n) {
  return Math.round(n * 100) / 100;
}

function fmtMoney(n, currency) {
  if (n == null) return '0 ' + (currency || 'ر.س');
  const num = Math.round(n * 100) / 100;
  return num.toLocaleString('en-US') + ' ' + (currency || 'ر.س');
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleDateString('ar-SA-u-ca-gregory', { year: 'numeric', month: 'long', day: 'numeric' });
}

function getSettings() {
  return db.prepare('SELECT * FROM settings WHERE id = 1').get();
}

function getCustomerSummary(customerId) {
  const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(customerId);
  const contract = db.prepare('SELECT * FROM contracts WHERE customer_id = ? ORDER BY id DESC LIMIT 1').get(customerId);
  if (!contract) return null;

  const installments = db.prepare('SELECT * FROM installments WHERE contract_id = ? ORDER BY installment_number').all(contract.id);
  const totalPaid = db.prepare('SELECT COALESCE(SUM(amount),0) total FROM payments WHERE customer_id = ?').get(customerId).total;
  const installmentsPaid = installments.reduce((s, i) => s + i.paid_amount, 0);
  const paidCount = installments.filter((i) => i.status === 'paid').length;
  const totalMonths = installments.length;
  const remaining = round2(contract.financed_amount - installmentsPaid);
  const overdue = installments.some((i) => i.status === 'overdue');

  let status = 'finished';
  if (contract.status === 'active') {
    status = overdue ? 'overdue' : 'committed';
  }

  return {
    customer: c,
    contract,
    installments,
    paidCount,
    totalMonths,
    totalPaid,
    installmentsPaid,
    remaining,
    status
  };
}

function getUnpaidInstallmentsForCustomer(customerId) {
  return db.prepare(`
    SELECT i.*, c.device_name, c.device_model, c.customer_id
    FROM installments i
    JOIN contracts c ON c.id = i.contract_id
    WHERE c.customer_id = ? AND i.status != 'paid'
    ORDER BY i.due_date
  `).all(customerId);
}

function getCurrentDueForCustomer(customerId) {
  return getUnpaidInstallmentsForCustomer(customerId)[0] || null;
}

function getOverdueCustomers() {
  const rows = db.prepare(`
    SELECT i.*, c.name customer_name, c.phone, cu.id contract_id, cu.customer_id,
      julianday('now') - julianday(i.due_date) AS late_days
    FROM installments i
    JOIN contracts cu ON cu.id = i.contract_id
    JOIN customers c ON c.id = cu.customer_id
    WHERE i.status = 'overdue'
    ORDER BY i.due_date
  `).all();
  return rows;
}

function getUpcomingDue(days = 7) {
  const today = new Date();
  const limit = new Date(today);
  limit.setDate(limit.getDate() + days);
  return db.prepare(`
    SELECT i.*, c.name customer_name, cu.id contract_id, cu.customer_id
    FROM installments i
    JOIN contracts cu ON cu.id = i.contract_id
    JOIN customers c ON c.id = cu.customer_id
    WHERE i.status = 'unpaid' AND i.due_date >= ? AND i.due_date <= ?
    ORDER BY i.due_date
  `).all(today.toISOString().slice(0, 10), limit.toISOString().slice(0, 10));
}

function getDashboardStats() {
  const settings = getSettings();
  const totalCustomers = db.prepare('SELECT COUNT(*) c FROM customers').get().c;
  const devicesSold = db.prepare('SELECT COUNT(*) c FROM contracts').get().c;
  const amountsPaid = db.prepare('SELECT COALESCE(SUM(amount),0) t FROM payments').get().t;
  const totalPayable = db.prepare('SELECT COALESCE(SUM(total_payable),0) t FROM contracts').get().t;
  const amountsDue = totalPayable - amountsPaid;
  const collectionRate = totalPayable > 0 ? Math.round((amountsPaid / totalPayable) * 100) : 0;

  const recentPayments = db.prepare(`
    SELECT p.*, c.name customer_name
    FROM payments p
    JOIN customers c ON c.id = p.customer_id
    ORDER BY p.payment_date DESC, p.id DESC
    LIMIT 8
  `).all();

  const overdueAlerts = getOverdueCustomers().slice(0, 6);

  return { settings, totalCustomers, devicesSold, amountsPaid, amountsDue, collectionRate, recentPayments, overdueAlerts };
}

function getReportsData() {
  const settings = getSettings();
  const totalProfit = db.prepare(`
    SELECT COALESCE(SUM(amount),0) t FROM payments
    WHERE payment_date >= date('now', '-30 days')
  `).get().t;

  const due7 = getUpcomingDue(7);
  const due7Sum = due7.reduce((s, i) => s + i.amount, 0);

  const overdue = getOverdueCustomers();
  const overdueSum = overdue.reduce((s, i) => s + i.amount, 0);
  const overdueCustomersCount = new Set(overdue.map((o) => o.customer_id)).size;

  // Sales data: last 7 days daily
  const sales = [];
  for (let d = 6; d >= 0; d--) {
    const day = new Date();
    day.setDate(day.getDate() - d);
    const key = day.toISOString().slice(0, 10);
    const total = db.prepare('SELECT COALESCE(SUM(amount),0) t FROM payments WHERE payment_date = ?').get(key).t;
    sales.push({ label: day.toLocaleDateString('ar-SA-u-ca-gregory', { weekday: 'short' }), value: total });
  }
  const salesMax = Math.max(...sales.map((s) => s.value), 1);

  const overdueTable = overdue.slice(0, 8);

  return { settings, totalProfit, due7, due7Sum, overdue, overdueSum, overdueCustomersCount, sales, salesMax, overdueTable };
}

function addNotification(type, title, message, customerId) {
  db.prepare('INSERT INTO notifications (type, title, message, related_customer_id) VALUES (?, ?, ?, ?)')
    .run(type, title, message, customerId);
}

function devicePlan(d) {
  const totalWithInterest = round2(d.price * (1 + d.interest_rate / 100));
  const downPayment = round2(totalWithInterest * d.down_payment_percent / 100);
  const financedAmount = round2(totalWithInterest - downPayment);
  const monthlyAmount = d.months > 0 ? round2(financedAmount / d.months) : 0;
  return { totalWithInterest, downPayment, financedAmount, monthlyAmount };
}

function getDeviceImages(deviceId) {
  return db.prepare('SELECT * FROM device_images WHERE device_id = ? ORDER BY sort_order, id').all(deviceId);
}

function getCatalogDevice(id) {
  const d = db.prepare('SELECT * FROM catalog_devices WHERE id = ?').get(id);
  if (!d) return null;
  return Object.assign(d, devicePlan(d), { images: getDeviceImages(id) });
}

function getCatalogDevices() {
  const rows = db.prepare('SELECT * FROM catalog_devices ORDER BY id DESC').all();
  return rows.map((d) => Object.assign(d, devicePlan(d), { images: getDeviceImages(d.id) }));
}

module.exports = {
  fmtMoney,
  fmtDate,
  getSettings,
  getCustomerSummary,
  getUnpaidInstallmentsForCustomer,
  getCurrentDueForCustomer,
  getOverdueCustomers,
  getUpcomingDue,
  getDashboardStats,
  getReportsData,
  addNotification,
  devicePlan,
  getDeviceImages,
  getCatalogDevice,
  getCatalogDevices
};
