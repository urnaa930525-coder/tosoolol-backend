const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const cloudinary = require('cloudinary').v2;
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');

// ---------- Cloudinary (persistent file storage) ----------
// Render's free web services wipe local disk on every redeploy, so video/
// thumbnail/subtitle files can't live there. Cloudinary stores them
// permanently and serves them over its own CDN instead.
// Set CLOUDINARY_URL (format: cloudinary://<api_key>:<api_secret>@<cloud_name>)
// in Render's environment variables — cloudinary configures itself from it.
if (process.env.CLOUDINARY_URL) {
  cloudinary.config(true); // picks up CLOUDINARY_URL automatically
} else {
  console.error('CLOUDINARY_URL тохируулаагүй байна — файл хадгалалт ажиллахгүй.');
}

// ---------- Bunny.net Stream (full-length movies, >100MB) ----------
// Cloudinary's free plan caps video uploads at 100MB, which full-length
// movies routinely exceed. Bunny Stream has no such per-file cap, so all
// video files now go there; thumbnails/subtitles still use Cloudinary.
const BUNNY_LIBRARY_ID = process.env.BUNNY_LIBRARY_ID;
const BUNNY_API_KEY = process.env.BUNNY_API_KEY;
const BUNNY_CDN_HOSTNAME = process.env.BUNNY_CDN_HOSTNAME; // e.g. vz-319a1e80-e2a.b-cdn.net
if (!BUNNY_LIBRARY_ID || !BUNNY_API_KEY || !BUNNY_CDN_HOSTNAME) {
  console.error('BUNNY_LIBRARY_ID / BUNNY_API_KEY / BUNNY_CDN_HOSTNAME тохируулаагүй байна — видео upload ажиллахгүй.');
}

async function createBunnyVideo(title){
  const createRes = await fetch(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos`, {
    method: 'POST',
    headers: { 'AccessKey': BUNNY_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title })
  });
  if (!createRes.ok) throw new Error('Bunny video үүсгэхэд алдаа гарлаа: ' + (await createRes.text()));
  const created = await createRes.json();
  return created.guid;
}

function bunnyUrls(guid){
  return {
    guid,
    playbackUrl: `https://${BUNNY_CDN_HOSTNAME}/${guid}/playlist.m3u8`,
    thumbnailUrl: `https://${BUNNY_CDN_HOSTNAME}/${guid}/thumbnail.jpg`
  };
}

// TUS (resumable upload protocol) signature, so the BROWSER can upload the
// video file straight to Bunny's servers — never passing through our own
// backend at all. This is what makes multi-GB movies work reliably: no
// relay step, no risk of our small Render instance timing out or running
// out of memory while shuttling gigabytes of video through itself.
function bunnyTusSignature(guid, expire){
  return crypto.createHash('sha256')
    .update(BUNNY_LIBRARY_ID + BUNNY_API_KEY + expire + guid)
    .digest('hex');
}

async function uploadVideoToBunny(localPath, title){
  const guid = await createBunnyVideo(title);

  // Upload the actual file bytes — stream it rather than reading the
  // whole file into memory first. A full-length movie (1-4GB+) read via
  // fs.readFileSync would exceed Render's free-tier 512MB RAM and crash
  // the process outright (which the browser just sees as "Failed to fetch").
  const stat = fs.statSync(localPath);
  const uploadRes = await fetch(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${guid}`, {
    method: 'PUT',
    headers: {
      'AccessKey': BUNNY_API_KEY,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(stat.size)
    },
    body: fs.createReadStream(localPath),
    duplex: 'half'
  });
  if (!uploadRes.ok) throw new Error('Bunny руу видео upload хийхэд алдаа гарлаа: ' + (await uploadRes.text()));

  if (fs.existsSync(localPath)) fs.unlinkSync(localPath);

  return bunnyUrls(guid);
}

function destroyOnBunny(guid){
  if (!guid) return Promise.resolve();
  return fetch(`https://video.bunnycdn.com/library/${BUNNY_LIBRARY_ID}/videos/${guid}`, {
    method: 'DELETE',
    headers: { 'AccessKey': BUNNY_API_KEY }
  }).catch(e => console.error('Bunny устгах алдаа:', e.message));
}

const app = express();
const PORT = process.env.PORT || 3000;

