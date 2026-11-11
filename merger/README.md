# خدمة دمج الفيديوهات — Video Merger API v2

خدمة كاملة لدمج عدة مقاطع فيديو في ملف واحد عالي الجودة (MP4 / H.264 + AAC)، مع واجهة عربية RTL وAPI عامة للمطورين، جاهزة للنشر على **Vercel**. تخزين كامل في **Turso (libSQL)** — بلا S3 وبلا خدمات خارجية.

## المزايا

- توحيد تلقائي لكل المصادر: scale + pad إلى أكبر دقة بين المدخلات (حد أقصى 1920×1080)، fps=30، yuv420p.
- مصدر بلا صوت؟ يُضاف مسار صامت تلقائيًا بدل أن يفشل الدمج.
- ترميز نهائي عالي الجودة: libx264 **CRF 18** + AAC 192k/44.1kHz + `+faststart`.
- تقدم حقيقي 0–100 (0–40 سحب المصادر، 40–90 الترميز من `ffmpeg -progress`، 90–100 التخزين) يُكتب في القاعدة فورًا ويُستطلع بالتوازي.
- بث الناتج بدعم **Range** (206 + Content-Range) — التقديم/الترجيع يعمل في المشغل.
- رفع ملفات من الجهاز بأجزاء 4MB ثنائية مع إعادة محاولة، وتخزين كل شيء كـ Blobs في Turso بصفوف 2MB.
- حذف تلقائي بعد **24 ساعة** (تنظيف كسول عند كل عملية + Cron يومي).

## بنية المجلدات

```
merger/
├── api/                 دوال Vercel Serverless (Node.js خالص CommonJS)
│   ├── jobs.js          POST /api/jobs
│   ├── upload.js        POST /api/upload?job=&seq=&chunk=
│   ├── cron.js          GET  /api/cron
│   ├── config.js        GET  /api/config
│   └── jobs/[id].js + jobs/[id]/process.js + jobs/[id]/video.js
├── lib/                 المنطق: db.js التخزين، merge.js محرك ffmpeg، storage.js Blobs، util.js
├── public/index.html    الواجهة العربية RTL (ملف واحد)
├── scripts/             اختبارات: test-unit.js + test-http.js
├── dev-server.js        خادم تطوير محلي يحاكي Vercel
├── vercel.json          maxDuration 300 + Cron يومي
└── .env.example         نموذج المتغيرات (بلا قيم حقيقية)
```

## الخطوة 1: إنشاء قاعدة Turso مجانية

```bash
# ثبّت CLI ثم سجّل دخولك
turso auth signup        # أو: turso auth login

# أنشئ قاعدة مجانية
turso db create mymerger

# احصل على الرابط (القيمة لـ TURSO_DATABASE_URL)
turso db show mymerger --url
# مثال: libsql://mymerger-<org>.turso.io

# أنشئ توكنًا بصلاحيات كتابة (القيمة لـ TURSO_AUTH_TOKEN)
turso db tokens create mymerger
```

> ملاحظة: الكود يحوّل `libsql://` إلى `https://` تلقائيًا — الاتصال عبر HTTP البحت متوافق مع serverless.

## الخطوة 2: التشغيل محليًا

```bash
cd merger
npm install
cp .env.example .env.local     # ثم ضع قيم Turso الحقيقية
npm run dev                    # يعمل على http://localhost:3001
npm test                       # الاختبارات الكاملة (وحدات + HTTP)
```

## الخطوة 3: النشر على Vercel خطوة بخطوة

1. ارفع المشروع إلى مستودع GitHub (مجلد `merger/` جزء من المستودع الرئيسي).
2. من لوحة Vercel: **Add New → Project** واختر المستودع.
3. في إعدادات البناء: **Root Directory = `merger`** (مهم جدًا لأن المستودع يحتوي أيضًا تطبيق Next.js في الجذر).
4. **Environment Variables** أضف:
   | المتغير | القيمة |
   |---|---|
   | `TURSO_DATABASE_URL` | `libsql://...turso.io` من الخطوة 1 |
   | `TURSO_AUTH_TOKEN` | التوكن من الخطوة 1 |
5. **Deploy**. بعد النشر اختبر: `curl https://<نطاقك>.vercel.app/api/config`
6. انسخ النطاق وضعه في تطبيق MCP الرئيسي كمتغير `MERGER_API_BASE`.

## توثيق API الكامل (بلا تسجيل دخول، CORS مفتوح، الأخطاء `{"error":"..."}`)

### `POST /api/jobs` — إنشاء مهمة

```bash
curl -X POST https://<domain>/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"videos":["https://example.com/clip1.mp4","https://example.com/clip2.mp4"]}'
```

أو بمصادر ملفات تُرفع لاحقًا:

```bash
curl -X POST https://<domain>/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"sources":[
        {"kind":"url","url":"https://example.com/clip1.mp4"},
        {"kind":"file","name":"clip2.mp4","size":10485760,"mime":"video/mp4"}]}'
```

استجابة `201`:

```json
{
  "jobId": "c194de6a-...",
  "status": "queued",
  "statusUrl": "https://<domain>/api/jobs/c194de6a-...",
  "processUrl": "https://<domain>/api/jobs/c194de6a-.../process",
  "expiresAt": "2026-11-12 18:00:00",
  "uploads": [ { "seq": 1, "name": "clip2.mp4", "size": 10485760, "totalChunks": 3,
                 "uploadUrl": "https://<domain>/api/upload?job=c194de6a-&seq=1&chunk=<CHUNK_INDEX>" } ],
  "uploadChunkBytes": 4194304
}
```

