const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { Pool } = require('pg');

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
      status TEXT NOT NULL DEFAULT 'PENDING',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      paid_at TIMESTAMPTZ
    );
    CREATE TABLE IF NOT EXISTS manual_requests (
      id BIGINT PRIMARY KEY,
      user_id TEXT NOT NULL,
      amount NUMERIC,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      approved_at TIMESTAMPTZ
    );
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

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const BANK_TRANSFER_INFO = {
  bank: 'Хаан Банк',
  account: '5561217601',
  holder: 'Б. Уранцэцэг'
};

const SUBSCRIPTION_PRICE = 6900;
const SUBSCRIPTION_DAYS = 30;

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(UPLOAD_DIR));
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
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max per file
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

// ---------- Thumbnail generation ----------
function generateThumbnail(videoPath, thumbPath) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, [
      '-y',
      '-ss', '1',
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', 'scale=480:-2',
      thumbPath
    ], (err) => {
      if (err) reject(err); else resolve();
    });
  });
}

async function activateSubscription(userId) {
  const now = new Date();
  const { rows } = await pool.query('SELECT expires_at FROM subscribers WHERE user_id = $1', [userId]);
  const current = rows[0] && new Date(rows[0].expires_at) > now ? new Date(rows[0].expires_at) : now;
  current.setDate(current.getDate() + SUBSCRIPTION_DAYS);
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
        await activateSubscription(rows[0].user_id);
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
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId шаардлагатай.' });

    const invoiceNo = `SUB-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const data = await createQpayInvoice({
      invoiceNo,
      amount: SUBSCRIPTION_PRICE,
      description: 'Гишүүнчлэл - 1 сар',
      req
    });

    await pool.query(
      `INSERT INTO payments (invoice_no, invoice_id, amount, description, user_id, status)
       VALUES ($1, $2, $3, $4, $5, 'PENDING')`,
      [invoiceNo, data.invoice_id, SUBSCRIPTION_PRICE, 'Гишүүнчлэл - 1 сар', userId]
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
    return res.json({ active: true, isAdmin: true, expiresAt: null, price: SUBSCRIPTION_PRICE });
  }
  const { rows } = await pool.query('SELECT expires_at FROM subscribers WHERE user_id = $1', [req.params.userId]);
  const record = rows[0];
  const active = !!record && new Date(record.expires_at) > new Date();
  res.json({ active, expiresAt: record ? record.expires_at : null, price: SUBSCRIPTION_PRICE });
});

app.get('/api/subscribe/bank-info', (req, res) => {
  res.json({ ...BANK_TRANSFER_INFO, price: SUBSCRIPTION_PRICE });
});

app.post('/api/subscribe/manual-request', async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId шаардлагатай.' });
  const id = Date.now();
  await pool.query(
    `INSERT INTO manual_requests (id, user_id, amount, status) VALUES ($1, $2, $3, 'pending')`,
    [id, userId, SUBSCRIPTION_PRICE]
  );
  res.status(201).json({ id, userId, amount: SUBSCRIPTION_PRICE, status: 'pending' });
});

app.get('/api/admin/manual-requests', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM manual_requests ORDER BY created_at ASC');
  res.json(rows.map(r => ({
    id: Number(r.id),
    userId: r.user_id,
    amount: Number(r.amount),
    status: r.status,
    createdAt: r.created_at,
    approvedAt: r.approved_at
  })));
});

app.post('/api/admin/manual-requests/:id/approve', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM manual_requests WHERE id = $1', [req.params.id]);
  const record = rows[0];
  if (!record) return res.status(404).json({ error: 'Хүсэлт олдсонгүй.' });
  if (record.status === 'approved') return res.status(400).json({ error: 'Аль хэдийн баталгаажсан.' });
  await pool.query(`UPDATE manual_requests SET status = 'approved', approved_at = now() WHERE id = $1`, [req.params.id]);
  await activateSubscription(record.user_id);
  res.json({ ok: true });
});

app.post('/api/admin/manual-requests/:id/reject', async (req, res) => {
  const { rowCount } = await pool.query(`UPDATE manual_requests SET status = 'rejected' WHERE id = $1`, [req.params.id]);
  if (!rowCount) return res.status(404).json({ error: 'Хүсэлт олдсонгүй.' });
  res.json({ ok: true });
});

// ---------- Simple phone-based auth (no SMS verification) ----------
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

app.post('/api/auth/register', async (req, res) => {
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

app.post('/api/auth/login', async (req, res) => {
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

app.post('/api/upload', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'subtitle', maxCount: 1 }, { name: 'thumbnail', maxCount: 1 }]), async (req, res) => {
  const videoFile = req.files && req.files.video && req.files.video[0];
  const subtitleFile = req.files && req.files.subtitle && req.files.subtitle[0];
  const thumbnailFile = req.files && req.files.thumbnail && req.files.thumbnail[0];

  if (!videoFile) return res.status(400).json({ error: 'Видео файл олдсонгүй.' });

  const { title, category, description, badge, subtitleLang } = req.body;
  if (!title || !category) {
    fs.unlinkSync(videoFile.path);
    if (subtitleFile) fs.unlinkSync(subtitleFile.path);
    return res.status(400).json({ error: 'title болон category заавал шаардлагатай.' });
  }

  let subtitleUrl = null;
  if (subtitleFile) {
    const ext = path.extname(subtitleFile.originalname).toLowerCase();
    const vttFilename = subtitleFile.filename.replace(/\.[^.]+$/, '') + '.vtt';
    const vttPath = path.join(UPLOAD_DIR, vttFilename);
    if (ext === '.vtt') {
      fs.renameSync(subtitleFile.path, vttPath);
    } else {
      // Convert SRT -> WebVTT: comma decimals -> dot, add WEBVTT header, position cues higher
      const srtContent = fs.readFileSync(subtitleFile.path, 'utf-8');
      const vttContent = 'WEBVTT\n\n' + srtContent
        .replace(/\r\n/g, '\n')
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
        .replace(/^(\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3})\s*$/gm, '$1 line:75%');
      fs.writeFileSync(vttPath, vttContent, 'utf-8');
      fs.unlinkSync(subtitleFile.path);
    }
    subtitleUrl = `/uploads/${vttFilename}`;
  }

  let thumbnailUrl = null;
  if (thumbnailFile) {
    thumbnailUrl = `/uploads/${thumbnailFile.filename}`;
  } else {
    try {
      const thumbFilename = videoFile.filename.replace(/\.[^.]+$/, '') + '.jpg';
      const thumbPath = path.join(UPLOAD_DIR, thumbFilename);
      await generateThumbnail(videoFile.path, thumbPath);
      thumbnailUrl = `/uploads/${thumbFilename}`;
    } catch (e) {
      console.error('Thumbnail generation failed:', e.message);
    }
  }

  const id = Date.now();
  const { rows } = await pool.query(
    `INSERT INTO videos (id, title, category, description, badge, filename, url, thumbnail_url, subtitle_url, subtitle_lang, size)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [
      id, title, category, description || '', badge || '',
      videoFile.filename, `/uploads/${videoFile.filename}`,
      thumbnailUrl, subtitleUrl, subtitleUrl ? (subtitleLang || 'mn') : null,
      videoFile.size
    ]
  );
  res.status(201).json(videoRowToJson(rows[0]));
});

