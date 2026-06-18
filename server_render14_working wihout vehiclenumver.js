// ============================================================
//  IndhanShodhak — server.js  (sql.js version)
//  Works on Node.js v24 — no compilation needed
//  FIXED: RevGeocode Nearby API for Cloud Static Key
// ============================================================

require('dotenv').config();
const express    = require('express');
const initSqlJs  = require('sql.js');
const path       = require('path');
const crypto     = require('crypto');
const multer     = require('multer');
const fs         = require('fs');
const nodemailer = require('nodemailer');

const app  = express();
const PORT = process.env.PORT || 3000;

const DB_PATH     = process.env.NODE_ENV === 'production'
  ? '/data/indhan.db'
  : path.join(__dirname, 'indhan.db');
const UPLOAD_PATH = process.env.NODE_ENV === 'production'
  ? '/data/uploads/pump-docs'
  : path.join(__dirname, 'uploads', 'pump-docs');
const PUBLIC_PATH = path.join(__dirname, 'public');

if (!fs.existsSync(UPLOAD_PATH)) fs.mkdirSync(UPLOAD_PATH, { recursive: true });

// ── sql.js setup — pure JS SQLite, no compilation needed ─────
let SQL, db;

// ✅ FIX: Move otpStore to top for availability
const otpStore        = {};   // OTP storage per mobile
const otpRequestCount = {};   // 60s rate limiting per mobile

async function initDB() {
  SQL = await initSqlJs();

  // Load existing DB file if it exists
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Save DB to file after every write
  function saveDB() {
    const data = db.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }

  // Wrap db with save-on-write helpers
  db.runSave = function(sql, params) {
    db.run(sql, params);
    saveDB();
  };

  db.execSave = function(sql) {
    db.exec(sql);
    saveDB();
  };

  // Create tables
  db.execSave(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY, value TEXT
    );
    CREATE TABLE IF NOT EXISTS users (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      mobile                TEXT UNIQUE,
      name                  TEXT NOT NULL,
      role                  TEXT DEFAULT 'user',
      email                 TEXT,
      password_hash         TEXT,
      language              TEXT DEFAULT 'en',
      trial_start_date      TEXT,
      subscription_status   TEXT DEFAULT 'trial',
      subscription_end_date TEXT,
      is_active             INTEGER DEFAULT 1,
      created_at            TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS petrol_pumps (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT NOT NULL,
      address        TEXT,
      tehsil         TEXT,
      district       TEXT,
      state          TEXT DEFAULT 'Maharashtra',
      pin_code       TEXT,
      lat            REAL,
      lng            REAL,
      oil_company    TEXT,
      license_number TEXT,
      owner_user_id  INTEGER,
      is_verified    INTEGER DEFAULT 0,
      is_active      INTEGER DEFAULT 1,
      created_at     TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fuel_reports (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      pump_id       INTEGER NOT NULL,
      reported_by   INTEGER NOT NULL,
      reporter_role TEXT DEFAULT 'user',
      petrol        INTEGER DEFAULT 0,
      diesel        INTEGER DEFAULT 0,
      cng           INTEGER DEFAULT 0,
      ev            INTEGER DEFAULT 0,
      queue_length  TEXT DEFAULT 'none',
      restock_note  TEXT,
      expires_at    TEXT,
      created_at    TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS pump_applications (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id         INTEGER NOT NULL,
      pump_id         INTEGER NOT NULL,
      applicant_name  TEXT,
      applicant_email TEXT,
      license_number  TEXT NOT NULL,
      doc_license     TEXT,
      doc_aadhaar     TEXT,
      doc_selfie      TEXT,
      status          TEXT DEFAULT 'pending',
      reject_reason   TEXT,
      reviewed_by     INTEGER,
      applied_at      TEXT DEFAULT (datetime('now')),
      reviewed_at     TEXT
    );
    CREATE TABLE IF NOT EXISTS user_fuel_applications (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id               INTEGER NOT NULL,
      applicant_name        TEXT NOT NULL,
      applicant_email       TEXT,
      vehicle_number        TEXT NOT NULL,
      fuel_type             TEXT NOT NULL,
      category              TEXT NOT NULL,
      profession            TEXT,
      doc_aadhaar           TEXT,
      doc_vehicle_rc        TEXT,
      doc_dept_id           TEXT,
      doc_official_letter   TEXT,
      doc_profession_cert   TEXT,
      doc_employer_letter   TEXT,
      doc_commercial_permit TEXT,
      doc_driver_licence    TEXT,
      doc_kisan_card        TEXT,
      doc_land_record       TEXT,
      status                TEXT DEFAULT 'pending',
      reject_reason         TEXT,
      reviewed_by           INTEGER,
      fuel_account_id       INTEGER,
      applied_at            TEXT DEFAULT (datetime('now')),
      reviewed_at           TEXT
    );
    CREATE TABLE IF NOT EXISTS fuel_accounts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id        INTEGER UNIQUE NOT NULL,
      vehicle_number TEXT NOT NULL,
      fuel_type      TEXT NOT NULL,
      category       TEXT NOT NULL,
      profession     TEXT,
      qr_code_data   TEXT,
      qr_image_b64   TEXT,
      is_active      INTEGER DEFAULT 1,
      activated_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS fuel_transactions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      fuel_account_id  INTEGER NOT NULL,
      pump_id          INTEGER NOT NULL,
      pump_operator_id INTEGER,
      litres_dispensed REAL NOT NULL,
      fuel_type        TEXT,
      category         TEXT,
      vehicle_number   TEXT,
      district         TEXT,
      tehsil           TEXT,
      state            TEXT,
      lock_until       TEXT,
      status           TEXT DEFAULT 'dispensed',
      deny_reason      TEXT,
      transaction_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS verifier_actions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      action      TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id   INTEGER NOT NULL,
      target_name TEXT,
      reason      TEXT,
      verifier_id INTEGER,
      created_at  TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL,
      created_at  TEXT DEFAULT (datetime('now')),
      expires_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS visitor_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page TEXT,
      ip TEXT,
      visited_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Default settings
  const settingsList = [
    ['subscription_price','14.99'], ['trial_days','10'],
    ['mapmyindia_token','NOT_SET'],
    ['tier_P1_litres','9999'], ['tier_P2_litres','20'],
    ['tier_P3_litres','50'],   ['tier_P4_litres','30'], ['tier_P5_litres','10'],
    ['tier_P1_hrs','0'],       ['tier_P2_hrs','72'],
    ['tier_P3_hrs','48'],      ['tier_P4_hrs','72'],    ['tier_P5_hrs','72'],
    ['report_expiry_user','4'],     ['report_expiry_owner','12'],
    ['rationing_mode','0'],          ['verification_mode','0'],
    ['sla_hours','48'],              ['admin_email', process.env.EMAIL_USER||''],
  ];
  settingsList.forEach(([k,v]) => {
    db.runSave(`INSERT OR IGNORE INTO settings (key,value) VALUES (?,?)`, [k,v]);
  });

  // Super admin — custom login ID (not mobile number)
  const adminCheck = dbGet(`SELECT id FROM users WHERE role='super_admin'`);
  if (!adminCheck) {
    const adminId  = process.env.ADMIN_LOGIN_ID  || 'IS_ADMIN_2026_DKG';
    const adminPwd = process.env.ADMIN_PASSWORD   || 'IndhanAdmin@2026';
    db.runSave(`
      INSERT INTO users (mobile,name,role,password_hash,email,subscription_status)
      VALUES (?,?,?,?,?,?)
    `, [adminId, 'Dr. Kishor Galnimbkar', 'super_admin', hashPwd(adminPwd), process.env.EMAIL_USER||'', 'active']);
    console.log('[DB] ==========================================');
    console.log('[DB] Super Admin Created!');
    console.log('[DB] Login ID  : ' + adminId);
    console.log('[DB] Password  : ' + adminPwd);
    console.log('[DB] ==========================================');
  }

  // Add new columns safely — ignore if already exist
  const safeAlter = [
    `CREATE TABLE IF NOT EXISTS payment_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER, payment_id TEXT, order_id TEXT,
      amount INTEGER, status TEXT,
      paid_at TEXT DEFAULT (datetime('now'))
    )`,
    `ALTER TABLE users ADD COLUMN razorpay_payment_id TEXT`,
    `ALTER TABLE users ADD COLUMN pump_login_id TEXT`,
    `ALTER TABLE users ADD COLUMN plain_password TEXT`,
    `ALTER TABLE users ADD COLUMN category TEXT`,
    `ALTER TABLE users ADD COLUMN qr_code_data TEXT`,
    `ALTER TABLE users ADD COLUMN original_category TEXT`,
    `ALTER TABLE fuel_accounts ADD COLUMN category TEXT`,
    `ALTER TABLE fuel_accounts ADD COLUMN profession TEXT`,
    `ALTER TABLE fuel_accounts ADD COLUMN qr_code_data TEXT`,
    `ALTER TABLE petrol_pumps ADD COLUMN scan_count_free INTEGER DEFAULT 0`,
    `ALTER TABLE petrol_pumps ADD COLUMN scan_period_start TEXT`,
    `ALTER TABLE petrol_pumps ADD COLUMN is_verified_active INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN category TEXT`,
    `ALTER TABLE users ADD COLUMN qr_code_data TEXT`,
    `ALTER TABLE fuel_accounts ADD COLUMN category TEXT`,
    `ALTER TABLE fuel_accounts ADD COLUMN profession TEXT`,
    `ALTER TABLE fuel_accounts ADD COLUMN qr_code_data TEXT`,
    `ALTER TABLE users ADD COLUMN subscription_paid_at TEXT`,
    `CREATE TABLE IF NOT EXISTS fuel_dispense_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      vehicle_number TEXT,
      pump_id INTEGER,
      dispensed_by INTEGER,
      litres REAL,
      fuel_type TEXT,
      category TEXT DEFAULT 'P5',
      dispensed_at TEXT DEFAULT (datetime('now'))
    )`,
    `ALTER TABLE users ADD COLUMN aadhaar_number TEXT`,
    `ALTER TABLE users ADD COLUMN aadhaar_verified INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN vehicle_number TEXT`,
    `ALTER TABLE users ADD COLUMN profile_complete INTEGER DEFAULT 0`,
    `ALTER TABLE users ADD COLUMN qr_code_data TEXT`,
    `ALTER TABLE users ADD COLUMN qr_image_b64 TEXT`,
    `ALTER TABLE users ADD COLUMN user_code TEXT`,
    `ALTER TABLE petrol_pumps ADD COLUMN staff_password TEXT`,
    `CREATE TABLE IF NOT EXISTS pump_staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pump_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      joined_at TEXT DEFAULT (datetime('now')),
      UNIQUE(pump_id, user_id)
    )`,
    `CREATE TABLE IF NOT EXISTS daily_stats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT UNIQUE,
      new_users INTEGER DEFAULT 0,
      new_paid INTEGER DEFAULT 0,
      revenue REAL DEFAULT 0,
      reports_filed INTEGER DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS ai_verify_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_type TEXT NOT NULL,
      application_id INTEGER NOT NULL,
      app_table TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      pass_number INTEGER DEFAULT 1,
      retry_count INTEGER DEFAULT 0,
      score INTEGER,
      verdict TEXT,
      reason TEXT,
      ai_provider TEXT,
      ai_raw TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      processed_at TEXT
    )`,
    `ALTER TABLE ai_verify_queue ADD COLUMN retry_count INTEGER DEFAULT 0`,
  ];
  safeAlter.forEach(sql => {
    try { db.run(sql); db.export && fs.writeFileSync(DB_PATH, Buffer.from(db.export())); }
    catch(e) { /* column already exists — ignore */ }
  });

  // ── User Code Generator (4 letters A-Z no I/O + 4 digits 1-9 no 0) ──
  function generateUserCode() {
    const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // 24 letters, no I, no O
    const D = '123456789';                 // 9 digits, no 0
    let code = '';
    for (let i = 0; i < 4; i++) code += L[Math.floor(Math.random() * L.length)];
    for (let i = 0; i < 4; i++) code += D[Math.floor(Math.random() * D.length)];
    return code; // e.g. BKTM7293
  }

  // ── Backfill: assign user_code to all existing users who don't have one ──
  try {
    const usersWithoutCode = db.exec(`SELECT id FROM users WHERE user_code IS NULL OR user_code = ''`);
    if (usersWithoutCode.length && usersWithoutCode[0].values.length) {
      let assigned = 0;
      for (const row of usersWithoutCode[0].values) {
        const uid = row[0];
        let code, attempts = 0;
        do {
          code = generateUserCode();
          attempts++;
        } while (dbGet('SELECT id FROM users WHERE user_code=?', [code]) && attempts < 100);
        db.run('UPDATE users SET user_code=? WHERE id=?', [code, uid]);
        assigned++;
      }
      db.export && fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
      console.log(`[USER_CODE] Backfilled ${assigned} users with unique codes.`);
    }
    // ── Force QR re-generation with new black QR style ──
    // Clear qr_image_b64 for users whose qr_code_data matches user_code (green QR already generated)
    // Next profile load will regenerate with black QR automatically
    const needsBlackQR = db.exec(`SELECT COUNT(*) as c FROM users WHERE user_code IS NOT NULL AND user_code != '' AND qr_image_b64 IS NOT NULL AND length(qr_image_b64) > 100`);
    const count = needsBlackQR?.[0]?.values?.[0]?.[0] || 0;
    if(count > 0) {
      db.run(`UPDATE users SET qr_image_b64=NULL WHERE user_code IS NOT NULL AND user_code != ''`);
      db.export && fs.writeFileSync(DB_PATH, Buffer.from(db.export()));
      console.log(`[QR REGEN] Cleared ${count} old QR images → black QR will regenerate on next profile load`);
    }
  } catch(e) { console.error('[USER_CODE] Backfill error:', e.message); }

  // Sample pumps
  const pumps = [
    ['HP Petrol Pump Newasa',  'Newasa Fata NH-61',  'Newasa',   'Ahilyanagar','Maharashtra','413736',19.5226,74.9602,'HP',  1],
    ['BPCL Rahata Road',       'Rahata Rd Shrirampur','Rahata',  'Ahilyanagar','Maharashtra','413709',19.6241,74.7324,'BPCL',0],
    ['IOC Pump Newasa Phata',  'NH-61 Newasa Phata', 'Newasa',   'Ahilyanagar','Maharashtra','413736',19.5105,74.9513,'IOC', 0],
    ['HP Kopargaon',           'Main Rd Kopargaon',  'Kopargaon','Ahilyanagar','Maharashtra','423601',19.8871,74.4796,'HP',  0],
    ['BPCL Sangamner',         'Pune Rd Sangamner',  'Sangamner','Ahilyanagar','Maharashtra','422605',19.5745,74.2091,'BPCL',0],
  ];
  // Only insert sample pumps if they don't already exist (check by name+lat to prevent duplicates on restart)
  pumps.forEach(p => {
    const already = dbGet('SELECT id FROM petrol_pumps WHERE name=? AND lat=? LIMIT 1', [p[0], p[6]]);
    if(!already) {
      db.runSave(`INSERT INTO petrol_pumps
        (name,address,tehsil,district,state,pin_code,lat,lng,oil_company,is_verified)
        VALUES (?,?,?,?,?,?,?,?,?,?)`, p);
    }
  });

  const pumpCount = dbGet(`SELECT COUNT(*) as c FROM petrol_pumps`);
  console.log('[DB] Ready ✅ | Pumps:', pumpCount?.c || 0);
  setTimeout(resumeAIQueue, 3000);
}

// ── DB helper functions ───────────────────────────────────────
function dbGet(sql, params=[]) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function dbAll(sql, params=[]) {
  const results = [];
  const stmt = db.prepare(sql);
  stmt.bind(params);
  while (stmt.step()) {
    results.push(stmt.getAsObject());
  }
  stmt.free();
  return results;
}

function dbRun(sql, params=[]) {
  db.run(sql, params);
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
  return db;
}

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
  if(req.path.startsWith('/api/')) return next();
  express.static(PUBLIC_PATH, { index: false })(req, res, next);
});

// ── Landing / Splash / Privacy routes ──
app.get('/', (req, res) => {
  res.sendFile(path.join(PUBLIC_PATH, 'landing.html'));
});
app.get('/splash', (req, res) => {
  res.sendFile(path.join(PUBLIC_PATH, 'splash.html'));
});
app.get('/privacy',  (req,res) => res.sendFile(path.join(PUBLIC_PATH,'privacy.html')));
app.get('/terms',    (req,res) => res.sendFile(path.join(PUBLIC_PATH,'terms.html')));
app.get('/shipping', (req,res) => res.sendFile(path.join(PUBLIC_PATH,'shipping.html')));
app.get('/contact',  (req,res) => res.sendFile(path.join(PUBLIC_PATH,'contact.html')));
app.get('/refunds',  (req,res) => res.sendFile(path.join(PUBLIC_PATH,'refunds.html')));

// ── Email — ZeptoMail (switch to Gmail: comment ZEPTO_PASS in .env, uncomment Gmail lines) ──
const mailer = nodemailer.createTransport({
  host: 'smtp.zeptomail.in',
  port: 587,
  secure: false,
  auth: {
    user: 'emailapikey',
    pass: process.env.ZEPTO_PASS || ''
  }
});

const MAIL_FROM = '"IndhanShodhak" <noreply@indhanshodhak.in>';

async function sendEmail(to, subject, html) {
  if (!process.env.ZEPTO_PASS) {
    console.log(`[EMAIL SKIPPED - ZEPTO_PASS not set] To: ${to}`);
    return;
  }
  try {
    await mailer.sendMail({ from: MAIL_FROM, to, subject, html });
    console.log(`[EMAIL SENT] ${to}`);
  } catch(e) { console.error('[EMAIL ERROR]', e.message); }
}

// ── File Upload ───────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const folder = path.join(UPLOAD_PATH, `app_${Date.now()}`);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
    cb(null, folder);
  },
  filename: (req, file, cb) => {
    const ext = file.mimetype==='application/pdf' ? '.pdf' : '.jpg';
    cb(null, file.fieldname + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 100*1024 },
  fileFilter: (req,file,cb) => {
    ['image/jpeg','application/pdf'].includes(file.mimetype) ? cb(null,true) : cb(new Error('Only JPG and PDF — max 100KB'));
  },
});

// ── Helpers ───────────────────────────────────────────────────
function hashPwd(p)    { return crypto.createHash('sha256').update(p+'indhan_salt_2026').digest('hex'); }
function getSetting(k) { const r=dbGet(`SELECT value FROM settings WHERE key=?`,[k]); return r?.value||null; }
function makeToken(id, mobile) {
  const token = crypto.randomBytes(32).toString('hex');
  dbRun(`INSERT OR REPLACE INTO sessions (token, user_id, expires_at)
         VALUES (?, ?, datetime('now', '+90 days'))`, [token, id]);
  return token;
}
function getUser(token) {
  if (!token) return null;
  try {
    // 1. Sessions table (new — 90-day expiry, survives restarts)
    const row = dbGet(
      `SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
       WHERE s.token=? AND s.expires_at>datetime('now') AND u.is_active=1`, [token]);
    if (row) return row;
    // 2. Legacy HMAC fallback (for users logged in before this update)
    const parts = token.split('.');
    if (parts.length===2 && !isNaN(parseInt(parts[0]))) {
      const user = dbGet(`SELECT * FROM users WHERE id=? AND is_active=1`,[parseInt(parts[0])]);
      if (user) {
        const exp = crypto.createHmac('sha256',process.env.TOKEN_SECRET||'indhan_tok_2026')
                          .update(String(user.id)+user.mobile).digest('hex');
        if (parts[1]===exp) {
          // Auto-migrate to sessions table
          dbRun(`INSERT OR IGNORE INTO sessions (token,user_id,expires_at)
                 VALUES (?,?,datetime('now','+90 days'))`, [token, user.id]);
          return user;
        }
      }
    }
    return null;
  } catch { return null; }
}
function requireAuth(roles=[]) {
  return (req,res,next) => {
    const token = req.headers['x-auth-token'];
    if (token && token.startsWith('GOVT.')) {
      const stored = otpStore['GOVT_' + token];
      if (!stored || Date.now() > stored.expires)
        return res.status(401).json({ error: 'Govt session expired. Please login again.' });
      if (roles.length && !roles.includes('govt_official'))
        return res.status(403).json({ error: 'Access denied' });
      req.user = { id: 0, mobile: 'GOVT', name: 'Govt Official', role: 'govt_official' };
      return next();
    }
    const user = getUser(req.headers['x-auth-token']);
    if (!user) return res.status(401).json({ error:'Login required' });
    if (roles.length && !roles.includes(user.role)) return res.status(403).json({ error:'Access denied' });
    req.user = user;
    next();
  };
}
function latestReport(pump_id) {
  return dbGet(`
    SELECT * FROM fuel_reports
    WHERE pump_id=? AND expires_at > datetime('now')
    ORDER BY CASE WHEN reporter_role='pump_owner' THEN 0 ELSE 1 END ASC, created_at DESC LIMIT 1
  `,[pump_id]);
}

function getTierLimits() {
  return {
    litres: {
      P1: parseInt(getSetting('tier_P1_litres')) || 9999,
      P2: parseInt(getSetting('tier_P2_litres')) || 20,
      P3: parseInt(getSetting('tier_P3_litres')) || 50,
      P4: parseInt(getSetting('tier_P4_litres')) || 30,
      P5: parseInt(getSetting('tier_P5_litres')) || 10,
    },
    hrs: {
      P1: parseInt(getSetting('tier_P1_hrs')) || 0,
      P2: parseInt(getSetting('tier_P2_hrs')) || 72,
      P3: parseInt(getSetting('tier_P3_hrs')) || 48,
      P4: parseInt(getSetting('tier_P4_hrs')) || 72,
      P5: parseInt(getSetting('tier_P5_hrs')) || 72,
    }
  };
}

// ── Visitor counter middleware ────────────────────────────────
app.use((req, res, next) => {
  const pages = ['/', '/govt', '/admin', '/verify', '/pump-owner', '/otp_login.html', '/profile_setup'];
  if (pages.includes(req.path)) {
    try { dbRun(`INSERT INTO visitor_log (page,ip) VALUES (?,?)`, [req.path, req.ip]); } catch(e){}
  }
  next();
});

app.get('/api/stats/visitors', (req, res) => {
  try {
    const today   = dbGet(`SELECT COUNT(*) as c FROM visitor_log WHERE date(visited_at)=date('now')`);
    const total   = dbGet(`SELECT COUNT(*) as c FROM visitor_log`);
    const week    = dbGet(`SELECT COUNT(*) as c FROM visitor_log WHERE visited_at>=datetime('now','-7 days')`);
    res.json({ today: today?.c||0, week: week?.c||0, total: total?.c||0 });
  } catch(e){ res.json({ today:0, week:0, total:0 }); }
});

app.get('/health', (req,res) => {
  const pumps = dbGet(`SELECT COUNT(*) as c FROM petrol_pumps`);
  const users = dbGet(`SELECT COUNT(*) as c FROM users`);
  res.json({ status:'ok', version:'1.0-sqljs', node:process.version, pumps:pumps?.c||0, users:users?.c||0, time:new Date().toISOString() });
});

// ============================================================
//  AUTH ROUTES
// ============================================================
app.post('/api/auth/register', (req,res) => {
  const { mobile, name, email, language='en' } = req.body;
  if (!mobile||!name) return res.status(400).json({ error:'mobile and name required' });
  if (dbGet(`SELECT id FROM users WHERE mobile=?`,[mobile]))
    return res.status(409).json({ error:'Mobile already registered. Please login.' });
  const days = parseInt(getSetting('trial_days')||'10');
  dbRun(`INSERT INTO users (mobile,name,email,language,trial_start_date,subscription_status)
         VALUES (?,?,?,?,datetime('now'),'trial')`, [mobile,name,email||null,language]);
  const user = dbGet(`SELECT id FROM users WHERE mobile=?`,[mobile]);
  res.json({ user_id:user.id, token:makeToken(user.id,mobile), trial_days:days, message:`Welcome! ${days}-day free trial started.` });
});

