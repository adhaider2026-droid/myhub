# MCP Media Generator — خادم MCP لتوليد الصور والفيديو ودمج المقاطع

خادم MCP كامل يجمع ثلاث قدرات في أداة واحدة، مع لوحة إدارة عربية RTL:

1. **توليد صور** من وصف نصي — `gpt-image-2-6/flare-text-to-image` (kie.ai + CometAPI).
2. **توليد فيديو** بصوت متزامن أصلي — `grok-imagine-video-1-5-preview` (kie.ai + CometAPI).
3. **دمج عدة مقاطع** في فيديو واحد — عبر خدمة الدمج المرفقة في [`merger/`](./merger).

- خادم MCP على المسار `/mcp` (نقل Streamable HTTP عبر SDK الرسمي، وضع stateless متوافق تمامًا مع Vercel serverless) يعرض **5 أدوات** يستدعيها أي عميل: ChatGPT Connectors / Claude Desktop / Cursor / Windsurf / Cline.
- **لوحة ويب عربية** لإدارة مفاتيح API، ومتابعة المهام حية، وإعدادات الربط جاهزة للنسخ.
- **نظام مفاتيح متسلسل صارم**: أول مفتاح أُضيف يُجرَّب أولًا ثم التالي ثم التالي — مع **تبديل تلقائي فوري** عند أي خطأ أو نفاد رصيد دون توقف المهمة، ونموذج الذكاء الاصطناعي **لا يرى أخطاء المفاتيح أو الرصيد أبدًا**.
- **روابط فقط**: لا يُنزَّل أي ملف وسائط على سيرفرنا — نخزّن روابط النتائج فقط في قاعدة Turso.

## الأدوات الخمس

| الأداة | الوظيفة |
|---|---|
| `generate_image` | توليد صورة (تعيد الرابط جاهزًا أو `task_id` للتابعة عبر `get_task`) |
| `generate_video` | توليد فيديو بصوت متزامن (image-to-video اختياري) |
| `merge_videos` | دمج 2–10 مقاطع بالترتيب عبر `urls` أو `task_ids` لمهام مكتملة |
| `get_task` | تتبع أي مهمة (توليد أو دمج) وتحديثها حية من المزود |
| `list_media` | استرجاع أحدث الوسائط المخزنة بروابطها |

أثناء الانتظار يُبث تقدم حي (Progress notifications كل ~3 ثوانٍ) إذا زوّد العميل الطلب بـ `_meta.progressToken`.

## بنية المشروع

```
├── src/
│   ├── app/
│   │   ├── mcp/route.ts            خادم MCP (WebStandardStreamableHTTPServerTransport — stateless)
│   │   ├── page.tsx                لوحة الإدارة العربية
│   │   └── api/
│   │       ├── health/route.ts     GET  /api/health
│   │       ├── keys/route.ts       GET/POST /api/keys (مفاتيح مقنعة دائمًا)
│   │       ├── keys/[id]/route.ts  PATCH/DELETE /api/keys/{id}
│   │       └── tasks/route.ts      GET /api/tasks (إحصائيات + أحدث المهام)
│   ├── lib/
│   │   ├── turso.ts                طبقة Turso + المخطط + عمليات المهام
│   │   ├── keys.ts                 التجمع التسلسلي + الإخفاء + تعليم المفاتيح
│   │   ├── errors.ts               تصنيف الأخطاء (disabled/exhausted/provider/params/temporary)
│   │   ├── models.ts               سجل MODELS مع aliases وتجاوز بالمتغيرات
│   │   ├── generation.ts           منسّق التوليد + التبديل التسلسلي + runMerge + refreshTask
│   │   ├── merger.ts               عميل خدمة الدمج v2
│   │   ├── providers/              محوّلا kie.ai و CometAPI
│   │   └── mcp/server.ts           تسجيل الأدوات الخمس والصياغة العربية
│   └── components/dashboard/       مكونات اللوحة
└── merger/                         مشروع خدمة دمج الفيديوهات (Vercel منفصل) — [توثيقه الكامل](./merger/README.md)
```