// ---------- Database ----------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      phone TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS videos (
      id BIGINT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL,
      description TEXT DEFAULT '',
      badge TEXT DEFAULT '',
      filename TEXT NOT NULL,
      url TEXT NOT NULL,
      thumbnail_url TEXT,
      subtitle_url TEXT,
      subtitle_lang TEXT,
      video_public_id TEXT,
      thumbnail_public_id TEXT,
      subtitle_public_id TEXT,
      size BIGINT,
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS subscribers (
      user_id TEXT PRIMARY KEY,
      expires_at TIMESTAMPTZ NOT NULL,
      last_paid_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS payments (
      invoice_no TEXT PRIMARY KEY,
      invoice_id TEXT,
      amount NUMERIC,
      description TEXT,
      user_id TEXT,
      plan_id TEXT,
      days INTEGER,
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS manual_requests (
      id BIGINT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount NUMERIC,
      plan_id TEXT,
      days INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      approved_at TIMESTAMPTZ
    );
  `);
  // Backfill columns for pre-existing tables from before multi-tier plans were added.
  await pool.query(`
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS plan_id TEXT;
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS days INTEGER;
    ALTER TABLE manual_requests ADD COLUMN IF NOT EXISTS plan_id TEXT;
    ALTER TABLE manual_requests ADD COLUMN IF NOT EXISTS days INTEGER;
    ALTER TABLE videos ADD COLUMN IF NOT EXISTS video_public_id TEXT;
    ALTER TABLE videos ADD COLUMN IF NOT EXISTS thumbnail_public_id TEXT;
    ALTER TABLE videos ADD COLUMN IF NOT EXISTS subtitle_public_id TEXT;
    ALTER TABLE videos ADD COLUMN IF NOT EXISTS bunny_video_id TEXT;
    ALTER TABLE videos ADD COLUMN IF NOT EXISTS video_provider TEXT DEFAULT 'cloudinary';
  `);
  console.log('DB ready.');
}

function videoRowToJson(r) {
  return {
    id: Number(r.id),
    title: r.title,
    category: r.category,
    description: r.description || '',
    badge: r.badge || '',
    filename: r.filename,
    url: r.url,
    thumbnailUrl: r.thumbnail_url,
    subtitleUrl: r.subtitle_url,
    subtitleLang: r.subtitle_lang,
    size: r.size !== null ? Number(r.size) : null,
    uploadedAt: r.uploaded_at
  };
}

// ---------- Admin phone numbers ----------
// Set ADMIN_PHONES as a comma-separated list of phone numbers in Render's
// environment variables, e.g. ADMIN_PHONES=99112233,88001122
const ADMIN_PHONES = new Set(
  String(process.env.ADMIN_PHONES || '')
    .split(',')
    .map(p => p.replace(/\D/g, ''))
    .filter(Boolean)
);
function isAdminPhone(phone) {
  return ADMIN_PHONES.has(String(phone || '').replace(/\D/g, ''));
}

// Scratch space only — multer writes here temporarily during an upload
// request, we push the file to Cloudinary, then delete the local copy.
// It's fine that this directory is wiped on redeploy; nothing here is
// meant to survive past the request that created it.
const UPLOAD_DIR = path.join(os.tmpdir(), 'nextkino-uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const BANK_TRANSFER_INFO = {
  bank: 'Хаан Банк',
  account: '5561217601',
  holder: 'Б. Уранцэцэг'
};

const SUBSCRIPTION_PLANS = {
  '1m': { label: '1 сар', price: 12900, days: 30 },
  '3m': { label: '3 сар', price: 32900, days: 90 },
  '1y': { label: '1 жил', price: 89900, days: 365 }
};
const DEFAULT_PLAN_ID = '1m';
function resolvePlan(planId) {
  return SUBSCRIPTION_PLANS[planId] ? { id: planId, ...SUBSCRIPTION_PLANS[planId] } : { id: DEFAULT_PLAN_ID, ...SUBSCRIPTION_PLANS[DEFAULT_PLAN_ID] };
}

// ---------- Admin token (protects destructive/admin-only endpoints) ----------
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) {
    console.error('ADMIN_TOKEN is not set — refusing admin action.');
    return res.status(503).json({ error: 'Admin тохиргоо дутуу байна.' });
  }
  const supplied = req.get('x-admin-token') || req.query.adminToken;
  if (supplied !== ADMIN_TOKEN) {
    return res.status(401).json({ error: 'Admin эрх шаардлагатай.' });
  }
  next();
}

// ---------- CORS: only allow the site's own origin(s) to call the API ----------
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || 'https://tosoolol-backend.onrender.com')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    // Same-origin page loads and server-to-server/curl calls send no Origin header — allow those.
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  }
}));

// ---------- Rate limiting ----------
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Хэт олон хүсэлт. 15 минутын дараа дахин оролдоно уу.' }
});
const manualRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Хэт олон хүсэлт илгээсэн байна. Дараа дахин оролдоно уу.' }
});
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Хэт олон хүсэлт. Түр хүлээгээд дахин оролдоно уу.' }
});

app.use('/api/', apiLimiter);
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Storage config ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, unique + path.extname(file.originalname));
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 3 * 1024 * 1024 * 1024 }, // 3GB max per file
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'subtitle') {
      const ext = path.extname(file.originalname).toLowerCase();
      if (ext === '.srt' || ext === '.vtt') return cb(null, true);
      return cb(new Error('Хадмал файл .srt эсвэл .vtt байх ёстой.'));
    }
    if (file.fieldname === 'thumbnail') {
      const allowedImg = ['image/jpeg', 'image/png', 'image/webp'];
      if (allowedImg.includes(file.mimetype)) return cb(null, true);
      return cb(new Error('Thumbnail зураг jpg, png эсвэл webp байх ёстой.'));
    }
    const allowed = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Дэмжигдэхгүй файл төрөл. mp4, webm, mov, mkv л зөвшөөрнө.'));
  }
});

// ---------- Cloudinary upload/delete helpers ----------
// Uploads a local (temp) file to Cloudinary and deletes the local copy
// afterwards either way, so scratch space never accumulates.
function uploadToCloudinary(localPath, options) {
  return cloudinary.uploader.upload(localPath, options)
    .finally(() => {
      if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
    });
}

function destroyOnCloudinary(publicId, resourceType) {
  if (!publicId) return Promise.resolve();
  return cloudinary.uploader.destroy(publicId, { resource_type: resourceType }).catch(e => {
    console.error('Cloudinary устгах алдаа:', e.message);
  });
}

async function activateSubscription(userId, days) {
  const now = new Date();
  const { rows } = await pool.query('SELECT expires_at FROM subscribers WHERE user_id = $1', [userId]);
  const current = rows[0] && new Date(rows[0].expires_at) > now ? new Date(rows[0].expires_at) : now;
  current.setDate(current.getDate() + (days || SUBSCRIPTION_PLANS[DEFAULT_PLAN_ID].days));
  await pool.query(
    `INSERT INTO subscribers (user_id, expires_at, last_paid_at) VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET expires_at = $2, last_paid_at = $3`,
    [userId, current.toISOString(), now.toISOString()]
  );
}

// ---------- QPay integration ----------
let qpayTokenCache = { token: null, expiresAt: 0 };

async function getQpayToken() {
  if (qpayTokenCache.token && Date.now() < qpayTokenCache.expiresAt) {
    return qpayTokenCache.token;
  }
  const basicAuth = Buffer.from(`${process.env.QPAY_CLIENT_ID}:${process.env.QPAY_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(process.env.QPAY_AUTH_URL, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basicAuth}`, 'Content-Type': 'application/json' }
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error('QPay auth error:', res.status, errText);
    throw new Error('QPay auth failed: ' + res.status + ' ' + errText);
  }
  const data = await res.json();
  qpayTokenCache.token = data.access_token;
  const expiresIn = (data.expires_in || 3600) - 60;
  qpayTokenCache.expiresAt = Date.now() + expiresIn * 1000;
  return qpayTokenCache.token;
}

async function createQpayInvoice({ invoiceNo, amount, description, req }) {
  const token = await getQpayToken();
  const qpayRes = await fetch('https://merchant.qpay.mn/v2/invoice', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      invoice_code: process.env.QPAY_INVOICE_CODE,
      sender_invoice_no: invoiceNo,
      invoice_receiver_code: 'terminal',
      invoice_description: description,
      amount: amount,
      callback_url: `${req.protocol}://${req.get('host')}/api/qpay/callback?invoice_no=${invoiceNo}`
    })
  });
  const data = await qpayRes.json();
  if (!qpayRes.ok) {
    console.error('QPay invoice error:', qpayRes.status, JSON.stringify(data));
    const err = new Error('QPay invoice үүсгэхэд алдаа гарлаа.');
    err.detail = data;
    throw err;
  }
  return data;
}

