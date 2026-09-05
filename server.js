const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_FILE = path.join(__dirname, 'videos.json');
const PAYMENTS_FILE = path.join(__dirname, 'payments.json');
const SUBSCRIBERS_FILE = path.join(__dirname, 'subscribers.json');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');
if (!fs.existsSync(PAYMENTS_FILE)) fs.writeFileSync(PAYMENTS_FILE, '{}');
if (!fs.existsSync(SUBSCRIBERS_FILE)) fs.writeFileSync(SUBSCRIBERS_FILE, '{}');

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
    const allowed = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Дэмжигдэхгүй файл төрөл. mp4, webm, mov, mkv л зөвшөөрнө.'));
  }
});

function readVideos() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8')); } catch (e) { return []; }
}
function writeVideos(list) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(list, null, 2));
}

function readPayments() {
  try { return JSON.parse(fs.readFileSync(PAYMENTS_FILE, 'utf-8')); } catch (e) { return {}; }
}
function writePayments(obj) {
  fs.writeFileSync(PAYMENTS_FILE, JSON.stringify(obj, null, 2));
}

function readSubscribers() {
  try { return JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf-8')); } catch (e) { return {}; }
}
function writeSubscribers(obj) {
  fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(obj, null, 2));
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
  if (!res.ok) throw new Error('QPay auth failed: ' + res.status);
  const data = await res.json();
  qpayTokenCache.token = data.access_token;
  // refresh a bit before actual expiry
  const expiresIn = (data.expires_in || 3600) - 60;
  qpayTokenCache.expiresAt = Date.now() + expiresIn * 1000;
  return qpayTokenCache.token;
}

app.post('/api/qpay/create-invoice', async (req, res) => {
  try {
    const { amount, description, senderInvoiceNo } = req.body;
    if (!amount || !description) return res.status(400).json({ error: 'amount, description шаардлагатай.' });

    const token = await getQpayToken();
    const invoiceNo = senderInvoiceNo || ('INV-' + Date.now());
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
    if (!qpayRes.ok) return res.status(400).json({ error: 'QPay invoice үүсгэхэд алдаа гарлаа.', detail: data });

    const payments = readPayments();
    payments[invoiceNo] = {
      invoice_id: data.invoice_id,
      sender_invoice_no: invoiceNo,
      amount,
      description,
      status: 'PENDING',
      createdAt: new Date().toISOString()
    };
    writePayments(payments);

    res.status(201).json({
      invoice_id: data.invoice_id,
      sender_invoice_no: invoiceNo,
      qr_text: data.qr_text,
      qr_image: data.qr_image,
      urls: data.urls || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/qpay/callback', (req, res) => {
  const invoiceNo = req.query.invoice_no;
  const payments = readPayments();
  if (invoiceNo && payments[invoiceNo]) {
    payments[invoiceNo].status = 'PAID';
    payments[invoiceNo].paidAt = new Date().toISOString();
    writePayments(payments);

    // If this was a subscription payment, activate/extend membership
    if (invoiceNo.startsWith('SUB-') && payments[invoiceNo].userId) {
      const subscribers = readSubscribers();
      const userId = payments[invoiceNo].userId;
      const now = new Date();
      const current = subscribers[userId] && new Date(subscribers[userId].expiresAt) > now
        ? new Date(subscribers[userId].expiresAt)
        : now;
      current.setDate(current.getDate() + SUBSCRIPTION_DAYS);
      subscribers[userId] = { expiresAt: current.toISOString(), lastPaidAt: now.toISOString() };
      writeSubscribers(subscribers);
    }
  }
  res.status(200).json({ ok: true });
});

app.get('/api/qpay/status/:senderInvoiceNo', (req, res) => {
  const payments = readPayments();
  const record = payments[req.params.senderInvoiceNo];
  if (!record) return res.status(404).json({ error: 'Олдсонгүй.' });
  res.json({ status: record.status });
});

app.post('/api/subscribe/create-invoice', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId шаардлагатай.' });

    const token = await getQpayToken();
    const invoiceNo = `SUB-${userId}-${Date.now()}`;
    const qpayRes = await fetch('https://merchant.qpay.mn/v2/invoice', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoice_code: process.env.QPAY_INVOICE_CODE,
        sender_invoice_no: invoiceNo,
        invoice_receiver_code: 'terminal',
        invoice_description: 'Гишүүнчлэл - 1 сар',
        amount: SUBSCRIPTION_PRICE,
        callback_url: `${req.protocol}://${req.get('host')}/api/qpay/callback?invoice_no=${invoiceNo}`
      })
    });
    const data = await qpayRes.json();
    if (!qpayRes.ok) return res.status(400).json({ error: 'QPay invoice үүсгэхэд алдаа гарлаа.', detail: data });

    const payments = readPayments();
    payments[invoiceNo] = {
      invoice_id: data.invoice_id,
      sender_invoice_no: invoiceNo,
      amount: SUBSCRIPTION_PRICE,
      description: 'Гишүүнчлэл - 1 сар',
      userId,
      status: 'PENDING',
      createdAt: new Date().toISOString()
    };
    writePayments(payments);

    res.status(201).json({
      invoice_id: data.invoice_id,
      sender_invoice_no: invoiceNo,
      qr_text: data.qr_text,
      qr_image: data.qr_image,
      urls: data.urls || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/subscribe/status/:userId', (req, res) => {
  const subscribers = readSubscribers();
  const record = subscribers[req.params.userId];
  const active = !!record && new Date(record.expiresAt) > new Date();
  res.json({ active, expiresAt: record ? record.expiresAt : null, price: SUBSCRIPTION_PRICE });
});

// ---------- Routes ----------
app.get('/api/health', (req, res) => res.json({ ok: true }));

app.get('/api/videos', (req, res) => {
  res.json(readVideos());
});

app.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Видео файл олдсонгүй.' });

  const { title, category, description, badge } = req.body;
  if (!title || !category) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'title болон category заавал шаардлагатай.' });
  }

  const videos = readVideos();
  const newVideo = {
    id: Date.now(),
    title,
    category,
    description: description || '',
    badge: badge || '',
    filename: req.file.filename,
    url: `/uploads/${req.file.filename}`,
    size: req.file.size,
    uploadedAt: new Date().toISOString()
  };
  videos.push(newVideo);
  writeVideos(videos);
  res.status(201).json(newVideo);
});

app.delete('/api/videos/:id', (req, res) => {
  const videos = readVideos();
  const idx = videos.findIndex(v => String(v.id) === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Видео олдсонгүй.' });
  const [removed] = videos.splice(idx, 1);
  const filePath = path.join(UPLOAD_DIR, removed.filename);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  writeVideos(videos);
  res.json({ ok: true });
});

// ---------- Error handling ----------
app.use((err, req, res, next) => {
  res.status(400).json({ error: err.message || 'Алдаа гарлаа.' });
});

app.listen(PORT, () => {
  console.log(`Tosoolol backend listening on port ${PORT}`);
});