## التشغيل محليًا

```bash
npm install        # أو bun install
cp .env.example .env.local   # ثم ضع القيم الحقيقية
npm run dev        # http://localhost:3000
npm run typecheck  # tsc --noEmit
```

## الخطوة 1: قاعدة Turso المجانية

```bash
turso auth signup
turso db create mysite
turso db show mysite --url        # ← TURSO_DATABASE_URL
turso db tokens create mysite     # ← TURSO_AUTH_TOKEN
```

المخطط يُنشأ تلقائيًا عند أول وصول (`CREATE TABLE IF NOT EXISTS`) — لا migrations. الكود يحوّل `libsql://` إلى `https://` للاتصال عبر HTTP البحت (متوافق مع serverless).

## الخطوة 2: متغيرات البيئة

| المتغير | إلزامي | الوصف |
|---|---|---|
| `TURSO_DATABASE_URL` | نعم | رابط قاعدة Turso |
| `TURSO_AUTH_TOKEN` | نعم | توكن بصلاحيات كتابة |
| `MERGER_API_BASE` | نعم للدمج | نطاق خدمة الدمج بعد نشر `merger/` (مثل `https://merger.vercel.app`) |
| `MCP_ACCESS_TOKEN` | لا | إن ضُبط يُطلب `Authorization: Bearer <token>` على `/mcp` |
| `KIE_IMAGE_MODEL` / `KIE_VIDEO_MODEL` | لا | تجاوز اسم الموديل لدى kie.ai |
| `COMETAPI_IMAGE_MODEL` / `COMETAPI_VIDEO_MODEL` | لا | تجاوز اسم الموديل لدى CometAPI |

> **أسماء الموديلات الفعلية** (متحقق منها بنداءات حقيقية): kie.ai يقبل `gpt-image-2-6/flare-text-to-image` بالشرطات (الصيغة بالنقاط تُرفض)، و`grok-imagine-video-1-5-preview`. أما CometAPI فيستخدم `gpt-image-2.6-flare` عبر `/v1/images/generations` و`grok-imagine-video` عبر `/grok/v1/videos/generations` وفق توثيقه الرسمي.

## الخطوة 3: النشر على Vercel

أنشئ **مشروعين** من نفس المستودع:

1. **التطبيق الرئيسي**: Root Directory = `/` (جذر المستودع). أضف المتغيرات: `TURSO_DATABASE_URL`، `TURSO_AUTH_TOKEN`، ثم بعد نشر خدمة الدمج أضف `MERGER_API_BASE`.
2. **خدمة الدمج**: مشروع ثانٍ بنفس المستودع مع **Root Directory = `merger`** وأضف متغيري Turso له. انسخ نطاقه وضعَه في `MERGER_API_BASE` للمشروع الأول.

مسار `/mcp` مضبوط بـ `maxDuration = 300` — على خطة Hobby الحد 60 ثانية فاخفض `wait_seconds` أو رقِّ للخطة Pro.

## ربط عملاء MCP

بعد النشر يكون الرابط `https://<نطاقك>/mcp` (اللوحة تعرضه جاهزًا للنسخ مع JSON كل عميل):

```json
{ "mcpServers": { "media-generator": { "url": "https://<نطاقك>/mcp" } } }
```

- **ChatGPT**: Settings → Connectors → Create → Custom MCP server → ضع الرابط في «Server URL».
- **Claude Desktop**: أضف القسم إلى `claude_desktop_config.json` (مع `"type": "http"`).
- **Cursor / Windsurf / Cline**: أضف القسم إلى `mcp.json`.
- **مهم**: الفيديو يحتاج دقائق — يعيد السيرفر `task_id` فورًا، وتابعه بـ `get_task` كل ~10 ثوانٍ حتى يظهر الرابط ويتوقف. أثناء الانتظار يُبث تقدم حي.

