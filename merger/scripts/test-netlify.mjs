// اختبار شامل لطبقة Netlify v2 — يستدعي دوال netlify/functions مباشرة بطلبات
// Request اصطناعية (نفس المسار المُنفَّذ على الاستضافة) ويتحقق من كل نقطة API.
// يشغّل: bun merger/scripts/test-netlify.mjs   (يحتاج merger/.env.local بقيم Turso)
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

const require = createRequire(import.meta.url);
const MERGER_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

// تحميل متغيرات البيئة المحلية قبل أي استيراد للمكتبات
const util = require(path.join(MERGER_ROOT, "lib/util.js"));
const loaded = util.loadEnvFiles(MERGER_ROOT);
if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error("✗ المتغيرات TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة (merger/.env.local)");
  process.exit(1);
}
console.log(`✓ بيئة محملة (${loaded} ملف) — القاعدة: ${process.env.TURSO_DATABASE_URL.replace(/^libsql:\/\//, "")}`);

// دوال Netlify كما ستنشر حرفيًا
const fnConfig = (await import("../netlify/functions/api-config.mjs")).default;
const fnJobs = (await import("../netlify/functions/api-jobs.mjs")).default;
const fnJob = (await import("../netlify/functions/api-job.mjs")).default;
const fnProcess = (await import("../netlify/functions/api-job-process.mjs")).default;
const fnVideo = (await import("../netlify/functions/api-job-video.mjs")).default;
const fnUpload = (await import("../netlify/functions/api-upload.mjs")).default;
const fnCron = (await import("../netlify/functions/cron-cleanup.mjs")).default;

const BASE = "https://merger-test.local";
let passed = 0;
let failed = 0;

function ok(cond, label, extra) {
  if (cond) { passed++; console.log(`✓ ${label}`); }
  else { failed++; console.error(`✗ ${label}${extra ? " — " + extra : ""}`); }
}

/** طلب بسيط ضد دالة معينة */
async function call(fn, method, p, { query = {}, body, headers = {}, host = "merger-test.local" } = {}) {
  const qs = new URLSearchParams(query).toString();
  const url = `${BASE}${p}${qs ? "?" + qs : ""}`;
  const req = new Request(url, {
    method,
    headers: { host, "x-forwarded-proto": "https", ...headers },
    body: body ?? undefined,
  });
  return fn(req);
}

async function jsonOf(res) {
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { __raw: t.slice(0, 200) }; }
}

/** توليد مقطع اختبار صغير بـ ffmpeg (بصوت، <4MB) */
function makeClip(file, color) {
  execFileSync("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", `color=c=${color}:s=320x240:r=15:d=2`,
    "-f", "lavfi", "-i", `sine=frequency=440:duration=2`,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
    file,
  ]);
  const size = fs.statSync(file).size;
  if (size > 4 * 1024 * 1024) throw new Error(`المقطع الاختباري أكبر من 4MB (${size})`);
  return size;
}