app.post('/api/qpay/create-invoice', async (req, res) => {
  try {
    const { amount, description, senderInvoiceNo } = req.body;
    if (!amount || !description) return res.status(400).json({ error: 'amount, description шаардлагатай.' });

    const invoiceNo = senderInvoiceNo || ('INV-' + Date.now());
    const data = await createQpayInvoice({ invoiceNo, amount, description, req });

    await pool.query(
      `INSERT INTO payments (invoice_no, invoice_id, amount, description, status)
       VALUES ($1, $2, $3, $4, 'PENDING')`,
      [invoiceNo, data.invoice_id, amount, description]
    );

    res.status(201).json({
      invoice_id: data.invoice_id,
      sender_invoice_no: invoiceNo,
      qr_text: data.qr_text,
      qr_image: data.qr_image,
      urls: data.urls || []
    });
  } catch (err) {
    res.status(400).json({ error: err.message, detail: err.detail });
  }
});

app.post('/api/qpay/callback', async (req, res) => {
  const invoiceNo = req.query.invoice_no;
  if (invoiceNo) {
    const { rows } = await pool.query('SELECT * FROM payments WHERE invoice_no = $1', [invoiceNo]);
    if (rows[0]) {
      await pool.query(
        `UPDATE payments SET status = 'PAID', paid_at = now() WHERE invoice_no = $1`,
        [invoiceNo]
      );
      if (invoiceNo.startsWith('SUB-') && rows[0].user_id) {
        await activateSubscription(rows[0].user_id, rows[0].days);
      }
    }
  }
  res.status(200).json({ ok: true });
});

