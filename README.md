# Tosoolol Backend

Видео upload хийх энгийн Express backend.

## Локал ажиллуулах

```
npm install
npm start
```

Дараа нь `http://localhost:3000/admin.html` руу орж туршина.

## API

- `GET /api/health` — сервер ажиллаж байгаа эсэхийг шалгах
- `GET /api/videos` — байршуулсан видеонуудын жагсаалт
- `POST /api/upload` — видео upload хийх (multipart/form-data: video, title, category, description, badge)
- `DELETE /api/videos/:id` — видео устгах

## Анхаарах зүйл

Render-ийн free tier дээр диск нь **түр зуурын (ephemeral)** — сервер дахин deploy хийгдэх бүрт uploads хавтас цэвэрлэгдэнэ. Жинхэнэ production-д S3 эсвэл Cloudflare R2 гэх мэт тогтмол cloud storage ашиглах шаардлагатай.