app.post('/api/auth/verify-admin-password', requireAuth(['super_admin']), (req, res) => {
  const { password } = req.body;
  if(!password) return res.status(400).json({ error:'Password required' });
  const user = dbGet(`SELECT * FROM users WHERE id=?`, [req.user.id]);
  if(!user) return res.status(404).json({ error:'User not found' });
  if(user.password_hash !== hashPwd(password))
    return res.json({ success:false, error:'Wrong password' });
  res.json({ success:true });
});

app.post('/api/auth/govt-login', (req, res) => {
  const { govt_id, password } = req.body;
  if (!govt_id || !password)
    return res.status(400).json({ error: 'Govt ID and Password required' });
  const storedId  = getSetting('govt_shared_id')  || 'INDHAN_GOVT_2026';
  const storedPwd = getSetting('govt_shared_pwd')  || hashPwd('Govt@India2026');
  if (govt_id.toUpperCase() !== storedId.toUpperCase() || hashPwd(password) !== storedPwd)
    return res.status(401).json({ error: 'Wrong Govt ID or Password. Contact admin.' });
  const tempToken = 'GOVT.' + crypto.randomBytes(16).toString('hex');
  otpStore['GOVT_' + tempToken] = { role: 'govt_official', expires: Date.now() + 12 * 3600000 };
  res.json({
    success: true,
    token:   tempToken,
    role:    'govt_official',
    name:    'Govt Official',
    message: 'Govt dashboard access granted for 12 hours.',
  });
});

app.post('/api/auth/login', (req,res) => {
  const { mobile, password } = req.body;
  if(!mobile||!password) return res.status(400).json({ error:'Login ID and password required' });
  const loginId = (mobile||'').toString().trim();
  const loginIdUpper = loginId.toUpperCase().replace(/\s/g,'');
  const user = dbGet(
    `SELECT * FROM users WHERE (mobile=? OR mobile=? OR pump_login_id=?) AND is_active=1`,
    [loginId, loginIdUpper, loginIdUpper]
  );
  if (!user) return res.status(401).json({ error:'Login ID not found. Check your credentials.' });
  if (['pump_owner','doc_verifier','govt_official','super_admin'].includes(user.role)) {
    if (!password) return res.status(400).json({ error:'Password required' });
    if (user.password_hash!==hashPwd(password)) return res.status(401).json({ error:'Wrong password' });
  }
  res.json({ token:makeToken(user.id,user.mobile), role:user.role, name:user.name, language:user.language });
});

app.post('/api/auth/logout', requireAuth(), (req,res) => {
  dbRun(`DELETE FROM sessions WHERE token=?`,[req.headers['x-auth-token']]);
  res.json({ success:true });
});

app.post('/api/auth/language', requireAuth(), (req,res) => {
  const { language } = req.body;
  const ok=['en','hi','mr','gu','pa','ta','te','kn','bn','ml','or','ur'];
  if (!ok.includes(language)) return res.status(400).json({ error:'Invalid language' });
  dbRun(`UPDATE users SET language=? WHERE id=?`,[language,req.user.id]);
  res.json({ success:true, language });
});

// ── Tier Limits API ───────────────────────────────────────────
app.get('/api/tier-limits', (req, res) => {
  res.json({ success:true, limits: getTierLimits() });
});
function saveTierLimits(body) {
  const tiers = ['P1','P2','P3','P4','P5'];
  tiers.forEach(t => {
    if(body[t+'_litres'] !== undefined)
      dbRun(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`,['tier_'+t+'_litres', String(body[t+'_litres'])]);
    if(body[t+'_hrs'] !== undefined)
      dbRun(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`,['tier_'+t+'_hrs', String(body[t+'_hrs'])]);
  });
}
app.post('/api/admin/tier-limits', (req, res) => {
  saveTierLimits(req.body);
  res.json({ success:true, limits: getTierLimits() });
});
app.post('/api/admin/save-tiers', (req, res) => {
  saveTierLimits(req.body);
  res.json({ success:true, message:'Tier limits saved!', limits: getTierLimits() });
});

// ============================================================
//  PUMP SEARCH
// ============================================================
// PUBLIC: Search pumps by name for signup — Google Places (no auth needed)
app.get('/api/pumps/search-place', async (req, res) => {
  const { q } = req.query;
  if(!q) return res.status(400).json({ error:'Query required' });
  const gKey = process.env.GOOGLE_PLACES_KEY;
  if(!gKey) return res.json({ places:[] });
  try {
    const resp = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type':     'application/json',
        'X-Goog-Api-Key':   gKey,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents',
      },
      body: JSON.stringify({
        textQuery:      q + ' petrol pump',
        includedType:   'gas_station',
        maxResultCount: 10,
        regionCode:     'IN',
      }),
      signal: AbortSignal.timeout(10000),
    });
    if(!resp.ok) return res.json({ places:[] });
    const data = await resp.json();
    const places = (data.places||[]).map(p => {
      const pinComp  = (p.addressComponents||[]).find(c=>c.types?.includes('postal_code'));
      // Try level_3 (actual district) first, fallback to level_2 (revenue division)
      const distComp = (p.addressComponents||[]).find(c=>c.types?.includes('administrative_area_level_3'))
                    || (p.addressComponents||[]).find(c=>c.types?.includes('administrative_area_level_2'));
      const cityComp = (p.addressComponents||[]).find(c=>c.types?.includes('locality')||c.types?.includes('administrative_area_level_3'));
      return {
        place_id: p.id,
        name:     p.displayName?.text || 'Petrol Pump',
        address:  p.formattedAddress || '',
        lat:      p.location?.latitude  || 0,
        lng:      p.location?.longitude || 0,
        pin_code: pinComp?.longText  || '',
        district: distComp?.longText || cityComp?.longText || '',
      };
    });
    res.json({ places });
  } catch(e) {
    console.error('[PLACE SEARCH]', e.message);
    res.json({ places:[] });
  }
});

app.get('/api/pumps/search', (req,res) => {
  const { pin, lat, lng, fuel } = req.query;
  let pumps = [];
  if (pin) {
    pumps = dbAll(`SELECT * FROM petrol_pumps WHERE pin_code=? AND is_active=1 ORDER BY is_verified DESC`,[pin]);
  } else if (lat && lng) {
    const R=0.1;
    pumps = dbAll(`SELECT * FROM petrol_pumps
      WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? AND is_active=1
      ORDER BY is_verified DESC`,[+lat-R,+lat+R,+lng-R,+lng+R]);
  } else {
    return res.status(400).json({ error:'Provide pin or lat/lng' });
  }
  let result = pumps.map(p => ({ ...p, fuel:latestReport(p.id) }));
  if(fuel) result = result.filter(p => p.fuel?.[fuel]);

  let u = null;
  try {
    const tok = req.headers['x-auth-token'];
    if(tok) u = getUser(tok);
  } catch(e){}
  const premium = u ? isUserPremium(u) : false;
  const price   = getSetting('subscription_price') || '14.99';

  if(!premium){
    result = result.map(p => {
      if(p.is_verified){
        return {
          id: p.id, name: p.name, oil_company: p.oil_company,
          address: p.address, district: p.district, pin_code: p.pin_code,
          is_verified: true, _locked: true, _locked_reason: 'verified',
          message: `Subscribe ₹${price}/month to see verified pump fuel data`
        };
      }
      return p;
    });
    const community = result.filter(p => !p._locked).slice(0,1);
    const locked    = result.filter(p => p._locked);
    result = [...community, ...locked];
  }
  res.json({ pumps:result, total:pumps.length, is_premium:premium, price });
});