app.get('/api/qpay/status/:senderInvoiceNo', async (req, res) => {
  const { rows } = await pool.query('SELECT status FROM payments WHERE invoice_no = $1', [req.params.senderInvoiceNo]);
  if (!rows[0]) return res.status(404).json({ error: 'Олдсонгүй.' });
  res.json({ status: rows[0].status });
});

app.post('/api/subscribe/create-invoice', async (req, res) => {
  try {
    const { userId, planId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId шаардлагатай.' });
    const plan = resolvePlan(planId);

    const invoiceNo = `SUB-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const data = await createQpayInvoice({
      invoiceNo,
      amount: plan.price,
      description: `Гишүүнчлэл - ${plan.label}`,
      req
    });

    await pool.query(
      `INSERT INTO payments (invoice_no, invoice_id, amount, description, user_id, plan_id, days, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING')`,
      [invoiceNo, data.invoice_id, plan.price, `Гишүүнчлэл - ${plan.label}`, userId, plan.id, plan.days]
    );

    res.status(201).json({
      invoice_id: data.invoice_id,
      sender_invoice_no: invoiceNo,
      qr_text: data.qr_text,
      qr_image: data.qr_image,
      urls: data.urls || []
    });
  } catch (err) {
    res.status(400).json({ error: err.message, detail: err.detail });
  }
});

app.get('/api/subscribe/status/:userId', async (req, res) => {
  if (isAdminPhone(req.params.userId)) {
    return res.json({ active: true, isAdmin: true, expiresAt: null, plans: SUBSCRIPTION_PLANS });
  }
  const { rows } = await pool.query('SELECT expires_at FROM subscribers WHERE user_id = $1', [req.params.userId]);
  const record = rows[0];
  const active = !!record && new Date(record.expires_at) > new Date();
  res.json({ active, expiresAt: record ? record.expires_at : null, plans: SUBSCRIPTION_PLANS });
});

app.get('/api/subscribe/bank-info', (req, res) => {
  res.json({ ...BANK_TRANSFER_INFO, plans: SUBSCRIPTION_PLANS });
});

app.post('/api/subscribe/manual-request', manualRequestLimiter, async (req, res) => {
  const { userId, planId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId шаардлагатай.' });
  const plan = resolvePlan(planId);
  const id = Date.now();
  await pool.query(
    `INSERT INTO manual_requests (id, user_id, amount, plan_id, days, status) VALUES ($1, $2, $3, $4, $5, 'pending')`,
    [id, userId, plan.price, plan.id, plan.days]
  );
  res.status(201).json({ id, userId, amount: plan.price, planId: plan.id, status: 'pending' });
});

app.get('/api/admin/manual-requests', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM manual_requests ORDER BY created_at ASC');
  res.json(rows.map(r => ({
    id: Number(r.id),
    userId: r.user_id,
    amount: Number(r.amount),
    planId: r.plan_id,
    days: r.days,
    status: r.status,
    createdAt: r.created_at,
    approvedAt: r.approved_at
  })));
});

app.post('/api/admin/manual-requests/:id/approve', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM manual_requests WHERE id = $1', [req.params.id]);
  const record = rows[0];
  if (!record) return res.status(404).json({ error: 'Хүсэлт олдсонгүй.' });
  if (record.status === 'approved') return res.status(400).json({ error: 'Аль хэдийн баталгаажсан.' });
  await pool.query(`UPDATE manual_requests SET status = 'approved', approved_at = now() WHERE id = $1`, [req.params.id]);
  await activateSubscription(record.user_id, record.days);
  res.json({ ok: true });
});

