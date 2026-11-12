'use strict';

/**
 * lib/merge.js — محرك الدمج بجودة عالية عبر ffmpeg:
 * - توحيد كل المصادر بفلتر واحد: scale+pad لأكبر دقة (حد 1920x1080، أبعاد زوجية)
 *   + fps=30 + setsar=1 + format=yuv420p ثم concat=n=N:v=1:a=1
 * - مصدر بلا صوت يُدعم بمسار anullsrc صامت بدل أن يفشل الدمج
 * - ترميز libx264 CRF 18 + AAC 192k/44100 + faststart + preset قابل للضبط
 * - تقدم حقيقي عبر -progress pipe:1 (قراءة out_time_us)
 *
 * mergeFiles نقية تمامًا (بلا قاعدة بيانات) وقابلة للاختبار مباشرة،
 * وprocessJob هي الطبقة العليا التي تحضّر المصادر وتخزّن الناتج.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { Readable } = require('stream');

const db = require('./db');
const storage = require('./storage');
const util = require('./util');

const TARGET_MAX_W = 1920;
const TARGET_MAX_H = 1080;
const FPS = 30;
const AUDIO_RATE = 44100;

/* ------------------------------------------------------------------ */
/* تشغيل أوامر خارجية والتقاط المخرجات                                 */
/* ------------------------------------------------------------------ */

function runCapture(bin, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(util.jsonError(500, `تعذر تشغيل ${path.basename(bin)}: ${e.message}`));
    }
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      err.push(d);
      if (err.length > 400) err.splice(0, 200);
    });
    child.on('error', (e) => {
      reject(util.jsonError(
        500,
        e.code === 'ENOENT'
          ? `الأداة ${path.basename(bin)} غير متوفرة على الخادم`
          : `تعذر تشغيل ${path.basename(bin)}: ${e.message}`
      ));
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) return resolve({ stdout, stderr });
      const tail = stderr.split('\n').filter(Boolean).slice(-4).join(' | ');
      reject(util.jsonError(500, `فشل تنفيذ ${path.basename(bin)} (كود ${code}): ${tail || 'خطأ غير معروف'}`));
    });
  });
}

function parseFps(v) {
  if (!v) return null;
  const m = /^(\d+)(?:\/(\d+))?$/.exec(String(v));
  if (!m) return null;
  const num = Number(m[1]);
  const den = m[2] ? Number(m[2]) : 1;
  if (!den) return null;
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : null;
}

/** ffprobe لملف: المدة، الدقة، fps، وجود صوت، والترميزات */
async function probeFile(p) {
  const bin = util.ffprobePath();
  const args = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', p];
  const { stdout } = await runCapture(bin, args);
  let json;
  try {
    json = JSON.parse(stdout);
  } catch (e) {
    throw util.jsonError(500, `تعذر تحليل خصائص الملف ${path.basename(p)}`);
  }
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const v = streams.find((s) => s.codec_type === 'video');
  const a = streams.find((s) => s.codec_type === 'audio');
  let duration = null;
  if (json.format && json.format.duration != null) duration = parseFloat(json.format.duration);
  if (!Number.isFinite(duration) && v && v.duration != null) duration = parseFloat(v.duration);
  if (!v || !v.width || !v.height || !Number.isFinite(duration) || duration <= 0) {
    throw util.jsonError(400, `الملف ${path.basename(p)} ليس فيديو صالحًا أو تعذر قراءة خصائصه الأساسية`);
  }
  return {
    duration,
    width: Number(v.width),
    height: Number(v.height),
    fps: parseFps(v.r_frame_rate) || parseFps(v.avg_frame_rate),
    hasAudio: !!a,
    vCodec: v.codec_name || null,
    aCodec: a ? a.codec_name || null : null,
  };
}

/* ------------------------------------------------------------------ */
/* تنزيل المصادر البعيدة إلى /tmp مع حد حجم ومهلة                      */
/* ------------------------------------------------------------------ */