// ══════════════════════════════════════════════════════════════
// ROUTE 1: /api/pumps/locations — CACHED 3000-4000 hrs
// ══════════════════════════════════════════════════════════════
app.get('/api/pumps/locations', async (req, res) => {
  const { pin, lat, lng } = req.query;

  let cacheKey, cacheHours;
  if(pin) {
    cacheKey   = 'pin:' + pin;
    cacheHours = CACHE_HOURS.PIN;
  } else if(lat && lng) {
    const rLat = parseFloat(lat).toFixed(2);
    const rLng = parseFloat(lng).toFixed(2);
    cacheKey   = `gps:${rLat}:${rLng}`;
    cacheHours = CACHE_HOURS.GPS;
  } else {
    return res.status(400).json({ error: 'PIN or GPS coordinates required' });
  }

  const cached = cacheGet(cacheKey);
  if(cached) {
    // Always refresh is_verified LIVE from DB even on cache hit
    // (pump location is cached, but green tick status changes after approval)
    const dbPumpIds = (cached.pumps||[])
      .filter(p => String(p.id).match(/^\d+$/))
      .map(p => p.id);
    let freshVerified = {};
    if(dbPumpIds.length > 0) {
      const placeholders = dbPumpIds.map(() => '?').join(',');
      dbAll(`SELECT id, is_verified FROM petrol_pumps WHERE id IN (${placeholders})`, dbPumpIds)
        .forEach(r => { freshVerified[r.id] = r.is_verified; });
    }
    const refreshedPumps = (cached.pumps||[]).map(p =>
      String(p.id).match(/^\d+$/)
        ? { ...p, is_verified: freshVerified[p.id] !== undefined ? freshVerified[p.id] : p.is_verified }
        : p
    );
    return res.json({ ...cached, pumps: refreshedPumps, from_cache: true });
  }

  // STEP 1: DB pumps
  let dbPumps = [];
  if(pin) {
    dbPumps = dbAll(
      'SELECT id,name,oil_company,address,district,pin_code,lat,lng,is_verified,license_number FROM petrol_pumps WHERE pin_code=? AND is_active=1 ORDER BY is_verified DESC',
      [pin]
    );
  } else if(lat && lng) {
    const R = 0.15; // ~15km radius
    const gpsMatches = dbAll(
      'SELECT id,name,oil_company,address,district,pin_code,lat,lng,is_verified,license_number FROM petrol_pumps WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? AND is_active=1 ORDER BY is_verified DESC',
      [+lat-R, +lat+R, +lng-R, +lng+R]
    );
    // Also include verified pumps with null/0 lat/lng — match by PIN of nearby pumps
    const areaPins = [...new Set(gpsMatches.map(p => p.pin_code).filter(Boolean))];
    let nullLatVerified = [];
    if(areaPins.length > 0) {
      const ph = areaPins.map(() => '?').join(',');
      nullLatVerified = dbAll(
        `SELECT id,name,oil_company,address,district,pin_code,lat,lng,is_verified,license_number FROM petrol_pumps WHERE is_active=1 AND is_verified=1 AND (lat IS NULL OR lat=0) AND pin_code IN (${ph})`,
        areaPins
      );
    }
    const gpsIds = new Set(gpsMatches.map(p => p.id));
    dbPumps = [...gpsMatches, ...nullLatVerified.filter(p => !gpsIds.has(p.id))];
  }

  // STEP 2: Get lat/lng for Google Places
  // If GPS provided → use directly
  // If PIN provided + DB has pumps → use DB pump coords
  // If PIN provided + DB empty → geocode PIN to lat/lng
  let useLat = lat || (dbPumps[0]?.lat);
  let useLng = lng || (dbPumps[0]?.lng);

  if(pin && !useLat) {
    // Geocode PIN → lat/lng using Google Geocoding API
    const gKey = process.env.GOOGLE_PLACES_KEY;
    if(gKey && gKey.length > 10) {
      try {
        console.log(`[GEOCODE] PIN ${pin} → lat/lng lookup`);
        const geoResp = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${pin},India&key=${gKey}`,
          { signal: AbortSignal.timeout(8000) }
        );
        const geoData = await geoResp.json();
        if(geoData.results && geoData.results[0]) {
          useLat = geoData.results[0].geometry.location.lat;
          useLng = geoData.results[0].geometry.location.lng;
          console.log(`[GEOCODE] PIN ${pin} → lat:${useLat} lng:${useLng}`);
        }
      } catch(e) {
        console.error('[GEOCODE] Error:', e.message);
      }
    }
  }

  // STEP 3: Google Places / OSM pump fetch
  let mmiPumps = [];
  if(useLat && useLng) {
    mmiPumps = await fetchMapMyIndiaPumps(useLat, useLng, 8);
    const dbNames = new Set(dbPumps.map(p => p.name.toLowerCase().replace(/\s+/g,'')));
    mmiPumps = mmiPumps.filter(p => !dbNames.has(p.name.toLowerCase().replace(/\s+/g,'')));
  }

  const allPumps = [
    ...dbPumps.map(p => ({ ...p, source: 'db' })),
    ...mmiPumps.map(p => ({ ...p, source: 'mmi' })),
  ];

  const result = {
    pumps: allPumps,
    total: allPumps.length,
    db_count: dbPumps.length,
    mmi_count: mmiPumps.length,
    cache_key: cacheKey,
    cache_hours: cacheHours,
    cached_at: new Date().toISOString(),
  };

  cacheSet(cacheKey, result, cacheHours);
  console.log(`[CACHE SET] ${cacheKey} → ${allPumps.length} pumps (DB:${dbPumps.length} MMI:${mmiPumps.length}) | ${cacheHours}hrs`);

  // Cloudflare cache headers — 1 year for pump locations
  // Short TTL so new verified pumps appear quickly. Server locationCache handles performance.
  res.setHeader('Cache-Control', 'public, max-age=7200');
  res.setHeader('Vary', 'Accept-Encoding');
  res.json({ ...result, from_cache: false });
});

// ══════════════════════════════════════════════════════════════
// ROUTE 2: /api/pumps/fuel-data — NEVER CACHED
// ══════════════════════════════════════════════════════════════
app.get('/api/pumps/fuel-data', (req, res) => {
  const { ids } = req.query;
  if(!ids) return res.json({ fuel: {} });

  const dbIds = ids.split(',')
    .filter(id => /^\d+$/.test(id.trim()))
    .map(Number)
    .slice(0, 50);

  if(dbIds.length === 0) return res.json({ fuel: {}, timestamp: new Date().toISOString() });

  const fuelData = {};
  dbIds.forEach(id => {
    const report = latestReport(id);
    const pump   = dbGet('SELECT is_verified, scan_count_free FROM petrol_pumps WHERE id=?', [id]);
    fuelData[id] = {
      petrol:      report?.petrol  || false,
      diesel:      report?.diesel  || false,
      cng:         report?.cng     || false,
      ev:          report?.ev      || false,
      queue:       report?.queue_length || 'none',
      updated_at:  report?.created_at || null,
      reporter:    report?.reporter_role || null,
      is_verified: pump?.is_verified || false,
      expires_at:  report?.expires_at || null,
    };
  });

  // Never cache fuel data — always live!
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.json({
    fuel: fuelData,
    timestamp: new Date().toISOString(),
    count: dbIds.length,
  });
});

app.get('/api/pumps/:id', requireAuth(), (req,res) => {
  const pump = dbGet(`SELECT * FROM petrol_pumps WHERE id=?`,[parseInt(req.params.id)]);
  if (!pump) return res.status(404).json({ error:'Pump not found' });
  res.json({ ...pump, fuel:latestReport(pump.id) });
});

// ============================================================
//  FUEL REPORTS
// ============================================================
// ══════════════════════════════════════════════════════════════════════════
// 🤖 AI DOCUMENT VERIFICATION AGENT
// Supports: Gemini Flash (free tier) + Claude Haiku (production)
// 20 workers, SQLite queue, two-pass system, fully scalable
// ══════════════════════════════════════════════════════════════════════════

// ── AI Provider Helpers ────────────────────────────────────────────────────
async function callGeminiAPI(prompt, imageBase64, mimeType) {
  const apiKey = getSetting('gemini_api_key') || process.env.GEMINI_API_KEY;
  if(!apiKey) throw new Error('Gemini API key not set. Add it in Admin → AI Verification Settings');
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;
  const body = {
    contents: [{
      parts: [
        { text: prompt },
        ...(imageBase64 ? [{ inline_data: { mime_type: mimeType||'image/jpeg', data: imageBase64 } }] : [])
      ]
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 512 }
  };
  const resp = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
  if(resp.status === 429) {
    const errText = await resp.text().catch(()=>'');
    // Daily quota exhausted = billing issue, no point retrying today
    if(errText.includes('billing') || errText.includes('plan and billing') || errText.includes('RESOURCE_EXHAUSTED')) {
      throw new Error(`QUOTA_EXHAUSTED: Daily Gemini free tier limit reached. Resets tomorrow or add billing. Details: ${errText.slice(0,150)}`);
    }
    // Per-minute rate limit — safe to retry after 65s
    console.log('[AI AGENT] Per-minute rate limit — waiting 65s...');
    await new Promise(r => setTimeout(r, 65000));
    const resp2 = await fetch(url, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) });
    if(!resp2.ok) {
      const errBody2 = await resp2.text().catch(()=>'');
      throw new Error(`Gemini API error after retry: ${resp2.status} — ${errBody2.slice(0,150)}`);
    }
    const data2 = await resp2.json();
    return data2.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  if(!resp.ok) {
    const errBody = await resp.text().catch(()=>'');
    throw new Error(`Gemini API error: ${resp.status} — ${errBody.slice(0,300)}`);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function callAnthropicAPI(prompt, imageBase64, mimeType) {
  const apiKey = getSetting('anthropic_api_key') || process.env.ANTHROPIC_API_KEY;
  if(!apiKey) throw new Error('Anthropic API key not set. Add it in Admin → AI Verification Settings');
  const url = 'https://api.anthropic.com/v1/messages';
  const content = [{ type:'text', text: prompt }];
  if(imageBase64) content.unshift({ type:'image', source:{ type:'base64', media_type: mimeType||'image/jpeg', data: imageBase64 } });
  const body = { model:'claude-haiku-4-5', max_tokens:512, messages:[{ role:'user', content }] };
  const resp = await fetch(url, { method:'POST',
    headers:{ 'Content-Type':'application/json', 'x-api-key': apiKey, 'anthropic-version':'2023-06-01' },
    body: JSON.stringify(body) });
  if(!resp.ok) throw new Error(`Anthropic API error: ${resp.status}`);
  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

async function callAI(prompt, imagePath) {
  const provider = getSetting('ai_provider') || process.env.AI_PROVIDER || 'gemini';
  let imageBase64 = null, mimeType = 'image/jpeg';
  if(imagePath && fs.existsSync(imagePath)) {
    imageBase64 = fs.readFileSync(imagePath).toString('base64');
    if(imagePath.toLowerCase().endsWith('.png')) mimeType = 'image/png';
    if(imagePath.toLowerCase().endsWith('.pdf')) mimeType = 'application/pdf';
  }
  // Direct Anthropic call if set as provider
  if(provider === 'anthropic') return callAnthropicAPI(prompt, imageBase64, mimeType);
  // Gemini with auto-fallback to Anthropic on quota/rate error
  try {
    return await callGeminiAPI(prompt, imageBase64, mimeType);
  } catch(e) {
    const isQuotaOrRate = e.message.includes('QUOTA_EXHAUSTED') || e.message.includes('429') || e.message.includes('quota');
    const hasAnthropicKey = getSetting('anthropic_api_key') || process.env.ANTHROPIC_API_KEY;
    if(isQuotaOrRate && hasAnthropicKey) {
      console.log('[AI AGENT] Gemini failed → auto-switching to Anthropic fallback');
      return await callAnthropicAPI(prompt, imageBase64, mimeType);
    }
    throw e; // re-throw if no fallback available
  }
}

// ── AI Prompts ─────────────────────────────────────────────────────────────
function buildPumpLicensePrompt(pumpName, licenseNumber) {
  return `You are verifying an Indian petrol pump Retail Outlet License for IndhanShodhak fuel app.
Expected pump name: "${pumpName}"
Expected license number: "${licenseNumber}"

Look at the document image and extract:
1. Pump/outlet name visible on document
2. License/agreement number
3. Oil company name (BPCL/HP/IOC/Shell/etc)
4. Expiry date if visible
5. Is this clearly a Retail Outlet License or dealership agreement?

Respond ONLY in this JSON format:
{"pump_name_found":"...","license_number_found":"...","oil_company":"...","expiry":"...","is_valid_doc":true/false,"name_match_pct":0-100,"license_match":true/false,"score":0-100,"reason":"..."}

Score guide: 85-100=clear valid doc with matching details, 50-84=readable but some mismatch, 0-49=unreadable/wrong doc/expired.
Be lenient about Indian document quality — old, faded, or pixelated documents are normal.`;
}

function buildAadhaarPrompt(registeredName) {
  return `You are verifying an Aadhaar card for IndhanShodhak fuel app.
Registered user name: "${registeredName}"

Look at the Aadhaar card image and check:
1. Is this clearly an Aadhaar card?
2. Name visible on card
3. Aadhaar number (12 digits) visible?
4. Is the photo box present? (IMPORTANT: only fail photo if completely absent, entirely black, or entirely overexposed — pixelated/old/low quality photos are NORMAL in India and must PASS)

Respond ONLY in this JSON format:
{"is_aadhaar":true/false,"name_found":"...","aadhaar_visible":true/false,"photo_status":"present/absent/black/overexposed","name_match_pct":0-100,"score":0-100,"reason":"..."}

Score guide: 85+=clear Aadhaar with name matching, 50-84=readable but partial mismatch, 0-49=wrong doc/name completely different/photo entirely absent or black.`;
}

function buildSelfiePrompt() {
  return `You are verifying a petrol pump photo for IndhanShodhak fuel app.
The pump owner should be standing at their actual petrol pump.

Look at this photo and determine:
1. Does this appear to be taken at a petrol pump / fuel station?
2. Can you see any of: fuel dispensers, pump canopy, fuel station signage, pump nozzles, forecourt?
3. Does it look like a genuine photo (not a stock image or screenshot)?

Respond ONLY in this JSON format:
{"is_at_pump":true/false,"pump_elements_visible":["list what you see"],"appears_genuine":true/false,"score":0-100,"reason":"..."}

Score: 85+=clear pump photo, 50-84=possibly at pump but unclear, 0-49=clearly not at a pump.`;
}

function buildTierDocPrompt(category, registeredName) {
  const docGuide = {
    P1: 'Government ID card + Vehicle RC + NOC (No Objection Certificate)',
    P2: 'Medical certificate + Hospital/clinic letter + Vehicle RC',
    P3: 'Commercial vehicle permit + Driving licence + Vehicle RC',
    P4: 'Kisan Credit Card (KCC) + 7/12 land extract',
  };
  return `You are verifying tier upgrade documents for IndhanShodhak fuel app.
User tier requested: ${category} (${docGuide[category]||'General documents'})
Registered name: "${registeredName}"

Look at this document and check:
1. What type of document is this?
2. Is the name on document matching "${registeredName}"?
3. Is this document valid and readable?
4. Does it match the expected document type for ${category}?

Respond ONLY in this JSON format:
{"doc_type_found":"...","name_found":"...","name_match_pct":0-100,"is_correct_doc_type":true/false,"is_readable":true/false,"score":0-100,"reason":"..."}

Be lenient about Indian document quality. Old, regional language, or pixelated documents are normal.`;
}

// ── Core Verification Logic ────────────────────────────────────────────────
async function runVerificationJob(job) {
  const approveScore = parseInt(getSetting('ai_approve_score') || '85');
  const rejectScore  = parseInt(getSetting('ai_reject_score')  || '50');

  try {
    dbRun(`UPDATE ai_verify_queue SET status='processing', ai_provider=? WHERE id=?`,
      [getSetting('ai_provider')||'gemini', job.id]);

    let scores = [], reasons = [], verdict = 'escalate';

    if(job.job_type === 'pump') {
      const app = dbGet(`SELECT pa.*, p.name as pump_name FROM pump_applications pa
        LEFT JOIN petrol_pumps p ON p.id=pa.pump_id WHERE pa.id=?`, [job.application_id]);
      if(!app) throw new Error('Application not found');

      // Check 1: Retail Outlet License
      if(app.doc_license && fs.existsSync(app.doc_license)) {
        const raw = await callAI(buildPumpLicensePrompt(app.pump_name||app.applicant_name, app.license_number), app.doc_license);
        const parsed = safeParseJSON(raw);
        scores.push(parsed.score||0);
        reasons.push('License: ' + (parsed.reason||'checked'));
      }

      // Check 2: Aadhaar
      if(app.doc_aadhaar && fs.existsSync(app.doc_aadhaar)) {
        const raw = await callAI(buildAadhaarPrompt(app.applicant_name), app.doc_aadhaar);
        const parsed = safeParseJSON(raw);
        scores.push(parsed.score||0);
        reasons.push('Aadhaar: ' + (parsed.reason||'checked'));
      }

      // Check 3: Pump Selfie
      if(app.doc_selfie && fs.existsSync(app.doc_selfie)) {
        const raw = await callAI(buildSelfiePrompt(), app.doc_selfie);
        const parsed = safeParseJSON(raw);
        scores.push(parsed.score||0);
        reasons.push('Selfie: ' + (parsed.reason||'checked'));
      }

    } else if(job.job_type === 'user_tier') {
      const app = dbGet(`SELECT ufa.*, u.name FROM user_fuel_applications ufa
        LEFT JOIN users u ON u.id=ufa.user_id WHERE ufa.id=?`, [job.application_id]);
      if(!app) throw new Error('Application not found');

      // Check Aadhaar
      if(app.doc_aadhaar && fs.existsSync(app.doc_aadhaar)) {
        const raw = await callAI(buildAadhaarPrompt(app.applicant_name||app.name), app.doc_aadhaar);
        const parsed = safeParseJSON(raw);
        scores.push(parsed.score||0);
        reasons.push('Aadhaar: ' + (parsed.reason||'checked'));
      }

      // Check tier-specific docs
      const tierDocs = [app.doc_vehicle_rc, app.doc_kisan_card, app.doc_profession_cert,
                        app.doc_dept_id, app.doc_commercial_permit, app.doc_driver_licence,
                        app.doc_employer_letter, app.doc_official_letter, app.doc_land_record];
      for(const docPath of tierDocs) {
        if(docPath && fs.existsSync(docPath)) {
          const raw = await callAI(buildTierDocPrompt(app.category, app.applicant_name||app.name), docPath);
          const parsed = safeParseJSON(raw);
          scores.push(parsed.score||0);
          reasons.push('Doc: ' + (parsed.reason||'checked'));
          break; // one tier doc is enough
        }
      }
    }

    const avgScore = scores.length ? Math.round(scores.reduce((a,b)=>a+b,0)/scores.length) : 0;
    const reasonStr = reasons.join(' | ');

    if(avgScore >= approveScore)      verdict = 'approve';
    else if(avgScore < rejectScore)   verdict = 'reject';
    else                              verdict = 'escalate';

    // Pass 2 for borderline
    if(verdict === 'escalate' && job.pass_number === 1) {
      dbRun(`UPDATE ai_verify_queue SET score=?, verdict='pass2_pending', reason=?, status='pending', pass_number=2 WHERE id=?`,
        [avgScore, reasonStr, job.id]);
      enqueueJob({ ...job, pass_number: 2, score: avgScore });
      return;
    }

    if(verdict === 'escalate' && job.pass_number === 2) {
      // Confirmed borderline — escalate to human
      dbRun(`UPDATE ai_verify_queue SET score=?, verdict='escalate', reason=?, status='done', processed_at=datetime('now') WHERE id=?`,
        [avgScore, reasonStr, job.id]);
      await sendAIEscalationEmail(job);
      return;
    }

    // Auto-approve or auto-reject
    dbRun(`UPDATE ai_verify_queue SET score=?, verdict=?, reason=?, status='done', processed_at=datetime('now') WHERE id=?`,
      [avgScore, verdict, reasonStr, job.id]);
    await applyAIVerdict(job, verdict, avgScore, reasonStr);

  } catch(e) {
    console.error(`[AI AGENT] Job ${job.id} error:`, e.message.slice(0, 120));
    const retries = (job.retry_count || 0) + 1;
    const isQuotaExhausted = e.message.includes('QUOTA_EXHAUSTED');
    const isRateLimit      = e.message.includes('429') && !isQuotaExhausted;
    const maxRetries       = 3;

    if(isQuotaExhausted) {
      // Daily quota gone — stop retrying, mark failed, notify admin
      dbRun(`UPDATE ai_verify_queue SET status='failed', reason=?, retry_count=? WHERE id=?`,
        ['Daily quota exhausted. Will retry tomorrow or switch to Anthropic API.', retries, job.id]);
      console.log(`[AI AGENT] ⛔ Daily quota exhausted — stopping retries for job ${job.id}. Reset tomorrow or switch to Anthropic.`);
    } else if(isRateLimit && retries < maxRetries) {
      // Per-minute rate limit — retry with backoff
      const delay = retries * 60000; // 60s, 120s, 180s
      dbRun(`UPDATE ai_verify_queue SET status='pending', reason=?, retry_count=? WHERE id=?`,
        [`Rate limited (attempt ${retries}/${maxRetries})`, retries, job.id]);
      console.log(`[AI AGENT] Job ${job.id} rate-limited (${retries}/${maxRetries}) — retry in ${retries}min`);
      setTimeout(() => enqueueJob({...job, retry_count: retries}), delay);
    } else {
      // Max retries reached or other error
      dbRun(`UPDATE ai_verify_queue SET status='failed', reason=?, retry_count=? WHERE id=?`,
        [e.message.slice(0,200), retries, job.id]);
      console.log(`[AI AGENT] Job ${job.id} permanently failed after ${retries} attempts`);
    }
  }
}

function safeParseJSON(text) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  } catch(e) { return {}; }
}

async function applyAIVerdict(job, verdict, score, reason) {
  const table  = job.app_table === 'pump' ? 'pump_applications' : 'user_fuel_applications';
  const status = verdict === 'approve' ? 'approved' : 'rejected';

  dbRun(`UPDATE ${table} SET status=?, reject_reason=? WHERE id=?`,
    [status, verdict==='approve'?null:`AI Score ${score}/100: ${reason}`, job.application_id]);

  if(verdict === 'approve' && job.app_table === 'pump') {
    const app = dbGet(`SELECT pump_id FROM pump_applications WHERE id=?`, [job.application_id]);
    if(app?.pump_id) {
      dbRun(`UPDATE petrol_pumps SET is_verified=1 WHERE id=?`, [app.pump_id]);
      cacheClear('gps:'); cacheClear('pin:');
    }
  }
  if(verdict === 'approve' && job.app_table === 'user_tier') {
    const app = dbGet(`SELECT user_id, category FROM user_fuel_applications WHERE id=?`, [job.application_id]);
    if(app) dbRun(`UPDATE users SET category=? WHERE id=?`, [app.category, app.user_id]);
  }

  const app = dbGet(`SELECT applicant_email, applicant_name FROM ${table} WHERE id=?`, [job.application_id]);
  if(app?.applicant_email) {
    const subj = verdict==='approve'
      ? '✅ IndhanShodhak — Application Approved!'
      : '❌ IndhanShodhak — Application Not Approved';
    const html = verdict==='approve'
      ? `<div style="font-family:sans-serif;max-width:480px">
          <h2 style="color:#1a6b2e">✅ Application Approved!</h2>
          <p>Dear <b>${app.applicant_name}</b>,</p>
          <p>Your IndhanShodhak application has been <b>approved</b> by our AI verification system.</p>
          <p>AI Confidence Score: <b>${score}/100</b></p>
          <p>You can now access your verified features on the app.</p>
          <p style="color:#888;font-size:12px">Powered by IndhanShodhak AI Verification</p>
        </div>`
      : `<div style="font-family:sans-serif;max-width:480px">
          <h2 style="color:#b71c1c">❌ Application Not Approved</h2>
          <p>Dear <b>${app.applicant_name}</b>,</p>
          <p>Unfortunately your application could not be approved. Reason:</p>
          <p style="background:#ffebee;padding:10px;border-radius:8px"><b>${reason}</b></p>
          <p>Please re-upload clearer documents and reapply. Our team is here to help.</p>
          <p style="color:#888;font-size:12px">AI Score: ${score}/100 | IndhanShodhak Verification</p>
        </div>`;
    await sendEmail(app.applicant_email, subj, html);
  }
  console.log(`[AI AGENT] ${job.app_table} app ${job.application_id} → ${verdict} (score:${score})`);
}

async function sendAIEscalationEmail(job) {
  const adminEmail = getSetting('admin_email') || process.env.EMAIL_USER;
  if(!adminEmail) return;
  const verifyUrl = `${process.env.APP_URL || 'http://localhost:3000'}/verify`;
  await sendEmail(adminEmail,
    `⚠️ IndhanShodhak — Manual Review Needed (AI Score: borderline)`,
    `<div style="font-family:sans-serif;max-width:480px">
      <h2 style="color:#e65100">⚠️ Manual Review Required</h2>
      <p>AI agent reviewed application #${job.application_id} (${job.job_type}) and flagged it as borderline.</p>
      <p>AI Score: <b>${job.score}/100</b> — Pass 1 and Pass 2 both inconclusive.</p>
      <p><a href="${verifyUrl}" style="background:#1a6b2e;color:white;padding:10px 20px;border-radius:8px;text-decoration:none">Open Verifier Panel →</a></p>
      <p style="color:#888;font-size:12px">IndhanShodhak AI Agent</p>
    </div>`);
}

// ── Worker Pool — 20 workers, SQLite-backed ────────────────────────────────
const AI_MAX_WORKERS_DEFAULT = parseInt(process.env.AI_WORKERS || '2'); // Free tier default
function getMaxWorkers(){ try { return parseInt(getSetting('ai_workers') || AI_MAX_WORKERS_DEFAULT); } catch(e){ return AI_MAX_WORKERS_DEFAULT; } }
let   aiActiveWorkers = 0;
const aiQueue = [];

function enqueueJob(job) {
  aiQueue.push(job);
  processAIQueue();
}

function processAIQueue() {
  if(aiQueue.length === 0 || aiActiveWorkers >= getMaxWorkers()) return;
  const job = aiQueue.shift();
  aiActiveWorkers++;
  runVerificationJob(job)
    .catch(e => console.error('[AI WORKER] Error:', e.message))
    .finally(() => {
      aiActiveWorkers--;
      setTimeout(processAIQueue, 5000); // 5s gap — respects free tier rate limit
    });
  if(aiQueue.length > 0 && aiActiveWorkers < getMaxWorkers()) {
    setTimeout(processAIQueue, 5000);
  }
}

// On server start — reload pending jobs from DB (survives restart)
function resumeAIQueue() {
  const apiKey = getSetting('gemini_api_key') || getSetting('anthropic_api_key') || process.env.GEMINI_API_KEY || process.env.ANTHROPIC_API_KEY;
  if(!apiKey) {
    console.log('[AI AGENT] No API key found — queue not resumed. Add key in Admin → AI Settings.');
    return;
  }
  // Reset stuck 'processing' jobs from crashed sessions
  dbRun(`UPDATE ai_verify_queue SET status='pending' WHERE status='processing'`);

  // ── Auto-queue any pending applications not yet in ai_verify_queue ──────
  const unqueuedPumps = dbAll(
    `SELECT pa.id FROM pump_applications pa
     WHERE pa.status='pending'
       AND NOT EXISTS (SELECT 1 FROM ai_verify_queue q WHERE q.application_id=pa.id AND q.app_table='pump' AND q.status NOT IN ('failed'))`);
  unqueuedPumps.forEach(app => {
    console.log(`[AI AGENT] Auto-queuing pump app ${app.id}`);
    triggerAIVerification(app.id, 'pump', 'pump');
  });

  const unqueuedUsers = dbAll(
    `SELECT ufa.id FROM user_fuel_applications ufa
     WHERE ufa.status='pending'
       AND NOT EXISTS (SELECT 1 FROM ai_verify_queue q WHERE q.application_id=ufa.id AND q.app_table='user_tier' AND q.status NOT IN ('failed'))`);
  unqueuedUsers.forEach(app => {
    console.log(`[AI AGENT] Auto-queuing user tier app ${app.id}`);
    triggerAIVerification(app.id, 'user_tier', 'user_tier');
  });

  // Resume existing pending queue jobs
  // Only resume jobs that haven't hit max retries
  const pending = dbAll(`SELECT * FROM ai_verify_queue WHERE status='pending' AND (retry_count IS NULL OR retry_count < 3) ORDER BY created_at ASC`);
  // Mark exhausted retry jobs as failed
  dbRun(`UPDATE ai_verify_queue SET status='failed', reason='Max retries exceeded' WHERE status='pending' AND retry_count >= 3`);
  if(pending.length > 0) {
    console.log(`[AI AGENT] ✅ API key found. Resuming ${pending.length} queued jobs...`);
    pending.forEach(job => enqueueJob(job));
  } else if(unqueuedPumps.length === 0 && unqueuedUsers.length === 0) {
    console.log(`[AI AGENT] ✅ API key found. No pending jobs. Ready for new applications.`);
  }
}

// ── AI Trigger — called after document upload ──────────────────────────────
function triggerAIVerification(appId, jobType, appTable) {
  if(!getSetting('gemini_api_key') && !getSetting('anthropic_api_key') && !process.env.GEMINI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.log('[AI AGENT] No API key configured — skipping AI verification');
    return;
  }
  // Allow re-queue if job is stuck (pending/processing for >5 minutes)
  const existing = dbGet(
    `SELECT id, status, created_at FROM ai_verify_queue
     WHERE application_id=? AND app_table=? AND status NOT IN ('done','failed')
     AND created_at > datetime('now','-5 minutes')`, [appId, appTable]);
  if(existing) { 
    console.log(`[AI AGENT] Job already active for app ${appId} (status:${existing.status})`);
    return;
  }
  // Reset any stuck old jobs
  dbRun(`UPDATE ai_verify_queue SET status='failed', reason='Superseded by new trigger'
    WHERE application_id=? AND app_table=? AND status NOT IN ('done','failed')`, [appId, appTable]);
  dbRun(`INSERT INTO ai_verify_queue(job_type,application_id,app_table,status,pass_number) VALUES(?,?,?,'pending',1)`,
    [jobType, appId, appTable]);
  const job = dbGet(`SELECT * FROM ai_verify_queue WHERE application_id=? AND app_table=? ORDER BY id DESC LIMIT 1`, [appId, appTable]);
  if(job) enqueueJob(job);
  console.log(`[AI AGENT] Queued ${jobType} verification for app ${appId}`);
}

// ── AI Status & Admin Routes ───────────────────────────────────────────────
app.get('/api/ai-verify/status/:appId', requireAuth(['doc_verifier','super_admin']), (req,res) => {
  const job = dbGet(`SELECT * FROM ai_verify_queue WHERE application_id=? ORDER BY id DESC LIMIT 1`, [req.params.appId]);
  res.json(job || { status:'not_queued' });
});

app.get('/api/ai-verify/queue', requireAuth(['doc_verifier','super_admin']), (req,res) => {
  const jobs = dbAll(`SELECT q.*, 
    CASE WHEN q.app_table='pump' THEN pa.applicant_name ELSE ufa.applicant_name END as applicant_name
    FROM ai_verify_queue q
    LEFT JOIN pump_applications pa ON pa.id=q.application_id AND q.app_table='pump'
    LEFT JOIN user_fuel_applications ufa ON ufa.id=q.application_id AND q.app_table='user_tier'
    ORDER BY q.created_at DESC LIMIT 100`);
  const approveScore = parseInt(getSetting('ai_approve_score')||'85');
  const rejectScore  = parseInt(getSetting('ai_reject_score') ||'50');
  res.json({ jobs, workers: { active: aiActiveWorkers, max: getMaxWorkers(), queued: aiQueue.length },
    thresholds: { approve: approveScore, reject: rejectScore } });
});

app.post('/api/ai-verify/retry/:jobId', requireAuth(['doc_verifier','super_admin']), (req,res) => {
  const job = dbGet(`SELECT * FROM ai_verify_queue WHERE id=?`, [req.params.jobId]);
  if(!job) return res.status(404).json({ error:'Job not found' });
  dbRun(`UPDATE ai_verify_queue SET status='pending', pass_number=1, verdict=NULL, score=NULL, reason=NULL WHERE id=?`, [job.id]);
  enqueueJob({ ...job, pass_number:1, verdict:null, score:null });
  res.json({ success:true, message:'Job requeued' });
});

// Reset all failed/quota-exceeded jobs (admin can retry after new day or new key)
app.post('/api/ai-verify/reset-all', requireAuth(['super_admin']), (req,res) => {
  dbRun(`UPDATE ai_verify_queue SET status='pending', retry_count=0, reason=NULL WHERE status='failed'`);
  const count = dbAll(`SELECT COUNT(*) as c FROM ai_verify_queue WHERE status='pending'`)[0]?.c || 0;
  setTimeout(resumeAIQueue, 1000);
  res.json({ success:true, message:`Reset ${count} failed jobs — AI agent restarted` });
});

// Re-trigger by application ID (for use from verify panel)
app.post('/api/ai-verify/trigger/:appId', requireAuth(['doc_verifier','super_admin']), (req,res) => {
  const { app_table } = req.body;
  if(!app_table) return res.status(400).json({ error:'app_table required (pump or user_tier)' });
  // Force reset any existing job
  dbRun(`UPDATE ai_verify_queue SET status='failed', reason='Manually re-triggered'
    WHERE application_id=? AND app_table=? AND status NOT IN ('done')`, [req.params.appId, app_table]);
  triggerAIVerification(parseInt(req.params.appId), app_table==='pump'?'pump':'user_tier', app_table);
  res.json({ success:true, message:`AI verification re-triggered for app ${req.params.appId}` });
});

// ── Hook AI trigger into pump application submission ───────────────────────
// ── Points Helper ────────────────────────────────────────────────────────
function awardPoint(userId, pumpId) {
  try {
    // Ensure user_points row exists
    dbRun(`INSERT OR IGNORE INTO user_points(user_id,month_points,carried_points,total_all_time) VALUES(?,0,0,0)`, [userId]);
    // Check daily cap (5 points per day)
    const today = new Date().toISOString().slice(0,10);
    const todayPts = parseInt(dbGet(
      `SELECT COUNT(*) as c FROM point_log WHERE user_id=? AND DATE(created_at)=? AND points>0`, [userId, today])?.c || 0);
    if(todayPts >= 5) return { awarded: false, reason: 'daily_cap' };
    // Award 1 point — store pump_id for history display
    const pid = pumpId ? parseInt(pumpId) : null;
    dbRun(`UPDATE user_points SET month_points=month_points+1, total_all_time=total_all_time+1 WHERE user_id=?`, [userId]);
    dbRun(`INSERT INTO point_log(user_id,pump_id,points,reason,created_at) VALUES(?,?,1,'fuel_report',datetime('now'))`, [userId, pid]);
    const bal = dbGet(`SELECT month_points, total_all_time FROM user_points WHERE user_id=?`, [userId]);
    return { awarded: true, month_points: bal?.month_points||1, total_all_time: bal?.total_all_time||1 };
  } catch(e) { console.error('awardPoint error:', e.message); return { awarded: false }; }
}

// ── Points API Routes ─────────────────────────────────────────────────────
// Balance
app.get('/api/points/balance', requireAuth(), (req,res) => {
  dbRun(`INSERT OR IGNORE INTO user_points(user_id,month_points,carried_points,total_all_time) VALUES(?,0,0,0)`, [req.user.id]);
  const pts = dbGet(`SELECT month_points, carried_points, total_all_time FROM user_points WHERE user_id=?`, [req.user.id]);
  const today = new Date().toISOString().slice(0,10);
  const todayPts = parseInt(dbGet(`SELECT COUNT(*) as c FROM point_log WHERE user_id=? AND DATE(created_at)=? AND points>0`,[req.user.id,today])?.c||0);
  const totalPts = (pts?.month_points||0) + (pts?.carried_points||0);
  res.json({
    month_points:   pts?.month_points||0,
    carried_points: pts?.carried_points||0,
    total_all_time: pts?.total_all_time||0,
    total:          totalPts,
    discount_rs:    (totalPts * 0.05).toFixed(2),
    today_points:   todayPts,
    daily_cap:      5,
    daily_remaining: Math.max(0, 5 - todayPts),
  });
});

// Leaderboard
app.get('/api/points/leaderboard', (req,res) => {
  const rows = dbAll(`
    SELECT u.name, u.mobile,
           up.month_points, up.total_all_time,
           (up.month_points + up.carried_points) as total
    FROM user_points up JOIN users u ON u.id=up.user_id
    WHERE u.is_active=1 AND u.role='user'
    ORDER BY total DESC LIMIT 10`);
  res.json({ leaders: rows });
});

// History
app.get('/api/points/history', requireAuth(), (req,res) => {
  const logs = dbAll(`
    SELECT pl.points, pl.reason, pl.created_at,
           p.name as pump_name, p.address, p.tehsil, p.district
    FROM point_log pl
    LEFT JOIN petrol_pumps p ON p.id = pl.pump_id
    WHERE pl.user_id=?
    ORDER BY pl.created_at DESC LIMIT 30`, [req.user.id]);
  res.json({ logs });
});

app.post('/api/reports/submit', requireAuth(), (req,res) => {
  const { pump_id, petrol, diesel, cng, ev, queue_length, restock_note } = req.body;
  if (!pump_id) return res.status(400).json({ error:'pump_id required' });
  if (['govt_official','doc_verifier'].includes(req.user.role))
    return res.status(403).json({ error:'Your role cannot submit reports' });
  const pump = dbGet(`SELECT * FROM petrol_pumps WHERE id=?`,[pump_id]);
  if (!pump) return res.status(404).json({ error:'Pump not found' });
  if (req.user.role==='pump_owner' && pump.owner_user_id!==req.user.id)
    return res.status(403).json({ error:'You can only update your own pump' });
  const hrs = parseInt(req.user.role==='pump_owner' ? getSetting('report_expiry_owner') : getSetting('report_expiry_user'));
  dbRun(`INSERT INTO fuel_reports (pump_id,reported_by,reporter_role,petrol,diesel,cng,ev,queue_length,restock_note,expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,datetime('now','+${hrs} hours'))`,
    [pump_id,req.user.id,req.user.role,petrol?1:0,diesel?1:0,cng?1:0,ev?1:0,queue_length||'none',restock_note||null]);
  // Award 1 point to community reporters (not pump owners)
  let pointsAwarded = null;
  if(req.user.role === 'user') {
    pointsAwarded = awardPoint(req.user.id, pump_id);
  }
  res.json({ success:true, message:'Report submitted!', points: pointsAwarded });
});

// External pump report (Google Places / OSM pumps not yet in DB)
// Auto-registers pump in DB and submits report
app.post('/api/reports/submit-external', requireAuth(), async (req,res) => {
  const { external_id, petrol, diesel, cng, ev, queue_length,
          pump_name, pump_address, pump_lat, pump_lng,
          pump_district, pump_state, pump_oil_company, pump_pin } = req.body;
  if (!external_id) return res.status(400).json({ error:'external_id required' });
  if (['govt_official','doc_verifier'].includes(req.user.role))
    return res.status(403).json({ error:'Your role cannot submit reports' });

  try {
    // Check if this external pump already auto-registered in DB
    let pump = dbGet(`SELECT * FROM petrol_pumps WHERE license_number=?`, [external_id]);

    if (!pump) {
      const saveLat = parseFloat(pump_lat) || 0;
      const saveLng = parseFloat(pump_lng) || 0;

      // Route to nearby VERIFIED pump ONLY if very close (~30m) AND same oil company
      // 300m was too wide — in small towns multiple pumps are within 300m of each other
      // causing community reports to silently route to wrong pumps
      if(saveLat && saveLng && pump_oil_company) {
        const R = 0.0003; // ~30m only — same physical pump, different data source
        const nearby = dbGet(
          `SELECT * FROM petrol_pumps WHERE is_verified=1 AND is_active=1
           AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? LIMIT 1`,
          [saveLat-R, saveLat+R, saveLng-R, saveLng+R]
        );
        // Extra safety: only route if oil company matches
        if(nearby && nearby.oil_company &&
           nearby.oil_company.toLowerCase() === pump_oil_company.toLowerCase()) {
          pump = nearby;
          console.log(`[REPORT] Routed to verified pump: ${pump.name} ID:${pump.id}`);
        }
      }

      // Only auto-create if no verified pump found nearby
      if(!pump) {
        const saveName  = pump_name        || 'Community Reported Pump';
        const saveAddr  = pump_address     || '';
        const saveDist  = pump_district    || '';
        const saveState = pump_state       || 'Maharashtra';
        const saveOil   = pump_oil_company || 'Other';
        const savePin   = pump_pin         || '';
        dbRun(`INSERT INTO petrol_pumps
               (name, address, district, pin_code, lat, lng, oil_company,
                is_verified, is_active, license_number, state)
               VALUES (?,?,?,?,?,?,?,0,1,?,?)`,
          [saveName, saveAddr, saveDist, savePin, saveLat, saveLng,
           saveOil, external_id, saveState]);
        pump = dbGet(`SELECT * FROM petrol_pumps WHERE license_number=?`, [external_id]);
        cacheClear('gps:'); cacheClear('pin:');
        console.log(`[NEW PUMP] Auto-registered: ${saveName} | lat:${saveLat},${saveLng}`);
      }
    }

    if (!pump) return res.status(500).json({ error: 'Could not register pump' });

    const hrs = parseInt(getSetting('report_expiry_user') || '4');
    dbRun(`INSERT INTO fuel_reports 
           (pump_id, reported_by, reporter_role, petrol, diesel, cng, ev, queue_length, expires_at)
           VALUES (?,?,?,?,?,?,?,?,datetime('now','+${hrs} hours'))`,
      [pump.id, req.user.id, req.user.role,
       petrol?1:0, diesel?1:0, cng?1:0, ev?1:0, queue_length||'none']);

    console.log(`[REPORT] External pump ${external_id} → DB id:${pump.id} report saved`);
    res.json({ success:true, message:'Report submitted! Thank you.' });

  } catch(e) {
    console.error('[REPORT-EXT]', e.message);
    res.status(500).json({ error: 'Report failed' });
  }
});

// ============================================================
//  PUMP OWNER APPLICATION
// ============================================================
const pumpRegUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const folder = path.join(UPLOAD_PATH, `pump_reg_${Date.now()}`);
      if(!fs.existsSync(folder)) fs.mkdirSync(folder, {recursive:true});
      cb(null, folder);
    },
    filename: (req, file, cb) => {
      cb(null, file.fieldname + '.jpg');
    },
  }),
  limits: { fileSize: 100*1024 },
  fileFilter: (req, file, cb) => {
    ['image/jpeg','image/jpg'].includes(file.mimetype)
      ? cb(null,true) : cb(new Error('JPG only'));
  },
});

app.post('/api/pump-owner/register',
  pumpRegUpload.fields([
    {name:'license', maxCount:1},
    {name:'aadhaar', maxCount:1},
    {name:'selfie',  maxCount:1},
  ]),
  async (req, res) => {
    try {
      const { owner_name, mobile, email, pump_name, oil_company,
              pin_code, address, district, state, license_number,
              lat, lng } = req.body;

      if(!owner_name||!mobile||!email||!pump_name||!license_number||!pin_code)
        return res.status(400).json({ error:'All fields are required' });
      if(mobile.length !== 10)
        return res.status(400).json({ error:'Invalid mobile number' });

      const existing = dbGet(
        `SELECT id FROM pump_applications WHERE license_number=? AND status='pending'`,
        [license_number.toUpperCase()]
      );
      if(existing)
        return res.status(409).json({ error:'Application with this license number already pending' });

      const files = req.files || {};
      const licPath     = files.license?.[0]?.path || null;
      const aadhaarPath = files.aadhaar?.[0]?.path || null;
      const selfiePath  = files.selfie?.[0]?.path  || null;

      if(!licPath)     return res.status(400).json({ error:'Pump license document required' });
      if(!aadhaarPath) return res.status(400).json({ error:'Aadhaar card required' });
      if(!selfiePath)  return res.status(400).json({ error:'Selfie at pump required' });

      let user = dbGet(`SELECT id FROM users WHERE mobile=?`, [mobile]);
      if(!user){
        dbRun(`INSERT INTO users (mobile,name,email,role,subscription_status)
               VALUES (?,?,?,'pump_owner_pending','active')`,
          [mobile, owner_name, email]);
        user = dbGet(`SELECT id FROM users WHERE mobile=?`, [mobile]);
      }

      let pump = dbGet(`SELECT id FROM petrol_pumps WHERE license_number=?`,
        [license_number.toUpperCase()]);
      if(!pump){
        const pumpLat = parseFloat(lat) || 0;
        const pumpLng = parseFloat(lng) || 0;
        dbRun(`INSERT INTO petrol_pumps
               (name, oil_company, pin_code, address, district, state,
                license_number, is_active, owner_user_id, lat, lng)
               VALUES (?,?,?,?,?,?,?,1,?,?,?)`,
          [pump_name, oil_company, pin_code, address, district||'', state||'',
           license_number.toUpperCase(), user.id, pumpLat, pumpLng]);
        pump = dbGet(`SELECT id FROM petrol_pumps WHERE license_number=?`,
          [license_number.toUpperCase()]);
        if(pumpLat !== 0)
          console.log(`[GPS SAVED] ${pump_name} → lat:${pumpLat} lng:${pumpLng} ✅`);
      }

      dbRun(`INSERT INTO pump_applications
             (user_id, pump_id, applicant_name, applicant_email,
              license_number, doc_license, doc_aadhaar, doc_selfie)
             VALUES (?,?,?,?,?,?,?,?)`,
        [user.id, pump.id, owner_name, email,
         license_number.toUpperCase(), licPath, aadhaarPath, selfiePath]);

      const appRow = dbGet(
        `SELECT id FROM pump_applications WHERE user_id=? ORDER BY applied_at DESC LIMIT 1`,
        [user.id]
      );

      console.log(`[PUMP REGISTRATION] ${owner_name} | ${pump_name} | License: ${license_number}`);
      // Trigger AI verification
      if(appRow?.id) triggerAIVerification(appRow.id, 'pump', 'pump');
      res.json({
        success: true,
        app_id: appRow?.id,
        message: 'Application submitted! AI verification started. You will receive email within 24 hours.'
      });
    } catch(e){
      console.error('[pump register error]', e.message);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  }
);

app.get('/pump-signup', (req,res) => res.sendFile(path.join(PUBLIC_PATH,'pump_signup.html')));
app.get('/pump_signup', (req,res) => res.sendFile(path.join(PUBLIC_PATH,'pump_signup.html')));

app.post('/api/pump-owner/change-password', requireAuth(['pump_owner','super_admin']), (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if(!current_password || !new_password)
      return res.status(400).json({ error: 'Both current and new password required' });
    if(new_password.length < 6)
      return res.status(400).json({ error: 'New password must be at least 6 characters' });

    const user = dbGet('SELECT password_hash, plain_password FROM users WHERE id=?', [req.user.id]);
    if(!user) return res.status(404).json({ error: 'User not found' });

    const hashMatch = user.password_hash === hashPwd(current_password);
    const plainMatch = user.plain_password === current_password;
    if(!hashMatch && !plainMatch)
      return res.status(401).json({ error: 'Current password is incorrect' });

    dbRun('UPDATE users SET password_hash=?, plain_password=? WHERE id=?',
      [hashPwd(new_password), new_password, req.user.id]);

    console.log('[PWD CHANGE] Pump owner', req.user.id, 'changed password');
    res.json({ success: true, message: 'Password changed successfully!' });
  } catch(e) {
    res.status(500).json({ error: 'Server error: ' + e.message });
  }
});

app.get('/api/pump-owner/subscription-status', requireAuth(['pump_owner','super_admin']), (req, res) => {
  try {
    const user = dbGet(
      'SELECT subscription_status, created_at, pump_login_id, plain_password FROM users WHERE id=?',
      [req.user.id]
    );
    const pump = dbGet(
      'SELECT name, oil_company, address, pin_code, license_number, is_verified, scan_count_free, scan_period_start FROM petrol_pumps WHERE owner_user_id=? AND is_active=1',
      [req.user.id]
    );

    const premium    = isPumpOwnerPremium(user);
    const trialDays  = parseInt(getSetting('trial_days') || '10');
    const created    = new Date(user.created_at || Date.now());
    const elapsed    = Math.floor((Date.now() - created.getTime()) / 86400000);
    const trialLeft  = Math.max(0, trialDays - elapsed);
    const price      = getSetting('subscription_price') || '14.99';

    const periodStart = pump?.scan_period_start ? new Date(pump.scan_period_start) : null;
    let scanCount = pump?.scan_count_free || 0;
    if(!periodStart || (Date.now() - periodStart) > 86400000) scanCount = 0;

    res.json({
      is_premium:    premium,
      status:        user.subscription_status,
      trial_left:    trialLeft,
      trial_days:    trialDays,
      price:         price,
      login_id:      user.pump_login_id || pump?.license_number || '—',
      pump: pump ? {
        name:          pump.name,
        oil_company:   pump.oil_company,
        address:       pump.address,
        pin_code:      pump.pin_code,
        license_number:pump.license_number,
        is_verified:   pump.is_verified,
      } : null,
      green_tick:    premium && !!pump?.is_verified,
      scan_count:    scanCount,
      scan_limit:    10,
      scan_remaining:Math.max(0, 10 - scanCount),
      scanner_blocked:!premium && scanCount >= 10,
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/fuel-id/scan', requireAuth(['pump_owner','super_admin']), (req, res) => {
  try {
    const { qr_data } = req.body;
    if(!qr_data) return res.status(400).json({error:'QR data required'});
    const pump = dbGet('SELECT * FROM petrol_pumps WHERE owner_user_id=? AND is_active=1',[req.user.id]);
    if(!pump) return res.status(404).json({error:'No pump linked'});

    // ── Universal resolver: user_code / INDHAN: prefix / legacy base64 ──
    function resolveUser(raw) {
      let input = (raw||'').trim();
      if (input.toUpperCase().startsWith('INDHAN:')) input = input.slice(7).trim();
      // New format: 4 uppercase letters (no I/O) + 4 digits (1-9)
      if (/^[A-HJ-NP-Z]{4}[1-9]{4}$/i.test(input)) {
        const u = dbGet('SELECT id,name,mobile,email,role,user_code,vehicle_number,category,profile_complete FROM users WHERE user_code=?', [input.toUpperCase()]);
        return { user: u, fa: u ? dbGet('SELECT * FROM fuel_accounts WHERE user_id=?', [u.id]) : null };
      }
      // Legacy: base64 JSON
      try {
        const decoded = JSON.parse(Buffer.from(input, 'base64').toString('utf8'));
        const uid = decoded.uid || decoded.id;
        const u = uid ? dbGet('SELECT id,name,mobile,email,role,user_code,vehicle_number,category,profile_complete FROM users WHERE id=?', [parseInt(uid)]) : null;
        return { user: u, fa: u ? dbGet('SELECT * FROM fuel_accounts WHERE user_id=?', [u.id]) : null };
      } catch(_) {}
      // Legacy: pipe-separated
      const uid2 = parseInt((input.split('|')[0])||'0');
      const u2 = uid2 ? dbGet('SELECT id,name,mobile,email,role,user_code,vehicle_number,category,profile_complete FROM users WHERE id=?', [uid2]) : null;
      return { user: u2, fa: u2 ? dbGet('SELECT * FROM fuel_accounts WHERE user_id=?', [u2.id]) : null };
    }

    const premium    = isPumpOwnerPremium(req.user);
    const FREE_LIMIT = 10;
    const WARN_AT    = 8;

    if(!premium){
      const now = new Date();
      const periodStart = pump.scan_period_start ? new Date(pump.scan_period_start) : null;
      let scanCount = pump.scan_count_free || 0;
      if(!periodStart || (now-periodStart) > 86400000){
        scanCount = 0;
        dbRun('UPDATE petrol_pumps SET scan_count_free=0,scan_period_start=datetime("now") WHERE id=?',[pump.id]);
      }
      if(scanCount >= FREE_LIMIT){
        return res.status(403).json({
          allowed:false, blocked:true, scan_count:scanCount, limit:FREE_LIMIT,
          error:`Daily scanner limit reached (${FREE_LIMIT} scans). Subscribe to unlock unlimited!`,
          subscribe_url:'/subscribe.html'
        });
      }
      scanCount++;
      dbRun('UPDATE petrol_pumps SET scan_count_free=? WHERE id=?',[scanCount,pump.id]);
      const { user, fa } = resolveUser(qr_data);
      const remaining = FREE_LIMIT - scanCount;
      return res.json({
        allowed:!!fa, is_premium:false, scan_count:scanCount, remaining,
        warning: scanCount>=WARN_AT ? `⚠️ ${remaining} scan${remaining===1?'':'s'} left today!` : null,
        subscribe_url: remaining<=2 ? '/subscribe.html' : null,
        user_name:user?.name||'Unknown', vehicle:(fa?.vehicle_number||'').trim()||(user?.vehicle_number||'').trim()||'—',
        user_code:user?.user_code||'—',
        category:fa?.category||'P5', fuel_type:fa?.fuel_type||'petrol',
        litres_allowed:getLitresForCategory(fa?.category||'P5'),
        message:fa?'✅ Valid Fuel ID':'❌ Invalid QR or Code'
      });
    }

    const { user, fa } = resolveUser(qr_data);
    const rationingOn    = getSetting('rationing_mode')    === '1';
    const verificationOn = getSetting('verification_mode') === '1';

    if(rationingOn && verificationOn && !fa) {
      return res.json({
        allowed:false, denied:true, crisis_block:true,
        user_name:user?.name||'Unknown', user_code:user?.user_code||'—',
        vehicle:'—', category:null, litres_allowed:0,
        message:'🚨 Full Crisis Mode — Fuel ID required. This user has no Fuel ID and cannot get fuel.',
        action:'Direct user to register at IndhanShodhak app',
      });
    }

    const effectiveCategory = fa?.category || (rationingOn ? 'P5' : null);
    res.json({
      allowed:      !!fa || !verificationOn,
      is_premium:   true,
      scan_count:   null, remaining:null,
      warning:      (!fa && rationingOn) ? '⚠️ No Fuel ID — Emergency limit: 10 litres (P5)' : null,
      user_name:    user?.name||'Unknown',
      user_code:    user?.user_code||'—',
      vehicle:      (fa?.vehicle_number||'').trim()||(user?.vehicle_number||'').trim()||'—',
      category:     effectiveCategory || 'P5',
      fuel_type:    fa?.fuel_type||'petrol',
      litres_allowed: getLitresForCategory(effectiveCategory || 'P5'),
      message:      fa ? '✅ Valid Fuel ID' : (rationingOn ? '⚠️ No Fuel ID — Emergency limit applied' : '❌ No Fuel ID'),
    });
  }catch(e){res.status(500).json({error:e.message});}
});

function getLitresForCategory(cat){
  const lim={P1:9999,P2:20,P3:50,P4:30,P5:10};
  return lim[cat]||10;
}

app.get('/api/pump-owner/scan-status', requireAuth(['pump_owner','super_admin']), (req,res)=>{
  const pump=dbGet('SELECT scan_count_free,scan_period_start FROM petrol_pumps WHERE owner_user_id=?',[req.user.id]);
  const premium=isPumpOwnerPremium(req.user);
  let scanCount=pump?.scan_count_free||0;
  const ps=pump?.scan_period_start?new Date(pump.scan_period_start):null;
  if(!ps||(Date.now()-ps)>86400000) scanCount=0;
  res.json({is_premium:premium,scan_count:scanCount,limit:10,
    remaining:Math.max(0,10-scanCount),blocked:!premium&&scanCount>=10,warning:!premium&&scanCount>=8});
});

// ══════════════════════════════════════════════════════════════
// LOCATION CACHE — Pump locations cached long-term
// ══════════════════════════════════════════════════════════════
const locationCache = new Map();

function cacheGet(key) {
  const entry = locationCache.get(key);
  if(!entry) return null;
  if(Date.now() > entry.expires) {
    locationCache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data, hours) {
  locationCache.set(key, {
    data,
    expires: Date.now() + (hours * 3600 * 1000),
    cachedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + hours * 3600000).toISOString()
  });
}

function cacheClear(pattern) {
  for(const key of locationCache.keys()) {
    if(!pattern || key.startsWith(pattern)) locationCache.delete(key);
  }
}

const CACHE_HOURS = {
  PIN:  8760,  // 1 year — pump locations rarely change
  GPS:  8760,  // 1 year — pump locations rarely change
  FUEL: 0,     // Always live — fuel availability is dynamic
};

// ══════════════════════════════════════════════════════════════
// ROUTE 3: Admin — Clear location cache
// ══════════════════════════════════════════════════════════════
app.post('/api/admin/clear-location-cache', requireAuth(['super_admin']), (req, res) => {
  const { pattern } = req.body;
  const before = locationCache.size;
  cacheClear(pattern || '');
  const after = locationCache.size;
  console.log(`[CACHE CLEAR] ${before - after} entries cleared`);
  res.json({ success: true, cleared: before - after, remaining: after });
});

app.get('/api/admin/cache-stats', requireAuth(['super_admin']), (req, res) => {
  const entries = [...locationCache.entries()].map(([key, val]) => ({
    key,
    pump_count: val.data?.pumps?.length || 0,
    cached_at:  val.data?.cached_at || '',
    expires_at: val.expiresAt,
    hours_left: Math.round((val.expires - Date.now()) / 3600000),
  }));
  res.json({ total: locationCache.size, entries });
});

// Manual cache clear — call after approving pumps if green tick doesn't show
app.post('/api/admin/cache-clear', requireAuth(['super_admin','doc_verifier']), (req, res) => {
  const before = locationCache.size;
  cacheClear('pin:');
  cacheClear('gps:');
  console.log(`[CACHE CLEAR MANUAL] ${before} → ${locationCache.size} entries cleared`);
  res.json({ success: true, cleared: before, remaining: locationCache.size });
});

app.post('/api/pump-owner/apply/:pumpId',
  requireAuth(),
  upload.fields([{name:'license',maxCount:1},{name:'aadhaar',maxCount:1},{name:'selfie',maxCount:1}]),
  async (req,res) => {
    const pumpId = parseInt(req.params.pumpId);
    const { license_number, applicant_email } = req.body;
    if (!license_number) return res.status(400).json({ error:'license_number required' });
    if (!req.files?.license||!req.files?.aadhaar||!req.files?.selfie)
      return res.status(400).json({ error:'All 3 documents required' });
    const pump = dbGet(`SELECT * FROM petrol_pumps WHERE id=?`,[pumpId]);
    if (!pump) return res.status(404).json({ error:'Pump not found' });
    const exists = dbGet(`SELECT id FROM pump_applications WHERE user_id=? AND pump_id=? AND status='pending'`,[req.user.id,pumpId]);
    if (exists) return res.status(409).json({ error:'Application already submitted' });
    dbRun(`INSERT INTO pump_applications (user_id,pump_id,applicant_name,applicant_email,license_number,doc_license,doc_aadhaar,doc_selfie)
           VALUES (?,?,?,?,?,?,?,?)`,
      [req.user.id,pumpId,req.user.name,applicant_email||null,license_number,
       req.files.license[0].path,req.files.aadhaar[0].path,req.files.selfie[0].path]);
    const app_row = dbGet(`SELECT id FROM pump_applications WHERE user_id=? AND pump_id=? ORDER BY applied_at DESC LIMIT 1`,[req.user.id,pumpId]);
    const verifiers = dbAll(`SELECT email FROM users WHERE role IN ('doc_verifier','super_admin') AND email IS NOT NULL`);
    verifiers.forEach(v => sendEmail(v.email,`[IndhanShodhak] New Pump Application #${app_row?.id}`,`<p>${req.user.name} applied for <b>${pump.name}</b>. <a href="${process.env.APP_URL||'http://localhost:3000'}/verify">Review</a></p>`));
    res.json({ success:true, message:'Application submitted! Reviewed within 48 hours.' });
  }
);

// ============================================================
//  VERIFIER ROUTES
// ============================================================
app.get('/api/verify/pump-applications', requireAuth(['doc_verifier','super_admin']), (req,res) => {
  const { status='pending' } = req.query;
  const apps = dbAll(`SELECT a.*, u.mobile, p.name as pump_name, p.district, p.oil_company,
    p.address, p.pin_code, p.lat, p.lng, p.is_verified as pump_is_verified,
    q.score as ai_score, q.verdict as ai_verdict, q.status as ai_status, q.reason as ai_reason
    FROM pump_applications a JOIN users u ON u.id=a.user_id JOIN petrol_pumps p ON p.id=a.pump_id
    LEFT JOIN ai_verify_queue q ON q.application_id=a.id AND q.app_table='pump'
    WHERE a.status=? ORDER BY a.applied_at ASC`,[status]);
  res.json({ applications:apps, count:apps.length });
});

const userDocUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const folder = path.join(__dirname, 'uploads', 'user-docs', `user_${Date.now()}`);
      if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
      cb(null, folder);
    },
    filename: (req, file, cb) => {
      const ext = file.mimetype === 'application/pdf' ? '.pdf' : '.jpg';
      cb(null, file.fieldname + ext);
    },
  }),
  limits: { fileSize: 100 * 1024 },
  fileFilter: (req, file, cb) => {
    ['image/jpeg','image/jpg'].includes(file.mimetype)
      ? cb(null, true) : cb(new Error('Only JPG/PNG/PDF allowed'));
  },
});

