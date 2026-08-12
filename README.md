# نظام إدارة الأقساط — Installment Management System

نظام متكامل لإدارة بيع الأجهزة (هواتف، أجهزة لوحية، حواسيب…) بالتقسيط، يشمل إدارة العملاء، العقود، الأقساط الشهرية، الدفعات، الإشعارات، التقارير، والأجهزة المتاحة للتقسيط.

A complete web application for managing mobile/device installment sales: customers, contracts, monthly installments, payments, notifications, reports, and a public storefront with WhatsApp ordering.

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Requirements](#requirements)
- [Installation](#installation)
- [Running the Application](#running-the-application)
- [Default Credentials](#default-credentials)
- [Configuration (Environment Variables)](#configuration-environment-variables)
- [Application Walkthrough](#application-walkthrough)
- [How Installments Are Calculated](#how-installments-are-calculated)
- [Database & Backups](#database--backups)
- [Troubleshooting](#troubleshooting)

---

## Features

- **Public storefront** (`/`) — showcases catalog devices with installment plans, images, and a "Order via WhatsApp" button.
- **Admin panel** at `/rent` with session-based login (signed cookie, no external session store).
- **Customer management** — add/edit/delete customers, national ID, full address, phone.
- **Contract & installment generation** — one click creates a contract with interest, down payment, monthly installments, and due dates.
- **Payment registration** — record cash or bank-transfer payments against the current due installment; contracts auto-mark as *finished* when fully paid.
- **Overdue tracking** — installments are auto-flagged as `overdue` past their due date; overdue customers surface in dashboards and reports.
- **Notifications center** — system, overdue, and upcoming-payment notifications with read/unread state.
- **Reports** — dashboard stats, 7-day sales chart, upcoming dues, overdue list, and a CSV export of overdue customers.
- **Device catalog management** — add/edit devices, prices, interest rates, installment plans, stock, featured flags, and up to 8 images per device.
- **User management** — manage admin/staff accounts and roles (system users, not used for login).
- **Settings** — default interest rate, number of months, down-payment percent, and currency.
- **Database backup/restore** — export a full `.db` backup and import one back, with an automatic safety backup created before every restore.
- **RTL Arabic UI** — built with Tailwind CSS (CDN) and Material Symbols icons.

---

## Tech Stack

| Layer      | Technology                                    |
|------------|-----------------------------------------------|
| Runtime    | Node.js                                       |
| Framework  | Express 4                                     |
| Templating | EJS                                           |
| Database   | SQLite via better-sqlite3 (synchronous; rollback-journal mode by default, WAL opt-in) |
| Uploads    | multer                                        |
| Frontend   | Tailwind CSS (CDN), Material Symbols, vanilla JS |

---

## Project Structure

```
rent/
├── server.js              # Express app, routes, auth, API endpoints
├── db.js                  # SQLite connection, schema, seeding, backup/restore
├── helpers.js             # Shared data helpers (summaries, stats, formatting)
├── package.json
├── installments.db        # SQLite database (auto-created; -wal/-shm files only appear if WAL is enabled)
├── backups/               # Automatic safety backups created before DB restore
├── logo/                  # Brand logos (served at /logo)
├── public/
│   └── uploads/devices/   # Uploaded device images
├── views/
│   ├── partials/          # head, sidebar, scripts, header shared layouts
│   ├── home.ejs           # Public storefront
│   ├── rent-login.ejs     # Admin login
│   ├── dashboard.ejs      # Admin dashboard
│   ├── customers.ejs      # Customer list
│   ├── customer-detail.ejs
│   ├── add-customer.ejs
│   ├── register-payment.ejs
│   ├── reports.ejs
│   ├── notifications.ejs
│   ├── settings.ejs
│   ├── contract.ejs       # Printable contract view
│   └── 404.ejs
```

### Main routes

| Method | Route                          | Purpose                                        |
|--------|--------------------------------|------------------------------------------------|
| GET    | `/`                            | Public storefront (catalog + installment plans) |
| GET    | `/rent`                        | Admin login page                               |
| POST   | `/rent/login`                  | Login (issues signed session cookie)           |
| GET    | `/rent/dashboard`              | Admin dashboard stats                          |
| GET    | `/rent/customers`              | Customer list (search / filter / pagination)   |
| GET    | `/rent/customers/:id`          | Customer detail + installment table            |
| GET    | `/rent/customers/:id/print`    | Printable contract                             |
| GET    | `/rent/add-customer`           | Add customer form                              |
| GET    | `/rent/register-payment`       | Register a payment                             |
| GET    | `/rent/reports`                | Reports page                                   |
| GET    | `/rent/settings`               | Settings (financial constants, devices, users, DB backup) |
| GET    | `/rent/notifications`          | Notifications center                           |
| POST   | `/api/customers`               | Create customer + contract + installments      |
| DELETE | `/api/customers/:id`           | Delete customer (cascades)                     |
| POST   | `/api/payments`                | Register a payment                             |
| GET    | `/api/database/export`         | Download full database backup (`.db`)          |
| POST   | `/api/database/import`         | Restore a database from an uploaded `.db` file |
| GET    | `/api/reports/export`          | Download overdue report as CSV                 |
| …      | `/api/*`                       | Devices, users, notifications, settings, etc.  |

All `/api/*` and `/rent/*` routes (except login) require an authenticated admin session.

---

## Requirements

- **Node.js** ≥ 18 (tested on **Node v20**)
- **npm** (bundled with Node)
- A modern browser (Chrome, Edge, Firefox, Safari) — the UI uses ES2015+ APIs (`closest`, `NodeList.forEach`, arrow functions).
- **Internet connection on first load** — Tailwind CSS and Google Fonts are loaded from CDNs.

> **Windows note:** `better-sqlite3` ships prebuilt binaries for common Node versions. If installation compiles from source you will need a C++ toolchain (Visual Studio Build Tools) — but this is usually unnecessary on recent Node versions.

---

## Installation

```bash
# 1. Open a terminal in the project folder
cd rent

# 2. Install dependencies
npm install
```

If `npm install` fails for `better-sqlite3`, try forcing a rebuild:

```bash
npm rebuild better-sqlite3
```

---

## Running the Application

```bash
# Start the server
npm start

# or equivalently:
node server.js
```

The server prints:

```
نظام إدارة الأقساط يعمل على: http://localhost:3000
```

Open the following in your browser:

- **Public site:** http://localhost:3000/
- **Admin login:** http://localhost:3000/rent

To run on a different port:

```bash
PORT=4000 node server.js        # Linux / macOS / Git Bash
# or on PowerShell/CMD:
$env:PORT=4000; node server.js  # PowerShell
set PORT=4000 && node server.js # CMD
```

On first start the application automatically:

1. Creates `installments.db` if missing.
2. Creates the schema (`settings`, `customers`, `contracts`, `installments`, `payments`, `notifications`, `catalog_devices`, `device_images`, `device_types`, `users`).
3. Seeds sample customers, contracts, devices, and notifications when the database is empty — so you can explore immediately.

---

## Default Credentials

| Field    | Value   |
|----------|---------|
| Username | `admin` |
| Password | `12345` |

> **Change these in production** via the environment variables below.

---

## Configuration (Environment Variables)

| Variable          | Default            | Description                                        |
|-------------------|--------------------|----------------------------------------------------|
| `PORT`            | `3000`             | HTTP port the server listens on                    |
| `ADMIN_USER`      | `admin`            | Admin login username                               |
| `ADMIN_PASSWORD`  | `12345`            | Admin login password                               |
| `SESSION_SECRET`  | `rent-admin-secret-2026` | Secret used to sign the session cookie. Change it! |

Example:

```bash
ADMIN_USER=admin ADMIN_PASSWORD=MyStrongPassword SESSION_SECRET=$(openssl rand -hex 32) npm start
```

---

## Application Walkthrough

### 1. Public Storefront (`/`)

Lists all catalog devices with their installment plan (full price, down payment, monthly installment, months, interest). Each device shows a **"التفاصيل وخطة التقسيط"** modal and an **"اطلب هذا الجهاز الآن"** WhatsApp button that pre-fills an order message (the WhatsApp number is a constant in `views/home.ejs` — `WHATSAPP_NUMBER`).

### 2. Admin Login (`/rent`)

Log in with the admin credentials. A signed, HTTP-only cookie (`rent_session`) keeps you logged in for **8 hours**.

### 3. Dashboard (`/rent/dashboard`)

Overview cards: total customers, devices sold, amounts paid, amounts due, collection rate. Recent payments and overdue alerts are shown on the page.

### 4. Add Customer (`/rent/add-customer`)

Fill in personal details, the device type/model, and the **full device price**. The installment plan is calculated live:

- Total after interest = price × (1 + interest%)
- Down payment = total × down-payment%
- Monthly installment = (total − down payment) ÷ months

The price field accepts **Western digits, Arabic–Indic digits (٠–٩), and Persian digits (۰–۹)** — they are normalized automatically. Non-numeric text is rejected with a clear message.

### 5. Customers List (`/rent/customers`)

Search by name/phone/national ID, filter by status (ملتزم / متأخر / منتهي), paginated table with paid/total progress bars and quick actions.

### 6. Customer Detail (`/rent/customers/:id`)

Full contract summary, installment table with due dates and statuses, payment history, a printable contract, and a "send payment reminder" action.

### 7. Register Payment (`/rent/register-payment`)

Search for a customer, review the current due installment, enter the amount and payment method (cash / bank transfer), and confirm. The installment and contract statuses update automatically; the contract becomes **finished** when all installments are paid.

### 8. Notifications (`/rent/notifications`)

Centers for overdue / upcoming / system notifications. Mark as read, send reminders, or mark all as read.

### 9. Reports (`/rent/reports`)

30-day profit, upcoming dues (7 days), overdue totals, a 7-day sales chart, and a downloadable **CSV** of overdue customers.

### 10. Settings (`/rent/settings`)

- **Financial constants:** default interest rate, months, down-payment %, currency.
- **Device types:** add/remove device categories.
- **Catalog devices:** add/edit/delete devices, plan parameters, stock, featured, and images.
- **Users:** manage system users and roles.
- **Database backup:** export and import the full database (see below).

---

## How Installments Are Calculated

Given the full price, the system uses the settings (or per-device overrides) as follows:

```
totalWithInterest = round2(fullPrice * (1 + interestRate / 100))
downPayment       = round2(totalWithInterest * downPercent / 100)
financedAmount    = round2(totalWithInterest - downPayment)
monthlyAmount     = round2(financedAmount / months)
```

The down payment is recorded as an immediate payment at contract signing, and `months` monthly installments are created with due dates starting one month after the start date. Due dates use `toISOString().slice(0, 10)`, so they follow **UTC** dates.

---

## Database & Backups

The database is a single SQLite file: **`installments.db`**. It runs in rollback-journal (`DELETE`) mode by default, which is the most portable option for shared hosting. To opt in to WAL mode (better concurrency, only if your hosting's filesystem supports it), set the environment variable `DB_JOURNAL_MODE=wal` before starting the server.

### Export (backup)

In **Settings → النسخ الاحتياطي لقاعدة البيانات**, click **تصدير نسخة احتياطية** — the server creates a consistent snapshot (`VACUUM INTO`) and downloads it as `installments-backup-<timestamp>.db`.

You can also download it directly at:

```
GET /api/database/export   (authenticated)
```

### Import (restore)

In the same section, choose a `.db` / `.sqlite` / `.sqlite3` file and click **استيراد**. Before restoring, the server:

1. Validates the file is a real SQLite database (`PRAGMA integrity_check`).
2. Creates an automatic safety backup in the `backups/` folder (`auto-backup-<timestamp>.db`).
3. Closes the live connection, swaps in the uploaded file, clears stale WAL/SHM files, and reopens.

After a successful import the page reloads automatically. The current data is only replaced after a valid file is confirmed, and the pre-restore backup lets you roll back.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `database is locked` (قاعدة البيانات مقفلة) | The server now waits up to 5s for locks and defaults to `DELETE` journal mode, so this usually appears only if the DB folder is not writable, a stale `installments.db-wal`/`installments.db-shm` lock exists, or another Node instance is running. Stop all server instances, delete any leftover `installments.db-wal` / `installments.db-shm` files, ensure the folder containing `installments.db` is writable by the app user (`chmod 775` on the dir, `chmod 666` on the DB file on Linux hosts), and restart with a single process. |
| `EADDRINUSE` / port already in use | Another instance is running. Stop it (or its process) and start again, or run on another port: `PORT=4000 node server.js`. |
| `Error: ... install better-sqlite3` | Run `npm install` again, or `npm rebuild better-sqlite3`. Ensure Node is recent (≥ 18). |
| Page shows "الصفحة التي تبحث عنها غير موجودة" (404) after adding a customer/payment | Make sure you're running the latest `server.js` — older versions redirected without the `/rent` prefix. Restart the server. |
| Price/amount fields reject Arabic digits | The fields now accept Arabic and Persian numerals automatically. If a non-numeric value is entered, you'll get a validation error. |
| Tailwind styles missing / unstyled page | You need internet access on the page load (Tailwind + fonts load from CDNs). |
| Changes don't appear | Restart the server — EJS views are read per-request, but `server.js` / `db.js` require a restart. |
| Cannot log in | Verify `ADMIN_USER` / `ADMIN_PASSWORD`; the defaults are `admin` / `12345`. |
| DB restore fails | Ensure the uploaded file is a valid SQLite database (a backup exported from this app works best). |

---

*نظام إدارة الأقساط — Mobile Installment Management System. Built with Express, EJS, and SQLite.*