> `uploadUrl` قالب — استبدل `<CHUNK_INDEX>` برقم الجزء (0,1,2,...) وأرسل البيانات الثنائية الخام.

### `POST /api/upload?job=<id>&seq=<n>&chunk=<k>` — رفع أجزاء

```bash
curl -X POST "https://<domain>/api/upload?job=<JOB_ID>&seq=1&chunk=0" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @chunk0.bin
```

استجابة: `{"ok":true,"received":1,"total":3,"done":false}` — عند اكتمال كل المصادر تتحول المهمة إلى `queued`.

### `POST /api/jobs/<id>/process` — تنفيذ الدمج (متزامن، ~10–30 ثانية للمقاطع القصيرة)

```bash
curl -X POST https://<domain>/api/jobs/<JOB_ID>/process
```

استجابة `200`:

```json
{
  "status": "done",
  "videoUrl": "https://<domain>/api/jobs/<JOB_ID>/video",
  "downloadUrl": "https://<domain>/api/jobs/<JOB_ID>/video?download=1",
  "size": 2145804,
  "duration": 9.02,
  "resolution": "1280x720",
  "expiresAt": "2026-11-12 18:00:00"
}
```

- قيد المعالجة فعله → `202` مع `{"status":"processing","progress":...}`.
- فشل (مثل مصدر يرفض التحميل) → HTTP 500 + `{"error":"..."}` — فشل حتمي، إعادة المحاولة تعطي النتيجة نفسها.

### `GET /api/jobs/<id>` — الحالة والتقدم

```bash
curl https://<domain>/api/jobs/<JOB_ID>
```

`{"jobId","status":"queued|uploading|processing|done|failed","progress":0-100,"videoUrl","downloadUrl","size","duration","resolution","error","expiresAt"}`

### `GET /api/jobs/<id>/video` — بث الناتج

```bash
curl -H "Range: bytes=0-1023" https://<domain>/api/jobs/<JOB_ID>/video -o part.bin   # 206
curl https://<domain>/api/jobs/<JOB_ID>/video?download=1 -o merged.mp4               # تحميل
```

يدعم Range كاملًا (206 + Content-Range + Accept-Ranges) — التقديم/الترجيع يعمل في `<video>`.

### `DELETE /api/jobs/<id>` — حذف فوري شامل

```bash
curl -X DELETE https://<domain>/api/jobs/<JOB_ID>   # {"ok":true}
```

### `GET /api/config` — الحدود والإصدار

`{"version":"2.0.0","maxSources":10,"sourceMaxMB":200,"outputMaxMB":150,"maxTotalDurationSec":600,"uploadChunkBytes":4194304}`

### `GET /api/cron` — التنظيف اليومي (مجدول تلقائيًا في vercel.json)

`{"deleted":3}`

## متغيرات البيئة

| المتغير | إلزامي | الافتراضي | الوصف |
|---|---|---|---|
| `TURSO_DATABASE_URL` | نعم | — | رابط قاعدة Turso |
| `TURSO_AUTH_TOKEN` | نعم | — | توكن كتابة |
| `MERGER_PORT` | لا | `3001` | منفذ dev-server المحلي |
| `MAX_SOURCES` | لا | `10` | أقصى عدد مقاطع |
| `SOURCE_MAX_MB` | لا | `200` | أقصى حجم لكل مصدر |
| `OUTPUT_MAX_MB` | لا | `150` | أقصى حجم للناتج |
| `MAX_TOTAL_DURATION_SEC` | لا | `600` | أقصى مدة إجمالية |
| `UPLOAD_CHUNK_BYTES` | لا | `4194304` | حجم جزء الرفع (مضاعف 2MB) |
| `FFMPEG_PRESET` | لا | `medium` | preset الترميز |
| `FFMPEG_PATH` / `FFPROBE_PATH` | لا | تلقائي | مسار الثنائيات يدويًا |

سلسلة إيجاد ffmpeg: متغير البيئة ← `ffmpeg-static` ← PATH النظامي. وعند فقد صلاحية التنفيذ في الاستضافة يُنسخ الثنائي إلى `/tmp` بصلاحية 755 (`ensureExecutable`).

## الحدود والقيود

- **10 مصادر** كحد أقصى، **200MB** لكل مصدر، **150MB** للناتج، **600 ثانية** مدة إجمالية.
- كل الملفات (مصادر مرفوعة + ناتج) **تُحذف تلقائيًا بعد 24 ساعة**.
- حدود الخطة المجانية الواجب معرفتها:
  - **Vercel Hobby**: أقصى مدة دالة 60 ثانية — الدمج الطويل قد يُقطع؛ `maxDuration: 300` يتطلب **Pro**. على Hobby استخدم مقاطعًا قصيرة أو خفّض الحدود.
  - **حجم الطلب**: ~4.5MB — لهذا يُرفع بالأجزاء 4MB (مطبَّق في الواجهة والـ API).
  - **Turso المجاني**: ~9GB تخزين و500M صفوف مقروءة شهريًا — التنظيف التلقائي بعد 24 ساعة يبقي الاستهلاك منخفضًا.

## الاختبارات

```bash
npm test          # 46 اختبارًا: 15 وحدة + 31 HTTP
```

- **وحدات**: توليد مصدرين مختلفي الدقة (أحدهما بلا صوت) → دمج مباشر → التحقق من الدقة/المدة/الصوت/الترميز/التقدم → تخزين Turso 5MB بتطابق sha256 → قراءة Range جزئي → حذف شامل.
- **HTTP**: إنشاء من روابط → دمج → بث Range 206 → مهمة مختلطة (رابط + ملف مرفوع مع إعادة محاولة) → الرفضات (400/404/405/409/413) → DELETE → 404 → تنظيف كامل.