async function downloadToTmp(url, tmpDir, cfgV, onProgress) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (e) {
    throw util.jsonError(400, `الرابط غير صالح: ${url}`);
  }
  const base = path.basename(parsed.pathname || '') || 'video';
  const safeBase = base.replace(/[^\w.\-]+/g, '_').slice(0, 80) || 'video';
  const dest = path.join(tmpDir, `src_${crypto.randomBytes(4).toString('hex')}_${safeBase}`);
  const maxBytes = cfgV.SOURCE_MAX_MB * 1024 * 1024;
  const timeoutMs = cfgV.DOWNLOAD_TIMEOUT_SEC * 1000;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error('TIMEOUT')), timeoutMs);
  let res;
  try {
    res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
  } catch (e) {
    clearTimeout(timer);
    const msg = (e && (e.name === 'AbortError' || /TIMEOUT/.test(String(e.message || e.cause))))
      ? `انتهت مهلة تنزيل المصدر (${cfgV.DOWNLOAD_TIMEOUT_SEC} ثانية): ${url}`
      : `تعذر تنزيل المصدر: ${url} — ${e.message}`;
    throw util.jsonError(400, msg);
  }

  if (!res.ok) {
    clearTimeout(timer);
    try { if (res.body) await res.body.cancel(); } catch (e) { /* تجاهل */ }
    throw util.jsonError(400, `تعذر تنزيل المصدر: ${url} — رمز الاستجابة ${res.status}`);
  }

  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    clearTimeout(timer);
    try { if (res.body) await res.body.cancel(); } catch (e) { /* تجاهل */ }
    throw util.jsonError(413, `حجم المصدر ${url} (${util.mb(declared)}MB) تجاوز الحد المسموح (${cfgV.SOURCE_MAX_MB}MB)`);
  }

  let received = 0;
  let lastFrac = 0;
  try {
    const nodeStream = Readable.fromWeb(res.body);
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (e) => {
        if (settled) return;
        settled = true;
        if (e) reject(e); else resolve();
      };
      nodeStream.on('error', (e) => {
        if (/TOO_BIG/.test(String(e.message))) {
          done(util.jsonError(413, `حجم المصدر ${url} تجاوز الحد المسموح (${cfgV.SOURCE_MAX_MB}MB) أثناء التنزيل`));
        } else if (e && (e.name === 'AbortError' || /TIMEOUT/.test(String(e.message || e.cause)))) {
          done(util.jsonError(400, `انتهت مهلة تنزيل المصدر (${cfgV.DOWNLOAD_TIMEOUT_SEC} ثانية): ${url}`));
        } else {
          done(util.jsonError(400, `فشل تنزيل المصدر: ${url} — ${e.message}`));
        }
      });
      nodeStream.on('data', (c) => {
        received += c.length;
        if (received > maxBytes) {
          nodeStream.destroy(new Error('TOO_BIG'));
          return;
        }
        if (typeof onProgress === 'function' && Number.isFinite(declared) && declared > 0) {
          const frac = received / declared;
          if (frac - lastFrac >= 0.05 || frac >= 1) {
            lastFrac = frac;
            onProgress(Math.min(1, frac));
          }
        }
      });
      const ws = fs.createWriteStream(dest);
      ws.on('error', (e) => done(util.jsonError(500, `تعذر كتابة المصدر إلى القرص المؤقت: ${e.message}`)));
      ws.on('finish', () => done(null));
      nodeStream.pipe(ws);
    });
  } finally {
    clearTimeout(timer);
  }

  if (received === 0) throw util.jsonError(400, `المصدر ${url} أعاد محتوى فارغًا`);
  return dest;
}

/* ------------------------------------------------------------------ */
/* mergeFiles — دالة نقية (بلا قاعدة بيانات) قابلة للاختبار مباشرة      */
/* ------------------------------------------------------------------ */

function evenDim(n) {
  let v = Math.max(2, Math.floor(Number(n) || 2));
  if (v % 2 !== 0) v -= 1;
  return Math.max(2, v);
}

