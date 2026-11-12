'use strict';

/**
 * lib/util.js — أدوات مشتركة: الإعدادات، CORS، قراءة الجسم، تحميل البيئة،
 * وإيجاد ثنائيات ffmpeg/ffprobe مع سلسلة بدائل (env -> static -> PATH).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

/** حجم صف التخزين في Turso (حد HTTP آمن) = 2MB */
const ROW_BYTES = 2 * 1024 * 1024;
/** عدد الصفوف المقروءة في كل استعلام صفحة */
const PAGE_ROWS = 8;

const VERSION = '2.0.0';
/** عمر المهمة قبل الحذف التلقائي (ساعات) */
const JOB_TTL_HOURS = 24;

function intEnv(name, def) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : def;
}

/** إعدادات الخدمة — تُقرأ من البيئة في كل استدعاء (بقيم افتراضية) */
function cfg() {
  // يجب أن يكون حجم جزء الرفع من مضاعفات ROW_BYTES حتى تنقسم الصفوف دون تداخل
  const rawChunk = intEnv('UPLOAD_CHUNK_BYTES', 4194304);
  const aligned = Math.max(ROW_BYTES, Math.floor(rawChunk / ROW_BYTES) * ROW_BYTES);
  return {
    VERSION,
    JOB_TTL_HOURS,
    MAX_SOURCES: intEnv('MAX_SOURCES', 10),
    SOURCE_MAX_MB: intEnv('SOURCE_MAX_MB', 200),
    OUTPUT_MAX_MB: intEnv('OUTPUT_MAX_MB', 150),
    MAX_TOTAL_DURATION_SEC: intEnv('MAX_TOTAL_DURATION_SEC', 600),
    UPLOAD_CHUNK_BYTES: aligned,
    FFMPEG_PRESET: String(process.env.FFMPEG_PRESET || 'medium'),
    DOWNLOAD_TIMEOUT_SEC: intEnv('DOWNLOAD_TIMEOUT_SEC', 120),
  };
}

/* ------------------------------------------------------------------ */
/* الأخطاء المهيكلة                                                    */
/* ------------------------------------------------------------------ */

function jsonError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

/* ------------------------------------------------------------------ */
/* CORS + الاستجابات                                                   */
/* ------------------------------------------------------------------ */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Content-Length, Range, X-Requested-With, Authorization',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, Content-Disposition, Content-Type',
  'Access-Control-Max-Age': '86400',
};

function setCors(res) {
  for (const k of Object.keys(CORS_HEADERS)) res.setHeader(k, CORS_HEADERS[k]);
}

/** يعالج OPTIONS ويعيد true إن تمت المعالجة */
function handleOptions(req, res) {
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.statusCode = 204;
    res.setHeader('Content-Length', '0');
    res.end();
    return true;
  }
  return false;
}