app.post('/api/user/apply-tier',
  requireAuth(),
  userDocUpload.fields([
    { name: 'doc_aadhaar',          maxCount: 1 },
    { name: 'doc_vehicle_rc',       maxCount: 1 },
    { name: 'doc_dept_id',          maxCount: 1 },
    { name: 'doc_official_letter',  maxCount: 1 },
    { name: 'doc_profession_cert',  maxCount: 1 },
    { name: 'doc_employer_letter',  maxCount: 1 },
    { name: 'doc_commercial_permit',maxCount: 1 },
    { name: 'doc_driver_licence',   maxCount: 1 },
    { name: 'doc_kisan_card',       maxCount: 1 },
    { name: 'doc_land_record',      maxCount: 1 },
  ]),
  (req, res) => {
    try {
      const user = req.user;
      const { applicant_name, vehicle_number, fuel_type, category, profession } = req.body;

      if (!applicant_name || !vehicle_number || !category)
        return res.status(400).json({ error: 'Name, vehicle number and category required' });

      const existing = dbGet(
        `SELECT id, status FROM user_fuel_applications WHERE user_id=? AND category=? AND status='pending'`,
        [user.id, category]
      );
      if (existing)
        return res.status(409).json({ error: `You already have a pending ${category} application. Wait for verifier review.` });

      const files = req.files || {};
      const getPath = (field) => files[field]?.[0]?.path || null;

      if (!getPath('doc_aadhaar'))
        return res.status(400).json({ error: 'Aadhaar card image is mandatory' });

      dbRun(`INSERT INTO user_fuel_applications
        (user_id, applicant_name, applicant_email, vehicle_number, fuel_type, category,
         profession, doc_aadhaar, doc_vehicle_rc, doc_dept_id, doc_official_letter,
         doc_profession_cert, doc_employer_letter,
         doc_commercial_permit, doc_driver_licence, doc_kisan_card, doc_land_record)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [user.id, applicant_name, user.email||'', vehicle_number, fuel_type||'petrol',
         category, profession||'',
         getPath('doc_aadhaar'), getPath('doc_vehicle_rc'),
         getPath('doc_dept_id'), getPath('doc_official_letter'),
         getPath('doc_profession_cert'), getPath('doc_employer_letter'),
         getPath('doc_commercial_permit'), getPath('doc_driver_licence'),
         getPath('doc_kisan_card'), getPath('doc_land_record')]
      );

      console.log(`[APPLICATION] User ${user.id} (${user.mobile}) applied for ${category}`);
      // Trigger AI verification
      const newTierApp = dbGet(`SELECT id FROM user_fuel_applications WHERE user_id=? AND category=? ORDER BY applied_at DESC LIMIT 1`,[user.id, category]);
      if(newTierApp?.id) triggerAIVerification(newTierApp.id, 'user_tier', 'user_tier');
      res.json({
        success: true,
        message: `✅ ${category} application submitted!\nAI verification started. You will receive email within 24 hours.\nOn approval — your QR upgrades automatically!`
      });
    } catch(e) {
      console.error('[apply-tier error]', e.message);
      res.status(500).json({ error: 'Server error: ' + e.message });
    }
  }
);

app.get('/api/verify/fuel-applications', requireAuth(['doc_verifier','super_admin']), (req,res) => {
  const { status='pending', category } = req.query;
  let sql = `SELECT a.*, u.mobile, q.score as ai_score, q.verdict as ai_verdict, q.status as ai_status, q.reason as ai_reason
    FROM user_fuel_applications a JOIN users u ON u.id=a.user_id
    LEFT JOIN ai_verify_queue q ON q.application_id=a.id AND q.app_table='user_tier'
    WHERE a.status=?`;
  const params = [status];
  if (category) { sql+=` AND a.category=?`; params.push(category); }
  sql += ` ORDER BY a.category, a.applied_at ASC`;
  const raw = dbAll(sql, params);

  const docFields = ['doc_aadhaar','doc_vehicle_rc','doc_dept_id','doc_official_letter',
                     'doc_profession_cert','doc_employer_letter','doc_commercial_permit',
                     'doc_driver_licence','doc_kisan_card','doc_land_record'];
  const apps = raw.map(a => {
    const docs = {};
    docFields.forEach(f => {
      const key = f.replace('doc_','');
      if(a[f]) docs[key] = a[f];
    });
    return { ...a, docs_uploaded: Object.keys(docs).length > 0 ? docs : null };
  });

  res.json({ applications:apps, count:apps.length,
    by_category:{P1:apps.filter(a=>a.category==='P1').length,P2:apps.filter(a=>a.category==='P2').length,
                 P3:apps.filter(a=>a.category==='P3').length,P4:apps.filter(a=>a.category==='P4').length,
                 P5:apps.filter(a=>a.category==='P5').length} });
});

app.post('/api/verify/pump-applications/:id/approve', requireAuth(['doc_verifier','super_admin']), async (req,res) => {
  const row = dbGet(`SELECT * FROM pump_applications WHERE id=?`,[parseInt(req.params.id)]);
  if (!row||row.status!=='pending') return res.status(400).json({ error:'Not found or already reviewed' });

  const licenseNo = (row.license_number||'').toUpperCase().replace(/\s/g,'');
  if(!licenseNo) return res.status(400).json({ error:'License number missing. Cannot create login.' });

  const autoPassword = 'IS@' + crypto.randomBytes(4).toString('hex').toUpperCase();

  dbRun(`UPDATE users SET role='pump_owner', password_hash=?, pump_login_id=? WHERE id=?`,
    [hashPwd(autoPassword), licenseNo, row.user_id]);
  dbRun(`UPDATE petrol_pumps SET owner_user_id=?, is_verified=1 WHERE id=?`,[row.user_id,row.pump_id]);

  // Auto-geocode if lat/lng missing — so pump appears on GPS search with green tick!
  const pumpRow = dbGet(`SELECT lat, lng, address, name, pin_code FROM petrol_pumps WHERE id=?`,[row.pump_id]);
  if(pumpRow && (parseFloat(pumpRow.lat||0) === 0)) {
    const gKey = process.env.GOOGLE_PLACES_KEY;
    if(gKey) {
      try {
        const geoQuery = encodeURIComponent(`${pumpRow.name} ${pumpRow.address} ${pumpRow.pin_code} India`);
        const geoResp  = await fetch(
          `https://maps.googleapis.com/maps/api/geocode/json?address=${geoQuery}&key=${gKey}`,
          { signal: AbortSignal.timeout(8000) }
        );
        const geoData = await geoResp.json();
        if(geoData.results && geoData.results[0]) {
          const loc = geoData.results[0].geometry.location;
          dbRun(`UPDATE petrol_pumps SET lat=?, lng=? WHERE id=?`,[loc.lat, loc.lng, row.pump_id]);
          console.log(`[GEOCODE ON APPROVAL] ${pumpRow.name} → lat:${loc.lat} lng:${loc.lng} ✅`);
        }
      } catch(ge) { console.log('[GEOCODE ON APPROVAL] Failed:', ge.message); }
    }
  }

  // Deactivate any auto-created community duplicate at same location
  // Prevents same physical pump appearing twice on user page
  const freshPump = dbGet(`SELECT lat,lng FROM petrol_pumps WHERE id=?`,[row.pump_id]);
  if(freshPump?.lat && freshPump?.lng) {
    const R = 0.003;
    dbRun(`UPDATE petrol_pumps SET is_active=0
           WHERE is_active=1 AND is_verified=0
           AND id != ?
           AND license_number LIKE 'gpl_%'
           AND lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`,
      [row.pump_id, freshPump.lat-R, freshPump.lat+R, freshPump.lng-R, freshPump.lng+R]);
    console.log(`[APPROVAL] Deactivated auto-created duplicates near pump ID:${row.pump_id}`);
  }
  cacheClear('pin:');
  cacheClear('gps:');
  console.log('[CACHE CLEAR] Cleared after pump approval — green tick shows immediately');
  dbRun(`UPDATE pump_applications SET status='approved', reviewed_by=?, reviewed_at=datetime('now') WHERE id=?`,[req.user.id,row.id]);
  if (row.doc_aadhaar&&fs.existsSync(row.doc_aadhaar)) fs.unlinkSync(row.doc_aadhaar);
  const userRow = dbGet(`SELECT mobile FROM users WHERE id=?`,[row.user_id]);
  if (row.applicant_email) await sendEmail(row.applicant_email,
    '[IndhanShodhak] ✅ Pump Verified — Your Login Details!',
    `<div style="font-family:Arial;max-width:480px;margin:0 auto">
      <div style="background:#1a6b2e;padding:20px;text-align:center;border-radius:12px 12px 0 0">
        <div style="font-size:36px">✅</div>
        <div style="color:white;font-size:18px;font-weight:700">Pump Verified!</div>
        <div style="color:rgba(255,255,255,.8);font-size:13px">${row.pump_name||'Your Pump'}</div>
      </div>
      <div style="background:white;padding:20px;border-radius:0 0 12px 12px">
        <p style="color:#333;font-size:14px;margin-bottom:16px">
          Congratulations! Your pump is now verified with a ✅ green tick and appears at the top of search results.
        </p>
        <div style="background:#e8f5e9;border:2px solid #1a6b2e;border-radius:12px;padding:16px;margin-bottom:16px">
          <div style="font-size:13px;font-weight:600;color:#555;margin-bottom:10px">🔐 Your Pump Login Details:</div>
          <div style="margin-bottom:8px">
            <div style="font-size:11px;color:#888">Login ID (your license number):</div>
            <div style="font-size:18px;font-weight:700;color:#1a6b2e;letter-spacing:1px">${licenseNo}</div>
          </div>
          <div>
            <div style="font-size:11px;color:#888">Password (change after first login):</div>
            <div style="font-size:18px;font-weight:700;color:#1565c0;letter-spacing:2px">${autoPassword}</div>
          </div>
        </div>
        <div style="background:#fff3e0;border-radius:10px;padding:12px;margin-bottom:16px;font-size:12px;color:#e65100;line-height:1.7">
          ⚠️ <b>Important:</b><br>
          → Login at: <b>${process.env.APP_URL||'https://www.indhanshodhak.in'}/login.html?role=pump</b><br>
          → Share these credentials with your pump staff<br>
          → Change password after first login from pump dashboard<br>
          → Keep credentials safe — do not share publicly
        </div>
        <p style="color:#888;font-size:12px">IndhanShodhak · Ahilyanagar, Maharashtra</p>
      </div>
    </div>`);
  res.json({ success:true, temp_password:autoPassword, message:'Approved! Aadhaar deleted. Email sent.' });
});