async function mergeFiles(inputPaths, outPath, opts) {
  const options = opts || {};
  if (!Array.isArray(inputPaths) || inputPaths.length < 2) {
    throw util.jsonError(400, 'يلزم مصدران على الأقل لدمج الفيديوهات');
  }
  const preset = options.preset || util.cfg().FFMPEG_PRESET;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const infos = [];
  for (const p of inputPaths) infos.push(await probeFile(p));

  const totalDuration = infos.reduce((s, i) => s + i.duration, 0);
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw util.jsonError(400, 'تعذر حساب المدة الإجمالية للمصادر');
  }
  const maxDur = util.cfg().MAX_TOTAL_DURATION_SEC;
  if (totalDuration > maxDur) {
    throw util.jsonError(400, `المدة الإجمالية للمصادر (${Math.round(totalDuration)} ثانية) تجاوز الحد المسموح (${maxDur} ثانية)`);
  }

  const maxW = Math.max(...infos.map((i) => i.width));
  const maxH = Math.max(...infos.map((i) => i.height));
  const W = evenDim(Math.min(maxW, TARGET_MAX_W));
  const H = evenDim(Math.min(maxH, TARGET_MAX_H));

  // مدخلات الفيديو الحقيقية أولًا ثم مدخلات anullsrc للمصادر الصامتة
  const args = ['-nostdin', '-y'];
  for (const p of inputPaths) args.push('-i', p);

  const chain = [];
  const concatLabels = [];
  let lavfiIndex = inputPaths.length;

  for (let i = 0; i < inputPaths.length; i++) {
    const info = infos[i];
    chain.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=${FPS},setsar=1,format=yuv420p[v${i}]`
    );
    if (info.hasAudio) {
      chain.push(`[${i}:a]aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    } else {
      args.push('-f', 'lavfi', '-t', info.duration.toFixed(3), '-i', `anullsrc=r=${AUDIO_RATE}:cl=stereo`);
      chain.push(`[${lavfiIndex}:a]aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
      lavfiIndex++;
    }
    concatLabels.push(`[v${i}][a${i}]`);
  }

  const filter = `${chain.join(';')};${concatLabels.join('')}concat=n=${inputPaths.length}:v=1:a=1[vout][aout]`;

  args.push(
    '-filter_complex', filter,
    '-map', '[vout]', '-map', '[aout]',
    '-c:v', 'libx264', '-crf', '18', '-preset', preset,
    '-c:a', 'aac', '-b:a', '192k', '-ar', String(AUDIO_RATE),
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    outPath
  );

  const bin = util.ffmpegPath();
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(util.jsonError(500, `تعذر تشغيل ffmpeg: ${e.message}`));
    }
    const errLines = [];
    child.stderr.on('data', (d) => {
      for (const line of d.toString('utf8').split('\n')) {
        if (line.trim()) errLines.push(line.trim());
        if (errLines.length > 60) errLines.shift();
      }
    });
    child.on('error', (e) => {
      reject(util.jsonError(500, e.code === 'ENOENT' ? 'ffmpeg غير مثبت على الخادم' : `تعذر تشغيل ffmpeg: ${e.message}`));
    });

    const rl = readline.createInterface({ input: child.stdout });
    let lastPct = -1;
    rl.on('line', (line) => {
      // out_time_us بالميكروثانية (وout_time_ms في ffmpeg هو أيضًا ميكروثانية تاريخيًا)
      const m = /out_time_us=(\d+)/.exec(line) || /out_time_ms=(\d+)/.exec(line);
      if (m && totalDuration > 0 && onProgress) {
        const sec = Number(m[1]) / 1e6;
        const pct = Math.max(0, Math.min(100, Math.round((sec / totalDuration) * 100)));
        if (pct > lastPct) {
          lastPct = pct;
          onProgress(pct);
        }
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        if (onProgress && lastPct < 100) onProgress(100);
        return resolve();
      }
      const tail = errLines.slice(-4).join(' | ');
      reject(util.jsonError(500, `فشل ترميز الفيديو عبر ffmpeg (كود ${code}): ${tail || 'خطأ غير معروف'}`));
    });
  });

  const st = await fsp.stat(outPath);
  if (!st.size) throw util.jsonError(500, 'الناتج فارغ بعد الترميز');
  const outInfo = await probeFile(outPath);
  return {
    size: st.size,
    duration: outInfo.duration,
    width: outInfo.width,
    height: outInfo.height,
    vCodec: outInfo.vCodec,
    aCodec: outInfo.aCodec,
    totalSourceDuration: totalDuration,
  };
}

/** تنزيل مع إعادة محاولة تلقائية — صور Pollinations قد ترد 503/402 عابرة عند ازدحام الخدمة المجانية */
async function downloadWithRetry(url, tmpDir, cfgV, onProgress, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await downloadToTmp(url, tmpDir, cfgV, onProgress);
    } catch (e) {
      lastErr = e;
      const code = e && e.statusCode;
      // الأخطاء الحتمية (413 حجم) لا تُعاد
      if (code === 413) throw e;
      if (i < attempts - 1) await util.sleep(6000 * (i + 1));
    }
  }
  throw lastErr;
}

/* ------------------------------------------------------------------ */
/* وضع الريلز — بناء فيديو من صور بحركة كاميرا وانتقالات ناعمة          */
/* ------------------------------------------------------------------ */

/** مدة الانتقال بين المشاهد (ثوانٍ) */
const FADE_SEC = 0.6;

/** تحليل خيارات الريلز المخزنة في المهمة مع قيم افتراضية آمنة */
function parseSlideOptions(json) {
  let o = {};
  try { o = json ? JSON.parse(json) : {}; } catch (e) { o = {}; }
  const clamp = (v, lo, hi, def) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
  };
  const even = (v, lo, hi, def) => {
    let n = clamp(v, lo, hi, def);
    if (n % 2 !== 0) n -= 1;
    return Math.max(2, n);
  };
  return {
    sceneDuration: clamp(o.sceneDuration, 2, 8, 4),
    transition: o.transition === 'cut' ? 'cut' : 'fade',
    width: even(o.width, 240, 1080, 720),
    height: even(o.height, 240, 1920, 1280),
  };
}

/** ffprobe للتحقق أن الملف صورة صالحة (بلا فحص مدة كما في الفيديو) */
async function probeImage(p) {
  const bin = util.ffprobePath();
  const args = ['-v', 'error', '-print_format', 'json', '-show_streams', p];
  const { stdout } = await runCapture(bin, args);
  let json;
  try {
    json = JSON.parse(stdout);
  } catch (e) {
    throw util.jsonError(400, `تعذر تحليل الصورة ${path.basename(p)}`);
  }
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const v = streams.find((s) => s.codec_type === 'video');
  if (!v || !v.width || !v.height) {
    throw util.jsonError(400, `الملف ${path.basename(p)} ليس صورة صالحة`);
  }
  return { width: Number(v.width), height: Number(v.height) };
}

/**
 * slideshowFiles — دالة نقية تبني ريلًا من صور:
 * - كل صورة: تكبير مسبق ×2 ثم zoompan بحركة تبادلية (تقريب/إبعاد) لمشهد D ثانية
 * - الانتقالات: xfade تدريجي بين المشاهد (أو قطع مباشر transition=cut)
 * - مسار صوت صامت anullsrc ليتعامل معه كل المشغلات والمنصات
 * - تقدم حقيقي عبر -progress pipe:1 (المدة الكلية معلومة مسبقًا)
 */
async function slideshowFiles(inputPaths, outPath, opts) {
  if (!Array.isArray(inputPaths) || inputPaths.length < 1) {
    throw util.jsonError(400, 'يلزم صورة واحدة على الأقل لبناء الريل');
  }
  const preset = opts.preset || util.cfg().FFMPEG_PRESET;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const W = evenDim(opts.width || 720);
  const H = evenDim(opts.height || 1280);
  const D = Math.max(2, Math.min(8, Math.floor(Number(opts.sceneDuration) || 4)));
  const N = inputPaths.length;
  const F = opts.transition === 'fade' && N > 1 ? FADE_SEC : 0;
  const totalDuration = N * D - (N - 1) * F;
  const frames = D * FPS;

  const args = ['-nostdin', '-y'];
  for (const p of inputPaths) {
    args.push('-loop', '1', '-framerate', String(FPS), '-t', D.toFixed(3), '-i', p);
  }
  args.push('-f', 'lavfi', '-t', totalDuration.toFixed(3), '-i', `anullsrc=r=${AUDIO_RATE}:cl=stereo`);

  const parts = [];
  const labels = [];
  for (let i = 0; i < N; i++) {
    const zExpr = i % 2 === 0 ? `1+0.12*on/${frames}` : `1.12-0.12*on/${frames}`;
    parts.push(
      `[${i}:v]scale=${W * 2}:${H * 2}:force_original_aspect_ratio=increase,` +
      `crop=${W * 2}:${H * 2},` +
      `zoompan=z='${zExpr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:fps=${FPS}:s=${W}x${H},` +
      `format=yuv420p,setsar=1[v${i}]`
    );
    labels.push(`[v${i}]`);
  }

  let xout;
  if (N === 1) {
    xout = '[v0]';
  } else if (F > 0) {
    let prev = '[v0]';
    for (let k = 1; k < N; k++) {
      const off = (k * (D - F)).toFixed(3);
      const outLbl = k === N - 1 ? 'xout' : `fx${k}`;
      parts.push(`${prev}${labels[k]}xfade=transition=fade:duration=${F}:offset=${off}[${outLbl}]`);
      prev = `[${outLbl}]`;
    }
    xout = '[xout]';
  } else {
    parts.push(`${labels.join('')}concat=n=${N}:v=1:a=0[xout]`);
    xout = '[xout]';
  }
  parts.push(`[${N}:a]aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[aout]`);

  args.push(
    '-filter_complex', parts.join(';'),
    '-map', xout, '-map', '[aout]',
    '-t', totalDuration.toFixed(3),
    '-c:v', 'libx264', '-crf', '19', '-preset', preset,
    '-c:a', 'aac', '-b:a', '128k', '-ar', String(AUDIO_RATE),
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    outPath
  );

  const bin = util.ffmpegPath();
  await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return reject(util.jsonError(500, `تعذر تشغيل ffmpeg: ${e.message}`));
    }
    const errLines = [];
    child.stderr.on('data', (d) => {
      for (const line of d.toString('utf8').split('\n')) {
        if (line.trim()) errLines.push(line.trim());
        if (errLines.length > 60) errLines.shift();
      }
    });
    child.on('error', (e) => {
      reject(util.jsonError(500, e.code === 'ENOENT' ? 'ffmpeg غير مثبت على الخادم' : `تعذر تشغيل ffmpeg: ${e.message}`));
    });

    const rl = readline.createInterface({ input: child.stdout });
    let lastPct = -1;
    rl.on('line', (line) => {
      const m = /out_time_us=(\d+)/.exec(line) || /out_time_ms=(\d+)/.exec(line);
      if (m && totalDuration > 0 && onProgress) {
        const sec = Number(m[1]) / 1e6;
        const pct = Math.max(0, Math.min(100, Math.round((sec / totalDuration) * 100)));
        if (pct > lastPct) {
          lastPct = pct;
          onProgress(pct);
        }
      }
    });

    child.on('close', (code) => {
      if (code === 0) {
        if (onProgress && lastPct < 100) onProgress(100);
        return resolve();
      }
      const tail = errLines.slice(-4).join(' | ');
      reject(util.jsonError(500, `فشل ترميز الريل عبر ffmpeg (كود ${code}): ${tail || 'خطأ غير معروف'}`));
    });
  });

  const st = await fsp.stat(outPath);
  if (!st.size) throw util.jsonError(500, 'الناتج فارغ بعد الترميز');
  const outInfo = await probeFile(outPath);
  return {
    size: st.size,
    duration: outInfo.duration,
    width: outInfo.width,
    height: outInfo.height,
    vCodec: outInfo.vCodec,
    aCodec: outInfo.aCodec,
    totalSourceDuration: totalDuration,
  };
}