function sendJson(res, code, obj, extraHeaders) {
  setCors(res);
  const body = JSON.stringify(obj);
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (extraHeaders) {
    for (const k of Object.keys(extraHeaders)) res.setHeader(k, extraHeaders[k]);
  }
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

function sendError(res, code, message) {
  sendJson(res, code, { error: String(message || 'خطأ غير متوقع') });
}

function methodNotAllowed(res, allow) {
  res.setHeader('Allow', allow);
  sendError(res, 405, 'الطريقة غير مسموحة لهذه النقطة — الطرق المتاحة: ' + allow);
}

/* ------------------------------------------------------------------ */
/* الأصل (Origin) — يحاكي سلوك Vercel عبر ترويسات البروكسي             */
/* ------------------------------------------------------------------ */

function getOrigin(req) {
  const xfHost = String(req.headers['x-forwarded-host'] || '');
  const host = (xfHost.split(',')[0] || req.headers.host || 'localhost').trim();
  const xfProto = String(req.headers['x-forwarded-proto'] || '');
  const proto = (xfProto.split(',')[0] || (req.socket && req.socket.encrypted ? 'https' : 'http')).trim();
  return `${proto}://${host}`;
}

/* ------------------------------------------------------------------ */
/* قراءة الجسم (ثنائي خام) مع حد أقصى — يستنزف الطلب كاملًا ثم يرفض    */
/* ------------------------------------------------------------------ */

function readRawBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let received = 0;
    let tooBig = false;
    let settled = false;
    req.on('data', (c) => {
      received += c.length;
      if (received > maxBytes) {
        tooBig = true;
        chunks.length = 0; // استنزاف الباقي دون تخزين
        return;
      }
      if (!tooBig) chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (tooBig) {
        reject(jsonError(413, `حجم الجسم المرسل (${received} بايت) تجاوز الحد المسموح (${maxBytes} بايت)`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
    req.on('error', (e) => {
      if (!settled) {
        settled = true;
        reject(e);
      }
    });
  });
}

async function readJsonBody(req, maxBytes) {
  const buf = await readRawBody(req, maxBytes || 1024 * 1024);
  if (!buf.length) throw jsonError(400, 'جسم الطلب فارغ — يجب إرسال JSON صالح');
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw jsonError(400, 'صيغة JSON غير صالحة في جسم الطلب');
  }
}

/* ------------------------------------------------------------------ */
/* معرفات فريدة                                                        */
/* ------------------------------------------------------------------ */

function newId() {
  return crypto.randomUUID();
}

/* ------------------------------------------------------------------ */
/* تحميل ملفات البيئة يدويًا (بدون مكتبات) — .env.local ثم .env        */
/* الملف الأول في الترتيب يغلب عند التعارض                            */
/* ------------------------------------------------------------------ */

function loadEnvFiles(dir) {
  const order = ['.env.local', '.env'];
  const loaded = {};
  for (const name of order) {
    const p = path.join(dir, name);
    let text = null;
    try {
      text = fs.readFileSync(p, 'utf8');
    } catch (e) {
      continue;
    }
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_.]*)\s*=(.*)$/);
      if (!m) continue;
      let v = m[2].trim();
      if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
        v = v.slice(1, -1);
      }
      if (!(m[1] in loaded)) loaded[m[1]] = v;
    }
  }
  for (const k of Object.keys(loaded)) {
    if (process.env[k] === undefined || process.env[k] === '') process.env[k] = loaded[k];
  }
  return Object.keys(loaded).length;
}

/* ------------------------------------------------------------------ */
/* إيجاد ثنائيات ffmpeg / ffprobe:                                     */
/* 1) متغير البيئة FFMPEG_PATH / FFPROBE_PATH                          */
/* 2) حزم ffmpeg-static / ffprobe-static                               */
/* 3) الأمر من PATH النظامي                                            */
/* ensureExecutable تنسخ الثنائي إلى /tmp بصلاحية 755 عند الحاجة       */
/* ------------------------------------------------------------------ */

const binaryCache = Object.create(null);

function findInPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (e) { /* جرّب التالي */ }
  }
  return null;
}

function ensureExecutable(p) {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return p;
  } catch (e) { /* لا صلاحية تنفيذ — انسخ إلى /tmp */ }
  try {
    const destDir = path.join(os.tmpdir(), 'merger-bins');
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(p));
    if (!fs.existsSync(dest)) {
      fs.copyFileSync(p, dest);
      try { fs.chmodSync(dest, 0o755); } catch (e) { /* تجاهل */ }
    }
    fs.accessSync(dest, fs.constants.X_OK);
    return dest;
  } catch (e) {
    return p;
  }
}

function resolveBinary(kind) {
  if (binaryCache[kind]) return binaryCache[kind];
  const envName = kind.toUpperCase() + '_PATH';
  const candidates = [];
  if (process.env[envName]) candidates.push(process.env[envName]);
  try {
    if (kind === 'ffmpeg') {
      const p = require('ffmpeg-static');
      if (p && typeof p === 'string') candidates.push(p);
    } else {
      const m = require('ffprobe-static');
      if (m && m.path) candidates.push(m.path);
    }
  } catch (e) { /* الحزمة غير مثبتة — تابع البدائل */ }
  candidates.push(kind); // من PATH

  for (let c of candidates) {
    try {
      if (!path.isAbsolute(c)) {
        c = findInPath(c);
        if (!c) continue;
      }
      if (!fs.existsSync(c)) continue;
      const resolved = ensureExecutable(c);
      binaryCache[kind] = resolved;
      return resolved;
    } catch (e) { /* جرّب المرشح التالي */ }
  }
  throw jsonError(500, `تعذر العثور على ${kind} على الخادم — ثبّته أو اضبط ${envName}`);
}

function ffmpegPath() {
  return resolveBinary('ffmpeg');
}

function ffprobePath() {
  return resolveBinary('ffprobe');
}