app.post('/api/verify/pump-applications/:id/reject', requireAuth(['doc_verifier','super_admin']), async (req,res) => {
  const { reason } = req.body;
  if (!reason) return res.status(400).json({ error:'Rejection reason required' });
  const row = dbGet(`SELECT * FROM pump_applications WHERE id=?`,[parseInt(req.params.id)]);
  if (!row||row.status!=='pending') return res.status(400).json({ error:'Not found or already reviewed' });
  dbRun(`UPDATE pump_applications SET status='rejected', reject_reason=?, reviewed_by=?, reviewed_at=datetime('now') WHERE id=?`,[reason,req.user.id,row.id]);
  ['doc_license','doc_aadhaar','doc_selfie'].forEach(f => { if(row[f]&&fs.existsSync(row[f])) fs.unlinkSync(row[f]); });
  if (row.applicant_email) await sendEmail(row.applicant_email,'[IndhanShodhak] Application Update',`<p>Reason: ${reason}</p>`);
  res.json({ success:true, message:'Rejected. Documents deleted.' });
});

// ============================================================
//  GOVT DASHBOARD
// ============================================================

// Dynamic district list from actual DB data — always matches stored values
app.get('/api/govt/districts', requireAuth(['govt_official','super_admin','doc_verifier']), (req,res) => {
  const { state='Maharashtra' } = req.query;
  const rows = dbAll(
    `SELECT DISTINCT district FROM petrol_pumps
     WHERE state=? AND is_active=1 AND district IS NOT NULL AND district != ''
     ORDER BY district`,
    [state]
  );
  res.json({ districts: rows.map(r => r.district) });
});

app.get('/api/govt/dashboard', requireAuth(['govt_official','super_admin','doc_verifier']), (req,res) => {
  const { state='Maharashtra', district, tehsil } = req.query;
  let sql = `SELECT p.*, (SELECT mobile FROM users WHERE id=p.owner_user_id) as owner_mobile, r.petrol, r.diesel, r.cng, r.ev, r.reporter_role, r.created_at as report_time
    FROM petrol_pumps p LEFT JOIN fuel_reports r ON r.pump_id=p.id
      AND r.created_at=(SELECT MAX(created_at) FROM fuel_reports WHERE pump_id=p.id AND expires_at>datetime('now'))
    WHERE p.state=? AND p.is_active=1`;
  const params=[state];
  if (district){sql+=` AND p.district=?`;params.push(district);}
  if (tehsil)  {sql+=` AND p.tehsil=?`; params.push(tehsil);}
  sql+=` ORDER BY p.district, p.tehsil, p.name`;
  const pumps=dbAll(sql,params);
  const now=Date.now();
  const byDistrict={}, byTehsil={};
  pumps.forEach(p => {
    if (p.district){
      if(!byDistrict[p.district]) byDistrict[p.district]={total:0,petrol:0,diesel:0,cng:0,stale:0};
      byDistrict[p.district].total++;
      if(p.petrol) byDistrict[p.district].petrol++;
      if(p.diesel) byDistrict[p.district].diesel++;
      if(!p.report_time||(now-new Date(p.report_time).getTime())>6*3600000) byDistrict[p.district].stale++;
    }
    if (p.tehsil){
      if(!byTehsil[p.tehsil]) byTehsil[p.tehsil]={total:0,petrol:0,diesel:0,stale:0};
      byTehsil[p.tehsil].total++;
      if(p.petrol) byTehsil[p.tehsil].petrol++;
      if(p.diesel) byTehsil[p.tehsil].diesel++;
      if(!p.report_time||(now-new Date(p.report_time).getTime())>6*3600000) byTehsil[p.tehsil].stale++;
    }
  });
  const total=pumps.length;
  res.json({ read_only:true, state, district:district||'All', tehsil:tehsil||'All',
    summary:{ total_pumps:total, reporting:pumps.filter(p=>p.report_time).length,
      stale_6hrs:pumps.filter(p=>!p.report_time||(now-new Date(p.report_time).getTime())>6*3600000).length,
      verified_owners:pumps.filter(p=>p.is_verified).length,
      petrol_available:pumps.filter(p=>p.petrol).length, diesel_available:pumps.filter(p=>p.diesel).length,
      petrol_pct:total?Math.round(pumps.filter(p=>p.petrol).length/total*100):0 },
    by_district:byDistrict, by_tehsil:byTehsil, pumps });
});