/* ------------------------------------------------------------------ */
/* processJob — الطبقة العليا: تحضير المصادر ثم الدمج ثم التخزين        */
/* ------------------------------------------------------------------ */

function donePayload(job, origin) {
  const videoUrl = job.videoUrl || (origin ? `${origin}/api/jobs/${job.id}/video` : null);
  return {
    status: 'done',
    jobId: job.id,
    videoUrl,
    downloadUrl: videoUrl ? `${videoUrl}?download=1` : null,
    size: job.size,
    duration: job.duration,
    resolution: job.resolution,
    expiresAt: job.expiresAt,
  };
}

async function processJob(jobId, origin) {
  const job = await db.getJob(jobId);
  if (!job) throw util.jsonError(404, 'المهمة غير موجودة أو انتهت صلاحيتها');

  if (job.status === 'uploading') {
    throw util.jsonError(409, 'ملفات المصادر لم تكتمل — أكمل رفع جميع الأجزاء ثم أعد المحاولة');
  }
  if (job.status === 'processing') {
    const e = util.jsonError(409, 'المهمة قيد المعالجة بالفعل');
    e.payload = { status: 'processing', jobId, progress: job.progress };
    e.statusCode = 202;
    throw e;
  }
  if (job.status === 'done') {
    return donePayload(job, origin);
  }

  // حجز ذرّي — يسمح بـ queued وfailed (إعادة محاولة بعد الفشل)
  const claimed = await db.claimForProcessing(jobId);
  if (!claimed) {
    const fresh = await db.getJob(jobId);
    if (fresh && fresh.status === 'processing') {
      const e = util.jsonError(409, 'المهمة قيد المعالجة بالفعل');
      e.payload = { status: 'processing', jobId, progress: fresh.progress };
      e.statusCode = 202;
      throw e;
    }
    if (fresh && fresh.status === 'done') return donePayload(fresh, origin);
    if (fresh && fresh.status === 'uploading') {
      throw util.jsonError(409, 'ملفات المصادر لم تكتمل — أكمل رفع جميع الأجزاء ثم أعد المحاولة');
    }
    throw util.jsonError(409, 'حالة المهمة الحالية لا تسمح ببدء المعالجة');
  }

  return runPipeline(jobId, origin, await db.getJob(jobId));
}