app.post('/api/admin/manual-requests/:id/reject', requireAdmin, async (req, res) => {
  const { rowCount } = await pool.query(`UPDATE manual_requests SET status = 'rejected' WHERE id = $1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Хүсэлт олдсонгүй.' });
  res.json({ ok: true });
});

// ---------- Simple phone-based auth (no SMS verification) ----------
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const { name } = req.body;
  if (phone.length < 8) return res.status(400).json({ error: 'Утасны дугаар буруу байна.' });
  if (!name || !name.trim()) return res.status(400).json({ error: 'Нэрээ оруулна уу.' });

  const existing = await pool.query('SELECT phone FROM users WHERE phone = $1', [phone]);
  if (existing.rows[0]) return res.status(409).json({ error: 'Энэ дугаар аль хэдийн бүртгэлтэй байна. Нэвтэрнэ үү.' });

  const { rows } = await pool.query(
    'INSERT INTO users (phone, name) VALUES ($1, $2) RETURNING phone, name, created_at',
    [phone, name.trim()]
  );
  res.status(201).json({ phone: rows[0].phone, name: rows[0].name, createdAt: rows[0].created_at, isAdmin: isAdminPhone(phone) });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (phone.length < 8) return res.status(400).json({ error: 'Утасны дугаар буруу байна.' });

  const { rows } = await pool.query('SELECT phone, name, created_at FROM users WHERE phone = $1', [phone]);
  if (!rows[0]) return res.status(404).json({ error: 'Энэ дугаар бүртгэлгүй байна. Эхлээд бүртгүүлнэ үү.' });
  res.json({ phone: rows[0].phone, name: rows[0].name, createdAt: rows[0].created_at, isAdmin: isAdminPhone(phone) });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/videos', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM videos ORDER BY uploaded_at ASC');
  res.json(rows.map(videoRowToJson));
});

// ---------- Direct-to-Bunny upload (recommended for large movies) ----------
// Step 1: the browser asks us to create a Bunny video entry and gets back a
// short-lived signed token that lets it push the file straight to Bunny's
// TUS endpoint — our server is never in the data path for the big upload.
app.post('/api/upload/init', requireAdmin, async (req, res) => {
  try {
    const title = (req.body && req.body.title) || 'Untitled';
    const guid = await createBunnyVideo(title);
    const expire = Math.floor(Date.now() / 1000) + 24 * 3600; // 24h to finish uploading
    const signature = bunnyTusSignature(guid, expire);
    res.json({
      videoId: guid,
      libraryId: BUNNY_LIBRARY_ID,
      expire,
      signature,
      tusEndpoint: 'https://video.bunnycdn.com/tusupload'
    });
  } catch (e) {
    console.error('upload/init failed:', e.message);
    res.status(500).json({ error: 'Bunny video эхлүүлэхэд алдаа гарлаа: ' + e.message });
  }
});

// Step 2: once the browser's direct TUS upload to Bunny finishes, it calls
// this to save the video's metadata (title/category/etc.) plus any
// thumbnail/subtitle files, which are small enough to go through us as usual.
app.post('/api/upload/finalize', requireAdmin, upload.fields([{ name: 'subtitle', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), async (req, res) => {
  const subtitleFile = req.files && req.files.subtitle && req.files.subtitle[0];
  const thumbnailFile = req.files && req.files.thumbnail && req.files.thumbnail[0];
  const { title, category, description, badge, subtitleLang, bunnyVideoId, size } = req.body;

  if (!title || !category || !bunnyVideoId) {
    if (subtitleFile && fs.existsSync(subtitleFile.path)) fs.unlinkSync(subtitleFile.path);
    if (thumbnailFile && fs.existsSync(thumbnailFile.path)) fs.unlinkSync(thumbnailFile.path);
    return res.status(400).json({ error: 'title, category, bunnyVideoId заавал шаардлагатай.' });
  }

  try {
    const bunny = bunnyUrls(bunnyVideoId);

    let subtitleUrl = null;
    let subtitlePublicId = null;
    if (subtitleFile) {
      const ext = path.extname(subtitleFile.originalname).toLowerCase();
      let vttPath = subtitleFile.path;
      if (ext !== '.vtt') {
        const srtContent = fs.readFileSync(subtitleFile.path, 'utf-8');
        const vttContent = 'WEBVTT\n\n' + srtContent
          .replace(/\r\n/g, '\n')
          .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
          .replace(/^(\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3})\s*$/gm, '$1 line:75%');
        vttPath = subtitleFile.path + '.vtt';
        fs.writeFileSync(vttPath, vttContent, 'utf-8');
        fs.unlinkSync(subtitleFile.path);
      }
      const subUpload = await uploadToCloudinary(vttPath, { resource_type: 'raw', folder: 'nextkino/subtitles', format: 'vtt' });
      subtitleUrl = subUpload.secure_url;
      subtitlePublicId = subUpload.public_id;
    }

    let thumbnailUrl = bunny.thumbnailUrl;
    let thumbnailPublicId = null;
    if (thumbnailFile) {
      const thumbUpload = await uploadToCloudinary(thumbnailFile.path, { resource_type: 'image', folder: 'nextkino/thumbnails' });
      thumbnailUrl = thumbUpload.secure_url;
      thumbnailPublicId = thumbUpload.public_id;
    }

    const id = Date.now();
    const { rows } = await pool.query(
      `INSERT INTO videos (id, title, category, description, badge, filename, url, thumbnail_url, subtitle_url, subtitle_lang, size, thumbnail_public_id, subtitle_public_id, bunny_video_id, video_provider)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        id, title, category, description || '', badge || '',
        title, bunny.playbackUrl,
        thumbnailUrl, subtitleUrl, subtitleUrl ? (subtitleLang || 'mn') : null,
        Number(size) || 0, thumbnailPublicId, subtitlePublicId, bunnyVideoId, 'bunny'
      ]
    );
    res.status(201).json(videoRowToJson(rows[0]));
  } catch (e) {
    console.error('finalize failed:', e.message);
    res.status(500).json({ error: 'Дуусгахад алдаа гарлаа: ' + e.message });
  }
});