app.get('/api/govt/export-csv', requireAuth(['govt_official','super_admin','doc_verifier']), (req,res) => {
  const { state='Maharashtra', district, tehsil, date_from, date_to } = req.query;
  let sql=`SELECT p.name, p.tehsil, p.district, p.state, p.oil_company,
      p.license_number, p.address, p.pin_code, p.lat, p.lng,
      p.is_verified, u.mobile as owner_mobile,
      r.petrol, r.diesel, r.cng, r.ev, r.queue_length,
      r.reporter_role, r.created_at as last_updated
    FROM petrol_pumps p
    LEFT JOIN users u ON u.id = p.owner_user_id
    LEFT JOIN fuel_reports r ON r.pump_id=p.id
      AND r.created_at=(SELECT MAX(created_at) FROM fuel_reports WHERE pump_id=p.id AND expires_at>datetime('now'))
    WHERE p.state=? AND p.is_active=1`;
  const params=[state];
  if(district) { sql+=` AND p.district=?`; params.push(district); }
  if(tehsil)   { sql+=` AND p.tehsil=?`;   params.push(tehsil); }
  if(date_from){ sql+=` AND DATE(r.created_at)>=?`; params.push(date_from); }
  if(date_to)  { sql+=` AND DATE(r.created_at)<=?`; params.push(date_to); }
  sql += ` ORDER BY p.district, p.tehsil, p.name`;
  const rows = dbAll(sql, params);
  // BOM for Excel UTF-8 compatibility (Marathi names)
  let csv = '\uFEFF';
  csv += 'Sr No,Pump Name,Address,PIN,Tehsil,District,State,Company,License No,';
  csv += 'Lat,Lng,Verified,Owner Mobile,';
  csv += 'Petrol Available,Diesel Available,CNG Available,EV Charging,Queue,';
  csv += 'Reported By,Last Updated (IST)\n';
  rows.forEach((r, i) => {
    const dt = r.last_updated
      ? new Date(r.last_updated + 'Z').toLocaleString('en-IN', { timeZone:'Asia/Kolkata' })
      : 'No Report';
    const reporterLabel = r.reporter_role === 'pump_owner' ? 'Pump Owner'
      : r.reporter_role === 'user' ? 'Community'
      : r.reporter_role ? r.reporter_role : '—';
    csv += [
      i+1,
      `"${(r.name||'').replace(/"/g,'""')}"`,
      `"${(r.address||'').replace(/"/g,'""')}"`,
      r.pin_code||'',
      `"${r.tehsil||''}"`,
      `"${r.district||''}"`,
      `"${r.state||''}"`,
      `"${r.oil_company||''}"`,
      `"${r.license_number||''}"`,
      r.lat||'',
      r.lng||'',
      r.is_verified ? 'Verified' : 'Not Verified',
      `"${r.owner_mobile||''}"`,
      r.petrol  ? 'Yes' : 'No',
      r.diesel  ? 'Yes' : 'No',
      r.cng     ? 'Yes' : 'No',
      r.ev      ? 'Yes' : 'No',
      r.queue_length||'—',
      reporterLabel,
      `"${dt}"`,
    ].join(',') + '\n';
  });
  const fname = `IndhanShodhak_${state}${district?'_'+district:''}_${new Date().toISOString().slice(0,10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(csv);
});

// ============================================================
//  ADMIN ROUTES
// ============================================================
app.get('/api/admin/settings', requireAuth(['super_admin']), (req,res) => {
  const rows=dbAll(`SELECT * FROM settings ORDER BY key`);
  const s={}; rows.forEach(r=>s[r.key]=r.value); res.json(s);
});

app.post('/api/admin/settings', requireAuth(['super_admin']), (req,res) => {
  const allowed=['subscription_price','trial_days','report_expiry_user','report_expiry_owner','rationing_mode','verification_mode','sla_hours','admin_email','razorpay_key_id','razorpay_key_secret','govt_shared_id','govt_shared_pwd','govt_shared_pwd_plain','mapmyindia_token','gemini_api_key','anthropic_api_key','ai_provider','ai_approve_score','ai_reject_score','ai_workers'];
  const updated=[];
  for (const [k,v] of Object.entries(req.body)) {
    if (allowed.includes(k)) { dbRun(`INSERT OR REPLACE INTO settings(key,value)VALUES(?,?)`,[k,String(v)]); updated.push(k); }
  }
  res.json({ success:true, updated });
});

app.post('/api/admin/create-verifier', (req,res) => {
  const { login_id, mobile, password } = req.body;
  const verifierLoginId = (login_id||mobile||'').trim();
  if(!verifierLoginId || !password)
    return res.status(400).json({ error:'Login ID and password required' });
  if(password.length < 6)
    return res.status(400).json({ error:'Password must be at least 6 characters' });
  const existing = dbGet(
    `SELECT id FROM users WHERE mobile=? OR pump_login_id=?`,
    [verifierLoginId, verifierLoginId.toUpperCase()]
  );
  if(existing) return res.status(409).json({ error:'This Login ID already exists. Choose different ID.' });
  const fakePhone = verifierLoginId;
  dbRun(`INSERT INTO users (mobile,name,role,password_hash,plain_password,subscription_status)
         VALUES (?,?,'doc_verifier',?,?,'active')`,
    [fakePhone, 'Verifier_'+verifierLoginId, hashPwd(password), password]);
  const u = dbGet(`SELECT id FROM users WHERE mobile=?`, [fakePhone]);
  res.json({
    success:  true,
    login_id: verifierLoginId,
    message:  `✅ Verifier created!\nLogin ID: ${verifierLoginId}\nPassword: ${password}\nLogin at: /login?role=verify`
  });
});

app.post('/api/admin/create-govt', (req,res) => {
  const { govt_id, govt_password } = req.body;
  if(!govt_id || !govt_password)
    return res.status(400).json({ error:'Govt ID and password required' });
  if(govt_password.length < 6)
    return res.status(400).json({ error:'Password must be at least 6 characters' });
  dbRun(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`,
    ['govt_shared_id', govt_id.toUpperCase()]);
  dbRun(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`,
    ['govt_shared_pwd', hashPwd(govt_password)]);
  dbRun(`INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)`,
    ['govt_shared_pwd_plain', govt_password]);
  res.json({
    success:  true,
    govt_id:  govt_id.toUpperCase(),
    message:  `✅ Govt login updated!\nGovt ID: ${govt_id.toUpperCase()}\nPassword: ${govt_password}\nLogin at: /govt_login`
  });
});

app.post('/api/admin/pumps/add', requireAuth(['super_admin']), (req,res) => {
  const { name,address,tehsil,district,state,pin_code,lat,lng,oil_company,license_number } = req.body;
  if (!name) return res.status(400).json({ error:'Pump name required' });
  dbRun(`INSERT INTO petrol_pumps (name,address,tehsil,district,state,pin_code,lat,lng,oil_company,license_number) VALUES (?,?,?,?,?,?,?,?,?,?)`,[name,address,tehsil,district,state||'Maharashtra',pin_code,lat,lng,oil_company,license_number]);
  const p=dbGet(`SELECT id FROM petrol_pumps WHERE name=? ORDER BY id DESC LIMIT 1`,[name]);
  res.json({ success:true, pump_id:p?.id });
});

app.get('/api/admin/daily-stats', requireAuth(['super_admin']), (req, res) => {
  const days = parseInt(req.query.days) || 7;

  // ── General Public (role='user') ──────────────────────────────
  const public_total  = parseInt(dbGet(
    `SELECT COUNT(*) as c FROM users WHERE role='user' AND is_active=1`)?.c||0);
  const joined_today  = parseInt(dbGet(
    `SELECT COUNT(*) as c FROM users WHERE role='user' AND is_active=1
     AND DATE(created_at)=DATE('now')`)?.c||0);

  // Tier-wise breakdown from fuel_accounts (only role='user')
  const tierRows = dbAll(
    `SELECT fa.category, COUNT(*) as c
     FROM fuel_accounts fa
     JOIN users u ON u.id=fa.user_id
     WHERE u.role='user' AND fa.is_active=1
     GROUP BY fa.category`
  );
  const tiers = { P1:0, P2:0, P3:0, P4:0, P5:0 };
  tierRows.forEach(r => { if(tiers[r.category]!==undefined) tiers[r.category]=r.c; });
  const tier_upgraded  = Object.values(tiers).reduce((a,b)=>a+b, 0);
  const no_tier        = public_total - tier_upgraded; // KEY METRIC — real active app users

  // ── Pump Owners ────────────────────────────────────────────────
  const pump_owners   = parseInt(dbGet(
    `SELECT COUNT(*) as c FROM users WHERE role='pump_owner' AND is_active=1`)?.c||0);

  // ── Pump Statistics ────────────────────────────────────────────
  const p_total       = parseInt(dbGet(
    `SELECT COUNT(*) as c FROM petrol_pumps WHERE is_active=1`)?.c||0);
  const p_verified    = parseInt(dbGet(
    `SELECT COUNT(*) as c FROM petrol_pumps WHERE is_verified=1 AND is_active=1`)?.c||0);
  const p_today       = parseInt(dbGet(
    `SELECT COUNT(*) as c FROM petrol_pumps WHERE is_active=1
     AND DATE(created_at)=DATE('now')`)?.c||0);

  // ── Daily Growth — new public users per day ────────────────────
  const daily_growth = dbAll(
    `SELECT DATE(created_at) as date, COUNT(*) as new_users
     FROM users WHERE role='user'
     AND created_at >= datetime('now', ?)
     GROUP BY DATE(created_at) ORDER BY date ASC`,
    [`-${days} days`]
  );

  // ── Govt shared ID ─────────────────────────────────────────────
  const govt_shared_id = getSetting('govt_shared_id') || 'INDHAN_GOVT_2026';

  res.json({
    totals: {
      total_users:   public_total,   // General public only (role='user')
      no_tier:       no_tier,        // Using app without tier upgrade ← KEY METRIC
      tier_upgraded: tier_upgraded,  // Have fuel QR/allocation
      tiers,                         // {P1:X, P2:X, P3:X, P4:X, P5:X}
      pump_owners,                   // Separate pump owner count
      joined_today,
      with_aadhaar:  0,              // Not yet in schema
      with_qr:       tier_upgraded,  // = fuel_accounts = QR holders
      // keep legacy fields for admin.html compatibility
      paid:          tier_upgraded,
      trial:         no_tier,
    },
    pump_stats: {
      total:       p_total,
      verified:    p_verified,
      added_today: p_today,
    },
    daily_growth,
    revenue: (() => {
      const price   = parseFloat(getSetting('subscription_price') || '14.99');
      const paying  = parseInt(dbGet(`SELECT COUNT(*) as c FROM users WHERE subscription_status='active'`)?.c || 0);
      const gross   = paying * price;
      const rzp_cut = gross * 0.02;
      const net     = gross - rzp_cut;
      const daily   = gross / 30;
      const yearly  = gross * 12;
      // Today's captured amount from payment_log
      const todayCaptured = parseInt(dbGet(
        `SELECT COALESCE(SUM(amount),0) as t FROM payment_log WHERE DATE(paid_at)=DATE('now') AND status='captured'`)?.t || 0) / 100;
      // Last 30 transactions
      const recent_txns = dbAll(
        `SELECT pl.id, pl.payment_id, pl.order_id, pl.amount, pl.status, pl.paid_at,
                u.name as user_name, u.mobile, u.email
         FROM payment_log pl LEFT JOIN users u ON u.id=pl.user_id
         ORDER BY pl.paid_at DESC LIMIT 30`);
      return {
        paying_users:   paying,
        price_per_user: price.toFixed(2),
        gross_monthly:  gross.toFixed(2),
        net_revenue:    net.toFixed(2),
        daily_revenue:  daily.toFixed(2),
        razorpay_cut:   rzp_cut.toFixed(2),
        google_cut:     (gross * 0.15).toFixed(2),
        yearly_est:     yearly.toFixed(2),
        captured_today: todayCaptured.toFixed(2),
        recent_txns,
      };
    })(),
    govt_shared_id,
  });
});

// Admin: transaction list
app.get('/api/admin/transactions', requireAuth(['super_admin']), (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const txns = dbAll(
    `SELECT pl.id, pl.payment_id, pl.order_id, pl.amount, pl.status, pl.paid_at,
            u.name as user_name, u.mobile, u.email
     FROM payment_log pl LEFT JOIN users u ON u.id=pl.user_id
     ORDER BY pl.paid_at DESC LIMIT ?`, [limit]);
  const totalCaptured = parseFloat(dbGet(
    `SELECT COALESCE(SUM(amount),0) as t FROM payment_log WHERE status='captured'`)?.t || 0) / 100;
  const todayCaptured = parseFloat(dbGet(
    `SELECT COALESCE(SUM(amount),0) as t FROM payment_log WHERE DATE(paid_at)=DATE('now') AND status='captured'`)?.t || 0) / 100;
  res.json({ txns, total_captured: totalCaptured.toFixed(2), today_captured: todayCaptured.toFixed(2), count: txns.length });
});

// Public crisis status — no auth required, used by user page to show crisis banner
app.get('/api/public/crisis-status', (req, res) => {
  const rationing    = getSetting('rationing_mode')    === '1';
  const verification = getSetting('verification_mode') === '1';
  let mode = 'normal';
  if(rationing && verification) mode = 'full-crisis';
  else if(rationing)            mode = 'emergency';
  else if(verification)         mode = 'pre-crisis';
  res.json({ rationing, verification, mode });
});


app.get('/api/admin/analytics', requireAuth(['super_admin']), (req,res) => {
  const price=parseFloat(getSetting('subscription_price')||'14.99');
  const paid=parseInt(dbGet(`SELECT COUNT(*) as c FROM users WHERE subscription_status='active'`)?.c||0);
  res.json({
    users:{ total:parseInt(dbGet(`SELECT COUNT(*) as c FROM users WHERE role='user'`)?.c||0),
      paid, trial:parseInt(dbGet(`SELECT COUNT(*) as c FROM users WHERE subscription_status='trial'`)?.c||0),
      pump_owners:parseInt(dbGet(`SELECT COUNT(*) as c FROM users WHERE role='pump_owner'`)?.c||0),
      verifiers:  parseInt(dbGet(`SELECT COUNT(*) as c FROM users WHERE role='doc_verifier'`)?.c||0),
      govt:       parseInt(dbGet(`SELECT COUNT(*) as c FROM users WHERE role='govt_official'`)?.c||0) },
    pumps:{ total:parseInt(dbGet(`SELECT COUNT(*) as c FROM petrol_pumps WHERE is_active=1`)?.c||0),
      verified:   parseInt(dbGet(`SELECT COUNT(*) as c FROM petrol_pumps WHERE is_verified=1`)?.c||0) },
    applications:{ pump_pending:parseInt(dbGet(`SELECT COUNT(*) as c FROM pump_applications WHERE status='pending'`)?.c||0),
      fuel_pending:parseInt(dbGet(`SELECT COUNT(*) as c FROM user_fuel_applications WHERE status='pending'`)?.c||0) },
    revenue:{ monthly_gross:(paid*price).toFixed(2), net_revenue:(paid*price*0.83).toFixed(2), per_user_per_month:price },
    settings:{ rationing_mode:getSetting('rationing_mode')==='1', verification_mode:getSetting('verification_mode')==='1',
      subscription_price:getSetting('subscription_price'), trial_days:getSetting('trial_days') }
  });
});

// ============================================================
//  PUMP STAFF LOGIN SYSTEM
// ============================================================
app.post('/api/pump-owner/set-staff-password',
  requireAuth(['pump_owner','super_admin']), (req, res) => {
  const { staff_password } = req.body;
  if (!staff_password || staff_password.length < 6)
    return res.status(400).json({ error: 'Staff password must be at least 6 characters' });
  const pump = dbGet(
    `SELECT * FROM petrol_pumps WHERE owner_user_id=? AND is_active=1`, [req.user.id]
  );
  if (!pump) return res.status(404).json({ error: 'No pump linked to your account' });
  dbRun(`UPDATE petrol_pumps SET staff_password=? WHERE id=?`,
    [hashPwd(staff_password), pump.id]);
  const pumpLoginId = 'PUMP_' + pump.oil_company + '_' + pump.id;
  res.json({
    success: true,
    pump_login_id: pumpLoginId,
    staff_password: staff_password,
    message: `Share these credentials with your pump staff:\nPump ID: ${pumpLoginId}\nStaff Password: ${staff_password}`,
  });
});

app.post('/api/auth/staff-login', (req, res) => {
  const { pump_login_id, staff_password, mobile } = req.body;
  if (!pump_login_id || !staff_password || !mobile)
    return res.status(400).json({ error: 'Pump ID, Staff Password and Mobile all required' });
  const parts = pump_login_id.toUpperCase().split('_');
  const pumpId = parseInt(parts[parts.length - 1]);
  if (!pumpId) return res.status(400).json({ error: 'Invalid Pump ID format' });
  const pump = dbGet(`SELECT * FROM petrol_pumps WHERE id=? AND is_active=1`, [pumpId]);
  if (!pump) return res.status(404).json({ error: 'Pump not found. Check Pump ID.' });
  if (!pump.staff_password)
    return res.status(400).json({ error: 'Staff login not set up by pump owner yet.' });
  if (pump.staff_password !== hashPwd(staff_password))
    return res.status(401).json({ error: 'Wrong Staff Password. Ask your pump owner.' });
  const otp = Math.floor(100000 + Math.random() * 900000).toString();
  otpStore[mobile] = { otp, expires: Date.now() + 5 * 60 * 1000, pumpId: pump.id, isStaff: true };
  console.log(`[STAFF OTP] Mobile: ${mobile} | Pump: ${pump.name} | OTP: ${otp}`);
  res.json({
    success: true,
    pump_name: pump.name,
    pump_district: pump.district,
    message: `OTP sent to ${mobile}. Enter to complete staff login.`,
    otp_for_testing: otp,
  });
});

app.post('/api/auth/staff-verify-otp', (req, res) => {
  const { mobile, otp, name } = req.body;
  if (!mobile || !otp) return res.status(400).json({ error: 'Mobile and OTP required' });
  const stored = otpStore[mobile];
  if (!stored || !stored.isStaff)
    return res.status(400).json({ error: 'Staff OTP not sent. Start over.' });
  if (Date.now() > stored.expires) {
    delete otpStore[mobile];
    return res.status(400).json({ error: 'OTP expired. Start over.' });
  }
  if (stored.otp !== otp.toString())
    return res.status(400).json({ error: 'Wrong OTP.' });
  const pumpId = stored.pumpId;
  delete otpStore[mobile];
  let user = dbGet(`SELECT * FROM users WHERE mobile=?`, [mobile]);
  if (!user) {
    dbRun(`INSERT INTO users (mobile,name,role,subscription_status,trial_start_date)
           VALUES (?,?,'pump_staff','active',datetime('now'))`,
      [mobile, name || 'Staff_' + String(mobile).slice(-4)]);
    user = dbGet(`SELECT * FROM users WHERE mobile=?`, [mobile]);
  }
  dbRun(`INSERT OR IGNORE INTO pump_staff (pump_id,user_id,joined_at) VALUES (?,?,datetime('now'))`, [pumpId, user.id]);
  const pump = dbGet(`SELECT * FROM petrol_pumps WHERE id=?`, [pumpId]);
  const token = makeToken(user.id, user.mobile);
  res.json({
    success: true,
    token,
    role: 'pump_staff',
    name: user.name,
    pump_id: pumpId,
    pump_name: pump?.name || '',
    message: 'Staff login successful!',
  });
});

app.get('/api/pump-owner/staff-log', requireAuth(['pump_owner','super_admin']), (req, res) => {
  const pump = dbGet(`SELECT * FROM petrol_pumps WHERE owner_user_id=? AND is_active=1`, [req.user.id]);
  if (!pump) return res.status(404).json({ error: 'No pump linked' });
  const logs = dbAll(`
    SELECT fr.*, u.name as staff_name, u.mobile as staff_mobile
    FROM fuel_reports fr
    JOIN users u ON u.id=fr.reported_by
    WHERE fr.pump_id=?
    ORDER BY fr.created_at DESC LIMIT 50
  `, [pump.id]);
  res.json({ pump_name: pump.name, staff_log: logs, count: logs.length });
});

// ============================================================
//  EMAIL OTP LOGIN
// ============================================================
function generateOTP(){ return Math.floor(100000 + Math.random() * 900000).toString(); }

async function sendOTPEmail(email, otp, name='User') {
  const html = `
  <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;background:#f9f9f9;border-radius:16px;overflow:hidden">
    <div style="background:#1a6b2e;padding:20px;text-align:center">
      <div style="font-size:32px">⛽</div>
      <div style="color:white;font-size:18px;font-weight:700;margin-top:6px">IndhanShodhak</div>
      <div style="color:rgba(255,255,255,.8);font-size:12px">इंधन उपलब्धता शोधा</div>
    </div>
    <div style="padding:24px;background:white">
      <p style="color:#333;font-size:14px;margin-bottom:16px">Hello ${name},</p>
      <p style="color:#555;font-size:13px;margin-bottom:20px">Your login OTP for IndhanShodhak is:</p>
      <div style="background:#f0f9f0;border:2px solid #1a6b2e;border-radius:12px;padding:20px;text-align:center;margin-bottom:20px">
        <div style="font-size:36px;font-weight:700;color:#1a6b2e;letter-spacing:10px">${otp}</div>
        <div style="font-size:12px;color:#888;margin-top:6px">Valid for 10 minutes only</div>
      </div>
      <p style="color:#888;font-size:12px;line-height:1.6">
        This OTP was requested for login to IndhanShodhak — India's Fuel Availability Tracker.<br>
        If you did not request this, please ignore this email.
      </p>
    </div>
    <div style="background:#f5f5f5;padding:12px;text-align:center;font-size:11px;color:#aaa">
      IndhanShodhak · Ahilyanagar, Maharashtra · noreply@indhanshodhak.in
    </div>
  </div>`;

  try {
    await mailer.sendMail({
      from:    MAIL_FROM,
      to:      email,
      subject: `${otp} — Your IndhanShodhak Login OTP`,
      html,
    });
    return true;
  } catch(e) {
    console.error('[EMAIL OTP] Failed:', e.message);
    return false;
  }
}

function isUserPremium(user) {
  if(!user) return false;
  if(['pump_owner','doc_verifier','govt_official','super_admin'].includes(user.role)) return true;
  if(user.subscription_status === 'active') return true;
  if(user.subscription_status === 'trial') {
    const td = parseInt(getSetting('trial_days') || '10');
    if(td === 0) return false;
    const elapsed = Math.floor((Date.now() - new Date(user.created_at||Date.now()).getTime()) / 86400000);
    return elapsed < td;
  }
  return false;
}
function isPumpOwnerPremium(user) {
  if(!user) return false;
  if(user.subscription_status === 'active') {
    if(user.subscription_paid_at) {
      const daysSince = Math.floor((Date.now() - new Date(user.subscription_paid_at).getTime()) / 86400000);
      if(daysSince > 30) return false;
    }
    return true;
  }
  if(user.subscription_status === 'trial') {
    const td = parseInt(getSetting('trial_days') || '10');
    if(td === 0) return false;
    const elapsed = Math.floor((Date.now() - new Date(user.created_at||Date.now()).getTime()) / 86400000);
    return elapsed < td;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════
// PUMP FETCH — Three-tier approach:
// 1. Google Places API (Primary — best India coverage)
// 2. OSM Overpass API  (Fallback — free, no key)
// 3. Mappls RevGeocode (Last resort)
// ══════════════════════════════════════════════════════════════

// TIER 1: Google Places API (New) — Nearby Search
async function fetchGooglePlacesPumps(lat, lng, radiusKm = 8) {
  const apiKey = process.env.GOOGLE_PLACES_KEY;
  if (!apiKey || apiKey.length < 10 || apiKey === 'YOUR_KEY_HERE') {
    console.log('[GOOGLE] No API key configured — skipping');
    return [];
  }

  try {
    console.log(`[GOOGLE] Fetching pumps near ${lat},${lng} radius:${radiusKm}km`);

    const resp = await fetch(
      `https://places.googleapis.com/v1/places:searchNearby`,
      {
        method: 'POST',
        headers: {
          'Content-Type':     'application/json',
          'X-Goog-Api-Key':   apiKey,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.addressComponents',
        },
        body: JSON.stringify({
          includedTypes:    ['gas_station'],
          maxResultCount:   20,
          locationRestriction: {
            circle: {
              center: { latitude: parseFloat(lat), longitude: parseFloat(lng) },
              radius: radiusKm * 1000,
            },
          },
        }),
        signal: AbortSignal.timeout(10000),
      }
    );

    if (!resp.ok) {
      const err = await resp.text().catch(() => '');
      console.error(`[GOOGLE] API error: ${resp.status} | ${err.slice(0, 100)}`);
      return [];
    }

    const data = await resp.json();
    const places = data.places || [];
    console.log(`[GOOGLE] ✅ Found ${places.length} fuel stations`);

    return places.map(p => {
      const name    = p.displayName?.text || 'Petrol Pump';
      const address = p.formattedAddress || '';
      // Extract pincode from addressComponents
      const pinComp = (p.addressComponents || [])
        .find(c => c.types?.includes('postal_code'));
      const pin = pinComp?.longText || '';
      // Extract city/district
      const cityComp = (p.addressComponents || [])
        .find(c => c.types?.includes('locality') || c.types?.includes('administrative_area_level_3'));
      // Also get actual district (level_3) separately for correct DB storage
      const distComp3 = (p.addressComponents || [])
        .find(c => c.types?.includes('administrative_area_level_3'))
        || (p.addressComponents || [])
        .find(c => c.types?.includes('administrative_area_level_2'));
      const city = cityComp?.longText || '';

      return {
        id:          'gpl_' + p.id,
        name:        name,
        oil_company: detectOilCompany(name),
        address:     address,
        district:    distComp3?.longText || city,  // level_3 = actual district
        pin_code:    pin,
        lat:         parseFloat(p.location?.latitude  || 0),
        lng:         parseFloat(p.location?.longitude || 0),
        is_verified: false,
        is_google:   true,
        fuel:        null,
      };
    }).filter(p => p.lat !== 0 && p.lng !== 0);

  } catch(e) {
    console.error('[GOOGLE] Fetch error:', e.message);
    return [];
  }
}

// TIER 2: OSM Overpass API — Free fallback
async function fetchOSMPumps(lat, lng, radiusKm = 8) {
  try {
    const radiusM = radiusKm * 1000;
    const query = `[out:json][timeout:15];(node["amenity"="fuel"](around:${radiusM},${lat},${lng});way["amenity"="fuel"](around:${radiusM},${lat},${lng}););out center 50;`;
    const UA = 'IndhanShodhak/1.0 (fuel tracker India)';

    console.log(`[OSM] Fetching pumps near ${lat},${lng} radius:${radiusKm}km`);

    let resp;
    try {
      resp = await fetch('https://overpass-api.de/api/interpreter', {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json', 'User-Agent': UA },
        body:    'data=' + encodeURIComponent(query),
        signal:  AbortSignal.timeout(15000),
      });
    } catch(e1) {
      resp = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, {
        method: 'GET', headers: { 'Accept': 'application/json', 'User-Agent': UA },
        signal: AbortSignal.timeout(15000),
      });
    }

    if (!resp.ok) { console.error(`[OSM] API error: ${resp.status}`); return []; }

    const data = await resp.json();
    const elements = data.elements || [];
    console.log(`[OSM] ✅ Found ${elements.length} fuel stations`);

    return elements.map(el => {
      const tags = el.tags || {};
      const elat = el.lat || el.center?.lat || 0;
      const elng = el.lon  || el.center?.lon  || 0;
      const name = tags.name || tags['name:en'] || tags.brand || 'Petrol Pump';
      return {
        id:          'osm_' + el.id,
        name:        name,
        oil_company: detectOilCompany(name + ' ' + (tags.brand || '')),
        address:     [tags['addr:housenumber'], tags['addr:street'], tags['addr:city']].filter(Boolean).join(', ') || '',
        district:    tags['addr:district'] || tags['addr:city'] || '',
        pin_code:    tags['addr:postcode'] || '',
        lat:         parseFloat(elat),
        lng:         parseFloat(elng),
        is_verified: false,
        is_osm:      true,
        fuel:        null,
      };
    }).filter(p => p.lat !== 0 && p.lng !== 0);

  } catch(e) {
    console.error('[OSM] Fetch error:', e.message);
    return [];
  }
}

// MAIN: fetchMapMyIndiaPumps — tries all tiers
async function fetchMapMyIndiaPumps(lat, lng, radiusKm = 8) {

  // TIER 1: Google Places (best coverage)
  const googlePumps = await fetchGooglePlacesPumps(lat, lng, radiusKm);
  if (googlePumps.length > 0) return googlePumps;

  // TIER 2: OSM (free fallback)
  const osmPumps = await fetchOSMPumps(lat, lng, radiusKm);
  if (osmPumps.length > 0) return osmPumps;

  // TIER 3: Mappls RevGeocode (last resort)
  const staticKey = process.env.MAPPLS_STATIC_KEY;
  if (!staticKey || staticKey.length < 10) return [];

  try {
    const url = `https://apis.mappls.com/advancedmaps/v1/${staticKey}/revgeocode_nearby` +
      `?lat=${lat}&lng=${lng}&radius=${radiusKm * 1000}&format=json`;
    console.log(`[MAPPLS] Last resort call for ${lat},${lng}`);
    const resp = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return [];
    const data = await resp.json();
    const pumps = (data.results || []).filter(p => {
      const n = (p.placeName || '').toLowerCase();
      return n.includes('petrol') || n.includes('hpcl') || n.includes('bpcl') ||
             n.includes('iocl') || n.includes('hp ') || n.includes('bharat');
    });
    return pumps.map(p => ({
      id: 'mmi_' + (p.eLoc || Math.random().toString(36).slice(2,8)),
      name: p.placeName || 'Petrol Pump',
      oil_company: detectOilCompany(p.placeName || ''),
      address: p.placeAddress || '', district: p.city || '',
      pin_code: p.pincode || '',
      lat: parseFloat(p.latitude || 0), lng: parseFloat(p.longitude || 0),
      is_verified: false, is_mmi: true, fuel: null,
    }));
  } catch(e) { return []; }
}

function detectOilCompany(name) {
  const n = name.toUpperCase();
  if (n.includes('HINDUSTAN') || n.includes('HPCL') || n.includes(' HP ') || n.startsWith('HP ')) return 'HP';
  if (n.includes('INDIAN OIL') || n.includes('IOCL') || n.includes(' IOC') || n.includes('INDANE')) return 'IOC';
  if (n.includes('BHARAT') || n.includes('BPCL') || n.includes(' BP ')) return 'BPCL';
  if (n.includes('SHELL')) return 'Shell';
  if (n.includes('RELIANCE')) return 'Reliance';
  return 'Other';
}

app.post('/api/auth/send-otp', async (req, res) => {
  const { mobile, email } = req.body;
  if (!mobile || String(mobile).length !== 10)
    return res.status(400).json({ error: 'Valid 10-digit mobile number required' });
  if (!email || !email.includes('@'))
    return res.status(400).json({ error: 'Valid email address required to receive OTP' });

  // 60 second rate limit per mobile
  const lastReq = otpRequestCount[mobile];
  if (lastReq && Date.now() - lastReq < 60000) {
    const wait = Math.ceil((60000 - (Date.now() - lastReq)) / 1000);
    return res.status(429).json({
      error: `Please wait ${wait} seconds before requesting another OTP`,
      wait_seconds: wait
    });
  }
  otpRequestCount[mobile] = Date.now();

  const otp = generateOTP();
  otpStore[mobile] = { otp, email, expires: Date.now() + 10 * 60 * 1000 };

  const existingUser = dbGet(`SELECT name FROM users WHERE mobile=?`, [mobile]);
  const userName = existingUser?.name || 'User';

  const sent = await sendOTPEmail(email, otp, userName);

  console.log(`[EMAIL OTP] Mobile: ${mobile} | Email: ${email} | OTP: ${otp} | Sent: ${sent}`);

  if(sent) {
    res.json({
      success: true,
      message: `OTP sent to ${email}`,
      email_hint: email.replace(/(.{2}).*(@.*)/, '$1****$2'),
      otp_for_testing: process.env.NODE_ENV === 'production' ? undefined : otp,
    });
  } else {
    res.json({
      success: true,
      message: `OTP generated (email delivery pending — check server console)`,
      otp_for_testing: otp,
    });
  }
});

app.post('/api/auth/verify-otp', (req, res) => {
  const { mobile, otp, email, name } = req.body;
  if (!mobile || !otp)
    return res.status(400).json({ error: 'Mobile and OTP required' });

  const stored = otpStore[mobile];
  if (!stored)
    return res.status(400).json({ error: 'OTP not sent or expired. Request new OTP.' });
  if (Date.now() > stored.expires) {
    delete otpStore[mobile];
    return res.status(400).json({ error: 'OTP expired (10 min). Please request new OTP.' });
  }
  if (stored.otp !== otp.toString())
    return res.status(400).json({ error: 'Wrong OTP. Please check your email and try again.' });

  delete otpStore[mobile];

  let user = dbGet(`SELECT * FROM users WHERE mobile=?`, [mobile]);
  const userEmail = email || stored.email;

  if (!user) {
    dbRun(`INSERT INTO users (mobile,name,email,subscription_status,trial_start_date)
           VALUES (?,?,?,'trial',datetime('now'))`,
      [mobile, name || 'User_' + String(mobile).slice(-4), userEmail||'']);
    user = dbGet(`SELECT * FROM users WHERE mobile=?`, [mobile]);
    if(userEmail) {
      mailer.sendMail({
        from: MAIL_FROM,
        to:   userEmail,
        subject: "Welcome to IndhanShodhak — India's Fuel Finder! ⛽",
        html: `<div style="font-family:Arial;max-width:480px;margin:0 auto">
          <div style="background:#1a6b2e;padding:20px;text-align:center;border-radius:12px 12px 0 0">
            <div style="font-size:40px">⛽</div>
            <div style="color:white;font-size:20px;font-weight:700">Welcome to IndhanShodhak!</div>
            <div style="color:rgba(255,255,255,.8);font-size:13px">इंधन उपलब्धता शोधा · India's Fuel Finder</div>
          </div>
          <div style="background:white;padding:20px;border-radius:0 0 12px 12px">
            <p style="color:#333;font-size:14px">Your account is created and <b>10-day free trial has started!</b></p>
            <div style="background:#e8f5e9;border-radius:10px;padding:14px;margin:14px 0;font-size:13px;color:#1b5e20;line-height:1.8">
              ✅ Find petrol pumps near you — real-time<br>
              🔔 Get fuel availability alerts<br>
              🎫 Get your Fuel ID QR code<br>
              🗺️ Live map with verified pump locations
            </div>
            <p style="color:#888;font-size:12px">Open IndhanShodhak → Profile → Complete setup → Get QR code</p>
          </div>
        </div>`,
      }).catch(()=>{});
    }
  } else {
    if(userEmail && !user.email) {
      dbRun(`UPDATE users SET email=? WHERE id=?`, [userEmail, user.id]);
    }
    if(name && (user.name||'').startsWith('User_')) {
      dbRun(`UPDATE users SET name=? WHERE id=?`, [name, user.id]);
      user.name = name;
    }
  }

  const isNew = !user.name || user.name.startsWith('User_');
  res.json({
    success:  true,
    token:    makeToken(user.id, user.mobile),
    role:     user.role,
    name:     user.name,
    is_new:   isNew,
    message:  isNew ? 'Welcome! Please complete your profile.' : 'Login successful!',
  });
});

app.get('/api/pump-owner/dashboard', requireAuth(['pump_owner','super_admin']), (req, res) => {
  const pump = dbGet(`SELECT * FROM petrol_pumps WHERE owner_user_id=? AND is_active=1`, [req.user.id]);
  const fuel = pump ? latestReport(pump.id) : null;
  res.json({ pump: pump||null, fuel: fuel||null, operator_name: req.user.name });
});