## سياسة المفاتيح المتسلسلة (القلب)

1. التجربة **تسلسلية صارمة بترتيب الإضافة** (`ORDER BY created_at ASC, id ASC`) — ليست round-robin.
2. تصنيف كل خطأ (`classifyProviderError`):
   - **disabled**: 401/403 أو رسالة توثيق → المفتاح يُعلَّم معطلًا تلقائيًا → انتقل للتالي.
   - **exhausted**: 402 أو رسالة رصيد (تُفحص قبل 400) → يُعلَّم مستنزفًا ويبقى في القاعدة → انتقل للتالي.
   - **provider**: الموديل غير مدعوم → انتقل للتالي. **params**: معطيات → توقف فورًا. **temporary**: 429/5xx/شبكة → انتقل للتالي.
3. فشل مفتاح/رصيد **في منتصف المهمة** → إعادة إنشاء **نفس المهمة بنفس `task_id`** على المفتاح التالي — صامت تمامًا.
4. فشل على **كل** المفاتيح → المهمة تبقى `processing` وتُعاد محاولتها مع كل `get_task` (بتهدئة ~45 ثانية) — لو شُحن رصيد أي مفتاح اكتملت من تلقاء نفسها.
5. إخفاء المفاتيح إلزامي في كل الاستجابات (`maskKey`)، ولا يُعاد المفتاح الكامل أبدًا.

## الاختبارات المنفذة (كلها ناجحة على بيئة حقيقية)

| الاختبار | النتيجة |
|---|---|
| `tsc --noEmit` نظيف + `next build` ينجح | ✓ |
| `/api/health` → `ok:true` + `turso-connected` + `merger.healthy:true` | ✓ |
| `tools/list` يعرض الأدوات الخمس بمخططات مطابقة (دمج بلا resolution/fps وبحد 10) | ✓ |
| e2e صورة حقيقية → رابط PNG يعمل | ✓ |
| e2e فيديو حقيقي → MP4 يعمل (13 إشعار تقدم أثناء البث) | ✓ |
| تبديل تسلسلي: مفتاح خاطئ أولًا → عُطّل تلقائيًا → نفس المهمة اكتملت على الثاني، بلا أي ذكر للمفاتيح | ✓ |
| تصنيف 402 → `exhausted` ويبقى في التجمع دون عرقلة التالي (21 اختبار منطق) | ✓ |
| مهمة فشلت على كل المفاتيح → بقيت `processing` → اكتملت تلقائيًا عبر `get_task` بعد شحن مفتاح | ✓ |
| e2e دمج عبر `merge_videos` → MP4 نهائي على نطاق خدمة الدمج يعمل (Range 206) | ✓ |
| رفض مقطع واحد/أكثر من 10 (مخطط الأداة + رسائل عربية مع تفاصيل المعرّفات) وحل `task_ids` بالترتيب | ✓ |
| `list_media` يعيد المخزن مرتبًا من الأحدث | ✓ |
| الواجهة: إضافة/تعطيل/حذف مفاتيح، متابعة حية كل 5 ثوانٍ، بطاقة ربط بثلاثة تبويبات، RTL كامل | ✓ |
| خدمة الدمج: 46 اختبارًا (15 وحدات + 31 HTTP) تشمل Range وتقسيم الأجزاء والحدود والحذف | ✓ |

## الأمان

- `.env*` مستثنى من Git منذ اليوم الأول (`.env.example` نموذج بلا قيم).
- المفاتيح مقنعة دائمًا: `ABCD123••••••••WXYZ` (والقصيرة: أول 3 + `••••`).
- حماية اختيارية بـ `MCP_ACCESS_TOKEN` على `/mcp`.
- روابط فقط — لا وسائط تُنزَّل إلى السيرفر الرئيسي (خدمة الدمج وحدها تجلب المصادر لمعالجتها ثم تحذفها).