async function runPipeline(jobId, origin, jobRow) {
  const job = jobRow || (await db.getJob(jobId));
  const cfgV = util.cfg();
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'merger-'));
  let lastWritten = 0;

  const setProgress = async (pct) => {
    const p = Math.max(0, Math.min(100, Math.round(pct)));
    if (p > lastWritten) {
      lastWritten = p;
      try { await db.updateJob(jobId, { progress: p }); } catch (e) { /* لا نُفشل المهمة لفشل التقدم */ }
    }
  };

  try {
    await setProgress(5);
    const sources = await db.getSources(jobId);
    if (!sources.length) throw util.jsonError(400, 'المهمة لا تحتوي أي مصادر');
    const isSlideshow = job.mode === 'slideshow';
    const slideOpts = isSlideshow ? parseSlideOptions(job.optionsJson) : null;

    // 1) تحضير المصادر محليًا (تنزيل الروابط أو تجميع الأجزاء) + ffprobe — تقدم 5..35 ثم 38
    const n = sources.length;
    const localPaths = [];
    const infos = [];
    for (let i = 0; i < n; i++) {
      const s = sources[i];
      const base = 5 + (30 * i) / n;
      const span = 30 / n;
      const onSrcProgress = (frac) => setProgress(base + span * Math.max(0, Math.min(1, frac)));

      let p;
      if (s.kind === 'url') {
        p = isSlideshow
          ? await downloadWithRetry(s.url, tmpDir, cfgV, onSrcProgress, 3)
          : await downloadToTmp(s.url, tmpDir, cfgV, onSrcProgress);
      } else if (s.kind === 'file') {
        const safeName = String(s.name || `source_${s.seq}`).replace(/[^\w.\-]+/g, '_').slice(0, 80) || `source_${s.seq}`;
        p = path.join(tmpDir, `src${i}_${safeName}`);
        await storage.readSourceToTmp(jobId, s.seq, p);
        onSrcProgress(1);
      } else {
        throw util.jsonError(400, `نوع مصدر غير معروف (${s.kind}) في الموضع ${i + 1}`);
      }

      // الريلز: التحقق أن المصدر صورة صالحة (بلا مدة/صوت) — الدمج: فحص فيديو كامل
      const info = isSlideshow ? await probeImage(p) : await probeFile(p);
      if (!isSlideshow) {
        await db.updateSource(s.id, {
          duration: info.duration,
          width: info.width,
          height: info.height,
          hasAudio: info.hasAudio ? 1 : 0,
        });
      }
      localPaths.push(p);
      infos.push(info);
    }
    await db.syncSourcesJson(jobId);
    await setProgress(38);

    // 2) حساب المدة الإجمالية والتحقق منها قبل الترميز
    let totalDuration;
    if (isSlideshow) {
      const fade = slideOpts.transition === 'fade' && localPaths.length > 1 ? FADE_SEC : 0;
      totalDuration = localPaths.length * slideOpts.sceneDuration - (localPaths.length - 1) * fade;
    } else {
      totalDuration = infos.reduce((s, i) => s + i.duration, 0);
    }
    if (totalDuration > cfgV.MAX_TOTAL_DURATION_SEC) {
      throw util.jsonError(400, `المدة الإجمالية للمصادر (${Math.round(totalDuration)} ثانية) تجاوز الحد المسموح (${cfgV.MAX_TOTAL_DURATION_SEC} ثانية)`);
    }

    // 3) الترميز — تقدم 40..90
    const outPath = path.join(tmpDir, 'output.mp4');
    const result = isSlideshow
      ? await slideshowFiles(localPaths, outPath, {
          sceneDuration: slideOpts.sceneDuration,
          transition: slideOpts.transition,
          width: slideOpts.width,
          height: slideOpts.height,
          preset: cfgV.FFMPEG_PRESET,
          onProgress: (pct) => setProgress(40 + pct * 0.5),
        })
      : await mergeFiles(localPaths, outPath, {
          preset: cfgV.FFMPEG_PRESET,
          onProgress: (pct) => setProgress(40 + pct * 0.5),
        });

    // 4) تحقق حجم الناتج قبل التخزين
    if (result.size > cfgV.OUTPUT_MAX_MB * 1024 * 1024) {
      throw util.jsonError(413, `حجم الفيديو الناتج (${util.mb(result.size)}MB) تجاوز الحد المسموح (${cfgV.OUTPUT_MAX_MB}MB)`);
    }

    // 5) تخزين الناتج — تقدم 90..99
    await setProgress(90);
    const outBuf = await fsp.readFile(outPath);
    await storage.writeOutput(jobId, outBuf, (p) => setProgress(90 + p * 0.09));
    await setProgress(99);

    // 6) إنجاز المهمة وحذف أجزاء المصادر بعد النجاح
    const videoUrl = `${origin}/api/jobs/${jobId}/video`;
    await db.updateJob(jobId, {
      status: 'done',
      progress: 100,
      error: null,
      videoUrl,
      size: result.size,
      duration: Math.round(result.duration * 1000) / 1000,
      resolution: `${result.width}x${result.height}`,
    });
    await db.deleteSourceChunks(jobId);

    const fresh = await db.getJob(jobId);
    return {
      status: 'done',
      jobId,
      videoUrl,
      downloadUrl: `${videoUrl}?download=1`,
      size: result.size,
      duration: Math.round(result.duration * 100) / 100,
      resolution: `${result.width}x${result.height}`,
      expiresAt: fresh ? fresh.expiresAt : null,
    };
  } catch (e) {
    const msg = e && e.message ? String(e.message).slice(0, 500) : 'فشل غير متوقع أثناء المعالجة';
    try {
      await db.updateJob(jobId, { status: 'failed', error: msg });
    } catch (e2) { /* تجاهل فشل تسجيل الفشل */ }
    throw e;
  } finally {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
    } catch (e) { /* نظافة أخيرة */ }
  }
}

module.exports = {
  mergeFiles,
  slideshowFiles,
  probeImage,
  parseSlideOptions,
  processJob,
  probeFile,
  downloadToTmp,
  donePayload,
};
