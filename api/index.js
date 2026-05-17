require('dotenv').config();

process.on('uncaughtException', (err) => {
  console.error('❌ Exception non gérée:', err.stack || err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ Rejet de promesse non géré:', reason?.stack || reason);
  process.exit(1);
});

const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const PDFDocument = require('pdfkit');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

const app = express();
const PORT = process.env.PORT || 3050;
const JWT_SECRET = process.env.JWT_SECRET || 'foodchooseapp_2024_secret';

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// All API routes first
app.get('/api/test', (req, res) => {
  res.json({ test: 'success' });
});

app.get('/api/cron/test', (req, res) => {
  res.json({ test: 'cron working' });
});

const PUBLIC_DIR = path.join(__dirname, '../public');
app.use(express.static(PUBLIC_DIR));

// ─── DB ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('⚠ Pool error:', err.message);
});

async function initDB(retries = 5, delay = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query('SELECT 1');
      break;
    } catch (e) {
      if (attempt === retries) { console.error('DB inaccessible après', retries, 'tentatives:', e.message); return; }
      console.log(`DB pas encore prête (tentative ${attempt}/${retries}), retry dans ${delay/1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  const sql = `
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, sector VARCHAR(255),
      phone VARCHAR(50), address TEXT, email VARCHAR(255) UNIQUE NOT NULL,
      location VARCHAR(255), password_hash VARCHAR(255) NOT NULL, logo_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS restaurants (
      id SERIAL PRIMARY KEY, name VARCHAR(255) NOT NULL, address TEXT,
      location VARCHAR(255), email VARCHAR(255) UNIQUE NOT NULL, phone VARCHAR(50),
      payment_types JSONB DEFAULT '[]', specialties JSONB DEFAULT '[]',
      password_hash VARCHAR(255) NOT NULL, photo_url TEXT, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS affiliations (
      id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT NOW(), UNIQUE(company_id, restaurant_id)
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      employee_id VARCHAR(100) UNIQUE NOT NULL, first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL, email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL, photo_url TEXT, drink_preference VARCHAR(20),
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS menus (
      id SERIAL PRIMARY KEY, restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL, description TEXT, category VARCHAR(100) DEFAULT 'plat',
      price DECIMAL(10,2) DEFAULT 0, available BOOLEAN DEFAULT TRUE, image_url TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id),
      restaurant_id INTEGER REFERENCES restaurants(id),
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      menu_id INTEGER REFERENCES menus(id), order_date DATE NOT NULL DEFAULT CURRENT_DATE,
      drink_preference VARCHAR(20), status VARCHAR(30) DEFAULT 'pending', notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(user_id, restaurant_id, order_date)
    );
    CREATE TABLE IF NOT EXISTS order_batches (
      id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id),
      restaurant_id INTEGER REFERENCES restaurants(id), batch_date DATE NOT NULL,
      status VARCHAR(30) DEFAULT 'pending', total_amount DECIMAL(10,2) DEFAULT 0,
      confirmed_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(company_id, restaurant_id, batch_date)
    );
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id),
      restaurant_id INTEGER REFERENCES restaurants(id),
      batch_id INTEGER REFERENCES order_batches(id),
      invoice_date DATE DEFAULT CURRENT_DATE, total_amount DECIMAL(10,2),
      items JSONB DEFAULT '[]', status VARCHAR(20) DEFAULT 'pending',
      sent BOOLEAN DEFAULT FALSE, sent_at TIMESTAMP, from_date DATE, to_date DATE,
      confirmed_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS order_history (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      company_id INTEGER REFERENCES companies(id), employee_id VARCHAR(100),
      employee_name VARCHAR(255), restaurant_name VARCHAR(255), menu_name VARCHAR(255),
      order_date DATE, drink_preference VARCHAR(20), action VARCHAR(50),
      action_timestamp TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY, sender_type VARCHAR(20) NOT NULL, sender_id INTEGER NOT NULL,
      company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
      restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      content TEXT NOT NULL, message_type VARCHAR(10) DEFAULT 'text',
      audio_data TEXT, read_by_company BOOLEAN DEFAULT FALSE,
      read_by_restaurant BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS message_type VARCHAR(10) DEFAULT 'text';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS audio_data TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_data TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_name VARCHAR(255);
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_mime VARCHAR(100);
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS audio_url VARCHAR(500);
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS file_url VARCHAR(500);
    CREATE TABLE IF NOT EXISTS notifications (
      id SERIAL PRIMARY KEY, target_type VARCHAR(20) NOT NULL, target_id INTEGER NOT NULL,
      title VARCHAR(255), message TEXT, type VARCHAR(50), read BOOLEAN DEFAULT FALSE,
      data JSONB DEFAULT '{}', created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS ratings (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id),
      menu_id INTEGER REFERENCES menus(id), restaurant_id INTEGER REFERENCES restaurants(id),
      score INTEGER CHECK (score BETWEEN 1 AND 5), comment TEXT, order_date DATE,
      created_at TIMESTAMP DEFAULT NOW(), UNIQUE(user_id, menu_id, order_date)
    );
    CREATE TABLE IF NOT EXISTS deletion_feedback (
      id SERIAL PRIMARY KEY, restaurant_id INTEGER, reason TEXT, experience VARCHAR(100),
      issue TEXT, confirmed BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY, email VARCHAR(255) NOT NULL, user_type VARCHAR(20) NOT NULL,
      otp_code VARCHAR(6) NOT NULL, expires_at TIMESTAMP NOT NULL,
      used BOOLEAN DEFAULT FALSE, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS weekly_programs (
      id SERIAL PRIMARY KEY, restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      image_url TEXT NOT NULL, title VARCHAR(255), created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS weekly_packs (
      id SERIAL PRIMARY KEY, restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL, description TEXT, image_url TEXT, is_active BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS weekly_menus (
      id SERIAL PRIMARY KEY, weekly_pack_id INTEGER REFERENCES weekly_packs(id) ON DELETE CASCADE,
      restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL, sort_order INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS weekly_menu_days (
      id SERIAL PRIMARY KEY, weekly_menu_id INTEGER REFERENCES weekly_menus(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL, is_optional BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW(), UNIQUE(weekly_menu_id, day_of_week)
    );
    CREATE TABLE IF NOT EXISTS weekly_day_dishes (
      id SERIAL PRIMARY KEY, weekly_menu_day_id INTEGER REFERENCES weekly_menu_days(id) ON DELETE CASCADE,
      restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL, description TEXT, price DECIMAL(10,2) DEFAULT 0,
      image_url TEXT, sort_order INTEGER DEFAULT 0, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS restaurant_settings (
      id SERIAL PRIMARY KEY, restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE UNIQUE,
      min_order_qty INTEGER DEFAULT 8, billing_frequency VARCHAR(20) DEFAULT 'monthly',
      created_at TIMESTAMP DEFAULT NOW(), updated_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS weekly_invoices (
      id SERIAL PRIMARY KEY, restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE,
      company_id INTEGER REFERENCES companies(id), weekly_pack_id INTEGER REFERENCES weekly_packs(id),
      invoice_number VARCHAR(50) NOT NULL, items JSONB DEFAULT '[]',
      total_amount DECIMAL(10,2) DEFAULT 0, billing_frequency VARCHAR(20) DEFAULT 'monthly',
      status VARCHAR(20) DEFAULT 'pending', from_date DATE, to_date DATE,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY, email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL, name VARCHAR(255) NOT NULL DEFAULT 'Super Admin',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS restaurant_contracts (
      id SERIAL PRIMARY KEY,
      restaurant_id INTEGER REFERENCES restaurants(id) ON DELETE CASCADE UNIQUE,
      status VARCHAR(10) DEFAULT 'pending' CHECK (status IN ('pending', 'signed')),
      payment_schedule VARCHAR(10) DEFAULT 'monthly' CHECK (payment_schedule IN ('weekly', 'monthly')),
      commission_rate DECIMAL(5,2) DEFAULT 1.00,
      signed_at TIMESTAMP,
      ip_address VARCHAR(45),
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS affiliation_contracts (
      id SERIAL PRIMARY KEY,
      affiliation_id INTEGER REFERENCES affiliations(id) ON DELETE CASCADE UNIQUE,
      restaurant_signed_at TIMESTAMP,
      company_signed_at TIMESTAMP,
      restaurant_ip VARCHAR(45),
      company_ip VARCHAR(45),
      created_at TIMESTAMP DEFAULT NOW()
    );
  `;
  try {
    await pool.query(sql);
    console.log('✅ DB initialisée');
    await seedAdmin();
  }
  catch (e) { console.error('DB error:', e.message); }
}

async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const name = process.env.ADMIN_NAME || 'Super Admin';
  if (!email || !password) return;
  try {
    const existing = await pool.query('SELECT id FROM admins WHERE email=$1', [email]);
    if (existing.rows.length) return;
    const hash = await bcrypt.hash(password, 10);
    await pool.query('INSERT INTO admins (email, password_hash, name) VALUES ($1,$2,$3)', [email, hash, name]);
    console.log('✅ Compte Super Admin créé:', email);
  } catch (e) { console.error('Seed admin error:', e.message); }
}

initDB();

// ─── Email ────────────────────────────────────────────────────────
const cleanPassword = (process.env.SMTP_PASS || '').replace(/\s/g, '');
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: cleanPassword }
});

async function sendMail(to, subject, html) {
  if (!process.env.SMTP_USER) {
    console.log('⚠️ SMTP_USER not configured, skipping email to:', to);
    return;
  }
  try { 
    await mailer.sendMail({ from: `"FoodChooseApp" <${process.env.SMTP_USER}>`, to, subject, html });
    console.log('✓ Email sent to:', to);
    return true;
  }
  catch (e) { 
    console.error('Mail error:', e.message);
    // Essayez avec d'autres options pour Gmail
    try {
      const mailer2 = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
        tls: { rejectUnauthorized: false }
      });
      await mailer2.sendMail({ from: `"FoodChooseApp" <${process.env.SMTP_USER}>`, to, subject, html });
      console.log('✓ Email sent (retry) to:', to);
      return true;
    } catch(e2) {
      console.error('Mail retry error:', e2.message);
      return false;
    }
  }
}

function welcomeEmailHtml(name, extra = '') {
  return `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:40px;background:#FFF8F3;border-radius:12px;">
    <h1 style="color:#E85A2A;font-size:28px;">🍽 FoodChooseApp</h1>
    <h2 style="color:#2C1810;">Bienvenue, ${name} !</h2>
    <p style="color:#4A3728;line-height:1.7">Votre compte a été créé avec succès sur <strong>FoodChooseApp</strong>, la plateforme de gestion des repas d'entreprise.</p>
    ${extra}
    <p style="color:#8B6554;font-size:13px;margin-top:24px;border-top:1px solid #F0E6DE;padding-top:16px">© FoodChooseApp — Plateforme de choix de repas</p>
  </div>`;
}

async function createNotification(targetType, targetId, title, message, type, data = {}) {
  try {
    await pool.query(
      'INSERT INTO notifications (target_type, target_id, title, message, type, data) VALUES ($1,$2,$3,$4,$5,$6)',
      [targetType, targetId, title, message, type, JSON.stringify(data)]
    );
  } catch (e) { console.error('Notif error:', e.message); }
}

// ─── Cloudinary Upload ────────────────────────────────────────────
async function uploadToCloudinary(dataUrl, folder, resourceType = 'auto') {
  try {
    const result = await cloudinary.uploader.upload(dataUrl, {
      folder: `foodchooseapp/${folder}`,
      resource_type: resourceType,
      quality: 'auto',
      fetch_format: 'auto'
    });
    return result.secure_url;
  } catch (e) {
    console.error('Cloudinary upload error:', e.message);
    return null;
  }
}

// ─── Auth Middlewares ─────────────────────────────────────────────
function makeAuth(role) {
  return (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token manquant' });
    try {
      const d = jwt.verify(token, JWT_SECRET);
      if (d.role !== role) return res.status(403).json({ error: 'Accès refusé' });
      req.user = d;
      next();
    } catch { res.status(401).json({ error: 'Token invalide' }); }
  };
}
const restaurantAuth = makeAuth('restaurant');
const companyAuth = makeAuth('company');
const employeeAuth = makeAuth('employee');
const adminAuth = makeAuth('admin');

function todayStr() { return new Date().toISOString().split('T')[0]; }

// ════════════════════════════════════════════════════════════════
//  AUTH ROUTES
// ════════════════════════════════════════════════════════════════

// Register restaurant
app.post('/api/auth/restaurant/register', async (req, res) => {
  const { name, address, location, email, phone, paymentTypes, specialties, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Champs requis manquants' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO restaurants (name,address,location,email,phone,payment_types,specialties,password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,name,email',
      [name, address||'', location||'', email, phone||'', JSON.stringify(paymentTypes||[]), JSON.stringify(specialties||[]), hash]
    );
    res.status(201).json(r.rows[0]);
    sendMail(email, '🍽 Bienvenue sur FoodChooseApp !', welcomeEmailHtml(name,
      `<p style="color:#4A3728">Votre restaurant <strong>${name}</strong> est maintenant enregistré sur la plateforme. Connectez-vous pour commencer à gérer vos menus et recevoir des commandes.</p>`
    )).catch(err => console.error('Email bienvenue restaurant:', err));
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email déjà utilisé' });
    res.status(500).json({ error: e.message });
  }
});

// Register company
app.post('/api/auth/company/register', async (req, res) => {
  const { name, sector, phone, address, email, location, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Champs requis manquants' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO companies (name,sector,phone,address,email,location,password_hash) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,name,email',
      [name, sector||'', phone||'', address||'', email, location||'', hash]
    );
    res.status(201).json(r.rows[0]);
    sendMail(email, '🍽 Bienvenue sur FoodChooseApp !', welcomeEmailHtml(name,
      `<p style="color:#4A3728">Votre entreprise <strong>${name}</strong> est enregistrée. Votre chargé(e) de commande peut maintenant se connecter et s'affilier aux restaurants.</p>`
    )).catch(err => console.error('Email bienvenue entreprise:', err));
  } catch (e) {
    if (e.code === '23505') return res.status(400).json({ error: 'Email déjà utilisé' });
    res.status(500).json({ error: e.message });
  }
});

// Unified login — auto-détecte le rôle, accepte email ou identifiant employé
app.post('/api/auth/login', async (req, res) => {
  const identifier = (req.body.identifier || req.body.email || '').trim();
  const password = req.body.password;
  if (!identifier || !password) return res.status(400).json({ error: 'Identifiant et mot de passe requis' });
  try {
    // Admin
    const adm = await pool.query('SELECT * FROM admins WHERE email=$1', [identifier]);
    if (adm.rows.length && await bcrypt.compare(password, adm.rows[0].password_hash)) {
      const a = adm.rows[0];
      const token = jwt.sign({ id: a.id, role: 'admin', name: a.name }, JWT_SECRET, { expiresIn: '8h' });
      return res.json({ token, role: 'admin', id: a.id, name: a.name });
    }
    // Entreprise
    const co = await pool.query('SELECT * FROM companies WHERE email=$1', [identifier]);
    if (co.rows.length && await bcrypt.compare(password, co.rows[0].password_hash)) {
      const c = co.rows[0];
      const token = jwt.sign({ id: c.id, role: 'company', name: c.name }, JWT_SECRET, { expiresIn: '8h' });
      return res.json({ token, role: 'company', id: c.id, name: c.name });
    }
    // Restaurant
    const rest = await pool.query('SELECT * FROM restaurants WHERE email=$1', [identifier]);
    if (rest.rows.length && await bcrypt.compare(password, rest.rows[0].password_hash)) {
      const r = rest.rows[0];
      const token = jwt.sign({ id: r.id, role: 'restaurant', name: r.name }, JWT_SECRET, { expiresIn: '8h' });
      return res.json({ token, role: 'restaurant', id: r.id, name: r.name });
    }
    // Employé par email
    const empByEmail = await pool.query('SELECT * FROM users WHERE email=$1', [identifier]);
    if (empByEmail.rows.length && await bcrypt.compare(password, empByEmail.rows[0].password_hash)) {
      const u = empByEmail.rows[0];
      const token = jwt.sign({ id: u.id, role: 'employee', employeeId: u.employee_id, name: `${u.first_name} ${u.last_name}`, companyId: u.company_id }, JWT_SECRET, { expiresIn: '8h' });
      return res.json({ token, role: 'employee', name: `${u.first_name} ${u.last_name}`, employeeId: u.employee_id, companyId: u.company_id });
    }
    // Employé par identifiant (ex: EMP-001)
    const empById = await pool.query('SELECT * FROM users WHERE LOWER(employee_id)=LOWER($1)', [identifier]);
    if (empById.rows.length && await bcrypt.compare(password, empById.rows[0].password_hash)) {
      const u = empById.rows[0];
      const token = jwt.sign({ id: u.id, role: 'employee', employeeId: u.employee_id, name: `${u.first_name} ${u.last_name}`, companyId: u.company_id }, JWT_SECRET, { expiresIn: '8h' });
      return res.json({ token, role: 'employee', name: `${u.first_name} ${u.last_name}`, employeeId: u.employee_id, companyId: u.company_id });
    }
    res.status(401).json({ error: 'Identifiants incorrects' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
//  RESTAURANT ROUTES
// ════════════════════════════════════════════════════════════════
app.get('/api/restaurant/profile', restaurantAuth, async (req, res) => {
  const r = await pool.query('SELECT id,name,address,location,email,phone,payment_types,specialties,photo_url,created_at FROM restaurants WHERE id=$1', [req.user.id]);
  res.json(r.rows[0]);
});

app.put('/api/restaurant/profile', restaurantAuth, async (req, res) => {
  const { name, address, location, phone, paymentTypes, specialties, photoUrl } = req.body;
  try {
    await pool.query(
      'UPDATE restaurants SET name=$1,address=$2,location=$3,phone=$4,payment_types=$5,specialties=$6,photo_url=COALESCE($7,photo_url) WHERE id=$8',
      [name, address, location, phone, JSON.stringify(paymentTypes||[]), JSON.stringify(specialties||[]), photoUrl||null, req.user.id]
    );
    res.json({ message: 'Profil mis à jour' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/restaurant/account', restaurantAuth, async (req, res) => {
  const { reason, experience, issue, confirmed } = req.body;
  if (!confirmed) return res.status(400).json({ error: 'Suppression non confirmée' });
  try {
    await pool.query('INSERT INTO deletion_feedback (restaurant_id,reason,experience,issue,confirmed) VALUES ($1,$2,$3,$4,$5)',
      [req.user.id, reason, experience, issue, true]);
    await pool.query('DELETE FROM restaurants WHERE id=$1', [req.user.id]);
    res.json({ message: 'Compte supprimé' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Menus
app.get('/api/restaurant/menus', restaurantAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM menus WHERE restaurant_id=$1 ORDER BY category,name', [req.user.id]);
  res.json(r.rows);
});

app.post('/api/restaurant/menus', restaurantAuth, async (req, res) => {
  const { name, description, category, price, imageUrl } = req.body;
  if (!name) return res.status(400).json({ error: 'Nom requis' });
  try {
    const r = await pool.query(
      'INSERT INTO menus (restaurant_id,name,description,category,price,image_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [req.user.id, name, description||'', category||'plat', parseFloat(price)||0, imageUrl||null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/restaurant/menus/:id', restaurantAuth, async (req, res) => {
  const { name, description, category, price, imageUrl, available } = req.body;
  try {
    const fields = [];
    const values = [];
    let idx = 1;
    if (name !== undefined) { fields.push(`name=$${idx++}`); values.push(name); }
    if (description !== undefined) { fields.push(`description=$${idx++}`); values.push(description); }
    if (category !== undefined) { fields.push(`category=$${idx++}`); values.push(category); }
    if (price !== undefined) { fields.push(`price=$${idx++}`); values.push(parseFloat(price)); }
    if (imageUrl !== undefined) { fields.push(`image_url=$${idx++}`); values.push(imageUrl); }
    if (available !== undefined) { fields.push(`available=$${idx++}`); values.push(available); }
    if (fields.length === 0) return res.status(400).json({ error: 'Aucun champ à mettre à jour' });
    values.push(req.params.id, req.user.id);
    await pool.query(
      `UPDATE menus SET ${fields.join(',')} WHERE id=$${idx++} AND restaurant_id=$${idx}`,
      values
    );
    res.json({ message: 'Menu mis à jour' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/restaurant/menus/:id/toggle', restaurantAuth, async (req, res) => {
  try {
    const r = await pool.query(
      'UPDATE menus SET available = NOT available WHERE id=$1 AND restaurant_id=$2 RETURNING available',
      [req.params.id, req.user.id]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ error: 'Menu non trouvé' });
    }
    res.json({ available: r.rows[0].available });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/restaurant/menus/:id', restaurantAuth, async (req, res) => {
  await pool.query('DELETE FROM menus WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.user.id]);
  res.json({ message: 'Menu supprimé' });
});

// Restaurant orders
app.get('/api/restaurant/orders', restaurantAuth, async (req, res) => {
  const { date, period, from, to, companyId, status } = req.query;
  let whereDate = "o.order_date >= CURRENT_DATE - INTERVAL '7 days'";
  let params = [req.user.id];
  
  if (from && to) {
    whereDate = "o.order_date >= $2 AND o.order_date <= $3";
    params = [req.user.id, from, to];
    if (companyId && companyId !== 'undefined') {
      whereDate += " AND o.company_id = $4";
      params.push(companyId);
    }
    if (status) {
      whereDate += " AND o.status = $" + (params.length + 1);
      params.push(status);
    }
  } else if (period === 'week') {
    whereDate = "o.order_date >= date_trunc('week', CURRENT_DATE) AND o.order_date <= CURRENT_DATE";
    if (companyId && companyId !== 'undefined') {
      whereDate += " AND o.company_id = $2";
      params.push(companyId);
    }
    if (status) {
      whereDate += " AND o.status = $" + (params.length + 1);
      params.push(status);
    }
  } else if (period === 'month') {
    whereDate = "o.order_date >= date_trunc('month', CURRENT_DATE) AND o.order_date <= CURRENT_DATE";
    if (companyId && companyId !== 'undefined') {
      whereDate += " AND o.company_id = $2";
      params.push(companyId);
    }
    if (status) {
      whereDate += " AND o.status = $" + (params.length + 1);
      params.push(status);
    }
  } else if (date) {
    whereDate = "o.order_date = $2";
    if (companyId && companyId !== 'undefined') {
      whereDate += " AND o.company_id = $3";
      params = [req.user.id, date, companyId];
      if (status) {
        whereDate += " AND o.status = $4";
        params.push(status);
      }
    } else {
      params = [req.user.id, date];
      if (status) {
        whereDate += " AND o.status = $3";
        params.push(status);
      }
    }
  } else {
    if (companyId && companyId !== 'undefined') {
      whereDate = "o.order_date >= CURRENT_DATE - INTERVAL '7 days' AND o.company_id = $2";
      params.push(companyId);
      if (status) {
        whereDate += " AND o.status = $3";
        params.push(status);
      }
    } else if (status) {
      whereDate = "o.order_date >= CURRENT_DATE - INTERVAL '7 days' AND o.status = $2";
      params.push(status);
    }
  }
  
  const q = `SELECT o.*,u.first_name,u.last_name,m.name AS menu_name,m.price,c.name AS company_name FROM orders o JOIN users u ON o.user_id=u.id JOIN menus m ON o.menu_id=m.id JOIN companies c ON o.company_id=c.id WHERE o.restaurant_id=$1 AND ${whereDate} ORDER BY o.order_date DESC, c.name`;
  const r = await pool.query(q, params);
  res.json(r.rows);
});

// Get list of companies for restaurant to filter by
app.get('/api/restaurant/companies', restaurantAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT DISTINCT c.id, c.name
    FROM companies c
    JOIN affiliations a ON a.company_id = c.id
    WHERE a.restaurant_id = $1
    ORDER BY c.name
  `, [req.user.id]);
  res.json(r.rows);
});

// Export orders PDF for restaurant (with date range and optional company filter)
app.get('/api/restaurant/orders/export-pdf', restaurantAuth, async (req, res) => {
  const { from, to, companyId } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Dates required' });
  try {
    let params = [req.user.id, from, to];
    let companyFilter = '';
    if (companyId) { companyFilter = ' AND o.company_id = $4'; params.push(companyId); }
    const orders = await pool.query(`
      SELECT o.order_date, c.name AS company_name, u.first_name, u.last_name, m.name AS menu_name, m.price, o.status
      FROM orders o
      JOIN users u ON o.user_id = u.id
      JOIN menus m ON o.menu_id = m.id
      JOIN companies c ON o.company_id = c.id
      WHERE o.restaurant_id = $1 AND o.order_date >= $2 AND o.order_date <= $3${companyFilter}
      ORDER BY o.order_date, c.name
    `, params);
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="commandes_${from}_${to}.pdf"`);
    doc.pipe(res);
    doc.rect(0, 0, doc.page.width, 110).fill('#E85A2A');
    doc.fillColor('#FFF8F3').fontSize(26).font('Helvetica-Bold').text('🍽 FoodChooseApp', 50, 30);
    doc.fontSize(14).font('Helvetica').text(`Rapport des commandes du ${from} au ${to}`, 50, 60);
    doc.fontSize(10).text(`Restaurant : ${req.user.name} | Généré le ${new Date().toLocaleDateString('fr-FR')}`, 50, 82);
    let y = 135;
    const total = orders.rows.reduce((s, o) => s + parseFloat(o.price || 0), 0);
    doc.fillColor('#2C1810').fontSize(12).font('Helvetica-Bold').text(`${orders.rows.length} commandes — Total : ${total.toLocaleString()} FCFA`, 50, y);
    y += 28;
    doc.rect(50, y, doc.page.width - 100, 22).fill('#2C1810');
    doc.fillColor('#FFF8F3').fontSize(9).font('Helvetica-Bold');
    ['Date', 'Entreprise', 'Employé', 'Menu', 'Prix'].forEach((h, i) => {
      doc.text(h, 50 + [0, 70, 160, 280, 400][i], y + 6);
    });
    y += 30;
    orders.rows.forEach((o, i) => {
      if (y > doc.page.height - 80) { doc.addPage(); y = 50; }
      if (i % 2 === 0) doc.rect(50, y - 3, doc.page.width - 100, 18).fill('#FFF8F3');
      doc.fillColor('#2C1810').fontSize(8).font('Helvetica');
      doc.text(o.order_date, 50, y);
      doc.text((o.company_name || '').substring(0, 12), 120, y);
      doc.text(`${o.last_name} ${o.first_name}`.substring(0, 14), 210, y);
      doc.text((o.menu_name || '').substring(0, 18), 280, y);
      doc.text(`${parseFloat(o.price || 0).toLocaleString()}`, 400, y);
      y += 20;
    });
    doc.rect(0, doc.page.height - 35, doc.page.width, 35).fill('#2C1810');
    doc.fillColor('#8B6554').fontSize(9).text('FoodChooseApp', 50, doc.page.height - 20);
    doc.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/restaurant/batches', restaurantAuth, async (req, res) => {
  const r = await pool.query(
    'SELECT ob.*,c.name AS company_name FROM order_batches ob JOIN companies c ON ob.company_id=c.id WHERE ob.restaurant_id=$1 ORDER BY ob.created_at DESC LIMIT 50',
    [req.user.id]);
  res.json(r.rows);
});

// Create a batch (group orders for a company on a date)
app.post('/api/restaurant/batches', restaurantAuth, async (req, res) => {
  const { companyId, batchDate } = req.body;
  if (!companyId || !batchDate) return res.status(400).json({ error: 'companyId et date requis' });
  try {
    const d = batchDate || todayStr();
    const r = await pool.query(
      'INSERT INTO order_batches (company_id,restaurant_id,batch_date,status) VALUES ($1,$2,$3,\'pending\') ON CONFLICT (company_id,restaurant_id,batch_date) DO UPDATE SET status=\'pending\',created_at=NOW() RETURNING *',
      [companyId, req.user.id, d]
    );
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/restaurant/batches/:id/confirm', restaurantAuth, async (req, res) => {
  try {
    const batch = await pool.query('SELECT * FROM order_batches WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.user.id]);
    if (!batch.rows.length) return res.status(404).json({ error: 'Batch introuvable' });
    await pool.query("UPDATE order_batches SET status='confirmed', confirmed_at=NOW() WHERE id=$1", [req.params.id]);
    await pool.query("UPDATE orders SET status='confirmed' WHERE company_id=$1 AND restaurant_id=$2 AND order_date=$3", [batch.rows[0].company_id, req.user.id, batch.rows[0].batch_date]);
    const restName = req.user.name;
    await createNotification('company', batch.rows[0].company_id, '✅ Commande confirmée', `${restName} a confirmé réception de votre commande du ${batch.rows[0].batch_date}`, 'order', { batchId: req.params.id });
    const co = await pool.query('SELECT email,name FROM companies WHERE id=$1', [batch.rows[0].company_id]);
    res.json({ message: 'Commande confirmée' });
    if (co.rows.length) sendMail(co.rows[0].email, `✅ Commande confirmée — ${restName}`, welcomeEmailHtml(co.rows[0].name, `<p style="color:#4A3728"><strong>${restName}</strong> a confirmé réception de votre commande du ${batch.rows[0].batch_date}.</p>`)).catch(err => console.error('Email confirmation:', err));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/restaurant/batches/:id/invoice', restaurantAuth, async (req, res) => {
  const { items, totalAmount } = req.body;
  try {
    const batch = await pool.query('SELECT * FROM order_batches WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.user.id]);
    if (!batch.rows.length) return res.status(404).json({ error: 'Batch introuvable' });
    const inv = await pool.query(
      'INSERT INTO invoices (company_id,restaurant_id,batch_id,total_amount,items) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [batch.rows[0].company_id, req.user.id, req.params.id, totalAmount, JSON.stringify(items||[])]
    );
    await pool.query("UPDATE order_batches SET status='invoiced', total_amount=$1 WHERE id=$2", [totalAmount, req.params.id]);
await pool.query("UPDATE orders SET status='invoiced' WHERE company_id=$1 AND restaurant_id=$2 AND order_date=$3", [batch.rows[0].company_id, req.user.id, batch.rows[0].batch_date]);
    const co = await pool.query('SELECT email,name FROM companies WHERE id=$1', [batch.rows[0].company_id]);
    res.json({ invoiceId: inv.rows[0].id, success: true });
    if (co.rows.length) sendMail(co.rows[0].email, `🧾 Facture reçue — ${req.user.name}`, welcomeEmailHtml(co.rows[0].name, `<p style="color:#4A3728">Vous avez reçu une facture de <strong>${req.user.name}</strong> d'un montant de <strong>${totalAmount} FCFA</strong> pour le ${batch.rows[0].batch_date}.</p>`)).catch(err => console.error('Email facture:', err));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get restaurant invoices
app.get('/api/restaurant/invoices', restaurantAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT i.*,c.name AS company_name FROM invoices i JOIN companies c ON i.company_id=c.id WHERE i.restaurant_id=$1 ORDER BY i.created_at DESC', [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Create invoice (generate)
app.post('/api/restaurant/invoices', restaurantAuth, async (req, res) => {
  const { company_id, items, total_amount } = req.body;
  const companyId = parseInt(company_id);
  if (!companyId || isNaN(companyId)) return res.status(400).json({ error: 'ID entreprise invalide' });
  if (!total_amount || total_amount <= 0) return res.status(400).json({ error: 'Montant invalide' });
  try {
    const inv = await pool.query(
      'INSERT INTO invoices (company_id, restaurant_id, items, total_amount) VALUES ($1, $2, $3, $4) RETURNING *',
      [companyId, req.user.id, JSON.stringify(items || []), total_amount]
    );
    res.json({ success: true, invoiceId: inv.rows[0].id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Send invoice
app.post('/api/restaurant/invoices/:id/send', restaurantAuth, async (req, res) => {
  try {
    const inv = await pool.query('SELECT i.*, c.email, c.name as company_name, r.name as restaurant_name FROM invoices i JOIN companies c ON i.company_id=c.id JOIN restaurants r ON i.restaurant_id=r.id WHERE i.id=$1 AND i.restaurant_id=$2', [req.params.id, req.user.id]);
    if (!inv.rows.length) return res.status(404).json({ error: 'Facture introuvable' });
    await pool.query('UPDATE invoices SET sent=true, sent_at=NOW() WHERE id=$1', [req.params.id]);
    const invData = inv.rows[0];
    if (invData.email) {
      sendMail(invData.email, `🧾 Facture de ${invData.restaurant_name}`, `<p>Vous avez reçu une facture de <strong>${invData.restaurant_name}</strong> d'un montant de <strong>${invData.total_amount} CFA</strong>.</p><p><a href="${req.protocol}://${req.get('host')}/api/restaurant/invoices/${invData.id}/pdf">Télécharger la facture PDF</a></p>`).catch(err => console.error('Email send error:', err));
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get companies for restaurant
app.get('/api/restaurant/companies', restaurantAuth, async (req, res) => {
  try {
    const companies = await pool.query('SELECT DISTINCT c.id, c.name FROM companies c JOIN affiliations a ON c.id = a.company_id WHERE a.restaurant_id=$1 ORDER BY c.name', [req.user.id]);
    res.json(companies.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Get single invoice as PDF for restaurant
app.get('/api/restaurant/invoices/:id/pdf', async (req, res) => {
  const token = req.query.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (d.role !== 'restaurant') return res.status(403).json({ error: 'Accès refusé' });
    const inv = await pool.query(`SELECT i.*,r.name AS restaurant_name,r.address AS restaurant_address,c.name AS company_name FROM invoices i JOIN restaurants r ON i.restaurant_id=r.id JOIN companies c ON i.company_id=c.id WHERE i.id=$1 AND i.restaurant_id=$2`, [req.params.id, d.id]);
    if (!inv.rows.length) return res.status(404).json({ error: 'Facture introuvable' });
    const inv_data = inv.rows[0];
    const items = Array.isArray(inv_data.items) ? inv_data.items : JSON.parse(inv_data.items||'[]');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="facture_${req.params.id}.pdf"`);
    doc.pipe(res);
    doc.rect(0,0,doc.page.width,110).fill('#E85A2A');
    doc.fillColor('#FFF8F3').fontSize(26).font('Helvetica-Bold').text('FoodChooseApp', 50, 30);
    doc.fontSize(13).font('Helvetica').text('FACTURE', 50, 62);
    doc.fontSize(10).text(`N° FAC-${String(req.params.id).padStart(5,'0')} | ${new Date(inv_data.created_at).toLocaleDateString('fr-FR')}`, 50, 80);
    let y = 135;
    doc.fillColor('#2C1810').fontSize(12).font('Helvetica-Bold').text('DE :', 50, y);
    doc.fontSize(11).font('Helvetica').fillColor('#4A3728').text(inv_data.restaurant_name, 50, y+16).text(inv_data.restaurant_address||'', 50, y+30);
    doc.fillColor('#2C1810').fontSize(12).font('Helvetica-Bold').text('POUR :', 300, y);
    doc.fontSize(11).font('Helvetica').fillColor('#4A3728').text(inv_data.company_name, 300, y+16);
    y += 80;
    doc.rect(50,y,doc.page.width-100,22).fill('#2C1810');
    doc.fillColor('#FFF8F3').fontSize(9).font('Helvetica-Bold').text('DESCRIPTION',58,y+6).text('QTÉ',300,y+6).text('P.U.',380,y+6).text('TOTAL',450,y+6);
    y += 30;
    items.forEach((item, i) => {
      if (i%2===0) doc.rect(50,y-3,doc.page.width-100,18).fill('#FFF8F3');
      doc.fillColor('#2C1810').fontSize(9).font('Helvetica');
      doc.text(item.name||'', 58, y).text(String(item.qty||1), 308, y).text(`${item.price||0}FCFA`, 380, y).text(`${(item.qty||1)*(item.price||0)}FCFA`, 450, y);
      y += 20;
    });
    y += 10;
    doc.rect(350,y,doc.page.width-400,30).fill('#E85A2A');
    doc.fillColor('#FFF8F3').fontSize(13).font('Helvetica-Bold').text(`TOTAL : ${inv_data.total_amount}FCFA`, 360, y+8);
    doc.rect(0,doc.page.height-35,doc.page.width,35).fill('#2C1810');
    doc.fillColor('#8B6554').fontSize(9).text('FoodChooseApp — Gestion des repas d\'entreprise', 50, doc.page.height-20);
    doc.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/restaurant/stats', restaurantAuth, async (req, res) => {
  try {
    const today = await pool.query("SELECT COUNT(*) FROM orders WHERE restaurant_id=$1 AND order_date=CURRENT_DATE", [req.user.id]);
    const week = await pool.query("SELECT COUNT(*) FROM orders WHERE restaurant_id=$1 AND order_date>=date_trunc('week',CURRENT_DATE)", [req.user.id]);
    const month = await pool.query("SELECT COUNT(*) FROM orders WHERE restaurant_id=$1 AND order_date>=date_trunc('month',CURRENT_DATE)", [req.user.id]);
    const revenue = await pool.query("SELECT COALESCE(SUM(m.price),0) AS total FROM orders o JOIN menus m ON o.menu_id=m.id WHERE o.restaurant_id=$1 AND o.order_date>=date_trunc('month',CURRENT_DATE)", [req.user.id]);
    const revenueWeek = await pool.query("SELECT COALESCE(SUM(m.price),0) AS total FROM orders o JOIN menus m ON o.menu_id=m.id WHERE o.restaurant_id=$1 AND o.order_date>=date_trunc('week',CURRENT_DATE)", [req.user.id]);
    const companies = await pool.query("SELECT COUNT(DISTINCT company_id) FROM affiliations WHERE restaurant_id=$1", [req.user.id]);
    const ratings = await pool.query("SELECT AVG(score) AS avg, COUNT(*) AS total FROM ratings WHERE restaurant_id=$1", [req.user.id]);
    const dailyOrders = await pool.query(`
      SELECT o.order_date::text AS date, COUNT(*) AS count, COALESCE(SUM(m.price),0) AS revenue
      FROM orders o JOIN menus m ON o.menu_id=m.id
      WHERE o.restaurant_id=$1 AND o.order_date>=CURRENT_DATE-30
      GROUP BY o.order_date ORDER BY o.order_date
    `, [req.user.id]);
    // Budget total (tous les revenus)
    const totalRevenue = await pool.query("SELECT COALESCE(SUM(m.price),0) AS total FROM orders o JOIN menus m ON o.menu_id=m.id WHERE o.restaurant_id=$1", [req.user.id]);
    // Top 3 clients (entreprises)
    const topClients = await pool.query(`
      SELECT c.id, c.name, COALESCE(SUM(m.price),0) AS total_revenue, COUNT(*) AS order_count
      FROM orders o
      JOIN menus m ON o.menu_id=m.id
      JOIN companies c ON o.company_id=c.id
      WHERE o.restaurant_id=$1
      GROUP BY c.id, c.name
      ORDER BY total_revenue DESC
      LIMIT 3
    `, [req.user.id]);
    res.json({
      today: parseInt(today.rows[0].count),
      week: parseInt(week.rows[0].count),
      month: parseInt(month.rows[0].count),
      revenueMonth: parseFloat(revenue.rows[0].total),
      revenueWeek: parseFloat(revenueWeek.rows[0].total),
      totalRevenue: parseFloat(totalRevenue.rows[0].total),
      companies: parseInt(companies.rows[0].count),
      avgRating: parseFloat(ratings.rows[0].avg || 0).toFixed(1),
      totalRatings: parseInt(ratings.rows[0].total),
      dailyOrders: dailyOrders.rows,
      topClients: topClients.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/restaurant/ratings', restaurantAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT r.*,u.first_name,u.last_name,m.name AS menu_name
    FROM ratings r JOIN users u ON r.user_id=u.id JOIN menus m ON r.menu_id=m.id
    WHERE r.restaurant_id=$1 ORDER BY r.created_at DESC LIMIT 50
  `, [req.user.id]);
  res.json(r.rows);
});

app.get('/api/restaurant/export-pdf', restaurantAuth, async (req, res) => {
  const { period } = req.query;
  let whereDate = "o.order_date = CURRENT_DATE";
  let periodLabel = "Aujourd'hui";
  if (period === 'week') { whereDate = "o.order_date >= date_trunc('week',CURRENT_DATE)"; periodLabel = "Cette semaine"; }
  if (period === 'month') { whereDate = "o.order_date >= date_trunc('month',CURRENT_DATE)"; periodLabel = "Ce mois"; }
  try {
    const orders = await pool.query(`
      SELECT o.order_date,u.first_name,u.last_name,m.name AS menu_name,m.price,c.name AS company_name,o.status
      FROM orders o JOIN users u ON o.user_id=u.id JOIN menus m ON o.menu_id=m.id JOIN companies c ON o.company_id=c.id
      WHERE o.restaurant_id=$1 AND ${whereDate} ORDER BY o.order_date,c.name,u.last_name
    `, [req.user.id]);
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="rapport_${period||'jour'}.pdf"`);
    doc.pipe(res);
    doc.rect(0,0,doc.page.width,110).fill('#E85A2A');
    doc.fillColor('#FFF8F3').fontSize(26).font('Helvetica-Bold').text('FoodChooseApp', 50, 30);
    doc.fontSize(14).font('Helvetica').text(`Rapport — ${periodLabel}`, 50, 62);
    doc.fontSize(11).text(`Restaurant : ${req.user.name} | Généré le ${new Date().toLocaleDateString('fr-FR')}`, 50, 82);
    let y = 135;
    const total = orders.rows.reduce((s,o) => s + parseFloat(o.price||0), 0);
    doc.fillColor('#2C1810').fontSize(13).font('Helvetica-Bold').text(`${orders.rows.length} commandes — Total : ${total.toLocaleString()} FCFA`, 50, y);
    y += 28;
    doc.rect(50, y, doc.page.width-100, 22).fill('#2C1810');
    doc.fillColor('#FFF8F3').fontSize(9).font('Helvetica-Bold');
    ['Date','Entreprise','Employé','Menu','Prix','Statut'].forEach((h,i) => {
      doc.text(h, 50+[0,70,160,250,360,430][i], y+6);
    });
    y += 30;
    orders.rows.forEach((o,i) => {
      if (y > doc.page.height-80) { doc.addPage(); y = 50; }
      if (i%2===0) doc.rect(50,y-3,doc.page.width-100,18).fill('#FFF8F3');
      doc.fillColor('#2C1810').fontSize(8).font('Helvetica');
      const d = new Date(o.order_date+'T12:00:00').toLocaleDateString('fr-FR',{day:'2-digit',month:'2-digit'});
      doc.text(d,50,y); doc.text((o.company_name||'').substring(0,12),120,y);
      doc.text(`${o.last_name} ${o.first_name}`.substring(0,14),210,y);
      doc.text((o.menu_name||'').substring(0,18),300,y);
      doc.text(`${parseFloat(o.price||0).toLocaleString()}`,410,y);
      doc.fillColor(o.status==='validated'||o.status==='confirmed'?'#16a34a':'#E85A2A').text(o.status,480,y);
      doc.fillColor('#2C1810'); y += 20;
    });
    doc.rect(0,doc.page.height-35,doc.page.width,35).fill('#2C1810');
    doc.fillColor('#8B6554').fontSize(9).text('FoodChooseApp',50,doc.page.height-20);
    doc.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
//  WEEKLY MENU SYSTEM — Restaurants
// ════════════════════════════════════════════════════════════════

// ——— Weekly Program Image ———
app.post('/api/restaurant/weekly-program', restaurantAuth, async (req, res) => {
  const { image, title } = req.body;
  try {
    if (!image) return res.status(400).json({ error: 'Image requise' });
    const url = await uploadToCloudinary(image, 'weekly_programs');
    const r = await pool.query(
      'INSERT INTO weekly_programs (restaurant_id, image_url, title) VALUES ($1,$2,$3) RETURNING *',
      [req.user.id, url || image, title || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/restaurant/weekly-programs', restaurantAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM weekly_programs WHERE restaurant_id=$1 ORDER BY created_at DESC LIMIT 5', [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/restaurant/weekly-program/:id', restaurantAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM weekly_programs WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ——— Weekly Packs CRUD ———
app.get('/api/restaurant/weekly-packs', restaurantAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM weekly_packs WHERE restaurant_id=$1 ORDER BY created_at DESC', [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/restaurant/weekly-packs', restaurantAuth, async (req, res) => {
  const { name, description, image } = req.body;
  try {
    let url = null;
    if (image) url = await uploadToCloudinary(image, 'weekly_packs');
    const r = await pool.query(
      'INSERT INTO weekly_packs (restaurant_id, name, description, image_url) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.user.id, name, description || null, url || null]
    );
    // Auto-create 3 default menus
    for (let i = 1; i <= 3; i++) {
      const menu = await pool.query(
        'INSERT INTO weekly_menus (weekly_pack_id, restaurant_id, name, sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
        [r.rows[0].id, req.user.id, `Menu ${i}`, i]
      );
      // Create 5 default days (Lundi-Vendredi)
      const dayNames = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
      for (let d = 0; d < dayNames.length; d++) {
        await pool.query(
          'INSERT INTO weekly_menu_days (weekly_menu_id, day_of_week, is_optional) VALUES ($1,$2,$3)',
          [menu.rows[0].id, d + 1, false]
        );
      }
      // Create 2 optional days (Samedi, Dimanche)
      for (let d = 6; d <= 7; d++) {
        await pool.query(
          'INSERT INTO weekly_menu_days (weekly_menu_id, day_of_week, is_optional) VALUES ($1,$2,$3)',
          [menu.rows[0].id, d, true]
        );
      }
    }
    const full = await pool.query(`
      SELECT wp.*, COALESCE(json_agg(json_build_object('id',wm.id,'name',wm.name,'sort_order',wm.sort_order,
        'days',(SELECT COALESCE(json_agg(json_build_object('id',wmd.id,'day_of_week',wmd.day_of_week,'is_optional',wmd.is_optional,
          'dishes',(SELECT COALESCE(json_agg(json_build_object('id',wdd.id,'name',wdd.name,'description',wdd.description,'price',wdd.price,'image_url',wdd.image_url,'sort_order',wdd.sort_order) ORDER BY wdd.sort_order),'[]'::json) FROM weekly_day_dishes wdd WHERE wdd.weekly_menu_day_id=wmd.id)
        ) ORDER BY wmd.day_of_week),'[]'::json) FROM weekly_menu_days wmd WHERE wmd.weekly_menu_id=wm.id)
      ) ORDER BY wm.sort_order),'[]'::json) AS menus
      FROM weekly_packs wp LEFT JOIN weekly_menus wm ON wm.weekly_pack_id=wp.id WHERE wp.id=$1 GROUP BY wp.id
    `, [r.rows[0].id]);
    res.status(201).json(full.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/restaurant/weekly-packs/:id', restaurantAuth, async (req, res) => {
  const { name, description, is_active, image } = req.body;
  try {
    let url = null;
    if (image) url = await uploadToCloudinary(image, 'weekly_packs');
    const r = await pool.query(
      'UPDATE weekly_packs SET name=COALESCE($1,name), description=COALESCE($2,description), image_url=COALESCE($3,image_url), is_active=COALESCE($4,is_active) WHERE id=$5 AND restaurant_id=$6 RETURNING *',
      [name || null, description !== undefined ? description : null, url, is_active !== undefined ? is_active : null, req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Pack introuvable' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/restaurant/weekly-packs/:id', restaurantAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM weekly_packs WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/restaurant/weekly-packs/:id', restaurantAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT wp.*, COALESCE(json_agg(json_build_object('id',wm.id,'name',wm.name,'sort_order',wm.sort_order,
        'days',(SELECT COALESCE(json_agg(json_build_object('id',wmd.id,'day_of_week',wmd.day_of_week,'is_optional',wmd.is_optional,
          'dishes',(SELECT COALESCE(json_agg(json_build_object('id',wdd.id,'name',wdd.name,'description',wdd.description,'price',wdd.price,'image_url',wdd.image_url,'sort_order',wdd.sort_order) ORDER BY wdd.sort_order),'[]'::json) FROM weekly_day_dishes wdd WHERE wdd.weekly_menu_day_id=wmd.id)
        ) ORDER BY wmd.day_of_week),'[]'::json) FROM weekly_menu_days wmd WHERE wmd.weekly_menu_id=wm.id)
      ) ORDER BY wm.sort_order),'[]'::json) AS menus
      FROM weekly_packs wp LEFT JOIN weekly_menus wm ON wm.weekly_pack_id=wp.id WHERE wp.id=$1 AND wp.restaurant_id=$2 GROUP BY wp.id
    `, [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Pack introuvable' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ——— Weekly Menus CRUD ———
app.post('/api/restaurant/weekly-packs/:packId/menus', restaurantAuth, async (req, res) => {
  const { name } = req.body;
  try {
    const pack = await pool.query('SELECT id FROM weekly_packs WHERE id=$1 AND restaurant_id=$2', [req.params.packId, req.user.id]);
    if (!pack.rows.length) return res.status(404).json({ error: 'Pack introuvable' });
    const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM weekly_menus WHERE weekly_pack_id=$1', [req.params.packId]);
    const r = await pool.query(
      'INSERT INTO weekly_menus (weekly_pack_id, restaurant_id, name, sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
      [req.params.packId, req.user.id, name || `Menu ${maxOrder.rows[0].next}`, maxOrder.rows[0].next]
    );
    // Create default days
    const dayNames = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
    for (let d = 0; d < dayNames.length; d++) {
      await pool.query('INSERT INTO weekly_menu_days (weekly_menu_id, day_of_week, is_optional) VALUES ($1,$2,$3)', [r.rows[0].id, d + 1, false]);
    }
    for (let d = 6; d <= 7; d++) {
      await pool.query('INSERT INTO weekly_menu_days (weekly_menu_id, day_of_week, is_optional) VALUES ($1,$2,$3)', [r.rows[0].id, d, true]);
    }
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/restaurant/weekly-menus/:id', restaurantAuth, async (req, res) => {
  const { name, sort_order } = req.body;
  try {
    const r = await pool.query(
      'UPDATE weekly_menus SET name=COALESCE($1,name), sort_order=COALESCE($2,sort_order) WHERE id=$3 AND restaurant_id=$4 RETURNING *',
      [name || null, sort_order !== undefined ? sort_order : null, req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Menu introuvable' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/restaurant/weekly-menus/:id', restaurantAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM weekly_menus WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ——— Weekly Dishes CRUD ———
app.post('/api/restaurant/dishes', restaurantAuth, async (req, res) => {
  const { weekly_menu_day_id, name, description, price, image } = req.body;
  try {
    const day = await pool.query(
      'SELECT wmd.id FROM weekly_menu_days wmd JOIN weekly_menus wm ON wmd.weekly_menu_id=wm.id WHERE wmd.id=$1 AND wm.restaurant_id=$2',
      [weekly_menu_day_id, req.user.id]
    );
    if (!day.rows.length) return res.status(404).json({ error: 'Jour introuvable' });
    let url = null;
    if (image) url = await uploadToCloudinary(image, 'weekly_dishes');
    const maxOrder = await pool.query('SELECT COALESCE(MAX(sort_order),0)+1 AS next FROM weekly_day_dishes WHERE weekly_menu_day_id=$1', [weekly_menu_day_id]);
    const r = await pool.query(
      'INSERT INTO weekly_day_dishes (weekly_menu_day_id, restaurant_id, name, description, price, image_url, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [weekly_menu_day_id, req.user.id, name, description || null, price || 0, url || null, maxOrder.rows[0].next]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/restaurant/dishes/:id', restaurantAuth, async (req, res) => {
  const { name, description, price, image } = req.body;
  try {
    let url = null;
    if (image) url = await uploadToCloudinary(image, 'weekly_dishes');
    const r = await pool.query(
      'UPDATE weekly_day_dishes SET name=COALESCE($1,name), description=COALESCE($2,description), price=COALESCE($3,price), image_url=COALESCE($4,image_url) WHERE id=$5 AND restaurant_id=$6 RETURNING *',
      [name || null, description !== undefined ? description : null, price !== undefined ? price : null, url, req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Plat introuvable' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/restaurant/dishes/:id', restaurantAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM weekly_day_dishes WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ——— Restaurant Settings ———
app.get('/api/restaurant/settings', restaurantAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM restaurant_settings WHERE restaurant_id=$1', [req.user.id]);
    if (!r.rows.length) {
      const created = await pool.query('INSERT INTO restaurant_settings (restaurant_id) VALUES ($1) RETURNING *', [req.user.id]);
      return res.json(created.rows[0]);
    }
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/restaurant/settings', restaurantAuth, async (req, res) => {
  const { min_order_qty, billing_frequency } = req.body;
  try {
    const r = await pool.query(`
      INSERT INTO restaurant_settings (restaurant_id, min_order_qty, billing_frequency)
      VALUES ($1, COALESCE($2,8), COALESCE($3,'monthly'))
      ON CONFLICT (restaurant_id) DO UPDATE SET
        min_order_qty=COALESCE($2,restaurant_settings.min_order_qty),
        billing_frequency=COALESCE($3,restaurant_settings.billing_frequency),
        updated_at=NOW()
      RETURNING *
    `, [req.user.id, min_order_qty !== undefined ? min_order_qty : null, billing_frequency || null]);
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ——— Weekly Invoices ———
app.post('/api/restaurant/weekly-invoices', restaurantAuth, async (req, res) => {
  const { company_id, weekly_pack_id, items, total_amount, billing_frequency, from_date, to_date } = req.body;
  try {
    const count = await pool.query('SELECT COUNT(*)+1 AS next FROM weekly_invoices WHERE restaurant_id=$1', [req.user.id]);
    const invNum = `WFAC-${String(req.user.id).padStart(3,'0')}-${String(count.rows[0].next).padStart(4,'0')}`;
    const r = await pool.query(
      'INSERT INTO weekly_invoices (restaurant_id, company_id, weekly_pack_id, invoice_number, items, total_amount, billing_frequency, from_date, to_date) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
      [req.user.id, company_id, weekly_pack_id || null, invNum, JSON.stringify(items || []), total_amount || 0, billing_frequency || 'monthly', from_date || null, to_date || null]
    );
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/restaurant/weekly-invoices', restaurantAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT wi.*, c.name AS company_name, wp.name AS pack_name
      FROM weekly_invoices wi
      LEFT JOIN companies c ON wi.company_id=c.id
      LEFT JOIN weekly_packs wp ON wi.weekly_pack_id=wp.id
      WHERE wi.restaurant_id=$1 ORDER BY wi.created_at DESC LIMIT 50
    `, [req.user.id]);
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/restaurant/weekly-invoices/:id', restaurantAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT wi.*, c.name AS company_name, c.email AS company_email, c.address AS company_address,
             r.name AS restaurant_name, r.address AS restaurant_address, wp.name AS pack_name
      FROM weekly_invoices wi
      LEFT JOIN companies c ON wi.company_id=c.id
      LEFT JOIN restaurants r ON wi.restaurant_id=r.id
      LEFT JOIN weekly_packs wp ON wi.weekly_pack_id=wp.id
      WHERE wi.id=$1 AND wi.restaurant_id=$2
    `, [req.params.id, req.user.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Facture introuvable' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/restaurant/weekly-invoices/:id', restaurantAuth, async (req, res) => {
  const { items, total_amount, status, billing_frequency } = req.body;
  try {
    const r = await pool.query(
      'UPDATE weekly_invoices SET items=COALESCE($1,items), total_amount=COALESCE($2,total_amount), status=COALESCE($3,status), billing_frequency=COALESCE($4,billing_frequency) WHERE id=$5 AND restaurant_id=$6 RETURNING *',
      [items ? JSON.stringify(items) : null, total_amount !== undefined ? total_amount : null, status || null, billing_frequency || null, req.params.id, req.user.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Facture introuvable' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/restaurant/weekly-invoices/:id', restaurantAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM weekly_invoices WHERE id=$1 AND restaurant_id=$2', [req.params.id, req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/restaurant/weekly-invoices/:id/pdf', async (req, res) => {
  const token = req.query.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (d.role !== 'restaurant') return res.status(403).json({ error: 'Accès refusé' });
    const inv = await pool.query(`
      SELECT wi.*, c.name AS company_name, c.address AS company_address,
             r.name AS restaurant_name, r.address AS restaurant_address, wp.name AS pack_name
      FROM weekly_invoices wi
      LEFT JOIN companies c ON wi.company_id=c.id
      LEFT JOIN restaurants r ON wi.restaurant_id=r.id
      LEFT JOIN weekly_packs wp ON wi.weekly_pack_id=wp.id
      WHERE wi.id=$1 AND wi.restaurant_id=$2
    `, [req.params.id, d.id]);
    if (!inv.rows.length) return res.status(404).json({ error: 'Facture introuvable' });
    const inv_data = inv.rows[0];
    const items = Array.isArray(inv_data.items) ? inv_data.items : JSON.parse(inv_data.items || '[]');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="facture_hebdo_${req.params.id}.pdf"`);
    doc.pipe(res);
    doc.rect(0,0,doc.page.width,110).fill('#E85A2A');
    doc.fillColor('#FFF8F3').fontSize(26).font('Helvetica-Bold').text('FoodChooseApp', 50, 30);
    doc.fontSize(14).font('Helvetica').text('FACTURE HEBDOMADAIRE', 50, 62);
    doc.fontSize(10).text(`N° ${inv_data.invoice_number} | ${new Date(inv_data.created_at).toLocaleDateString('fr-FR')}`, 50, 80);
    if (inv_data.from_date && inv_data.to_date) {
      doc.fontSize(9).text(`Période : ${new Date(inv_data.from_date+'T12:00:00').toLocaleDateString('fr-FR')} → ${new Date(inv_data.to_date+'T12:00:00').toLocaleDateString('fr-FR')}`, 50, 94);
    }
    let y = 135;
    doc.fillColor('#2C1810').fontSize(12).font('Helvetica-Bold').text('DE :', 50, y);
    doc.fontSize(11).font('Helvetica').fillColor('#4A3728').text(inv_data.restaurant_name, 50, y+16).text(inv_data.restaurant_address||'', 50, y+30);
    doc.fillColor('#2C1810').fontSize(12).font('Helvetica-Bold').text('POUR :', 300, y);
    doc.fontSize(11).font('Helvetica').fillColor('#4A3728').text(inv_data.company_name, 300, y+16).text(inv_data.company_address||'', 300, y+30);
    if (inv_data.pack_name) {
      doc.fillColor('#8B6554').fontSize(10).font('Helvetica').text(`Pack : ${inv_data.pack_name}`, 300, y+50);
    }
    y += 80;
    doc.rect(50,y,doc.page.width-100,22).fill('#2C1810');
    doc.fillColor('#FFF8F3').fontSize(9).font('Helvetica-Bold').text('DÉSIGNATION',58,y+6).text('QTÉ',300,y+6).text('P.U.',380,y+6).text('TOTAL',450,y+6);
    y += 30;
    items.forEach((item, i) => {
      if (i%2===0) doc.rect(50,y-3,doc.page.width-100,18).fill('#FFF8F3');
      doc.fillColor('#2C1810').fontSize(9).font('Helvetica');
      doc.text(item.name||'', 58, y).text(String(item.qty||1), 308, y).text(`${item.price||0}FCFA`, 380, y).text(`${(item.qty||1)*(item.price||0)}FCFA`, 450, y);
      y += 20;
    });
    y += 10;
    doc.rect(350,y,doc.page.width-400,30).fill('#E85A2A');
    doc.fillColor('#FFF8F3').fontSize(13).font('Helvetica-Bold').text(`TOTAL : ${inv_data.total_amount}FCFA`, 360, y+8);
    doc.rect(0,doc.page.height-35,doc.page.width,35).fill('#2C1810');
    doc.fillColor('#8B6554').fontSize(9).text('FoodChooseApp — Gestion des repas d\'entreprise', 50, doc.page.height-20);
    doc.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ════════════════════════════════════════════════════════════════
app.get('/api/notifications', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    const d = jwt.verify(token, JWT_SECRET);
    let targetType = d.role === 'restaurant' ? 'restaurant' : d.role === 'admin' || d.role === 'company' ? 'company' : 'employee';
    const r = await pool.query('SELECT * FROM notifications WHERE target_type=$1 AND target_id=$2 ORDER BY created_at DESC LIMIT 30', [targetType, d.id]);
    res.json(r.rows);
  } catch { res.json([]); }
});

app.put('/api/notifications/:id/read', async (req, res) => {
  await pool.query('UPDATE notifications SET read=TRUE WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
});

app.put('/api/notifications/read-all', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  try {
    const d = jwt.verify(token, JWT_SECRET);
    let targetType = d.role === 'restaurant' ? 'restaurant' : d.role === 'employee' ? 'employee' : 'company';
    await pool.query('UPDATE notifications SET read=TRUE WHERE target_type=$1 AND target_id=$2', [targetType, d.id]);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

// ════════════════════════════════════════════════════════════════
//  MESSAGES
// ════════════════════════════════════════════════════════════════
app.get('/api/messages', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const { companyId, restaurantId } = req.query;
  try {
    jwt.verify(token, JWT_SECRET);
    const r = await pool.query(
      'SELECT m.*,CASE WHEN m.sender_type=\'company\' THEN c.name ELSE r.name END AS sender_name FROM messages m LEFT JOIN companies c ON m.company_id=c.id LEFT JOIN restaurants r ON m.restaurant_id=r.id WHERE m.company_id=$1 AND m.restaurant_id=$2 ORDER BY m.created_at',
      [companyId, restaurantId]
    );
    res.json(r.rows);
  } catch { res.json([]); }
});

app.post('/api/messages', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const { companyId, restaurantId, content, messageType, audioData, fileData, fileName, fileMime } = req.body;
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const senderType = d.role === 'restaurant' ? 'restaurant' : 'company';
    const senderId = d.id;
    const msgType = messageType === 'voice' ? 'voice' : messageType === 'file' ? 'file' : 'text';
    const defaultContent = msgType === 'voice' ? '🎙 Message vocal'
      : msgType === 'file' ? (fileMime?.startsWith('image/') ? '📷 Photo' : fileMime?.startsWith('video/') ? '🎬 Vidéo' : `📄 ${fileName || 'Fichier'}`)
      : (content || '');

    // Upload to Cloudinary if Cloudinary is configured
    let audioUrl = null;
    let fileUrl = null;
    const cloudinaryConfigured = process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_CLOUD_NAME !== 'your_cloud_name';

    if (cloudinaryConfigured) {
      if (msgType === 'voice' && audioData) {
        audioUrl = await uploadToCloudinary(audioData, 'voice', 'video');
      } else if (msgType === 'file' && fileData) {
        const resType = fileMime?.startsWith('image/') ? 'image' : fileMime?.startsWith('video/') ? 'video' : 'raw';
        fileUrl = await uploadToCloudinary(fileData, 'files', resType);
      }
    }

    // Store URL in DB (fall back to base64 in audio_data/file_data if Cloudinary not configured)
    const storeAudioData = cloudinaryConfigured ? null : (audioData || null);
    const storeFileData = cloudinaryConfigured ? null : (fileData || null);

    const r = await pool.query(
      'INSERT INTO messages (sender_type,sender_id,company_id,restaurant_id,content,message_type,audio_data,file_data,file_name,file_mime,audio_url,file_url) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *',
      [senderType, senderId, companyId, restaurantId, content || defaultContent, msgType, storeAudioData, storeFileData, fileName || null, fileMime || null, audioUrl, fileUrl]
    );
    const preview = msgType === 'voice' ? '🎙 Message vocal' : msgType === 'file' ? defaultContent : (content || '').substring(0, 80);
    if (senderType === 'company') {
      await createNotification('restaurant', restaurantId, '💬 Nouveau message', preview, 'message', { companyId, restaurantId });
      const rest = await pool.query('SELECT email,name FROM restaurants WHERE id=$1', [restaurantId]);
      if (rest.rows.length) sendMail(rest.rows[0].email, '💬 Nouveau message FoodChooseApp', welcomeEmailHtml(rest.rows[0].name, `<p style="color:#4A3728">Vous avez reçu un message : <em>${preview}</em></p>`)).catch(err => console.error('Email message:', err));
    } else {
      await createNotification('company', companyId, '💬 Nouveau message', preview, 'message', { companyId, restaurantId });
      const co = await pool.query('SELECT email,name FROM companies WHERE id=$1', [companyId]);
      if (co.rows.length) sendMail(co.rows[0].email, '💬 Nouveau message FoodChooseApp', welcomeEmailHtml(co.rows[0].name, `<p style="color:#4A3728">Vous avez reçu un message : <em>${preview}</em></p>`)).catch(err => console.error('Email message:', err));
    }
    res.status(201).json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/messages/read', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const { companyId, restaurantId } = req.body;
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const field = d.role === 'restaurant' ? 'read_by_restaurant' : 'read_by_company';
    await pool.query(`UPDATE messages SET ${field}=TRUE WHERE company_id=$1 AND restaurant_id=$2`, [companyId, restaurantId]);
    res.json({ ok: true });
  } catch { res.json({ ok: false }); }
});

app.get('/api/messages/unread-count', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  const { companyId, restaurantId } = req.query;
  try {
    const d = jwt.verify(token, JWT_SECRET);
    const field = d.role === 'restaurant' ? 'read_by_restaurant' : 'read_by_company';
    const r = await pool.query(`SELECT COUNT(*) FROM messages WHERE company_id=$1 AND restaurant_id=$2 AND ${field}=FALSE AND sender_type!=$3`, [companyId, restaurantId, d.role]);
    res.json({ count: parseInt(r.rows[0].count) });
  } catch { res.json({ count: 0 }); }
});

// ════════════════════════════════════════════════════════════════
//  ADMIN ROUTES
// ════════════════════════════════════════════════════════════════
app.get('/api/admin/all-restaurants', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const r = await pool.query(`
    SELECT r.id, r.name, r.address, r.location, r.phone, r.specialties, r.photo_url,
    EXISTS(SELECT 1 FROM affiliations a WHERE a.company_id=$1 AND a.restaurant_id=r.id) AS affiliated,
    (SELECT COUNT(*) FROM menus m WHERE m.restaurant_id=r.id AND m.available=TRUE) AS menu_count
    FROM restaurants r ORDER BY r.name
  `, [companyId]);
  res.json(r.rows);
});

app.get('/api/admin/restaurants/:id/menus', companyAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM menus WHERE restaurant_id=$1 AND available=TRUE ORDER BY category,name', [req.params.id]);
  const rest = await pool.query('SELECT name,address,specialties,photo_url FROM restaurants WHERE id=$1', [req.params.id]);
  if (!rest.rows.length) return res.status(404).json({ error: 'Restaurant introuvable' });
  res.json({ restaurant: rest.rows[0], menus: r.rows });
});

app.post('/api/admin/affiliations', companyAuth, async (req, res) => {
  const { restaurantId } = req.body;
  const companyId = req.user.id;
  try {
    await pool.query('INSERT INTO affiliations (company_id,restaurant_id) VALUES ($1,$2)', [companyId, restaurantId]);
    const rest = await pool.query('SELECT name FROM restaurants WHERE id=$1', [restaurantId]);
    await createNotification('restaurant', restaurantId, '🤝 Nouvelle affiliation', `L'entreprise souhaite s'affilier à votre restaurant`, 'affiliation', { companyId });
    res.json({ message: 'Affiliation créée' });
  } catch (e) {
    if (e.code==='23505') return res.status(400).json({ error: 'Déjà affilié' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/affiliations/:restaurantId', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  await pool.query('DELETE FROM affiliations WHERE company_id=$1 AND restaurant_id=$2', [companyId, req.params.restaurantId]);
  res.json({ message: 'Affiliation supprimée' });
});

app.get('/api/admin/affiliations', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const r = await pool.query(`
    SELECT r.id,r.name,r.address,r.specialties,r.photo_url,a.created_at AS affiliated_at,
    (SELECT COUNT(*) FROM menus m WHERE m.restaurant_id=r.id AND m.available=TRUE) AS menu_count
    FROM affiliations a JOIN restaurants r ON a.restaurant_id=r.id
    WHERE a.company_id=$1 ORDER BY r.name
  `, [companyId]);
  res.json(r.rows);
});

app.get('/api/admin/employees', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const r = await pool.query('SELECT id,employee_id,first_name,last_name,email,drink_preference,photo_url,created_at FROM users WHERE company_id=$1 ORDER BY last_name', [companyId]);
  res.json(r.rows);
});

app.post('/api/admin/employees', companyAuth, async (req, res) => {
  const { firstName, lastName, email, employeeId } = req.body;
  if (!firstName||!lastName||!email||!employeeId) return res.status(400).json({ error: 'Champs requis' });
  const companyId = req.user.id;
  const defaultPwd = process.env.DEFAULT_EMPLOYEE_PASSWORD || 'Elimmeka123';
  try {
    const hash = await bcrypt.hash(defaultPwd, 10);
    const r = await pool.query(
      'INSERT INTO users (company_id,employee_id,first_name,last_name,email,password_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,employee_id,first_name,last_name,email',
      [companyId, employeeId.trim(), firstName.trim(), lastName.trim(), email.trim(), hash]
    );
    res.status(201).json(r.rows[0]);
    const appUrl = process.env.APP_URL || 'http://localhost:3050';
    sendMail(email, '🍽 Vos identifiants FoodChooseApp',
      `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:40px;background:#FFF8F3;border-radius:12px;">
        <h1 style="color:#E85A2A;font-size:28px;">🍽 FoodChooseApp</h1>
        <h2 style="color:#2C1810;">Bonjour ${firstName} ${lastName},</h2>
        <p style="color:#4A3728;line-height:1.7">Votre compte employé a été créé sur <strong>FoodChooseApp</strong>. Voici vos identifiants de connexion :</p>
        <div style="background:#2C1810;border-radius:10px;padding:28px;text-align:center;margin:20px 0">
          <p style="color:#F9C74F;font-size:11px;letter-spacing:1px;margin:0 0 6px">IDENTIFIANT EMPLOYÉ</p>
          <p style="color:#FFF8F3;font-size:24px;font-weight:700;font-family:monospace;margin:0 0 20px">${employeeId}</p>
          <p style="color:#F9C74F;font-size:11px;letter-spacing:1px;margin:0 0 6px">MOT DE PASSE PROVISOIRE</p>
          <p style="color:#FFF8F3;font-size:24px;font-weight:700;font-family:monospace;margin:0">${defaultPwd}</p>
        </div>
        <div style="text-align:center;margin:28px 0">
          <a href="${appUrl}/employee" style="background:#E85A2A;color:#FFF8F3;text-decoration:none;padding:14px 32px;border-radius:8px;font-size:16px;font-weight:700;display:inline-block;">Accéder à la plateforme →</a>
        </div>
        <p style="color:#E85A2A;font-weight:600;font-size:14px;">⚠️ Pensez à changer votre mot de passe dès votre première connexion.</p>
        <p style="color:#4A3728;font-size:13px;line-height:1.6">Pour cela : connectez-vous → <strong>Mon profil</strong> → <strong>Changer mon mot de passe</strong>.</p>
        <p style="color:#8B6554;font-size:13px;margin-top:24px;border-top:1px solid #F0E6DE;padding-top:16px">© FoodChooseApp — Plateforme de choix de repas</p>
      </div>`
    ).catch(err => console.error('Email employé:', err));
  } catch (e) {
    if (e.code==='23505') return res.status(400).json({ error: 'ID ou email déjà existant' });
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/admin/employees/:id', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const userId = parseInt(req.params.id);
  if (isNaN(userId)) return res.status(400).json({ error: 'ID invalide' });
  
  try {
    await pool.query('DELETE FROM ratings WHERE user_id=$1', [userId]);
    await pool.query('DELETE FROM orders WHERE user_id=$1 AND company_id=$2', [userId, companyId]);
    await pool.query('DELETE FROM users WHERE id=$1 AND company_id=$2', [userId, companyId]);
    res.json({ message: 'Employé supprimé' });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/admin/orders', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const { date, restaurantId, from, to } = req.query;
  let q, params;
  
  // Support period search (from/to dates)
  if (from && to) {
    q = `SELECT o.*,u.first_name,u.last_name,u.employee_id,m.name AS menu_name,m.price,r.name AS restaurant_name
      FROM orders o JOIN users u ON o.user_id=u.id JOIN menus m ON o.menu_id=m.id JOIN restaurants r ON o.restaurant_id=r.id
      WHERE o.company_id=$1 AND o.order_date>=$2 AND o.order_date<=$3`;
    params = [companyId, from, to];
    if (restaurantId) { q += ` AND o.restaurant_id=$4`; params.push(restaurantId); }
    q += ' ORDER BY o.order_date DESC, r.name,u.last_name';
  } else {
    const d = date || todayStr();
    q = `SELECT o.*,u.first_name,u.last_name,u.employee_id,m.name AS menu_name,m.price,r.name AS restaurant_name
      FROM orders o JOIN users u ON o.user_id=u.id JOIN menus m ON o.menu_id=m.id JOIN restaurants r ON o.restaurant_id=r.id
      WHERE o.company_id=$1 AND o.order_date=$2`;
    params = [companyId, d];
    if (restaurantId) { q += ` AND o.restaurant_id=$3`; params.push(restaurantId); }
    q += ' ORDER BY r.name,u.last_name';
  }
  const r = await pool.query(q, params);
  res.json(r.rows);
});

// Export orders PDF for company (with date range)
app.get('/api/admin/orders/export-pdf', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'Dates required' });
  try {
    const orders = await pool.query(`
      SELECT o.order_date, u.first_name, u.last_name, m.name AS menu_name, m.price, r.name AS restaurant_name, o.drink_preference
      FROM orders o
      JOIN users u ON o.user_id = u.id
      JOIN menus m ON o.menu_id = m.id
      JOIN restaurants r ON o.restaurant_id = r.id
      WHERE o.company_id = $1 AND o.order_date >= $2 AND o.order_date <= $3
      ORDER BY o.order_date DESC, r.name, u.last_name
    `, [companyId, from, to]);
    const coName = req.user.name;
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="commandes_${from}_${to}.pdf"`);
    doc.pipe(res);
    doc.rect(0, 0, doc.page.width, 110).fill('#E85A2A');
    doc.fillColor('#FFF8F3').fontSize(26).font('Helvetica-Bold').text('🍽 FoodChooseApp', 50, 30);
    doc.fontSize(14).font('Helvetica').text(`Commandes du ${from} au ${to}`, 50, 60);
    doc.fontSize(10).text(`Entreprise : ${coName}`, 50, 82);
    let y = 135;
    const total = orders.rows.reduce((s, o) => s + parseFloat(o.price || 0), 0);
    doc.fillColor('#2C1810').fontSize(12).font('Helvetica-Bold').text(`${orders.rows.length} commandes — ${total.toLocaleString()} FCFA`, 50, y);
    y += 28;
    doc.rect(50, y, doc.page.width - 100, 22).fill('#2C1810');
    doc.fillColor('#FFF8F3').fontSize(9).font('Helvetica-Bold');
    doc.text('DATE', 58, y + 6).text('RESTAURANT', 130, y + 6).text('EMPLOYÉ', 260, y + 6).text('MENU', 370, y + 6).text('PRIX', 480, y + 6);
    y += 30;
    orders.rows.forEach((o, i) => {
      if (y > doc.page.height - 80) { doc.addPage(); y = 50; }
      if (i % 2 === 0) doc.rect(50, y - 3, doc.page.width - 100, 18).fill('#FFF8F3');
      doc.fillColor('#2C1810').fontSize(8).font('Helvetica');
      doc.text(o.order_date, 58, y);
      doc.text((o.restaurant_name || '').substring(0, 16), 130, y);
      doc.text(`${o.last_name} ${o.first_name}`.substring(0, 14), 260, y);
      doc.text((o.menu_name || '').substring(0, 18), 370, y);
      doc.text(`${parseFloat(o.price || 0).toLocaleString()}`, 480, y);
      y += 20;
    });
    doc.rect(0, doc.page.height - 35, doc.page.width, 35).fill('#2C1810');
    doc.fillColor('#8B6554').fontSize(9).text('FoodChooseApp', 50, doc.page.height - 20);
    doc.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/admin/orders/validate', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const { date, restaurantId } = req.body;
  const d = date || todayStr();
  try {
    const r = await pool.query(
      "UPDATE orders SET status='validated_by_admin', updated_at=NOW() WHERE company_id=$1 AND order_date=$2 AND status='pending' AND ($3::integer IS NULL OR restaurant_id=$3) RETURNING restaurant_id",
      [companyId, d, restaurantId||null]
    );
    const restaurantIds = [...new Set(r.rows.map(o => o.restaurant_id))];
    const coName = (req.user.name || '').replace('Admin – ', '');
    for (const rid of restaurantIds) {
      await pool.query(
        'INSERT INTO order_batches (company_id,restaurant_id,batch_date,status) VALUES ($1,$2,$3,\'pending\') ON CONFLICT (company_id,restaurant_id,batch_date) DO UPDATE SET status=\'pending\'',
        [companyId, rid, d]
      );
      await createNotification('restaurant', rid, '🛒 Nouvelle commande', `Commande de ${coName} pour le ${d}`, 'order', { companyId, date: d });
      const rest = await pool.query('SELECT email,name FROM restaurants WHERE id=$1', [rid]);
      if (rest.rows.length) sendMail(rest.rows[0].email, `🛒 Nouvelle commande — ${coName}`, `<div style="font-family:Georgia;padding:40px;background:#FFF8F3"><h1 style="color:#E85A2A">🍽 FoodChooseApp</h1><p><strong>${coName}</strong> a passé une commande pour le ${d}. Connectez-vous pour confirmer et envoyer la facture.</p></div>`).catch(err => console.error('Email commande:', err));
    }
    res.json({ validated: r.rowCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/invoices', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const r = await pool.query(`
    SELECT i.*,r.name AS restaurant_name FROM invoices i JOIN restaurants r ON i.restaurant_id=r.id
    WHERE i.company_id=$1 ORDER BY i.created_at DESC
  `, [companyId]);
  res.json(r.rows);
});

app.post('/api/admin/invoices/:id/confirm', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const invoiceId = parseInt(req.params.id);
  if (isNaN(invoiceId)) return res.status(400).json({ error: 'ID invalide' });
  
  try {
    const inv = await pool.query('SELECT * FROM invoices WHERE id=$1 AND company_id=$2', [invoiceId, companyId]);
    if (!inv.rows.length) return res.status(404).json({ error: 'Facture introuvable' });
    
    await pool.query('UPDATE invoices SET status=$1 WHERE id=$2', ['confirmed', invoiceId]);
    
    const rest = await pool.query('SELECT r.name FROM restaurants r JOIN invoices i ON i.restaurant_id=r.id WHERE i.id=$1', [invoiceId]);
    if (rest.rows.length) {
      await createNotification('restaurant', inv.rows[0].restaurant_id, '✅ Facture confirmée', `L'entreprise a confirmé la réception de la facture FAC-${String(invoiceId).padStart(5,'0')}`, 'invoice', { invoiceId: invoiceId });
    }
    
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/invoices/:id/pdf', async (req, res) => {
  const token = req.query.token || req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token manquant' });
  try {
    const d = jwt.verify(token, JWT_SECRET);
    if (d.role !== 'company') return res.status(403).json({ error: 'Accès refusé' });
    const companyId = d.id;
    const inv = await pool.query(`SELECT i.*,r.name AS restaurant_name,r.address AS restaurant_address,c.name AS company_name FROM invoices i JOIN restaurants r ON i.restaurant_id=r.id JOIN companies c ON i.company_id=c.id WHERE i.id=$1 AND i.company_id=$2`, [req.params.id, companyId]);
    if (!inv.rows.length) return res.status(404).json({ error: 'Facture introuvable' });
    const inv_data = inv.rows[0];
    const items = Array.isArray(inv_data.items) ? inv_data.items : JSON.parse(inv_data.items||'[]');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="facture_${req.params.id}.pdf"`);
    doc.pipe(res);
    doc.rect(0,0,doc.page.width,110).fill('#E85A2A');
    doc.fillColor('#FFF8F3').fontSize(26).font('Helvetica-Bold').text('FoodChooseApp', 50, 30);
    doc.fontSize(13).font('Helvetica').text('FACTURE', 50, 62);
    doc.fontSize(10).text(`N° FAC-${String(req.params.id).padStart(5,'0')} | ${new Date(inv_data.created_at).toLocaleDateString('fr-FR')}`, 50, 80);
    let y = 135;
    doc.fillColor('#2C1810').fontSize(12).font('Helvetica-Bold').text('DE :', 50, y);
    doc.fontSize(11).font('Helvetica').fillColor('#4A3728').text(inv_data.restaurant_name, 50, y+16).text(inv_data.restaurant_address||'', 50, y+30);
    doc.fillColor('#2C1810').fontSize(12).font('Helvetica-Bold').text('POUR :', 300, y);
    doc.fontSize(11).font('Helvetica').fillColor('#4A3728').text(inv_data.company_name, 300, y+16);
    y += 80;
    doc.rect(50,y,doc.page.width-100,22).fill('#2C1810');
    doc.fillColor('#FFF8F3').fontSize(9).font('Helvetica-Bold').text('DESCRIPTION',58,y+6).text('QTÉ',300,y+6).text('P.U.',380,y+6).text('TOTAL',450,y+6);
    y += 30;
    items.forEach((item, i) => {
      if (i%2===0) doc.rect(50,y-3,doc.page.width-100,18).fill('#FFF8F3');
      doc.fillColor('#2C1810').fontSize(9).font('Helvetica');
      doc.text(item.name||'', 58, y).text(String(item.qty||1), 308, y).text(`${item.price||0}FCFA`, 380, y).text(`${(item.qty||1)*(item.price||0)}FCFA`, 450, y);
      y += 20;
    });
    y += 10;
    doc.rect(350,y,doc.page.width-400,30).fill('#E85A2A');
    doc.fillColor('#FFF8F3').fontSize(13).font('Helvetica-Bold').text(`TOTAL : ${inv_data.total_amount}FCFA`, 360, y+8);
    doc.rect(0,doc.page.height-35,doc.page.width,35).fill('#2C1810');
    doc.fillColor('#8B6554').fontSize(9).text('FoodChooseApp — Gestion des repas d\'entreprise', 50, doc.page.height-20);
    doc.end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/history', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const { from, to, employeeId } = req.query;
  let q = 'SELECT * FROM order_history WHERE company_id=$1';
  const params = [companyId];
  if (from) { params.push(from); q += ` AND order_date>=$${params.length}`; }
  if (to) { params.push(to); q += ` AND order_date<=$${params.length}`; }
  if (employeeId) { params.push(employeeId); q += ` AND employee_id=$${params.length}`; }
  q += ' ORDER BY action_timestamp DESC LIMIT 200';
  const r = await pool.query(q, params);
  res.json(r.rows);
});

app.get('/api/admin/stats', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  try {
    const empCount = await pool.query('SELECT COUNT(*) FROM users WHERE company_id=$1', [companyId]);
    const affCount = await pool.query('SELECT COUNT(*) FROM affiliations WHERE company_id=$1', [companyId]);
    const todayOrders = await pool.query("SELECT COUNT(*) FROM orders WHERE company_id=$1 AND order_date=CURRENT_DATE", [companyId]);
    const pendingOrders = await pool.query("SELECT COUNT(*) FROM orders WHERE company_id=$1 AND order_date=CURRENT_DATE AND status='pending'", [companyId]);
    res.json({ employees: parseInt(empCount.rows[0].count), affiliations: parseInt(affCount.rows[0].count), todayOrders: parseInt(todayOrders.rows[0].count), pendingOrders: parseInt(pendingOrders.rows[0].count) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/expenses', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const { period } = req.query;
  let groupBy = "to_char(o.order_date,'YYYY-MM-DD')";
  let whereDate = "o.order_date >= CURRENT_DATE - 7";
  if (period === 'month') { whereDate = "o.order_date >= date_trunc('month',CURRENT_DATE)"; groupBy = "to_char(o.order_date,'YYYY-MM-DD')"; }
  if (period === 'quarter') { whereDate = "o.order_date >= date_trunc('quarter',CURRENT_DATE)"; groupBy = "to_char(date_trunc('week',o.order_date),'YYYY-MM-DD')"; }
  try {
    const r = await pool.query(`
      SELECT ${groupBy} AS period, COUNT(*) AS orders, COALESCE(SUM(m.price),0) AS total
      FROM orders o JOIN menus m ON o.menu_id=m.id
      WHERE o.company_id=$1 AND ${whereDate}
      GROUP BY ${groupBy} ORDER BY period
    `, [companyId]);
    const totalWeek = await pool.query("SELECT COALESCE(SUM(m.price),0) AS total FROM orders o JOIN menus m ON o.menu_id=m.id WHERE o.company_id=$1 AND o.order_date>=date_trunc('week',CURRENT_DATE)", [companyId]);
    const totalMonth = await pool.query("SELECT COALESCE(SUM(m.price),0) AS total FROM orders o JOIN menus m ON o.menu_id=m.id WHERE o.company_id=$1 AND o.order_date>=date_trunc('month',CURRENT_DATE)", [companyId]);
    res.json({ series: r.rows, totalWeek: parseFloat(totalWeek.rows[0].total), totalMonth: parseFloat(totalMonth.rows[0].total) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/admin/export-pdf', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const { date } = req.query;
  const d = date || todayStr();
  try {
    const orders = await pool.query(`
      SELECT o.*,u.first_name,u.last_name,m.name AS menu_name,m.price,r.name AS restaurant_name,o.drink_preference
      FROM orders o JOIN users u ON o.user_id=u.id JOIN menus m ON o.menu_id=m.id JOIN restaurants r ON o.restaurant_id=r.id
      WHERE o.company_id=$1 AND o.order_date=$2 ORDER BY r.name,u.last_name
    `, [companyId, d]);
    const coName = (req.user.name || '').replace('Admin – ','');
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    res.setHeader('Content-Type','application/pdf');
    res.setHeader('Content-Disposition',`attachment; filename="commandes_${d}.pdf"`);
    doc.pipe(res);
    doc.rect(0,0,doc.page.width,110).fill('#E85A2A');
    doc.fillColor('#FFF8F3').fontSize(26).font('Helvetica-Bold').text('FoodChooseApp', 50, 30);
    doc.fontSize(14).font('Helvetica').text(`Commandes — ${new Date(d+'T12:00:00').toLocaleDateString('fr-FR',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}`, 50, 60);
    doc.fontSize(10).text(`Entreprise : ${coName}`, 50, 82);
    let y = 135;
    const total = orders.rows.reduce((s,o)=>s+parseFloat(o.price||0),0);
    doc.fillColor('#2C1810').fontSize(12).font('Helvetica-Bold').text(`${orders.rows.length} commandes — ${total.toLocaleString()} FCFA`, 50, y);
    y += 28;
    doc.rect(50,y,doc.page.width-100,22).fill('#2C1810');
    doc.fillColor('#FFF8F3').fontSize(9).font('Helvetica-Bold');
    doc.text('EMPLOYÉ',58,y+6).text('RESTAURANT',180,y+6).text('MENU',300,y+6).text('BOISSON',420,y+6).text('STATUT',490,y+6);
    y += 30;
    orders.rows.forEach((o,i)=>{
      if(y>doc.page.height-80){doc.addPage();y=50;}
      if(i%2===0) doc.rect(50,y-3,doc.page.width-100,18).fill('#FFF8F3');
      const drinkLabel={'lipton':'Lipton','cafeine':'Caféine','both':'Les 2'}[o.drink_preference]||'-';
      doc.fillColor('#2C1810').fontSize(8).font('Helvetica');
      doc.text(`${o.last_name} ${o.first_name}`,58,y).text((o.restaurant_name||'').substring(0,16),180,y).text((o.menu_name||'').substring(0,20),300,y).text(drinkLabel,420,y);
      doc.fillColor(o.status.includes('valid')||o.status==='confirmed'?'#16a34a':'#E85A2A').text(o.status,490,y);
      doc.fillColor('#2C1810'); y+=20;
    });
    doc.rect(0,doc.page.height-35,doc.page.width,35).fill('#2C1810');
    doc.fillColor('#8B6554').fontSize(9).text('FoodChooseApp',50,doc.page.height-20);
    doc.end();
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/api/admin/conversations', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const r = await pool.query(`
    SELECT r.id AS restaurant_id, r.name AS restaurant_name, r.photo_url,
    (SELECT COUNT(*) FROM messages m WHERE m.company_id=$1 AND m.restaurant_id=r.id AND m.read_by_company=FALSE AND m.sender_type='restaurant') AS unread,
    (SELECT content FROM messages m WHERE m.company_id=$1 AND m.restaurant_id=r.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
    (SELECT created_at FROM messages m WHERE m.company_id=$1 AND m.restaurant_id=r.id ORDER BY m.created_at DESC LIMIT 1) AS last_at
    FROM affiliations a JOIN restaurants r ON a.restaurant_id=r.id WHERE a.company_id=$1 ORDER BY last_at DESC NULLS LAST
  `, [companyId]);
  res.json(r.rows);
});

// GET /api/company/weekly-programs — tous les programmes hebdo des restaurants affiliés
app.get('/api/company/weekly-programs', companyAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT wp.*, rest.name AS restaurant_name, rest.photo_url AS restaurant_photo
      FROM weekly_programs wp
      JOIN affiliations a ON a.restaurant_id = wp.restaurant_id
      JOIN restaurants rest ON rest.id = wp.restaurant_id
      WHERE a.company_id = $1
      ORDER BY wp.created_at DESC
    `, [req.user.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/company/weekly-packs — tous les packs hebdo actifs des restaurants affiliés
app.get('/api/company/weekly-packs', companyAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT wp.*, rest.name AS restaurant_name, rest.photo_url AS restaurant_photo,
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', wm.id, 'name', wm.name, 'sort_order', wm.sort_order,
          'days', (
            SELECT COALESCE(json_agg(json_build_object(
              'id', wmd.id, 'day_of_week', wmd.day_of_week, 'is_optional', wmd.is_optional,
              'dishes', (
                SELECT COALESCE(json_agg(json_build_object(
                  'id', wdd.id, 'name', wdd.name, 'description', wdd.description,
                  'price', wdd.price, 'image_url', wdd.image_url
                ) ORDER BY wdd.sort_order), '[]'::json)
                FROM weekly_day_dishes wdd WHERE wdd.weekly_menu_day_id = wmd.id
              )
            ) ORDER BY wmd.day_of_week), '[]'::json)
            FROM weekly_menu_days wmd WHERE wmd.weekly_menu_id = wm.id
          )
        ) ORDER BY wm.sort_order)
        FROM weekly_menus wm WHERE wm.weekly_pack_id = wp.id
      ), '[]'::json) AS menus
      FROM weekly_packs wp
      JOIN affiliations a ON a.restaurant_id = wp.restaurant_id
      JOIN restaurants rest ON rest.id = wp.restaurant_id
      WHERE a.company_id = $1 AND wp.is_active = TRUE
      ORDER BY rest.name, wp.name
    `, [req.user.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/restaurant/contract — statut du contrat du restaurant connecté
app.get('/api/restaurant/contract', restaurantAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM restaurant_contracts WHERE restaurant_id=$1', [req.user.id]);
    res.json(r.rows[0] || { status: 'pending', restaurant_id: req.user.id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/contract/sign — signer le contrat
app.post('/api/restaurant/contract/sign', restaurantAuth, async (req, res) => {
  const { payment_schedule } = req.body;
  const schedule = ['weekly','monthly'].includes(payment_schedule) ? payment_schedule : 'monthly';
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.connection?.remoteAddress || 'unknown';
  try {
    const r = await pool.query(`
      INSERT INTO restaurant_contracts (restaurant_id, status, payment_schedule, commission_rate, signed_at, ip_address)
      VALUES ($1,'signed',$2,1.00,NOW(),$3)
      ON CONFLICT (restaurant_id) DO UPDATE SET status='signed', payment_schedule=$2, signed_at=NOW(), ip_address=$3
      RETURNING *
    `, [req.user.id, schedule, ip]);
    const rest = await pool.query('SELECT name, email FROM restaurants WHERE id=$1', [req.user.id]);
    if (rest.rows.length) {
      createNotification('admin', 1, '📝 Contrat signé', `${rest.rows[0].name} a signé le contrat d'exclusivité.`, 'contract', { restaurantId: req.user.id });
    }
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/contracts — liste tous les contrats (admin)
app.get('/api/admin/contracts', adminAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT rc.*, rest.name AS restaurant_name, rest.email AS restaurant_email, rest.phone, rest.address
      FROM restaurants rest
      LEFT JOIN restaurant_contracts rc ON rc.restaurant_id = rest.id
      ORDER BY CASE WHEN rc.status='pending' OR rc.status IS NULL THEN 0 ELSE 1 END, rest.name
    `);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Affiliation contracts ────────────────────────────────────────

// GET /api/restaurant/affiliation-contracts — liste les contrats d'affiliation du restaurant
app.get('/api/restaurant/affiliation-contracts', restaurantAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT a.id AS affiliation_id, c.name AS company_name, c.logo_url AS company_logo,
             ac.id AS contract_id, ac.restaurant_signed_at, ac.company_signed_at, ac.created_at
      FROM affiliations a
      JOIN companies c ON c.id = a.company_id
      LEFT JOIN affiliation_contracts ac ON ac.affiliation_id = a.id
      WHERE a.restaurant_id = $1
      ORDER BY a.created_at DESC
    `, [req.user.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/restaurant/affiliation-contracts/:affiliationId/sign — restaurant signe
app.post('/api/restaurant/affiliation-contracts/:affiliationId/sign', restaurantAuth, async (req, res) => {
  const affiliationId = parseInt(req.params.affiliationId);
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.connection?.remoteAddress || 'unknown';
  try {
    const check = await pool.query('SELECT id FROM affiliations WHERE id=$1 AND restaurant_id=$2', [affiliationId, req.user.id]);
    if (!check.rows.length) return res.status(403).json({ error: 'Affiliation introuvable' });
    const r = await pool.query(`
      INSERT INTO affiliation_contracts (affiliation_id, restaurant_signed_at, restaurant_ip)
      VALUES ($1, NOW(), $2)
      ON CONFLICT (affiliation_id) DO UPDATE SET restaurant_signed_at=NOW(), restaurant_ip=$2
      RETURNING *
    `, [affiliationId, ip]);
    const co = await pool.query('SELECT c.id, c.name FROM affiliations a JOIN companies c ON c.id=a.company_id WHERE a.id=$1', [affiliationId]);
    if (co.rows.length) {
      createNotification('company', co.rows[0].id, '📝 Contrat d\'affiliation signé', `Le restaurant a signé le contrat d'affiliation.`, 'contract', { affiliationId });
    }
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/company/affiliation-contracts — liste les contrats d'affiliation de l'entreprise
app.get('/api/company/affiliation-contracts', companyAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT a.id AS affiliation_id, rest.name AS restaurant_name, rest.photo_url AS restaurant_photo,
             ac.id AS contract_id, ac.restaurant_signed_at, ac.company_signed_at, ac.created_at
      FROM affiliations a
      JOIN restaurants rest ON rest.id = a.restaurant_id
      LEFT JOIN affiliation_contracts ac ON ac.affiliation_id = a.id
      WHERE a.company_id = $1
      ORDER BY a.created_at DESC
    `, [req.user.id]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/company/affiliation-contracts/:affiliationId/sign — entreprise signe
app.post('/api/company/affiliation-contracts/:affiliationId/sign', companyAuth, async (req, res) => {
  const affiliationId = parseInt(req.params.affiliationId);
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.connection?.remoteAddress || 'unknown';
  try {
    const check = await pool.query('SELECT id FROM affiliations WHERE id=$1 AND company_id=$2', [affiliationId, req.user.id]);
    if (!check.rows.length) return res.status(403).json({ error: 'Affiliation introuvable' });
    const r = await pool.query(`
      INSERT INTO affiliation_contracts (affiliation_id, company_signed_at, company_ip)
      VALUES ($1, NOW(), $2)
      ON CONFLICT (affiliation_id) DO UPDATE SET company_signed_at=NOW(), company_ip=$2
      RETURNING *
    `, [affiliationId, ip]);
    const rest = await pool.query('SELECT r.id, r.name FROM affiliations a JOIN restaurants r ON r.id=a.restaurant_id WHERE a.id=$1', [affiliationId]);
    if (rest.rows.length) {
      createNotification('restaurant', rest.rows[0].id, '📝 Contrat d\'affiliation signé', `L'entreprise a signé le contrat d'affiliation.`, 'contract', { affiliationId });
    }
    res.json(r.rows[0]);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
//  EMPLOYEE ROUTES
// ════════════════════════════════════════════════════════════════
app.get('/api/employee/search', employeeAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const r = await pool.query(`
    SELECT m.id, m.name, m.price, m.category, m.description,
           r.id AS restaurant_id, r.name AS restaurant_name, r.photo_url
    FROM menus m
    JOIN restaurants r ON m.restaurant_id = r.id
    JOIN affiliations a ON a.restaurant_id = r.id
    WHERE a.company_id = $1 AND m.available = TRUE AND m.name ILIKE $2
    ORDER BY m.name LIMIT 20
  `, [req.user.companyId, `%${q}%`]);
  res.json(r.rows);
});

app.get('/api/admin/search', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);
  const r = await pool.query(`
    SELECT m.id, m.name, m.price, m.category, m.description,
           r.id AS restaurant_id, r.name AS restaurant_name, r.photo_url
    FROM menus m
    JOIN restaurants r ON m.restaurant_id = r.id
    JOIN affiliations a ON a.restaurant_id = r.id
    WHERE a.company_id = $1 AND m.available = TRUE AND m.name ILIKE $2
    ORDER BY m.name LIMIT 20
  `, [companyId, `%${q}%`]);
  res.json(r.rows);
});

// GET /api/employee/weekly-programs
app.get('/api/employee/weekly-programs', employeeAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT wp.*, rest.name AS restaurant_name, rest.photo_url AS restaurant_photo
      FROM weekly_programs wp
      JOIN affiliations a ON a.restaurant_id = wp.restaurant_id
      JOIN restaurants rest ON rest.id = wp.restaurant_id
      WHERE a.company_id = $1
      ORDER BY wp.created_at DESC
    `, [req.user.companyId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/employee/weekly-packs
app.get('/api/employee/weekly-packs', employeeAuth, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT wp.*, rest.name AS restaurant_name, rest.photo_url AS restaurant_photo,
      COALESCE((
        SELECT json_agg(json_build_object(
          'id', wm.id, 'name', wm.name, 'sort_order', wm.sort_order,
          'days', (
            SELECT COALESCE(json_agg(json_build_object(
              'id', wmd.id, 'day_of_week', wmd.day_of_week, 'is_optional', wmd.is_optional,
              'dishes', (
                SELECT COALESCE(json_agg(json_build_object(
                  'id', wdd.id, 'name', wdd.name, 'description', wdd.description,
                  'price', wdd.price, 'image_url', wdd.image_url
                ) ORDER BY wdd.sort_order), '[]'::json)
                FROM weekly_day_dishes wdd WHERE wdd.weekly_menu_day_id = wmd.id
              )
            ) ORDER BY wmd.day_of_week), '[]'::json)
            FROM weekly_menu_days wmd WHERE wmd.weekly_menu_id = wm.id
          )
        ) ORDER BY wm.sort_order)
        FROM weekly_menus wm WHERE wm.weekly_pack_id = wp.id
      ), '[]'::json) AS menus
      FROM weekly_packs wp
      JOIN affiliations a ON a.restaurant_id = wp.restaurant_id
      JOIN restaurants rest ON rest.id = wp.restaurant_id
      WHERE a.company_id = $1 AND wp.is_active = TRUE
      ORDER BY rest.name, wp.name
    `, [req.user.companyId]);
    res.json(r.rows);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/employee/restaurants', employeeAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT r.id,r.name,r.address,r.specialties,r.photo_url,
    (SELECT COUNT(*) FROM menus m WHERE m.restaurant_id=r.id AND m.available=TRUE) AS menu_count
    FROM affiliations a JOIN restaurants r ON a.restaurant_id=r.id
    WHERE a.company_id=$1 ORDER BY r.name
  `, [req.user.companyId]);
  res.json(r.rows);
});

app.get('/api/employee/restaurants/:id/menus', employeeAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM menus WHERE restaurant_id=$1 AND available=TRUE ORDER BY category,name', [req.params.id]);
  res.json(r.rows);
});

app.get('/api/employee/order', employeeAuth, async (req, res) => {
  const { restaurantId } = req.query;
  const d = todayStr();
  let q = `SELECT o.*,m.name AS menu_name,r.name AS restaurant_name FROM orders o JOIN menus m ON o.menu_id=m.id JOIN restaurants r ON o.restaurant_id=r.id WHERE o.user_id=$1 AND o.order_date=$2`;
  const params = [req.user.id, d];
  if (restaurantId) { q += ` AND o.restaurant_id=$3`; params.push(restaurantId); }
  const r = await pool.query(q, params);
  res.json(restaurantId ? (r.rows[0]||null) : r.rows);
});

app.post('/api/employee/order', employeeAuth, async (req, res) => {
  const { menuId, restaurantId, drinkPreference, notes } = req.body;
  if (!menuId||!restaurantId) return res.status(400).json({ error: 'Menu et restaurant requis' });
  try {
    const menu = await pool.query('SELECT restaurant_id FROM menus WHERE id=$1 AND available=TRUE', [menuId]);
    if (!menu.rows.length) return res.status(404).json({ error: 'Menu indisponible' });
    const r = await pool.query(
      'INSERT INTO orders (company_id,restaurant_id,user_id,menu_id,order_date,drink_preference,notes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [req.user.companyId, restaurantId, req.user.id, menuId, todayStr(), drinkPreference||null, notes||null]
    );
    if (drinkPreference) await pool.query('UPDATE users SET drink_preference=$1 WHERE id=$2', [drinkPreference, req.user.id]);
    const menuData = await pool.query('SELECT name FROM menus WHERE id=$1', [menuId]);
    const restData = await pool.query('SELECT name,email FROM restaurants WHERE id=$1', [restaurantId]);
    const coData = await pool.query('SELECT name FROM companies WHERE id=$1', [req.user.companyId]);
    const d = todayStr();
    await pool.query('INSERT INTO order_history (user_id,company_id,employee_id,employee_name,restaurant_name,menu_name,order_date,drink_preference,action) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [req.user.id, req.user.companyId, req.user.employeeId, req.user.name, restData.rows[0]?.name, menuData.rows[0]?.name, d, drinkPreference||null, 'created']);
    // Notify restaurant
    await createNotification('restaurant', restaurantId, '🛒 Nouvelle commande', `Commande de ${coData.rows[0]?.name} pour le ${d}`, 'order', { companyId: req.user.companyId, date: d });
    // Send email to restaurant
    try {
      sendMail(restData.rows[0].email, '🛒 Nouvelle commande — FoodChooseApp',
        `<div style="font-family:Georgia,serif;padding:40px;background:#FFF8F3;border-radius:12px">
          <h1 style="color:#E85A2A">🍽 FoodChooseApp</h1>
          <h2 style="color:#2C1810">Nouvelle commande !</h2>
          <p style="color:#4A3728;font-size:16px"><strong>${coData.rows[0]?.name}</strong> a passé une commande pour le <strong>${d}</strong></p>
          <div style="background:#2C1810;border-radius:10px;padding:20px;margin:20px 0">
            <p style="color:#E85A2A;font-size:12px;margin:0">MENU</p>
            <p style="color:#FFF8F3;font-size:18px;font-weight:700;margin:4px 0 16px">${menuData.rows[0]?.name}</p>
            <p style="color:#E85A2A;font-size:12px;margin:0">EMPLOYÉ</p>
            <p style="color:#FFF8F3;font-size:16px;margin:4px 0">${req.user.name}</p>
          </div>
          <p style="color:#8B6554;font-size:13px">Connectez-vous pour confirmer et envoyer la facture.</p>
        </div>`
      ).catch(err => console.error('Email commande erreur:', err));
    } catch(e) {}
    res.status(201).json(r.rows[0]);
  } catch (e) {
    if (e.code==='23505') return res.status(400).json({ error: 'Commande déjà existante pour ce restaurant aujourd\'hui' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/employee/order/:id', employeeAuth, async (req, res) => {
  const { menuId, drinkPreference, notes } = req.body;
  try {
    const ex = await pool.query('SELECT * FROM orders WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
    if (!ex.rows.length) return res.status(404).json({ error: 'Commande introuvable' });
    if (ex.rows[0].status !== 'pending') return res.status(400).json({ error: 'Impossible de modifier cette commande' });
    await pool.query('UPDATE orders SET menu_id=$1,drink_preference=$2,notes=$3,updated_at=NOW() WHERE id=$4 AND user_id=$5', [menuId, drinkPreference||null, notes||null, req.params.id, req.user.id]);
    if (drinkPreference) await pool.query('UPDATE users SET drink_preference=$1 WHERE id=$2', [drinkPreference, req.user.id]);
    const menuData = await pool.query('SELECT name FROM menus WHERE id=$1', [menuId]);
    await pool.query('INSERT INTO order_history (user_id,company_id,employee_id,employee_name,restaurant_name,menu_name,order_date,drink_preference,action) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [req.user.id, req.user.companyId, req.user.employeeId, req.user.name, '', menuData.rows[0]?.name, ex.rows[0].order_date, drinkPreference||null, 'updated']);
    res.json({ message: 'Commande mise à jour' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/employee/order/:id', employeeAuth, async (req, res) => {
  try {
    const orderId = parseInt(req.params.id);
    if (isNaN(orderId)) return res.status(400).json({ error: 'ID invalide' });
    
    const ex = await pool.query('SELECT o.*,m.name AS menu_name,r.name AS rest_name FROM orders o JOIN menus m ON o.menu_id=m.id JOIN restaurants r ON o.restaurant_id=r.id WHERE o.id=$1 AND o.user_id=$2', [orderId, req.user.id]);
    if (!ex.rows.length) return res.status(404).json({ error: 'Introuvable' });
    if (ex.rows[0].status !== 'pending') return res.status(400).json({ error: 'Impossible de supprimer' });
    await pool.query('DELETE FROM orders WHERE id=$1 AND user_id=$2', [orderId, req.user.id]);
    await pool.query('INSERT INTO order_history (user_id,company_id,employee_id,employee_name,restaurant_name,menu_name,order_date,action) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
      [req.user.id, req.user.companyId, req.user.employeeId, req.user.name, ex.rows[0].rest_name, ex.rows[0].menu_name, ex.rows[0].order_date, 'deleted']);
    res.json({ message: 'Supprimée' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/employee/ratings', employeeAuth, async (req, res) => {
  const { menuId, restaurantId, score, comment, orderDate } = req.body;
  try {
    await pool.query(
      'INSERT INTO ratings (user_id,menu_id,restaurant_id,score,comment,order_date) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id,menu_id,order_date) DO UPDATE SET score=$4,comment=$5',
      [req.user.id, menuId, restaurantId, score, comment||null, orderDate||todayStr()]
    );
    const menuData = await pool.query('SELECT name FROM menus WHERE id=$1', [menuId]);
    await createNotification('restaurant', restaurantId, `⭐ Nouvelle note : ${score}/5`, `${req.user.name} a noté ${menuData.rows[0]?.name} — ${'⭐'.repeat(score)}`, 'rating', { score, menuId });
    res.json({ message: 'Note enregistrée' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/employee/history', employeeAuth, async (req, res) => {
  const r = await pool.query('SELECT * FROM order_history WHERE user_id=$1 ORDER BY action_timestamp DESC', [req.user.id]);
  res.json(r.rows);
});

app.delete('/api/employee/history', employeeAuth, async (req, res) => {
  await pool.query('DELETE FROM order_history WHERE user_id=$1', [req.user.id]);
  res.json({ message: 'Historique vidé' });
});

app.delete('/api/employee/history/:id', employeeAuth, async (req, res) => {
  await pool.query('DELETE FROM order_history WHERE id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ message: 'Supprimé' });
});

app.get('/api/employee/profile', employeeAuth, async (req, res) => {
  const r = await pool.query('SELECT id,employee_id,first_name,last_name,email,drink_preference,photo_url,created_at FROM users WHERE id=$1', [req.user.id]);
  res.json(r.rows[0]);
});

app.put('/api/employee/profile', employeeAuth, async (req, res) => {
  const { newPassword, photoUrl, firstName, lastName } = req.body;
  try {
    if (newPassword) {
      const hash = await bcrypt.hash(newPassword, 10);
      await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    }
    if (photoUrl) await pool.query('UPDATE users SET photo_url=$1 WHERE id=$2', [photoUrl, req.user.id]);
    if (firstName) await pool.query('UPDATE users SET first_name=$1 WHERE id=$2', [firstName, req.user.id]);
    if (lastName) await pool.query('UPDATE users SET last_name=$1 WHERE id=$2', [lastName, req.user.id]);
    res.json({ message: 'Profil mis à jour' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Restaurant conversations
app.get('/api/restaurant/conversations', restaurantAuth, async (req, res) => {
  const r = await pool.query(`
    SELECT c.id AS company_id, c.name AS company_name, c.logo_url,
    (SELECT COUNT(*) FROM messages m WHERE m.restaurant_id=$1 AND m.company_id=c.id AND m.read_by_restaurant=FALSE AND m.sender_type='company') AS unread,
    (SELECT content FROM messages m WHERE m.restaurant_id=$1 AND m.company_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
    (SELECT created_at FROM messages m WHERE m.restaurant_id=$1 AND m.company_id=c.id ORDER BY m.created_at DESC LIMIT 1) AS last_at
    FROM affiliations a JOIN companies c ON a.company_id=c.id WHERE a.restaurant_id=$1 ORDER BY last_at DESC NULLS LAST
  `, [req.user.id]);
  res.json(r.rows);
});

// ─── Company profile (logo)
app.get('/api/admin/company-profile', companyAuth, async (req, res) => {
  const companyId = req.user.id;
  const r = await pool.query('SELECT id, name, email, logo_url FROM companies WHERE id=$1', [companyId]);
  res.json(r.rows[0] || {});
});

app.put('/api/admin/company-profile', companyAuth, async (req, res) => {
  const { logoUrl, name, email } = req.body;
  const companyId = req.user.id;
  try {
    if (logoUrl) await pool.query('UPDATE companies SET logo_url=$1 WHERE id=$2', [logoUrl, companyId]);
    if (name) await pool.query('UPDATE companies SET name=$1 WHERE id=$2', [name, companyId]);
    if (email) await pool.query('UPDATE companies SET email=$1 WHERE id=$2', [email, companyId]);
    res.json({ message: 'Profil mis à jour' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
//  CHANGEMENT DE MOT DE PASSE
// ════════════════════════════════════════════════════════════════

app.put('/api/restaurant/password', restaurantAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Champs requis' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Minimum 6 caractères' });
  try {
    const r = await pool.query('SELECT password_hash FROM restaurants WHERE id=$1', [req.user.id]);
    if (!await bcrypt.compare(currentPassword, r.rows[0].password_hash))
      return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE restaurants SET password_hash=$1 WHERE id=$2', [hash, req.user.id]);
    res.json({ message: 'Mot de passe mis à jour' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/company/password', companyAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Champs requis' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Minimum 6 caractères' });
  try {
    const companyId = req.user.id;
    // Vérification selon le rôle
    const r = await pool.query('SELECT password_hash FROM companies WHERE id=$1', [companyId]);
    if (!await bcrypt.compare(currentPassword, r.rows[0].password_hash))
      return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE companies SET password_hash=$1 WHERE id=$2', [hash, companyId]);
    res.json({ message: 'Mot de passe mis à jour' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
//  RÉCUPÉRATION DE MOT DE PASSE (OTP)
// ════════════════════════════════════════════════════════════════

app.post('/api/auth/forgot-password', async (req, res) => {
  const { email, userType } = req.body;
  if (!email || !userType) return res.status(400).json({ error: 'Champs requis' });
  try {
    let user;
    if (userType === 'admin') {
      const r = await pool.query('SELECT id, name FROM admins WHERE email=$1', [email]);
      user = r.rows[0];
    } else if (userType === 'company') {
      const r = await pool.query('SELECT id, name FROM companies WHERE email=$1', [email]);
      user = r.rows[0];
    } else if (userType === 'restaurant') {
      const r = await pool.query('SELECT id, name FROM restaurants WHERE email=$1', [email]);
      user = r.rows[0];
    } else if (userType === 'employee') {
      const r = await pool.query('SELECT id, first_name AS name FROM users WHERE email=$1', [email]);
      user = r.rows[0];
    }
    if (!user) return res.status(404).json({ error: 'Aucun compte trouvé pour cet email' });

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    await pool.query('DELETE FROM password_resets WHERE email=$1 AND user_type=$2', [email, userType]);
    await pool.query(
      'INSERT INTO password_resets (email, user_type, otp_code, expires_at) VALUES ($1,$2,$3,$4)',
      [email, userType, otp, expiresAt]
    );
    await sendMail(email, '🔑 Code de récupération FoodChooseApp',
      `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:40px;background:#FFF8F3;border-radius:12px;">
        <h1 style="color:#E85A2A;font-size:28px;">🍽 FoodChooseApp</h1>
        <h2 style="color:#2C1810;">Récupération de mot de passe</h2>
        <p style="color:#4A3728;line-height:1.7">Bonjour <strong>${user.name}</strong>,<br>Voici votre code de vérification :</p>
        <div style="background:#2C1810;border-radius:10px;padding:32px;text-align:center;margin:24px 0">
          <p style="color:#F9C74F;font-size:11px;letter-spacing:2px;margin:0 0 12px;text-transform:uppercase">Code OTP</p>
          <p style="color:#FFF8F3;font-size:42px;font-weight:700;font-family:monospace;letter-spacing:10px;margin:0">${otp}</p>
        </div>
        <p style="color:#4A3728;font-size:13px;">Ce code expire dans <strong>15 minutes</strong>. Ne le partagez jamais.</p>
        <p style="color:#8B6554;font-size:13px;margin-top:24px;border-top:1px solid #F0E6DE;padding-top:16px">© FoodChooseApp — Plateforme de choix de repas</p>
      </div>`
    );
    res.json({ message: 'Code envoyé par email' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, userType, otp } = req.body;
  try {
    const r = await pool.query(
      'SELECT * FROM password_resets WHERE email=$1 AND user_type=$2 AND otp_code=$3 AND used=FALSE AND expires_at > NOW()',
      [email, userType, otp]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Code invalide ou expiré' });
    res.json({ valid: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const { email, userType, otp, newPassword } = req.body;
  if (!email || !userType || !otp || !newPassword) return res.status(400).json({ error: 'Champs requis' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'Minimum 6 caractères' });
  try {
    const r = await pool.query(
      'SELECT * FROM password_resets WHERE email=$1 AND user_type=$2 AND otp_code=$3 AND used=FALSE AND expires_at > NOW()',
      [email, userType, otp]
    );
    if (!r.rows.length) return res.status(400).json({ error: 'Code invalide ou expiré' });
    const hash = await bcrypt.hash(newPassword, 10);
    if (userType === 'admin') await pool.query('UPDATE admins SET password_hash=$1 WHERE email=$2', [hash, email]);
    else if (userType === 'company') await pool.query('UPDATE companies SET password_hash=$1 WHERE email=$2', [hash, email]);
    else if (userType === 'restaurant') await pool.query('UPDATE restaurants SET password_hash=$1 WHERE email=$2', [hash, email]);
    else if (userType === 'employee') await pool.query('UPDATE users SET password_hash=$1 WHERE email=$2', [hash, email]);
    await pool.query('UPDATE password_resets SET used=TRUE WHERE email=$1 AND user_type=$2', [email, userType]);
    res.json({ message: 'Mot de passe réinitialisé avec succès' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Detect user type from email
app.post('/api/auth/identify', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email requis' });
  try {
    if ((await pool.query('SELECT 1 FROM admins WHERE email=$1', [email])).rows.length)
      return res.json({ userType: 'admin' });
    if ((await pool.query('SELECT 1 FROM companies WHERE email=$1', [email])).rows.length)
      return res.json({ userType: 'company' });
    if ((await pool.query('SELECT 1 FROM restaurants WHERE email=$1', [email])).rows.length)
      return res.json({ userType: 'restaurant' });
    if ((await pool.query('SELECT 1 FROM users WHERE email=$1', [email])).rows.length)
      return res.json({ userType: 'employee' });
    res.status(404).json({ error: 'Aucun compte trouvé' });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ─── Static file serving ──────────────────────────────────────────
app.get('/login',              (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'login.html')));
app.get('/restaurant/login',   (req, res) => res.redirect('/login.html'));
app.get('/company/login',      (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'company/login.html')));
app.get('/employee/login',     (req, res) => res.redirect('/login.html'));
app.get('/restaurant/register',(req, res) => res.sendFile(path.join(PUBLIC_DIR, 'restaurant/register.html')));
app.get('/restaurant/dashboard',(req, res) => res.sendFile(path.join(PUBLIC_DIR, 'restaurant/dashboard.html')));
app.get('/company/register',   (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'company/register.html')));
app.get('/company/admin',      (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'company/admin.html')));
app.get('/employee',           (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'employee/index.html')));
app.get('/admin',              (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin/index.html')));

// ════════════════════════════════════════════════════════════════════════
//  RAPPELS QUOTIDIENS (Lun-Ven)
//  9h  → notification in-app
//  10h → notification in-app
//  11h → email
// ════════════════════════════════════════════════════════════════
const employeesWithoutOrder = async (today) => {
  const r = await pool.query(`
    SELECT u.id, u.email, u.first_name
    FROM users u
    WHERE u.company_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.order_date = $1)
  `, [today]);
  return r.rows;
};

// Get employees who haven't received reminder at specific hour today
const employeesWithoutReminderAtHour = async (today, hour) => {
  const r = await pool.query(`
    SELECT u.id, u.email, u.first_name
    FROM users u
    WHERE u.company_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.user_id = u.id AND o.order_date = $1)
      AND NOT EXISTS (
        SELECT 1 FROM notifications n 
        WHERE n.target_type = 'user' 
          AND n.target_id = u.id 
          AND n.created_at::date = $1
          AND n.title LIKE $2
      )
  `, [today, `%${hour}h%`]);
  return r.rows;
};

// 9h — notification + email
cron.schedule('0 9 * * 1-5', async () => {
  try {
    const today = todayStr();
    const appUrl = process.env.APP_URL || 'http://localhost:3050';
    const employees = await employeesWithoutReminderAtHour(today, '9h');
    for (const emp of employees) {
      await createNotification('employee', emp.id,
        '9h 🍽 Choisissez votre repas du jour !',
        `Bonjour ${emp.first_name} ! Pensez à faire votre choix de repas avant la clôture des commandes.`,
        'reminder', {});
      sendMail(emp.email, '🍽 Choisissez votre repas du jour !',
        `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:40px;background:#FFF8F3;border-radius:12px;">
          <h1 style="color:#E85A2A;font-size:28px;">FoodChooseApp</h1>
          <h2 style="color:#2C1810;">Bonjour ${emp.first_name} !</h2>
          <p style="color:#4A3728;line-height:1.7">C'est l'heure de choisir votre repas du jour !<br>Pensez à faire votre choix avant la clôture des commandes.</p>
          <div style="text-align:center;margin:24px 0">
            <a href="${appUrl}/employee" style="display:inline-block;background:#E85A2A;color:white;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Choisir mon repas</a>
          </div>
          <p style="color:#8B6554;font-size:13px;margin-top:24px;border-top:1px solid #F0E6DE;padding-top:16px">© FoodChooseApp — Plateforme de choix de repas</p>
        </div>`
      ).catch(err => console.error('Email rappel 9h:', err));
    }
    if (employees.length) console.log(`🔔🔔 Rappels 9h : ${employees.length} employé(s)`);
  } catch(e) { console.error('Cron 9h error:', e.message); }
}, { timezone: 'Africa/Abidjan' });

// 10h — notification + email
cron.schedule('0 10 * * 1-5', async () => {
  try {
    const today = todayStr();
    const appUrl = process.env.APP_URL || 'http://localhost:3050';
    const employees = await employeesWithoutReminderAtHour(today, '10h');
    for (const emp of employees) {
      await createNotification('employee', emp.id,
        '10h ⏰ Rappel — Repas du jour',
        `${emp.first_name}, vous n'avez pas encore fait votre choix ! Il vous reste encore un peu de temps.`,
        'reminder', {});
      sendMail(emp.email, '⏰ Rappel — Choisissez votre repas !',
        `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:40px;background:#FFF8F3;border-radius:12px;">
          <h1 style="color:#E85A2A;font-size:28px;">FoodChooseApp</h1>
          <h2 style="color:#2C1810;">Bonjour ${emp.first_name} !</h2>
          <p style="color:#4A3728;line-height:1.7">Vous n'avez pas encore fait votre choix de repas.<br>Il vous reste encore du temps avant la clôture !</p>
          <div style="text-align:center;margin:24px 0">
            <a href="${appUrl}/employee" style="display:inline-block;background:#E85A2A;color:white;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Choisir mon repas</a>
          </div>
          <p style="color:#8B6554;font-size:13px;margin-top:24px;border-top:1px solid #F0E6DE;padding-top:16px">© FoodChooseApp — Plateforme de choix de repas</p>
        </div>`
      ).catch(err => console.error('Email rappel 10h:', err));
    }
    if (employees.length) console.log(`🔔🔔 Rappels 10h : ${employees.length} employé(s)`);
  } catch(e) { console.error('Cron 10h error:', e.message); }
}, { timezone: 'Africa/Abidjan' });

// 11h — notification + email (dernier rappel)
cron.schedule('0 11 * * 1-5', async () => {
  try {
    const today = todayStr();
    const appUrl = process.env.APP_URL || 'http://localhost:3050';
    const employees = await employeesWithoutReminderAtHour(today, '11h');
    for (const emp of employees) {
      await createNotification('employee', emp.id,
        '11h 📧 Dernier rappel — Commandez maintenant',
        `Un email de rappel a été envoyé à votre adresse. C'est le dernier rappel !`,
        'reminder', {});
      sendMail(emp.email, '📧 Dernier rappel — Repas du jour',
        `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:40px;background:#FFF8F3;border-radius:12px;">
          <h1 style="color:#E85A2A;font-size:28px;">FoodChooseApp</h1>
          <h2 style="color:#2C1810;">Bonjour ${emp.first_name} !</h2>
          <p style="color:#4A3728;line-height:1.7">Vous n'avez pas encore sélectionné votre repas d'aujourd'hui.<br>
          C'est votre <strong>dernier rappel</strong>. Connectez-vous maintenant pour faire votre choix.</p>
          <div style="text-align:center;margin:24px 0">
            <a href="${appUrl}/employee" style="display:inline-block;background:#E85A2A;color:white;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Choisir mon repas</a>
          </div>
          <p style="color:#8B6554;font-size:13px;margin-top:24px;border-top:1px solid #F0E6DE;padding-top:16px">© FoodChooseApp — Plateforme de choix de repas</p>
        </div>`
      ).catch(err => console.error('Email rappel 11h:', err));
    }
    if (employees.length) console.log(`📧📧 Rappels email 11h : ${employees.length} employé(s)`);
  } catch(e) { console.error('Cron 11h error:', e.message); }
}, { timezone: 'Africa/Abidjan' });

app.get('/api/wake_db', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

const sendReminderAtHour = async (hour, titlePrefix, messageTemplate) => {
  const today = todayStr();
  const appUrl = process.env.APP_URL || 'http://localhost:3050';
  const employees = await employeesWithoutReminderAtHour(today, hour);
  for (const emp of employees) {
    await createNotification('employee', emp.id, `${hour} ${titlePrefix}`,
      messageTemplate(emp.first_name), 'reminder', {});
    sendMail(emp.email, `${hour} ${titlePrefix}`,
      `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;padding:40px;background:#FFF8F3;border-radius:12px;">
        <h1 style="color:#E85A2A;font-size:28px;">FoodChooseApp</h1>
        <h2 style="color:#2C1810;">Bonjour ${emp.first_name} !</h2>
        <p style="color:#4A3728;line-height:1.7">${messageTemplate(emp.first_name).replace(/\n/g, '<br>')}</p>
        <div style="text-align:center;margin:24px 0">
          <a href="${appUrl}/employee" style="display:inline-block;background:#E85A2A;color:white;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none">Choisir mon repas</a>
        </div>
        <p style="color:#8B6554;font-size:13px;margin-top:24px;border-top:1px solid #F0E6DE;padding-top:16px">© FoodChooseApp — Plateforme de choix de repas</p>
      </div>`
    ).catch(err => console.error(`Email rappel ${hour}:`, err));
  }
  if (employees.length) console.log(`🔔🔔 Rappels ${hour} : ${employees.length} employé(s)`);
  return employees.length;
};

app.get('/api/cron/reminder_9h', async (req, res) => {
  console.log('[CRON 9h] Endpoint triggered at', new Date().toISOString());
  try {
    const count = await sendReminderAtHour('9h', '🍽 Choisissez votre repas du jour !', (name) =>
      `Bonjour ${name} ! Pensez à faire votre choix de repas avant la clôture des commandes.`
    );
    res.json({ ok: true, reminders: count });
  } catch (e) {
    console.error('Cron 9h error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cron/reminder_10h', async (req, res) => {
  try {
    const count = await sendReminderAtHour('10h', '⏰ Rappel — Repas du jour', (name) =>
      `${name}, vous n'avez pas encore fait votre choix ! Il vous reste encore un peu de temps.`
    );
    res.json({ ok: true, reminders: count });
  } catch (e) {
    console.error('Cron 10h error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/cron/reminder_11h', async (req, res) => {
  try {
    const count = await sendReminderAtHour('11h', '📧 Dernier rappel — Commandez maintenant', (name) =>
      `Un email de rappel a été envoyé à votre adresse. C'est le le dernier rappel !`
    );
    res.json({ ok: true, reminders: count });
  } catch (e) {
    console.error('Cron 11h error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.get('/test', async (req, res) => {
  console.log('[TEST] /test endpoint called');
  res.json({ success: true, message: 'Test endpoint working' });
});

if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => console.log(`🍽 FoodChooseApp → http://localhost:${PORT}`));

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`❌ Port ${PORT} déjà occupé. Nouvel essai nodemon dans 2 s...`);
      setTimeout(() => process.exit(1), 2000);
    } else {
      console.error(`❌ Erreur serveur: ${err.message}`);
      process.exit(1);
    }
  });

  const shutdown = async () => {
    console.log('\n🛑 Arrêt du serveur...');
    server.closeAllConnections();
    server.close(async () => {
      await pool.end();
      process.exit(0);
    });
    setTimeout(() => { pool.end().finally(() => process.exit(0)); }, 3000);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

app.get('/api/test-cron', async (req, res) => {
  console.log('[TEST] /api/test-cron called');
  res.json({ success: true, message: 'Cron endpoint working' });
});


// ════════════════════════════════════════════════════════════════
//  SUPER ADMIN ROUTES
// ════════════════════════════════════════════════════════════════

// Login admin
app.post('/api/auth/admin/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Champs requis manquants' });
  try {
    const r = await pool.query('SELECT * FROM admins WHERE email=$1', [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'Identifiants incorrects' });
    const admin = r.rows[0];
    if (!await bcrypt.compare(password, admin.password_hash)) return res.status(401).json({ error: 'Identifiants incorrects' });
    const token = jwt.sign({ id: admin.id, role: 'admin', name: admin.name }, JWT_SECRET, { expiresIn: '8h' });
    res.json({ token, role: 'admin', id: admin.id, name: admin.name });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stats globales
app.get('/api/super-admin/stats', adminAuth, async (req, res) => {
  try {
    const [restaurants, companies, employees, ordersToday, ordersTotal,
           menus, plats, boissons, commTotal, commToday] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM restaurants'),
      pool.query('SELECT COUNT(*) FROM companies'),
      pool.query('SELECT COUNT(*) FROM users'),
      pool.query("SELECT COUNT(*) FROM orders WHERE order_date=CURRENT_DATE"),
      pool.query('SELECT COUNT(*) FROM orders'),
      pool.query('SELECT COUNT(*) FROM menus'),
      pool.query("SELECT COUNT(*) FROM menus WHERE category='plat'"),
      pool.query("SELECT COUNT(*) FROM menus WHERE category IN ('boisson','drink','beverage')"),
      pool.query(`SELECT COALESCE(SUM(m.price * 0.01), 0) AS total
                  FROM orders o JOIN menus m ON m.id=o.menu_id
                  WHERE o.status IN ('confirmed','completed','delivered')`),
      pool.query(`SELECT COALESCE(SUM(m.price * 0.01), 0) AS total
                  FROM orders o JOIN menus m ON m.id=o.menu_id
                  WHERE o.order_date=CURRENT_DATE AND o.status IN ('confirmed','completed','delivered')`),
    ]);
    res.json({
      restaurants: parseInt(restaurants.rows[0].count),
      companies: parseInt(companies.rows[0].count),
      employees: parseInt(employees.rows[0].count),
      ordersToday: parseInt(ordersToday.rows[0].count),
      ordersTotal: parseInt(ordersTotal.rows[0].count),
      menus: parseInt(menus.rows[0].count),
      plats: parseInt(plats.rows[0].count),
      boissons: parseInt(boissons.rows[0].count),
      commissionTotal: parseFloat(commTotal.rows[0].total).toFixed(2),
      commissionToday: parseFloat(commToday.rows[0].total).toFixed(2),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Tous les menus de tous les restaurants
app.get('/api/super-admin/menus', adminAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT m.id, m.name, m.description, m.category, m.price, m.available, m.image_url, m.created_at,
              r.id AS restaurant_id, r.name AS restaurant_name
       FROM menus m
       JOIN restaurants r ON r.id = m.restaurant_id
       ORDER BY r.name, m.category, m.name`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Commandes en temps réel (100 dernières)
app.get('/api/super-admin/orders/live', adminAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT o.id, o.order_date, o.status, o.drink_preference, o.created_at,
              r.name AS restaurant_name,
              c.name AS company_name,
              u.first_name || ' ' || u.last_name AS employee_name,
              m.name AS menu_name, m.price AS menu_price, m.category AS menu_category,
              ROUND(m.price * 0.01, 2) AS commission
       FROM orders o
       JOIN restaurants r ON r.id = o.restaurant_id
       JOIN companies c ON c.id = o.company_id
       JOIN users u ON u.id = o.user_id
       LEFT JOIN menus m ON m.id = o.menu_id
       ORDER BY o.created_at DESC
       LIMIT 100`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Liste tous les restaurants
app.get('/api/super-admin/restaurants', adminAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT r.id, r.name, r.email, r.phone, r.location, r.created_at,
        (SELECT COUNT(*) FROM affiliations a WHERE a.restaurant_id=r.id) AS affiliations_count,
        (SELECT COUNT(*) FROM menus m WHERE m.restaurant_id=r.id) AS menus_count
       FROM restaurants r ORDER BY r.created_at DESC`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Liste toutes les entreprises
app.get('/api/super-admin/companies', adminAuth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT c.id, c.name, c.email, c.phone, c.sector, c.location, c.created_at,
        (SELECT COUNT(*) FROM users u WHERE u.company_id=c.id) AS employees_count,
        (SELECT COUNT(*) FROM affiliations a WHERE a.company_id=c.id) AS affiliations_count
       FROM companies c ORDER BY c.created_at DESC`
    );
    res.json(r.rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Détails d'un restaurant
app.get('/api/super-admin/restaurants/:id', adminAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,email,phone,address,location,photo_url,created_at FROM restaurants WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Restaurant introuvable' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Détails d'une entreprise
app.get('/api/super-admin/companies/:id', adminAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,email,phone,sector,address,location,created_at FROM companies WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Entreprise introuvable' });
    res.json(r.rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Supprimer un restaurant
app.delete('/api/super-admin/restaurants/:id', adminAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT name FROM restaurants WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Restaurant introuvable' });
    await pool.query('DELETE FROM restaurants WHERE id=$1', [req.params.id]);
    res.json({ ok: true, message: `Restaurant "${r.rows[0].name}" supprimé` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Supprimer une entreprise
app.delete('/api/super-admin/companies/:id', adminAuth, async (req, res) => {
  try {
    const r = await pool.query('SELECT name FROM companies WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Entreprise introuvable' });
    await pool.query('DELETE FROM companies WHERE id=$1', [req.params.id]);
    res.json({ ok: true, message: `Entreprise "${r.rows[0].name}" supprimée` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Réinitialiser le mot de passe d'un restaurant (admin)
app.put('/api/super-admin/restaurants/:id/reset-password', adminAuth, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min 6 caractères)' });
  try {
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE restaurants SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Réinitialiser le mot de passe d'une entreprise (admin)
app.put('/api/super-admin/companies/:id/reset-password', adminAuth, async (req, res) => {
  const { newPassword } = req.body;
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: 'Mot de passe trop court (min 6 caractères)' });
  try {
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE companies SET password_hash=$1 WHERE id=$2', [hash, req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════

app.get('*', (req, res) => {
  console.log(`[${new Date().toISOString()}] 404: ${req.path}`);
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

module.exports = app;