app.get('/api/admin/users', requireAuth(['super_admin']), (req, res) => {
  const { role } = req.query;
  let sql = `SELECT id,mobile,name,role,email,subscription_status,plain_password,pump_login_id,created_at FROM users WHERE is_active=1`;
  const params = [];
  if (role) { sql += ` AND role=?`; params.push(role); }
  sql += ` ORDER BY CASE role WHEN 'super_admin' THEN 1 WHEN 'doc_verifier' THEN 2 WHEN 'govt_official' THEN 3 WHEN 'pump_owner' THEN 4 ELSE 5 END, created_at DESC`;
  const users = dbAll(sql, params);
  res.json({ users, count: users.length });
});

// ============================================================
//  USER PROFILE
// ============================================================
app.post('/api/user/complete-profile', requireAuth(), async (req, res) => {
  const { aadhaar_number, vehicle_number, name, fuel_type } = req.body;
  if (!aadhaar_number || aadhaar_number.length !== 12)
    return res.status(400).json({ error: 'Valid 12-digit Aadhaar number required' });
  if (!vehicle_number)
    return res.status(400).json({ error: 'Vehicle number required' });
  const existing = dbGet(
    `SELECT id FROM users WHERE aadhaar_number=? AND id!=?`,
    [aadhaar_number, req.user.id]
  );
  if (existing)
    return res.status(409).json({ error: 'This Aadhaar is already registered. Contact support.' });
  if (name) dbRun(`UPDATE users SET name=? WHERE id=?`, [name, req.user.id]);
  dbRun(`UPDATE users SET aadhaar_number=?, aadhaar_verified=1, vehicle_number=?,
         profile_complete=1 WHERE id=?`,
    [aadhaar_number, vehicle_number.toUpperCase(), req.user.id]);
  // ── Assign user_code if not already set ──
  let userRec = dbGet('SELECT user_code FROM users WHERE id=?', [req.user.id]);
  if (!userRec?.user_code) {
    const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ', D = '123456789';
    let code, attempts = 0;
    do {
      code = Array.from({length:4},()=>L[Math.floor(Math.random()*L.length)]).join('') +
             Array.from({length:4},()=>D[Math.floor(Math.random()*D.length)]).join('');
      attempts++;
    } while(dbGet('SELECT id FROM users WHERE user_code=?',[code]) && attempts<100);
    dbRun('UPDATE users SET user_code=? WHERE id=?', [code, req.user.id]);
    userRec = { user_code: code };
  }
  const userCode = userRec.user_code;
  // ── New simple QR: INDHAN:XXXX9999 ──
  const qrData = userCode;
  let qrImageBase64 = '';
  try {
    const QRCode = require('qrcode');
    qrImageBase64 = await QRCode.toDataURL('INDHAN:' + userCode, {
      width: 300, margin: 2,
      color: { dark: '#000000', light: '#ffffff' }
    });
  } catch(e) { console.error('QR gen error:', e.message); }
  dbRun(`UPDATE users SET qr_code_data=?, qr_image_b64=? WHERE id=?`,
    [qrData, qrImageBase64, req.user.id]);
  const user = dbGet(`SELECT * FROM users WHERE id=?`, [req.user.id]);
  res.json({
    success:          true,
    profile_complete: true,
    category:         'P5',
    vehicle_number:   vehicle_number.toUpperCase(),
    user_code:        userCode,
    qr_code_data:     qrData,
    qr_image_b64:     qrImageBase64,
    message:          'Profile complete! P5 QR code generated. Your code: ' + userCode,
  });
});

app.get('/api/user/profile', requireAuth(), async (req, res) => {
  try {
    let user = dbGet(`SELECT id,mobile,name,role,email,subscription_status,
                        aadhaar_verified,vehicle_number,profile_complete,
                        qr_code_data,qr_image_b64,created_at,category,original_category,user_code
                        FROM users WHERE id=?`, [req.user.id]);
    if(!user) return res.status(404).json({error:'User not found'});

    // ── Assign user_code if missing (new users without Aadhaar) ──
    if(!user.user_code) {
      const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ', D = '123456789';
      let newCode, att = 0;
      do {
        newCode = Array.from({length:4},()=>L[Math.floor(Math.random()*L.length)]).join('') +
                  Array.from({length:4},()=>D[Math.floor(Math.random()*D.length)]).join('');
        att++;
      } while(dbGet('SELECT id FROM users WHERE user_code=?',[newCode]) && att<100);
      dbRun('UPDATE users SET user_code=? WHERE id=?', [newCode, user.id]);
      user.user_code = newCode;
      console.log(`[USER_CODE] Assigned new code ${newCode} to user ${user.id} (${user.name})`);
    }

    // ── Generate/regenerate QR if missing or old format ──
    if(!user.qr_image_b64 || user.qr_code_data !== user.user_code) {
      try {
        const QRCode = require('qrcode');
        const newQrImage = await QRCode.toDataURL('INDHAN:' + user.user_code, {
          width: 300, margin: 2,
          color: { dark: '#000000', light: '#ffffff' }
        });
        dbRun(`UPDATE users SET qr_code_data=?, qr_image_b64=? WHERE id=?`,
          [user.user_code, newQrImage, user.id]);
        user.qr_code_data = user.user_code;
        user.qr_image_b64 = newQrImage;
        console.log(`[QR REGEN] User ${user.id} (${user.name}) → INDHAN:${user.user_code}`);
      } catch(qrErr) {
        console.error('[QR REGEN] Error:', qrErr.message);
      }
    }

    const premium   = isUserPremium(user);
    const trialDays = parseInt(getSetting('trial_days')||'10');
    const elapsed   = Math.floor((Date.now()-new Date(user.created_at||Date.now()).getTime())/86400000);
    const trialLeft = Math.max(0, trialDays - elapsed);
    const fa = dbGet('SELECT category,vehicle_number,fuel_type FROM fuel_accounts WHERE user_id=?',[user.id]);
    const origCat = user.original_category || fa?.category || 'P5';
    const effCat  = (!premium && fa?.category && fa.category!=='P5') ? 'P5' : (fa?.category||'P5');
    res.json({
      user, profile_complete:!!user.profile_complete,
      is_premium:premium, trial_remaining:trialLeft, trial_days:trialDays,
      effective_category:effCat, original_category:origCat,
      show_upgrade_prompt:!premium && origCat!=='P5',
    });
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/user/update-name', requireAuth(), (req, res) => {
  const { name, email } = req.body;
  if(!name) return res.status(400).json({ error: 'Name required' });
  dbRun(`UPDATE users SET name=?, email=? WHERE id=?`,
    [name, email||null, req.user.id]);
  res.json({ success: true });
});

// Verifier document view
app.get('/api/verify/document/:type/:id/:docKey', requireAuth(['doc_verifier','super_admin']), (req,res) => {
  const { type, id, docKey } = req.params;
  let row;
  if(type === 'fuel'){
    row = dbGet(`SELECT * FROM user_fuel_applications WHERE id=?`, [parseInt(id)]);
  } else {
    row = dbGet(`SELECT * FROM pump_applications WHERE id=?`, [parseInt(id)]);
  }
  if(!row) return res.status(404).json({ error:'Not found' });
  const fieldName = 'doc_' + docKey;
  const filePath = row[fieldName];
  if(!filePath || !fs.existsSync(filePath))
    return res.status(404).json({ error:'Document not found or deleted' });
  res.sendFile(path.resolve(filePath));
});

app.post('/api/verify/fuel-applications/:id/approve', requireAuth(['doc_verifier','super_admin']), async (req, res) => {
  const row = dbGet(`SELECT * FROM user_fuel_applications WHERE id=?`, [parseInt(req.params.id)]);
  if(!row||row.status!=='pending') return res.status(400).json({ error: 'Not found or already reviewed' });
  const finalCategory = req.body.category || row.category || 'P5';
  dbRun(`INSERT OR REPLACE INTO fuel_accounts (user_id,vehicle_number,fuel_type,category,profession)
         VALUES (?,?,?,?,?)`,
    [row.user_id, row.vehicle_number, row.fuel_type, finalCategory, row.profession||null]);
  const acct = dbGet(`SELECT id FROM fuel_accounts WHERE user_id=?`, [row.user_id]);
  // ── Use existing user_code or assign new one ──
  let approvedUser = dbGet('SELECT user_code FROM users WHERE id=?', [row.user_id]);
  if (!approvedUser?.user_code) {
    const L2 = 'ABCDEFGHJKLMNPQRSTUVWXYZ', D2 = '123456789';
    let code2, att2 = 0;
    do {
      code2 = Array.from({length:4},()=>L2[Math.floor(Math.random()*L2.length)]).join('') +
              Array.from({length:4},()=>D2[Math.floor(Math.random()*D2.length)]).join('');
      att2++;
    } while(dbGet('SELECT id FROM users WHERE user_code=?',[code2]) && att2<100);
    dbRun('UPDATE users SET user_code=? WHERE id=?', [code2, row.user_id]);
    approvedUser = { user_code: code2 };
  }
  const approvedCode = approvedUser.user_code;
  const qrData = approvedCode;
  dbRun(`UPDATE users SET profile_complete=1, qr_code_data=?, category=? WHERE id=?`,
    [qrData, finalCategory, row.user_id]);
  dbRun(`UPDATE user_fuel_applications SET status='approved', reviewed_by=?, reviewed_at=datetime('now'), fuel_account_id=? WHERE id=?`,
    [req.user.id, acct?.id||0, row.id]);
  if(row.doc_aadhaar && require('fs').existsSync(row.doc_aadhaar))
    require('fs').unlinkSync(row.doc_aadhaar);
  if(row.applicant_email){
    const tierNames  = {P1:'Emergency',P2:'Essential Services',P3:'Transport',P4:'Farmer',P5:'General Public'};
    const tierLimits = {P1:'Full Tank · Anytime',P2:'20L / 72hrs',P3:'50L / 48hrs',P4:'30L / 72hrs',P5:'10L / 72hrs'};
    sendEmail(row.applicant_email,
      `✅ IndhanShodhak — ${finalCategory} Fuel ID Approved!`,
      `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
        <div style="background:#1a6b2e;padding:24px;text-align:center;border-radius:12px 12px 0 0">
          <div style="font-size:48px">✅</div>
          <div style="color:white;font-size:20px;font-weight:700;margin-top:8px">Fuel ID Approved!</div>
        </div>
        <div style="background:white;padding:24px;border-radius:0 0 12px 12px">
          <div style="background:#e8f5e9;border:2px solid #1a6b2e;border-radius:12px;padding:16px;margin-bottom:20px;text-align:center">
            <div style="font-size:28px;font-weight:700;color:#1a6b2e">${finalCategory} — ${tierNames[finalCategory]}</div>
            <div style="font-size:16px;color:#2e7d32;margin-top:6px">🚗 ${row.vehicle_number} · ⛽ ${(row.fuel_type||'Petrol').toUpperCase()}</div>
            <div style="background:#1a6b2e;color:white;border-radius:20px;padding:6px 20px;display:inline-block;margin-top:10px">${tierLimits[finalCategory]}</div>
          </div>
        </div>
      </div>`).catch(()=>{});
  }
  res.json({ success: true, category: finalCategory, message: 'Approved! QR generated. Email sent. Aadhaar deleted.' });
});

app.post('/api/verify/fuel-applications/:id/reject', requireAuth(['doc_verifier','super_admin']), async (req, res) => {
  const { reason } = req.body;
  if(!reason) return res.status(400).json({ error: 'Rejection reason required' });
  const row = dbGet(`SELECT * FROM user_fuel_applications WHERE id=?`, [parseInt(req.params.id)]);
  if(!row||row.status!=='pending') return res.status(400).json({ error: 'Not found or already reviewed' });
  dbRun(`UPDATE user_fuel_applications SET status='rejected', reject_reason=?, reviewed_by=?, reviewed_at=datetime('now') WHERE id=?`,
    [reason, req.user.id, row.id]);
  const docFields = ['doc_aadhaar','doc_vehicle_rc','doc_dept_id','doc_official_letter','doc_profession_cert','doc_employer_letter','doc_commercial_permit','doc_driver_licence','doc_kisan_card','doc_land_record'];
  const fs2 = require('fs');
  docFields.forEach(f=>{ if(row[f]&&fs2.existsSync(row[f])) fs2.unlinkSync(row[f]); });
  if(row.applicant_email){
    sendEmail(row.applicant_email,
      '❌ IndhanShodhak — Fuel ID Application Needs Correction',
      `<div style="font-family:Arial;max-width:500px;margin:0 auto">
        <div style="background:#b71c1c;padding:24px;text-align:center;border-radius:12px 12px 0 0">
          <div style="font-size:48px">📋</div>
          <div style="color:white;font-size:20px;font-weight:700">Application Needs Correction</div>
        </div>
        <div style="background:white;padding:24px;border-radius:0 0 12px 12px">
          <div style="background:#ffebee;border:2px solid #b71c1c;border-radius:12px;padding:16px;margin-bottom:20px">
            <div style="font-size:12px;color:#b71c1c;font-weight:600">❌ REASON:</div>
            <div style="font-size:15px;color:#333">${reason}</div>
          </div>
        </div>
      </div>`).catch(()=>{});
  }
  res.json({ success: true, message: 'Rejected. Email sent. Docs deleted.' });
});

app.post('/api/admin/delete-user', requireAuth(['super_admin']), (req, res) => {
  const { user_id } = req.body;
  if(!user_id) return res.status(400).json({ error:'user_id required' });
  const user = dbGet(`SELECT role FROM users WHERE id=?`, [parseInt(user_id)]);
  if(user?.role === 'super_admin')
    return res.status(403).json({ error:'Cannot delete super admin!' });
  dbRun(`UPDATE users SET is_active=0 WHERE id=?`, [parseInt(user_id)]);
  res.json({ success:true });
});

app.post('/api/admin/change-user-password', requireAuth(['super_admin']), (req, res) => {
  const { user_id, new_password, current_password } = req.body;
  if(!new_password)
    return res.status(400).json({ error:'New password required' });
  if(new_password.length < 6)
    return res.status(400).json({ error:'Password must be at least 6 characters' });
  const targetId = (user_id === 'self') ? req.user.id : parseInt(user_id);
  if(user_id === 'self' && current_password) {
    const me = dbGet(`SELECT password_hash FROM users WHERE id=?`, [req.user.id]);
    if(me && me.password_hash !== hashPwd(current_password))
      return res.status(401).json({ error:'Wrong current password' });
  }
  dbRun(`UPDATE users SET password_hash=?, plain_password=? WHERE id=?`,
    [hashPwd(new_password), new_password, targetId]);
  res.json({ success:true, message:'Password changed!' });
});

app.get('/api/payment/config', (req, res) => {
  const key   = getSetting('razorpay_key_id') || 'NOT_SET';
  const price = parseFloat(getSetting('subscription_price') || '14.99');
  const trial = parseInt(getSetting('trial_days') || '10');
  res.json({
    key_id:      key,
    configured:  key !== 'NOT_SET',
    price:       price,
    price_paise: Math.round(price * 100),
    trial_days:  trial,
    currency:    'INR',
  });
});

app.post('/api/payment/create-order', requireAuth(), async (req, res) => {
  const keyId     = getSetting('razorpay_key_id');
  const keySecret = getSetting('razorpay_key_secret');
  if(!keyId || !keySecret || keyId==='NOT_SET')
    return res.status(400).json({ error:'Razorpay not configured. Contact admin.' });
  try {
    const https = require('https');
    const orderData = JSON.stringify({
      amount:   req.body.amount || 1499,
      currency: 'INR',
      receipt:  'indhan_' + req.user.id + '_' + Date.now(),
      notes: { user_id: req.user.id, mobile: req.user.mobile }
    });
    const auth = Buffer.from(keyId + ':' + keySecret).toString('base64');
    const order = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.razorpay.com', path: '/v1/orders', method: 'POST',
        headers: {
          'Content-Type':'application/json',
          'Authorization':'Basic ' + auth,
          'Content-Length': Buffer.byteLength(orderData)
        }
      };
      let data='';
      const req2 = https.request(options, r => { r.on('data',d=>{data+=d;}); r.on('end',()=>resolve(JSON.parse(data))); });
      req2.on('error', reject);
      req2.write(orderData); req2.end();
    });
    if(order.error) return res.status(400).json({ error: order.error.description });
    res.json(order);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/payment/verify', requireAuth(), (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
  const keySecret = getSetting('razorpay_key_secret');
  if(!keySecret) return res.status(400).json({ error:'Not configured' });
  const hmac = require('crypto').createHmac('sha256', keySecret);
  hmac.update(razorpay_order_id + '|' + razorpay_payment_id);
  const expected = hmac.digest('hex');
  if(expected !== razorpay_signature)
    return res.status(400).json({ success:false, error:'Signature mismatch' });
  dbRun(`UPDATE users SET subscription_status='active', subscription_paid_at=datetime('now'),
         razorpay_payment_id=? WHERE id=?`, [razorpay_payment_id, req.user.id]);
  dbRun(`INSERT INTO payment_log (user_id,payment_id,order_id,amount,status,paid_at)
         VALUES (?,?,?,?,?,datetime('now'))`,
    [req.user.id, razorpay_payment_id, razorpay_order_id, 1499, 'captured']);
  const fa2  = dbGet('SELECT category FROM fuel_accounts WHERE user_id=?',[req.user.id]);
  const u2   = dbGet('SELECT original_category FROM users WHERE id=?',[req.user.id]);
  if(fa2&&u2&&u2.original_category&&u2.original_category!==fa2.category){
    dbRun('UPDATE fuel_accounts SET category=? WHERE user_id=?',[u2.original_category,req.user.id]);
    console.log('[TIER RESTORE] User',req.user.id,'restored to',u2.original_category);
  }
  const pump2=dbGet('SELECT id FROM petrol_pumps WHERE owner_user_id=? AND is_active=1',[req.user.id]);
  if(pump2) dbRun('UPDATE petrol_pumps SET is_verified_active=1,scan_count_free=0 WHERE id=?',[pump2.id]);
  res.json({ success:true, message:'Payment verified! Subscription active. Tier restored.' });
});

// ============================================================
//  DATA RETENTION — 90 days as per D3 requirement
// ============================================================
app.get('/api/govt/history', requireAuth(['govt_official','super_admin','doc_verifier']), (req, res) => {
  const { state='Maharashtra', district, days=90, date_from, date_to } = req.query;
  let sql = `SELECT fr.*, p.name as pump_name, p.tehsil, p.district, p.state, p.oil_company
    FROM fuel_reports fr JOIN petrol_pumps p ON p.id=fr.pump_id
    WHERE p.state=?`;
  const params=[state];
  if(date_from && date_to) {
    sql += ` AND DATE(fr.created_at) BETWEEN ? AND ?`;
    params.push(date_from, date_to);
  } else {
    sql += ` AND fr.created_at >= datetime('now','-${parseInt(days)} days')`;
  }
  if(district){sql+=` AND p.district=?`;params.push(district);}
  sql+=` ORDER BY fr.created_at DESC LIMIT 5000`; // Increased from 1000
  const rows = dbAll(sql, params);
  res.json({ reports: rows, count: rows.length, days_retained: days, state, district: district||'All' });
});

app.post('/api/pump-owner/update-fuel', requireAuth(['pump_owner','super_admin']), (req, res) => {
  const { petrol, diesel, cng, ev, queue_length, restock_note } = req.body;
  const pump = dbGet(`SELECT * FROM petrol_pumps WHERE owner_user_id=? AND is_active=1`, [req.user.id]);
  if(!pump) return res.status(404).json({ error:'No pump linked to your account' });
  dbRun(`INSERT INTO fuel_reports (pump_id,reported_by,reporter_role,petrol,diesel,cng,ev,queue_length,restock_note,expires_at)
         VALUES (?,?,?,?,?,?,?,?,?,datetime('now','+12 hours'))`,
    [pump.id, req.user.id, 'pump_owner', petrol?1:0, diesel?1:0, cng?1:0, ev?1:0,
     queue_length||'none', restock_note||null]);

  // ── False Report Detection ───────────────────────────────────────────
  // Find any community report in last 4 hours that contradicts owner's data
  const ownerPetrol = petrol ? 1 : 0;
  const ownerDiesel = diesel ? 1 : 0;
  const recentCommunity = dbAll(`
    SELECT reported_by, petrol, diesel FROM fuel_reports
    WHERE pump_id=? AND reporter_role='user'
      AND created_at >= datetime('now','-4 hours')
    ORDER BY created_at DESC LIMIT 5`, [pump.id]);

  recentCommunity.forEach(cr => {
    // Contradiction: owner says available, community said not (or vice versa)
    const petrolContra = (ownerPetrol !== cr.petrol);
    const dieselContra = (ownerDiesel !== cr.diesel);
    if(petrolContra || dieselContra) {
      try {
        dbRun(`INSERT OR IGNORE INTO user_points(user_id,month_points,carried_points,total_all_time) VALUES(?,0,0,0)`, [cr.reported_by]);
        dbRun(`UPDATE user_points SET month_points=MAX(0,month_points-2), total_all_time=MAX(0,total_all_time-2) WHERE user_id=?`, [cr.reported_by]);
        dbRun(`INSERT INTO point_log(user_id,pump_id,points,reason,created_at) VALUES(?,?,-2,'false_report_penalty',datetime('now'))`, [cr.reported_by, pump.id]);
      } catch(e) { console.error('False report penalty error:', e.message); }
    }
  });

  res.json({
    success: true,
    green_tick: true,
    top_listing: true,
    expires_hours: 12,
    message: '✅ Fuel status updated! Green tick active for 12 hours. Your pump shown at TOP of search results.',
  });
});


// ═══════════════════════════════════════════════════════════════════════
// VERIFIER ACTION ROUTES — Warn / Deregister / Re-register
// ═══════════════════════════════════════════════════════════════════════

// Search community users (general public reporters)
app.get('/api/verify/community-users', requireAuth(['doc_verifier','super_admin']), (req,res) => {
  const { search='' } = req.query;
  const q = `%${search}%`;
  const users = dbAll(`
    SELECT u.id, u.name, u.mobile, u.email, u.is_active, u.created_at,
           up.month_points, up.carried_points, up.total_all_time,
           (SELECT COUNT(*) FROM fuel_reports WHERE reported_by=u.id) as total_reports,
           (SELECT COUNT(*) FROM point_log WHERE user_id=u.id AND reason='false_report_penalty') as penalties
    FROM users u
    LEFT JOIN user_points up ON up.user_id=u.id
    WHERE u.role='user' AND (u.name LIKE ? OR u.mobile LIKE ?)
    ORDER BY total_reports DESC LIMIT 50`, [q, q]);
  res.json({ users });
});

// ── COMMUNITY STATS ──────────────────────────────────────────────────────
app.get('/api/verify/community-stats', requireAuth(['doc_verifier','super_admin']), (req,res) => {
  const total     = parseInt(dbGet(`SELECT COUNT(*) as c FROM users WHERE role='user'`)?.c||0);
  const active    = parseInt(dbGet(`SELECT COUNT(*) as c FROM users WHERE role='user' AND is_active=1`)?.c||0);
  const suspended = parseInt(dbGet(`SELECT COUNT(*) as c FROM users WHERE role='user' AND is_active=0`)?.c||0);
  const reporters = parseInt(dbGet(`SELECT COUNT(DISTINCT reported_by) as c FROM fuel_reports r JOIN users u ON u.id=r.reported_by WHERE u.role='user'`)?.c||0);
  res.json({ total, active, suspended, reporters });
});

