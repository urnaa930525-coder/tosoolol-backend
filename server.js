const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_FILE = path.join(__dirname, 'videos.json');

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]');

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