async function main() {
  // 1) config: OPTIONS / GET / طريقة مرفوضة
  const rOpt = await call(fnConfig, "OPTIONS", "/api/config");
  ok(rOpt.status === 204, "config OPTIONS → 204", `got ${rOpt.status}`);
  const rCfg = await call(fnConfig, "GET", "/api/config");
  const cfgBody = await jsonOf(rCfg);
  ok(rCfg.status === 200 && cfgBody.version === "2.0.0" && cfgBody.uploadChunkBytes === 4194304,
    "config GET → 200 + حدود صحيحة", JSON.stringify(cfgBody));
  ok(rCfg.headers.get("access-control-allow-origin") === "*", "config CORS مفتوح");
  const r405 = await call(fnConfig, "POST", "/api/config");
  ok(r405.status === 405, "config POST → 405", `got ${r405.status}`);

  // 2) إنشاء مهمة بملفين (مصادر kind=file)
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "netlify-test-"));
  const c1 = path.join(tmp, "a.mp4"), c2 = path.join(tmp, "b.mp4");
  const s1 = makeClip(c1, "red"), s2 = makeClip(c2, "blue");
  console.log(`✓ مقطعان مولَّدان (${util.mb(s1)}MB و ${util.mb(s2)}MB)`);

  const rJob = await call(fnJobs, "POST", "/api/jobs", {
    body: JSON.stringify({
      sources: [
        { kind: "file", name: "a.mp4", size: s1, mime: "video/mp4" },
        { kind: "file", name: "b.mp4", size: s2, mime: "video/mp4" },
      ],
    }),
    headers: { "content-type": "application/json" },
  });
  const job = await jsonOf(rJob);
  ok(rJob.status === 201 && job.jobId && job.status === "uploading", "jobs POST → 201 uploading", JSON.stringify(job).slice(0, 300));
  ok(Array.isArray(job.uploads) && job.uploads.length === 2, "قائمة الرفع: مصدران بجزء واحد لكل منهما");

  const jobId = job.jobId;
  ok(job.statusUrl === `${BASE}/api/jobs/${jobId}`, "getOrigin يبني روابط من ترويسات البروكسي", job.statusUrl);

  // رفض مصدر واحد
  const rOne = await call(fnJobs, "POST", "/api/jobs", { body: JSON.stringify({ videos: ["https://a.com/x.mp4"] }), headers: { "content-type": "application/json" } });
  ok(rOne.status === 400, "رفض مصدر واحد → 400", `got ${rOne.status}`);

  // مسار الفشل: رابط ميت → الخلفية تسجّل failed في القاعدة بلا إعادة رمي
  const rBad = await call(fnJobs, "POST", "/api/jobs", { body: JSON.stringify({ videos: ["https://dead.invalid/x.mp4", "https://dead.invalid/y.mp4"] }), headers: { "content-type": "application/json" } });
  const badJob = await jsonOf(rBad);
  await fnProcess(new Request(`${BASE}/api/jobs/${badJob.jobId}/process`, { method: "POST" }));
  const stBad = await jsonOf(await call(fnJob, "GET", `/api/jobs/${badJob.jobId}`));
  ok(stBad.status === "failed" && (stBad.error || "").includes("تعذر تنزيل"), "رابط ميت → failed مع خطأ عربي في القاعدة", JSON.stringify(stBad).slice(0, 160));
  await call(fnJob, "DELETE", `/api/jobs/${badJob.jobId}`);

  // 3) رفع الأجزاء — نقرأ seq من استجابة الإنشاء نفسها (نفس تدفق الواجهة)
  const files = { "a.mp4": c1, "b.mp4": c2 };
  let lastUp;
  for (const up of job.uploads) {
    lastUp = await call(fnUpload, "POST", "/api/upload", {
      query: { job: jobId, seq: up.seq, chunk: 0 },
      body: fs.readFileSync(files[up.name]),
      headers: { "content-type": "application/octet-stream" },
    });
  }
  const u1 = await jsonOf(lastUp);
  ok(lastUp.status === 200 && u1.ok === true, "upload جزء المصدر الأخير → ok", JSON.stringify(u1));
  ok(u1.done === true, "اكتمال كل المصادر بعد آخر جزء", JSON.stringify(u1));

  const st0 = await jsonOf(await call(fnJob, "GET", `/api/jobs/${jobId}`));
  ok(st0.status === "queued", "الحالة أصبحت queued بعد الرفع", st0.status);

  // 4) تنفيذ الدمج — دالة خلفية تجري هنا كاملًا (سحب/ترميز/تخزين)
  // محاكاة ترويسات Netlify المحفوظة في الاستدعاء الخلفي (host دائمًا موجود)
  console.log("⏳ تنفيذ الدمج عبر دالة الخلفية…");
  const t0 = Date.now();
  const rProc = await fnProcess(new Request(`${BASE}/api/jobs/${jobId}/process`, {
    method: "POST",
    headers: { host: "merger-test.local", "x-forwarded-proto": "https" },
  }));
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  ok(rProc.status === 202, `process خلفية → 202 فوري (${secs}ث تنفيذًا فعليًا)`, `got ${rProc.status}`);

  const st1 = await jsonOf(await call(fnJob, "GET", `/api/jobs/${jobId}`));
  ok(st1.status === "done" && st1.progress === 100, "الحالة done بعد الدمج", JSON.stringify(st1).slice(0, 200));
  ok(st1.resolution === "320x240" && st1.duration >= 3.5 && st1.duration <= 5, `المدة والدقة صحيحة (${st1.duration}ث ${st1.resolution})`, `${st1.duration} ${st1.resolution}`);
  ok(st1.videoUrl && st1.videoUrl.startsWith("https://merger-test.local/api/jobs/"), "videoUrl مبني من origin", st1.videoUrl);

  // 5) بث الناتج: كامل + Range 206 + HEAD
  const rVid = await call(fnVideo, "GET", `/api/jobs/${jobId}/video`);
  ok(rVid.status === 200 && (rVid.headers.get("content-type") || "").includes("video/mp4") && rVid.headers.get("accept-ranges") === "bytes",
    "video GET → 200 mp4 + Accept-Ranges", `${rVid.status} ${rVid.headers.get("content-type")}`);
  const full = Buffer.from(await rVid.arrayBuffer());
  ok(full.length === st1.size && full.length > 10 * 1024, `حجم البث الكامل مطابق (${full.length} بايت)`, `${full.length} vs ${st1.size}`);

  const rRange = await call(fnVideo, "GET", `/api/jobs/${jobId}/video`, { headers: { range: "bytes=0-999" } });
  ok(rRange.status === 206, "Range → 206", `got ${rRange.status}`);
  ok((rRange.headers.get("content-range") || "") === `bytes 0-999/${st1.size}`, "Content-Range صحيح", rRange.headers.get("content-range"));
  const part = Buffer.from(await rRange.arrayBuffer());
  ok(part.length === 1000 && part.equals(full.subarray(0, 1000)), "بايتات المدى مطابقة للأصل");

  const rTail = await call(fnVideo, "GET", `/api/jobs/${jobId}/video`, { headers: { range: "bytes=-500" } });
  const tail = Buffer.from(await rTail.arrayBuffer());
  ok(rTail.status === 206 && tail.length === 500 && tail.equals(full.subarray(full.length - 500)), "Range لاحق (آخر 500 بايت) صحيح");

  const rHead = await call(fnVideo, "HEAD", `/api/jobs/${jobId}/video`);
  ok(rHead.status === 200 && (await rHead.arrayBuffer()).byteLength === 0, "HEAD → 200 بلا جسم");

  // 6) الاستعلام بعد الاكتمال ثابت
  const rAgain = await jsonOf(await call(fnJob, "GET", `/api/jobs/${jobId}`));
  ok(rAgain.status === "done", "استعلام بعد الاكتمال ثابت");

  // 7) cron المجدولة — نفحص ناتج المعالج نفسه عبر الجسر (المجدول يتجاهل الاستجابة على الاستضافة)
  const { handle: cronHandle } = await import("../netlify/functions/_lib/shim.mjs");
  const cronHandler = (await import("../api/cron.js")).default;
  const cronRes = await cronHandle(new Request(`${BASE}/api/cron`, { method: "GET" }), cronHandler);
  const cronBody = await jsonOf(cronRes);
  ok(cronRes.status === 200 && typeof cronBody.deleted === "number", `cron المجدولة → ${cronBody.deleted} مهمة محذوفة`, JSON.stringify(cronBody));

  // 8) DELETE شامل ثم 404
  const rDel = await call(fnJob, "DELETE", `/api/jobs/${jobId}`);
  const delBody = await jsonOf(rDel);
  ok(rDel.status === 200 && delBody.ok === true, "DELETE → ok", JSON.stringify(delBody));
  const r404 = await call(fnJob, "GET", `/api/jobs/${jobId}`);
  ok(r404.status === 404, "بعد الحذف → 404", `got ${r404.status}`);
  const rV404 = await call(fnVideo, "GET", `/api/jobs/${jobId}/video`);
  ok(rV404.status === 404, "بث بعد الحذف → 404", `got ${rV404.status}`);

  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`\nالنتيجة: ${passed} نجح / ${failed} فشل`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error("✗ فشل غير متوقع:", e); process.exit(1); });