app.post('/api/videos/:id/thumbnail', upload.single('thumbnail'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Thumbnail зураг олдсонгүй.' });

  const { rows } = await pool.query('SELECT * FROM videos WHERE id = $1', [req.params.id]);
  const video = rows[0];
  if (!video) {
    fs.unlinkSync(file.path);
    return res.status(404).json({ error: 'Видео олдсонгүй.' });
  }

  if (video.thumbnail_url) {
    const oldPath = path.join(UPLOAD_DIR, path.basename(video.thumbnail_url));
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  }
  const thumbnailUrl = `/uploads/${file.filename}`;
  const { rows: updated } = await pool.query(
    'UPDATE videos SET thumbnail_url = $1 WHERE id = $2 RETURNING *',
    [thumbnailUrl, req.params.id]
  );
  res.json(videoRowToJson(updated[0]));
});

app.delete('/api/videos/:id', async (req, res) => {
  const { rows } = await pool.query('DELETE FROM videos WHERE id = $1 RETURNING *', [req.params.id]);
  const removed = rows[0];
  if (!removed) return res.status(404).json({ error: 'Видео олдсонгүй.' });
  const filePath = path.join(UPLOAD_DIR, removed.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  if (removed.subtitle_url) {
    const subPath = path.join(UPLOAD_DIR, path.basename(removed.subtitle_url));
    if (fs.existsSync(subPath)) fs.unlinkSync(subPath);
  }
  if (removed.thumbnail_url) {
    const thumbPath = path.join(UPLOAD_DIR, path.basename(removed.thumbnail_url));
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
  }
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
