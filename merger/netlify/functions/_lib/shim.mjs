// جسر التوافق مع Netlify Functions v2 — يحوّل طلب الويب القياسي (Request)
// إلى زمن Node الشبيه بـ ServerResponse الذي توقعه معالجات مجلد api/ المكتوبة
// لصيغة Vercel (req.method / req.query / req.on('data') / res.setHeader ...).
// بهذا يعمل المنطق المُختبَر نفسه على المنصتين دون أي تعديل.
//
// الاستجابة: إن أنهى المعالج الكتابة (end) تُجمَّع الأجزاء المخزَّنة في جسم ملموس؛
// وإن عاد المعالج وهو يبث (stream.pipe كما في بث الفيديو) يُعاد Readable متدفق
// حتى تتجاوز الاستجابات الكبيرة حدود التخزين المؤقت.

import { Readable } from "node:stream";
import { PassThrough } from "node:stream";
// استيراد ساكن — esbuild يجمّعه داخل حزمة الدالة؛ الـ createRequire الديناميكي
// كان يترك المسار النسبي حيًا بعد النشر فينفصل عن بنية /var/task
import * as util from "../../../lib/util.js";

/** استجابة Node شبيهة بـ ServerResponse — PassThrough يدعم stream.pipe والبث التدفق */
class ShimRes extends PassThrough {
  constructor() {
    super();
    this.statusCode = 200;
    this._headers = new Map();
  }
  setHeader(name, value) {
    this._headers.set(String(name).toLowerCase(), String(value));
    return this;
  }
  getHeader(name) {
    const v = this._headers.get(String(name).toLowerCase());
    return v === undefined ? undefined : v;
  }
  removeHeader(name) {
    this._headers.delete(String(name).toLowerCase());
  }
  getHeaders() {
    return Object.fromEntries(this._headers);
  }
}

/** يبني كائن طلب Node من طلب الويب: ترويسات مُنقّحة + query + جسم كـ Readable */
async function buildReq(request, url) {
  const headers = {};
  request.headers.forEach((v, k) => {
    headers[k] = v; // مفاتيح Headers تأتي بأحرف صغيرة مسبقًا
  });
  // محاكاة ترويسات البروكسي التي يعتمدها util.getOrigin لبناء روابط النتائج
  if (!headers["x-forwarded-host"] && headers.host) headers["x-forwarded-host"] = headers.host;
  if (!headers["x-forwarded-proto"]) {
    headers["x-forwarded-proto"] = url.protocol === "https:" ? "https" : "http";
  }

  // الجسم كاملًا في الذاكرة (حد Netlify ~6MB < حد أجزاء الرفع 4MB) — أبسط وأضمن من التدفق
  const ab = await request.arrayBuffer();
  const bodyBuf = Buffer.from(ab);
  const req = Readable.from(bodyBuf.length ? [bodyBuf] : []);
  req.method = request.method;
  req.headers = headers;
  req.url = url.pathname + url.search;
  req.query = Object.fromEntries(url.searchParams);
  // معالجات jobs/[id] تقرأ req.query.id — على Netlify المعرّف يأتي من المسار
  // (config.path = "/api/jobs/:id") فنحقنه في query للتوافق الكامل مع صيغة Vercel
  const pathId = String(url.pathname).match(/\/api\/jobs\/([A-Za-z0-9-]+)/);
  if (pathId && !req.query.id) req.query.id = pathId[1];
  req.socket = {};
  return req;
}

function headersOf(res) {
  const out = {};
  for (const [k, v] of res._headers) out[k] = v;
  return out;
}

/**
 * يشغّل معالجًا بصيغة Vercel داخل دالة Netlify v2 ويعيد Response.
 * - انتهى المعالج بالكتابة → جسم ملموس (Buffer) لكل نقاط JSON.
 * - عاد المعالج وهو يبث → Readable.toWeb لتدفق بلا حد حجم (بث الفيديو).
 * - خطأ قبل الكتابة → sendError الأصلي بصيغة {"error":"..."} المتوقعة من العملاء.
 */
export async function handle(request, handler) {
  const url = new URL(request.url);
  const req = await buildReq(request, url);
  const res = new ShimRes();

  try {
    await handler(req, res);
  } catch (e) {
    // خطأ صريح من المعالج (مثل 202 «قيد المعالجة» أو 409) → نفس سلوك Vercel
    if (!res.writableEnded) {
      const code = e && e.statusCode ? e.statusCode : 500;
      const msg = e && e.message ? e.message : "خطأ غير متوقع";
      try {
        util.sendError(res, code, msg);
      } catch (e2) {
        try { res.destroy(); } catch (e3) { /* تجاهل */ }
      }
    }
  }

  if (res.writableEnded) {
    // اجمع كل الأجزاء المخزَّنة بعد اكتمال الكتابة
    const parts = [];
    let c;
    while ((c = res.read()) !== null) parts.push(c);
    const body = Buffer.concat(parts);
    return new Response(new Uint8Array(body), {
      status: res.statusCode,
      headers: headersOf(res),
    });
  }

  // بث تدفقي (video.js يعيد بعد stream.pipe قبل اكتمال القراءة)
  return new Response(Readable.toWeb(res), {
    status: res.statusCode,
    headers: headersOf(res),
  });
}

/** يستخرج معرّف المهمة من مسار مثل /api/jobs/<id> أو /api/jobs/<id>/video */
export function jobIdFromPath(pathname) {
  const m = String(pathname).match(/\/api\/jobs\/([A-Za-z0-9-]+)/);
  return m ? m[1] : "";
}

/** طلب اصطناعي GET للدوال المجدولة (cron) — يستدعي معالج api/cron نفسه */
export function syntheticGet(pathname) {
  return new Request(`http://local-netlify${pathname}`, { method: "GET" });
}