// ── COMMUNITY USERS ALL (Browse) ───────────────────────────────────────
app.get('/api/verify/community-users-all', requireAuth(['doc_verifier','super_admin']), (req,res) => {
  const users = dbAll(`
    SELECT u.id, u.name, u.mobile, u.email, u.is_active, u.created_at,
           up.month_points, up.carried_points, up.total_all_time,
           (SELECT COUNT(*) FROM fuel_reports WHERE reported_by=u.id) as total_reports,
           (SELECT COUNT(*) FROM point_log WHERE user_id=u.id AND reason='false_report_penalty') as penalties
    FROM users u
    LEFT JOIN user_points up ON up.user_id=u.id
    WHERE u.role='user'
    ORDER BY total_reports DESC, u.created_at DESC
    LIMIT 200`);
  res.json({ users, count: users.length });
});

// ── WARN ───────────────────────────────────────────────────────────────
app.post('/api/verify/warn-pump/:pumpId', requireAuth(['doc_verifier','super_admin']), async (req,res) => {
  const { pumpId } = req.params;
  const pump = dbGet(`SELECT p.*, u.email, u.name as owner_name, u.mobile
    FROM petrol_pumps p LEFT JOIN users u ON u.id=p.owner_user_id
    WHERE p.id=?`, [pumpId]);
  if(!pump) return res.status(404).json({ error:'Pump not found' });
  const email = pump.email || req.body.email;
  if(email) {
    await sendEmail(email, '⚠️ IndhanShodhak — Warning Notice', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#e65100">⚠️ Warning Notice</h2>
        <p>Dear <b>${pump.owner_name||'Pump Owner'}</b>,</p>
        <p>Your pump <b>"${pump.name}"</b> has been flagged for unethical activity on IndhanShodhak.</p>
        <p><b>Warning:</b> Any further violations will result in immediate de-registration and removal of green tick verification.</p>
        <p>If you believe this is an error, contact the admin team.</p>
        <br><p style="color:#888;font-size:12px">IndhanShodhak — Fuel Monitoring System</p>
      </div>`);
  }
  dbRun(`INSERT INTO verifier_actions (action,target_type,target_id,target_name,reason,verifier_id)
         VALUES ('warn','pump',?,?,?,?)`,
    [pumpId, pump.name, req.body.reason||'Warning issued', req.user.id]);
  console.log(`[WARN] Pump ${pumpId} warned by verifier ${req.user.id}`);
  res.json({ success:true, email_sent:!!email });
});

app.post('/api/verify/warn-user/:userId', requireAuth(['doc_verifier','super_admin']), async (req,res) => {
  const { userId } = req.params;
  const user = dbGet(`SELECT u.*, fa.category FROM users u
    LEFT JOIN fuel_accounts fa ON fa.user_id=u.id WHERE u.id=?`, [userId]);
  if(!user) return res.status(404).json({ error:'User not found' });
  const email = user.email || req.body.email;
  const tierName = {P1:'Emergency',P2:'Essential Services',P3:'Transport',P4:'Farmer',P5:'General Public'}[user.category||'P5'];
  if(email) {
    await sendEmail(email, '⚠️ IndhanShodhak — Warning Notice', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#e65100">⚠️ Warning Notice</h2>
        <p>Dear <b>${user.name}</b>,</p>
        <p>Your IndhanShodhak account (${user.category||'P5'} — ${tierName}) has been flagged for unethical activity.</p>
        <p><b>Warning:</b> Any further violations will result in tier de-registration and loss of Fuel ID privileges.</p>
        <p>Please ensure accurate fuel reporting at all times.</p>
        <br><p style="color:#888;font-size:12px">IndhanShodhak — Fuel Monitoring System</p>
      </div>`);
  }
  dbRun(`INSERT INTO verifier_actions (action,target_type,target_id,target_name,reason,verifier_id)
         VALUES ('warn','tier_user',?,?,?,?)`,
    [userId, user.name, req.body.reason||'Warning issued', req.user.id]);
  res.json({ success:true, email_sent:!!email });
});

app.post('/api/verify/warn-community/:userId', requireAuth(['doc_verifier','super_admin']), async (req,res) => {
  const { userId } = req.params;
  const user = dbGet(`SELECT * FROM users WHERE id=?`, [userId]);
  if(!user) return res.status(404).json({ error:'User not found' });
  if(user.email) {
    await sendEmail(user.email, '⚠️ IndhanShodhak — Warning: False Reporting', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#e65100">⚠️ Warning: False Data Reporting</h2>
        <p>Dear <b>${user.name}</b>,</p>
        <p>Your account has been flagged for submitting inaccurate fuel data on IndhanShodhak.</p>
        <p><b>Reason:</b> ${req.body.reason||'Repeated false fuel status reports detected.'}</p>
        <p><b>Warning:</b> Continued false reporting will result in account suspension and loss of all points.</p>
        <br><p style="color:#888;font-size:12px">IndhanShodhak — Fuel Monitoring System</p>
      </div>`);
  }
  dbRun(`INSERT INTO verifier_actions (action,target_type,target_id,target_name,reason,verifier_id)
         VALUES ('warn','community',?,?,?,?)`,
    [userId, user.name, req.body.reason||'Warning issued', req.user.id]);
  res.json({ success:true, email_sent:!!user.email });
});

// ── DEREGISTER ─────────────────────────────────────────────────────────
app.post('/api/verify/deregister-pump/:pumpId', requireAuth(['doc_verifier','super_admin']), async (req,res) => {
  const { pumpId } = req.params;
  const { reason } = req.body;
  if(!reason || reason.length < 10) return res.status(400).json({ error:'Reason required (min 10 chars)' });
  const pump = dbGet(`SELECT p.*, u.email, u.name as owner_name
    FROM petrol_pumps p LEFT JOIN users u ON u.id=p.owner_user_id WHERE p.id=?`, [pumpId]);
  if(!pump) return res.status(404).json({ error:'Pump not found' });
  // Remove verification
  dbRun(`UPDATE petrol_pumps SET is_verified=0 WHERE id=?`, [pumpId]);
  cacheClear('gps:'); cacheClear('pin:');
  // Send email
  if(pump.email) {
    await sendEmail(pump.email, '🚫 IndhanShodhak — Pump De-registered', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#b71c1c">🚫 Pump De-registered</h2>
        <p>Dear <b>${pump.owner_name||'Pump Owner'}</b>,</p>
        <p>Your pump <b>"${pump.name}"</b> has been de-registered from IndhanShodhak.</p>
        <p><b>Reason:</b> ${reason}</p>
        <p>The green tick verification has been removed. You may re-apply after resolving the issue.</p>
        <br><p style="color:#888;font-size:12px">IndhanShodhak — Fuel Monitoring System</p>
      </div>`);
  }
  dbRun(`INSERT INTO verifier_actions (action,target_type,target_id,target_name,reason,verifier_id)
         VALUES ('deregister','pump',?,?,?,?)`,
    [pumpId, pump.name, reason, req.user.id]);
  console.log(`[DEREGISTER] Pump ${pumpId} deregistered by verifier ${req.user.id}. Reason: ${reason}`);
  res.json({ success:true });
});

app.post('/api/verify/deregister-user/:userId', requireAuth(['doc_verifier','super_admin']), async (req,res) => {
  const { userId } = req.params;
  const { reason } = req.body;
  if(!reason || reason.length < 10) return res.status(400).json({ error:'Reason required (min 10 chars)' });
  const user = dbGet(`SELECT u.*, fa.category FROM users u
    LEFT JOIN fuel_accounts fa ON fa.user_id=u.id WHERE u.id=?`, [userId]);
  if(!user) return res.status(404).json({ error:'User not found' });
  // Deactivate fuel account (remove tier + QR)
  dbRun(`UPDATE fuel_accounts SET is_active=0 WHERE user_id=?`, [userId]);
  // Deduct 10 points inline
  dbRun(`INSERT OR IGNORE INTO user_points(user_id) VALUES(?)`, [userId]);
  dbRun(`UPDATE user_points SET month_points=MAX(0,month_points-10), total_all_time=MAX(0,total_all_time-10) WHERE user_id=?`, [userId]);
  dbRun(`INSERT INTO point_log(user_id,pump_id,points,reason,created_at) VALUES(?,NULL,-10,'deregister_penalty',datetime('now'))`, [userId]);
  // Send email
  if(user.email) {
    await sendEmail(user.email, '🚫 IndhanShodhak — Fuel ID De-registered', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#b71c1c">🚫 Fuel ID De-registered</h2>
        <p>Dear <b>${user.name}</b>,</p>
        <p>Your Fuel ID (${user.category||'P5'}) has been de-registered from IndhanShodhak.</p>
        <p><b>Reason:</b> ${reason}</p>
        <p>Your QR code is now invalid. 10 reporter points have been deducted. You may re-apply after resolving the issue.</p>
        <br><p style="color:#888;font-size:12px">IndhanShodhak — Fuel Monitoring System</p>
      </div>`);
  }
  dbRun(`INSERT INTO verifier_actions (action,target_type,target_id,target_name,reason,verifier_id)
         VALUES ('deregister','tier_user',?,?,?,?)`,
    [userId, user.name, reason, req.user.id]);
  res.json({ success:true });
});

app.post('/api/verify/deregister-community/:userId', requireAuth(['doc_verifier','super_admin']), async (req,res) => {
  const { userId } = req.params;
  const { reason } = req.body;
  if(!reason || reason.length < 10) return res.status(400).json({ error:'Reason required (min 10 chars)' });
  const user = dbGet(`SELECT * FROM users WHERE id=?`, [userId]);
  if(!user) return res.status(404).json({ error:'User not found' });
  dbRun(`UPDATE users SET is_active=0 WHERE id=?`, [userId]);
  // Deduct 10 points inline (deductPoints function not defined)
  dbRun(`INSERT OR IGNORE INTO user_points(user_id) VALUES(?)`, [userId]);
  dbRun(`UPDATE user_points SET month_points=MAX(0,month_points-10), total_all_time=MAX(0,total_all_time-10) WHERE user_id=?`, [userId]);
  dbRun(`INSERT INTO point_log(user_id,pump_id,points,reason,created_at) VALUES(?,NULL,-10,'deregister_penalty',datetime('now'))`, [userId]);
  if(user.email) {
    await sendEmail(user.email, '🚫 IndhanShodhak — Account Suspended', `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#b71c1c">🚫 Account Suspended</h2>
        <p>Dear <b>${user.name}</b>,</p>
        <p>Your IndhanShodhak account has been suspended due to unethical activity.</p>
        <p><b>Reason:</b> ${reason}</p>
        <p>10 reporter points have been deducted. Contact admin to appeal.</p>
        <br><p style="color:#888;font-size:12px">IndhanShodhak — Fuel Monitoring System</p>
      </div>`);
  }
  dbRun(`INSERT INTO verifier_actions (action,target_type,target_id,target_name,reason,verifier_id)
         VALUES ('deregister','community',?,?,?,?)`,
    [userId, user.name, reason, req.user.id]);
  res.json({ success:true });
});

// ── RE-REGISTER ────────────────────────────────────────────────────────
app.post('/api/verify/reregister-pump/:pumpId', requireAuth(['doc_verifier','super_admin']), async (req,res) => {
  const { pumpId } = req.params;
  dbRun(`UPDATE petrol_pumps SET is_verified=1 WHERE id=?`, [pumpId]);
  cacheClear('gps:'); cacheClear('pin:');
  const pump = dbGet(`SELECT name FROM petrol_pumps WHERE id=?`, [pumpId]);
  dbRun(`INSERT INTO verifier_actions (action,target_type,target_id,target_name,reason,verifier_id)
         VALUES ('reregister','pump',?,?,?,?)`,
    [pumpId, pump?.name||'', req.body.reason||'Re-registered', req.user.id]);
  res.json({ success:true });
});

app.post('/api/verify/reregister-user/:userId', requireAuth(['doc_verifier','super_admin']), async (req,res) => {
  const { userId } = req.params;
  dbRun(`UPDATE fuel_accounts SET is_active=1 WHERE user_id=?`, [userId]);
  const user = dbGet(`SELECT name FROM users WHERE id=?`, [userId]);
  dbRun(`INSERT INTO verifier_actions (action,target_type,target_id,target_name,reason,verifier_id)
         VALUES ('reregister','tier_user',?,?,?,?)`,
    [userId, user?.name||'', req.body.reason||'Re-registered', req.user.id]);
  res.json({ success:true });
});

app.post('/api/verify/reregister-community/:userId', requireAuth(['doc_verifier','super_admin']), async (req,res) => {
  const { userId } = req.params;
  dbRun(`UPDATE users SET is_active=1 WHERE id=?`, [userId]);
  const user = dbGet(`SELECT name FROM users WHERE id=?`, [userId]);
  dbRun(`INSERT INTO verifier_actions (action,target_type,target_id,target_name,reason,verifier_id)
         VALUES ('reregister','community',?,?,?,?)`,
    [userId, user?.name||'', req.body.reason||'Re-registered', req.user.id]);
  res.json({ success:true });
});


// ── Pages
app.get('/app',               (req,res) => res.sendFile(path.join(PUBLIC_PATH,'index.html')));
app.get('/landing',           (req,res) => res.sendFile(path.join(PUBLIC_PATH,'landing.html')));
app.get('/home',              (req,res) => res.sendFile(path.join(PUBLIC_PATH,'landing.html')));
app.get('/login',             (req,res) => res.sendFile(path.join(PUBLIC_PATH,'login.html')));
app.get('/login.html',        (req,res) => res.sendFile(path.join(PUBLIC_PATH,'login.html')));
app.get('/login.html.html',   (req,res) => res.sendFile(path.join(PUBLIC_PATH,'login.html')));
app.get('/otp_login', (req,res)=>res.redirect('/login'));
app.get('/otp_login_old',         (req,res) => res.sendFile(path.join(PUBLIC_PATH,'otp_login.html')));
app.get('/otp_login.html',    (req,res) => res.sendFile(path.join(PUBLIC_PATH,'otp_login.html')));
app.get('/govt_login',        (req,res) => res.sendFile(path.join(PUBLIC_PATH,'govt_login.html')));
app.get('/govt_login.html',   (req,res) => res.sendFile(path.join(PUBLIC_PATH,'govt_login.html')));
app.get('/profile_setup',     (req,res) => res.sendFile(path.join(PUBLIC_PATH,'profile_setup.html')));
app.get('/profile_setup.html',(req,res) => res.sendFile(path.join(PUBLIC_PATH,'profile_setup.html')));
app.get('/subscribe',         (req,res) => res.sendFile(path.join(PUBLIC_PATH,'subscribe.html')));
app.get('/subscribe.html',    (req,res) => res.sendFile(path.join(PUBLIC_PATH,'subscribe.html')));
app.get('/pump-owner', (req,res) => res.sendFile(path.join(PUBLIC_PATH,'pump-owner.html')));
app.get('/verify',     (req,res) => res.sendFile(path.join(PUBLIC_PATH,'verify.html')));
app.get('/govt',       (req,res) => res.sendFile(path.join(PUBLIC_PATH,'govt.html')));
app.get('/admin',      (req,res) => res.sendFile(path.join(PUBLIC_PATH,'admin.html')));

// API 404 handler
app.use('/api', (req, res) => {
  res.status(404).json({ error: `API route not found: ${req.method} ${req.path}` });
});

// ── Start ─────────────────────────────────────────────────────
initDB().then(() => {
  // ── Table migrations for existing DBs (safe to run every startup) ──────
  try {
    dbRun(`CREATE TABLE IF NOT EXISTS user_points (
      user_id INTEGER PRIMARY KEY, month_points INTEGER DEFAULT 0,
      carried_points INTEGER DEFAULT 0, total_all_time INTEGER DEFAULT 0,
      redeemed_month INTEGER DEFAULT 0, month_year TEXT DEFAULT '',
      last_updated TEXT DEFAULT (datetime('now')))`);
    dbRun(`CREATE TABLE IF NOT EXISTS point_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL,
      pump_id INTEGER, points INTEGER NOT NULL, reason TEXT NOT NULL,
      month_year TEXT, created_at TEXT DEFAULT (datetime('now')))`);
    dbRun(`CREATE TABLE IF NOT EXISTS verifier_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT NOT NULL,
      target_type TEXT NOT NULL, target_id INTEGER NOT NULL,
      target_name TEXT, reason TEXT, verifier_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')))`);
    try { dbRun(`ALTER TABLE users ADD COLUMN state TEXT DEFAULT ''`); } catch(e){}
    console.log('[DB] ✅ Migration tables verified');
  } catch(me) { console.error('[DB] Migration error:', me.message); }
  // ── Session cleanup ────────────────────────────────────────────────────
  try { dbRun(`DELETE FROM sessions WHERE expires_at < datetime('now')`); } catch(e){}
  setInterval(()=>{ try{dbRun(`DELETE FROM sessions WHERE expires_at<datetime('now')`)}catch(e){} }, 6*60*60*1000);

  // ── Daily AI Summary Email — runs at 8 PM IST every day ──────────────────
  function scheduleDailySummary() {
    const now = new Date();
    // Calculate next 8 PM IST (UTC+5:30 = 14:30 UTC)
    const next8PM = new Date();
    next8PM.setUTCHours(14, 30, 0, 0);
    if(now >= next8PM) next8PM.setUTCDate(next8PM.getUTCDate() + 1);
    const msUntil = next8PM - now;
    console.log(`[AI AGENT] Daily summary scheduled in ${Math.round(msUntil/3600000)}hrs`);
    setTimeout(async () => {
      await sendDailySummary();
      setInterval(sendDailySummary, 24*60*60*1000); // repeat every 24h
    }, msUntil);
  }

  async function sendDailySummary() {
    try {
      const adminEmail = getSetting('admin_email') || process.env.EMAIL_USER;
      if(!adminEmail) return;
      const today = new Date().toISOString().slice(0,10);

      // AI verification stats for today
      const approved  = parseInt(dbGet(`SELECT COUNT(*) as c FROM ai_verify_queue WHERE verdict='approve' AND DATE(processed_at)=?`,[today])?.c||0);
      const rejected  = parseInt(dbGet(`SELECT COUNT(*) as c FROM ai_verify_queue WHERE verdict='reject' AND DATE(processed_at)=?`,[today])?.c||0);
      const escalated = parseInt(dbGet(`SELECT COUNT(*) as c FROM ai_verify_queue WHERE verdict='escalate' AND DATE(processed_at)=?`,[today])?.c||0);
      const failed    = parseInt(dbGet(`SELECT COUNT(*) as c FROM ai_verify_queue WHERE status='failed' AND DATE(processed_at)=?`,[today])?.c||0);
      const pending   = parseInt(dbGet(`SELECT COUNT(*) as c FROM ai_verify_queue WHERE status='pending'`)?.c||0);
      const provider  = getSetting('ai_provider') || 'gemini';

      // New registrations today
      const newUsers  = parseInt(dbGet(`SELECT COUNT(*) as c FROM users WHERE DATE(created_at)=?`,[today])?.c||0);
      const newPumps  = parseInt(dbGet(`SELECT COUNT(*) as c FROM pump_applications WHERE DATE(applied_at)=?`,[today])?.c||0);
      const newTier   = parseInt(dbGet(`SELECT COUNT(*) as c FROM user_fuel_applications WHERE DATE(applied_at)=?`,[today])?.c||0);
      const reports   = parseInt(dbGet(`SELECT COUNT(*) as c FROM fuel_reports WHERE DATE(created_at)=?`,[today])?.c||0);

      // Skip if nothing happened today
      if(approved+rejected+escalated+failed+newUsers+newPumps+reports === 0) {
        console.log('[AI AGENT] Daily summary: no activity today — skipping email');
        return;
      }

      const needsAttention = escalated > 0 || pending > 0 || failed > 0;
      const subject = needsAttention
        ? `⚠️ IndhanShodhak Daily Summary — ${escalated+pending} need attention`
        : `✅ IndhanShodhak Daily Summary — ${today}`;

      const html = `<div style="font-family:sans-serif;max-width:520px;margin:0 auto">
        <div style="background:#1a6b2e;padding:16px 20px;border-radius:12px 12px 0 0">
          <h2 style="color:white;margin:0">⛽ IndhanShodhak Daily Summary</h2>
          <p style="color:rgba(255,255,255,.8);margin:4px 0 0;font-size:13px">${today} · AI Provider: ${provider.toUpperCase()}</p>
        </div>
        <div style="background:#f9f9f9;padding:16px 20px;border-radius:0 0 12px 12px;border:1px solid #e0e0e0">

          <div style="margin-bottom:16px">
            <div style="font-size:13px;font-weight:700;color:#555;margin-bottom:8px">🤖 AI Verification Today</div>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:6px 0;font-size:13px">✅ Auto-Approved</td><td style="text-align:right;font-weight:700;color:#1a6b2e">${approved}</td></tr>
              <tr><td style="padding:6px 0;font-size:13px">❌ Auto-Rejected</td><td style="text-align:right;font-weight:700;color:#b71c1c">${rejected}</td></tr>
              ${escalated>0?`<tr style="background:#fff3e0"><td style="padding:6px 0;font-size:13px">⚠️ Needs Manual Review</td><td style="text-align:right;font-weight:700;color:#e65100">${escalated}</td></tr>`:''}
              ${pending>0?`<tr style="background:#fff3e0"><td style="padding:6px 0;font-size:13px">⏳ Still Pending</td><td style="text-align:right;font-weight:700;color:#e65100">${pending}</td></tr>`:''}
              ${failed>0?`<tr style="background:#ffebee"><td style="padding:6px 0;font-size:13px">🔴 Failed Jobs</td><td style="text-align:right;font-weight:700;color:#b71c1c">${failed}</td></tr>`:''}
            </table>
          </div>

          <div style="margin-bottom:16px;border-top:1px solid #e0e0e0;padding-top:12px">
            <div style="font-size:13px;font-weight:700;color:#555;margin-bottom:8px">📊 App Activity Today</div>
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:4px 0;font-size:13px">👤 New Users</td><td style="text-align:right;font-weight:600">${newUsers}</td></tr>
              <tr><td style="padding:4px 0;font-size:13px">⛽ Pump Applications</td><td style="text-align:right;font-weight:600">${newPumps}</td></tr>
              <tr><td style="padding:4px 0;font-size:13px">🎫 Tier Upgrade Requests</td><td style="text-align:right;font-weight:600">${newTier}</td></tr>
              <tr><td style="padding:4px 0;font-size:13px">📋 Fuel Reports Filed</td><td style="text-align:right;font-weight:600">${reports}</td></tr>
            </table>
          </div>

          ${needsAttention ? `<div style="background:#fff3e0;border:1px solid #ffe082;border-radius:8px;padding:10px 14px;margin-bottom:12px">
            <b style="color:#e65100">⚠️ Action Required</b><br>
            <span style="font-size:12px;color:#555">${escalated} escalated · ${pending} pending jobs need attention.</span><br>
            <a href="${process.env.APP_URL||'https://www.indhanshodhak.in'}/verify" style="font-size:12px;color:#1a6b2e;font-weight:700">Open Verifier Panel →</a>
          </div>` : ''}

          <p style="font-size:11px;color:#aaa;margin:0;border-top:1px solid #e0e0e0;padding-top:10px">
            IndhanShodhak AI Agent · Auto-generated daily summary · Do not reply
          </p>
        </div>
      </div>`;

      await sendEmail(adminEmail, subject, html);
      console.log(`[AI AGENT] ✅ Daily summary sent to ${adminEmail}`);
    } catch(e) {
      console.error('[AI AGENT] Daily summary error:', e.message);
    }
  }

  scheduleDailySummary();

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`
╔══════════════════════════════════════════════════╗
║   🚀 IndhanShodhak FIXED SERVER v2.0            ║
║   Node.js ${process.version} — sql.js (no compile)       ║
╠══════════════════════════════════════════════════╣
║   http://localhost:${PORT}/           Landing Page   ║
║   http://localhost:${PORT}/admin      Admin Panel    ║
║   http://localhost:${PORT}/govt       Govt Dashboard ║
║   http://localhost:${PORT}/verify     Verifier Panel ║
║   http://localhost:${PORT}/pump-owner Pump Scanner   ║
╠══════════════════════════════════════════════════╣
║   ✅ FIXED: RevGeocode Nearby API integration   ║
║   ✅ FIXED: otpStore location                   ║
║   ✅ FIXED: visitor_log table                   ║
╚══════════════════════════════════════════════════╝
    `);
  });
}).catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});