/* ------------------------------------------------------------------ */
/* تنزيل الثنائيات وقت التشغيل — Netlify لا يشحن node_modules مع الدوال */
/* ------------------------------------------------------------------ */

// مصادر رسمية: ffmpeg من إصدارات ffmpeg-static (ثنائي خام)، وffprobe من حزمة npm الرسمية (tgz)
const BINARY_SOURCES = {
  ffmpeg: {
    url: 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.0/ffmpeg-linux-x64',
    archive: false,
  },
  ffprobe: {
    url: 'https://registry.npmjs.org/ffprobe-static/-/ffprobe-static-3.1.0.tgz',
    archive: true,
    inner: 'package/bin/linux/x64/ffprobe',
  },
};

const binaryDownloads = {}; // ضمان تنزيل واحد لكل ثنائي (وعد مشترك)

/**
 * يعيد مسار الثنائي مع الضمان: إن لم يوجد محليًا (env/حزمة/PATH) ينزّله إلى /tmp/bin
 * ويعيد استخدام النسخة المخزنة في النداءات التالية لنفس نسخة الـ lambda.
 */
async function ensureBinary(kind) {
  try {
    return resolveBinary(kind); // env أو الحزمة أو PATH
  } catch (e) {
    /* غير موجود — نفعل التنزيل */
  }
  const cached = `/tmp/bin/${kind}`;
  try {
    fs.accessSync(cached, fs.constants.X_OK);
    binaryCache[kind] = cached;
    return cached;
  } catch (e) {
    /* لا نسخة مخزنة — ننزّل */
  }
  if (!binaryDownloads[kind]) binaryDownloads[kind] = downloadBinary(kind);
  const p = await binaryDownloads[kind];
  binaryCache[kind] = p;
  return p;
}

async function downloadBinary(kind) {
  const src = BINARY_SOURCES[kind];
  if (!src) throw jsonError(500, `لا مصدر تنزيل للثنائي ${kind}`);
  fs.mkdirSync('/tmp/bin', { recursive: true });
  const finalPath = `/tmp/bin/${kind}`;

  const res = await fetch(src.url, { signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw jsonError(500, `فشل تنزيل ${kind} (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());

  if (!src.archive) {
    // ثنائي خام — اكتبه مباشرة
    fs.writeFileSync(finalPath, buf);
    fs.chmodSync(finalPath, 0o755);
    return finalPath;
  }

  // tgz — استخرج بالـ tar المتوفر في النظام ثم انسخ الثنائي المطلوب
  const tgz = `/tmp/${kind}.tgz`;
  const tmpExtract = `/tmp/${kind}-extract`;
  fs.writeFileSync(tgz, buf);
  fs.rmSync(tmpExtract, { recursive: true, force: true });
  fs.mkdirSync(tmpExtract, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', tgz, '-C', tmpExtract], { stdio: 'ignore' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(jsonError(500, `فشل استخراج ${kind} (tar كود ${code})`))));
    child.on('error', (e) => reject(jsonError(500, `tar غير متاح لاستخراج ${kind}: ${e.message}`)));
  });
  const inner = path.join(tmpExtract, src.inner);
  fs.accessSync(inner, fs.constants.X_OK);
  fs.copyFileSync(inner, finalPath);
  fs.chmodSync(finalPath, 0o755);
  try { fs.rmSync(tmpExtract, { recursive: true, force: true }); fs.rmSync(tgz, { force: true }); } catch (e) { /* تنظيف */ }
  return finalPath;
}

/* ------------------------------------------------------------------ */
/* مساعدات متنوعة                                                      */
/* ------------------------------------------------------------------ */

/** تحويل قيمة BLOB من قاعدة البيانات إلى Buffer */
function toBuffer(v) {
  if (v == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof ArrayBuffer) return Buffer.from(new Uint8Array(v));
  if (ArrayBuffer.isView(v)) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return Buffer.from(String(v), 'utf8');
}

function mb(bytes) {
  return (Number(bytes || 0) / (1024 * 1024)).toFixed(1);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = {
  ROW_BYTES,
  PAGE_ROWS,
  VERSION,
  JOB_TTL_HOURS,
  cfg,
  jsonError,
  setCors,
  handleOptions,
  sendJson,
  sendError,
  methodNotAllowed,
  getOrigin,
  readRawBody,
  readJsonBody,
  newId,
  loadEnvFiles,
  ffmpegPath,
  ffprobePath,
  ensureBinary,
  toBuffer,
  mb,
  sleep,
};