app.post('/api/upload', requireAdmin, upload.fields([{ name: 'video', maxCount: 1 }, { name: 'subtitle', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), async (req, res) => {
  const videoFile = req.files && req.files.video && req.files.video[0];
  const subtitleFile = req.files && req.files.subtitle && req.files.subtitle[0];
  const thumbnailFile = req.files && req.files.thumbnail && req.files.thumbnail[0];

  if (!videoFile) return res.status(400).json({ error: 'Видео файл олдсонгүй.' });

  const { title, category, description, badge, subtitleLang } = req.body;
  if (!title || !category) {
    if (fs.existsSync(videoFile.path)) fs.unlinkSync(videoFile.path);
    if (subtitleFile && fs.existsSync(subtitleFile.path)) fs.unlinkSync(subtitleFile.path);
    if (thumbnailFile && fs.existsSync(thumbnailFile.path)) fs.unlinkSync(thumbnailFile.path);
    return res.status(400).json({ error: 'title болон category заавал шаардлагатай.' });
  }

  try {
    // Video -> Bunny Stream (no per-file size cap, unlike Cloudinary's free plan)
    const bunnyUpload = await uploadVideoToBunny(videoFile.path, title);

    // Subtitle -> convert SRT to WebVTT if needed, then upload as a raw asset
    let subtitleUrl = null;
    let subtitlePublicId = null;
    if (subtitleFile) {
      const ext = path.extname(subtitleFile.originalname).toLowerCase();
      let vttPath = subtitleFile.path;
      if (ext !== '.vtt') {
        const srtContent = fs.readFileSync(subtitleFile.path, 'utf-8');
        const vttContent = 'WEBVTT\n\n' + srtContent
          .replace(/\r\n/g, '\n')
          .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
          .replace(/^(\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3})\s*$/gm, '$1 line:75%');
        vttPath = subtitleFile.path + '.vtt';
        fs.writeFileSync(vttPath, vttContent, 'utf-8');
        fs.unlinkSync(subtitleFile.path);
      }
      const subUpload = await uploadToCloudinary(vttPath, {
        resource_type: 'raw',
        folder: 'nextkino/subtitles',
        format: 'vtt'
      });
      subtitleUrl = subUpload.secure_url;
      subtitlePublicId = subUpload.public_id;
    }

    // Thumbnail -> use the uploaded image if given, otherwise Bunny's own
    // auto-generated frame (ready a little after encoding finishes).
    let thumbnailUrl;
    let thumbnailPublicId = null;
    if (thumbnailFile) {
      const thumbUpload = await uploadToCloudinary(thumbnailFile.path, {
        resource_type: 'image',
        folder: 'nextkino/thumbnails'
      });
      thumbnailUrl = thumbUpload.secure_url;
      thumbnailPublicId = thumbUpload.public_id;
    } else {
      thumbnailUrl = bunnyUpload.thumbnailUrl;
    }

    const id = Date.now();
    const { rows } = await pool.query(
      `INSERT INTO videos (id, title, category, description, badge, filename, url, thumbnail_url, subtitle_url, subtitle_lang, size, thumbnail_public_id, subtitle_public_id, bunny_video_id, video_provider)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        id, title, category, description || '', badge || '',
        videoFile.originalname, bunnyUpload.playbackUrl,
        thumbnailUrl, subtitleUrl, subtitleUrl ? (subtitleLang || 'mn') : null,
        videoFile.size, thumbnailPublicId, subtitlePublicId, bunnyUpload.guid, 'bunny'
      ]
    );
    res.status(201).json(videoRowToJson(rows[0]));
  } catch (e) {
    console.error('Upload failed:', e.message);
    res.status(500).json({ error: 'Видео байршуулахад алдаа гарлаа: ' + e.message });
  }
});

app.post('/api/videos/:id/thumbnail', requireAdmin, upload.single('thumbnail'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Thumbnail зураг олдсонгүй.' });

  const { rows } = await pool.query('SELECT * FROM videos WHERE id = $1', [req.params.id]);
  const video = rows[0];
  if (!video) {
    if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    return res.status(404).json({ error: 'Видео олдсонгүй.' });
  }

  try {
    const thumbUpload = await uploadToCloudinary(file.path, {
      resource_type: 'image',
      folder: 'nextkino/thumbnails'
    });
    // Only remove the old Cloudinary thumbnail if it was a real uploaded
    // image (not an auto-generated video-frame URL, which has no owned id).
    if (video.thumbnail_public_id) {
      await destroyOnCloudinary(video.thumbnail_public_id, 'image');
    }
    const { rows: updated } = await pool.query(
      'UPDATE videos SET thumbnail_url = $1, thumbnail_public_id = $2 WHERE id = $3 RETURNING *',
      [thumbUpload.secure_url, thumbUpload.public_id, req.params.id]
    );
    res.json(videoRowToJson(updated[0]));
  } catch (e) {
    console.error('Thumbnail upload failed:', e.message);
    res.status(500).json({ error: 'Thumbnail байршуулахад алдаа гарлаа: ' + e.message });
  }
});

app.delete('/api/videos/:id', requireAdmin, async (req, res) => {
  const { rows } = await pool.query('DELETE FROM videos WHERE id = $1 RETURNING *', [req.params.id]);
  const removed = rows[0];
  if (!removed) return res.status(404).json({ error: 'Видео олдсонгүй.' });
  if (removed.video_provider === 'bunny') {
    await destroyOnBunny(removed.bunny_video_id);
  } else if (removed.video_public_id) {
    await destroyOnCloudinary(removed.video_public_id, 'video');
  }
  if (removed.thumbnail_public_id) await destroyOnCloudinary(removed.thumbnail_public_id, 'image');
  if (removed.subtitle_public_id) await destroyOnCloudinary(removed.subtitle_public_id, 'raw');
  res.json({ ok: true });
});

// ---------- Error handling ----------
app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || 'Алдаа гарлаа.' });
});

initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Tosoolol backend listening on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
  });
