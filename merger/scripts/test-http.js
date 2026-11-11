'use strict';

/**
 * اختبار HTTP كامل ضد dev-server (المنفذ 3001):
 * إنشاء من روابط → دمج → بث Range → مهمة مختلطة (رابط + ملف مرفوع) → الرفضات → الحذف → 404.
 * السكربت يشغّل الخادم بنفسه ثم يطفئه ويحذف كل آثار الاختبار.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.MERGER_PORT || 3001);
const BASE = `http://localhost:${PORT}`;
const FIXTURES = path.join(__dirname, '..', '.tmp-fixtures');

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
const createdJobs = [];

async function api(method, urlPath, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  let body = opts.body;
  if (opts.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = opts.json === null ? 'json-typo{' : JSON.stringify(opts.json);
  }
  const res = await fetch(BASE + urlPath, { method, headers, body, signal: opts.signal });
  let data = null;
  const text = await res.text();
  try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  return { status: res.status, headers: res.headers, data };
}

async function waitServer(ms = 15000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(`${BASE}/api/config`);
      if (r.ok) return true;
    } catch (e) { /* لم يجهز بعد */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  if (!fs.existsSync(path.join(FIXTURES, 'a.mp4'))) {
    console.log('تشغيل اختبار الوحدات أولًا لتوليد الملفات المصدرية…');
    const { execFileSync } = require('child_process');
    execFileSync('node', [path.join(__dirname, 'test-unit.js')], { stdio: 'inherit' });
  }
  const aUrl = `${BASE}/files/a.mp4`;
  const bUrl = `${BASE}/files/b.mp4`;

  // تشغيل الخادم
  const server = spawn('node', [path.join(__dirname, '..', 'dev-server.js')], {
    env: Object.assign({}, process.env, { MERGER_PORT: String(PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  try {
    check('dev-server جاهز', await waitServer());

    console.log('== الإعدادات و CORS ==');
    const cfg = await api('GET', '/api/config');
    check('GET /api/config → 200', cfg.status === 200);
    check('config: maxSources = 10', cfg.data.maxSources === 10);
    const opt = await fetch(`${BASE}/api/jobs`, { method: 'OPTIONS' });
    check('OPTIONS → 204 مع CORS', opt.status === 204 && opt.headers.get('access-control-allow-origin') === '*');

    console.log('== 1) مهمة من روابط: إنشاء → دمج → بث ==');
    const created = await api('POST', '/api/jobs', { json: { videos: [aUrl, bUrl] } });
    check('POST /api/jobs → 201', created.status === 201, `status=${created.status}`);
    const jobId = created.data.jobId;
    createdJobs.push(jobId);
    check('استجابة الإنشاء: jobId + statusUrl + processUrl + expiresAt',
      !!jobId && !!created.data.statusUrl && !!created.data.processUrl && !!created.data.expiresAt);

    const t0 = Date.now();
    const proc = await api('POST', `/api/jobs/${jobId}/process`);
    check('POST process → 200 done', proc.status === 200 && proc.data.status === 'done',
      `(${((Date.now() - t0) / 1000).toFixed(1)} ثانية)`);
    check('videoUrl على نطاق الخدمة نفسها', typeof proc.data.videoUrl === 'string'
      && proc.data.videoUrl.includes(`/api/jobs/${jobId}/video`)
      && !proc.data.videoUrl.includes('localhost:' + PORT + '/files'), proc.data.videoUrl);
    check('الميتا: الحجم/المدة/الدقة موجودة',
      proc.data.size > 0 && proc.data.duration > 0 && /^\d+x\d+$/.test(proc.data.resolution || ''),
      `${proc.data.resolution} / ${proc.data.duration}ث`);
    check('الدقة = أكبر دقة (1280x720)', proc.data.resolution === '1280x720');
    check('المدة ≈ مجموع المدد (9ث)', Math.abs((proc.data.duration || 0) - 9) <= 1.2, `${(proc.data.duration || 0).toFixed(2)}`);

    const st = await api('GET', `/api/jobs/${jobId}`);
    check('GET /api/jobs/{id} → done + progress 100', st.status === 200 && st.data.status === 'done' && st.data.progress === 100);

    const range = await fetch(`${BASE}/api/jobs/${jobId}/video`, { headers: { Range: 'bytes=0-99' } });
    check('بث الناتج: Range → 206 + Content-Range',
      range.status === 206 && range.headers.get('content-range') === `bytes 0-99/${proc.data.size}`,
      range.headers.get('content-range'));
    const full = await fetch(`${BASE}/api/jobs/${jobId}/video`);
    check('بث كامل → 200 مع Content-Length', full.status === 200 && Number(full.headers.get('content-length')) === proc.data.size);
    const dl = await fetch(`${BASE}/api/jobs/${jobId}/video?download=1`, { method: 'HEAD' });
    check('download=1 → Content-Disposition attachment', (dl.headers.get('content-disposition') || '').includes('attachment'));

    console.log('== 2) مهمة مختلطة (رابط + ملف مرفوع) مع إعادة محاولة رفع ==');
    const fileBuf = fs.readFileSync(path.join(FIXTURES, 'a.mp4'));
    const mixed = await api('POST', '/api/jobs', {
      json: { sources: [
        { kind: 'url', url: bUrl },
        { kind: 'file', name: 'uploaded.mp4', size: fileBuf.length, mime: 'video/mp4' },
      ] },
    });
    check('إنشاء مهمة مختلطة → 201 مع uploads[]', mixed.status === 201 && Array.isArray(mixed.data.uploads) && mixed.data.uploads.length === 1);
    const mJob = mixed.data.jobId;
    createdJobs.push(mJob);
    check('status = uploading + uploadChunkBytes', mixed.data.status === 'uploading' && mixed.data.uploadChunkBytes > 0);
    const up = mixed.data.uploads[0];
    const bytes = mixed.data.uploadChunkBytes;
    const totalChunks = up.totalChunks;

    // محاولة فاشلة متعمدة أولًا: جزء وسيط بقصير خاطئ → يرفض → ثم الرفع الصحيح ينجح
    const midChunk = totalChunks > 1 ? 1 : 0;
    if (totalChunks > 1) {
      const bad = await fetch(`${BASE}/api/upload?job=${mJob}&seq=${up.seq}&chunk=${midChunk}`, {
        method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: Buffer.alloc(100), // وسيط قصير → يجب أن يرفض
      });
      check('رفض جزء وسيط ناقص → 400', bad.status === 400);
    }
    for (let c = 0; c < totalChunks; c++) {
      const slice = fileBuf.subarray(c * bytes, Math.min((c + 1) * bytes, fileBuf.length));
      const r = await api('POST', `/api/upload?job=${mJob}&seq=${up.seq}&chunk=${c}`, {
        body: Buffer.from(slice), headers: { 'Content-Type': 'application/octet-stream' },
      });
      check(`رفع الجزء ${c + 1}/${totalChunks} → ok`, r.status === 200 && r.data.ok === true);
    }
    const mProc = await api('POST', `/api/jobs/${mJob}/process`);
    check('دمج المهمة المختلطة → done', mProc.status === 200 && mProc.data.status === 'done', mProc.data.resolution);
    check('المدة ≈ 9 ثوانٍ (مقطعان)', Math.abs((mProc.data.duration || 0) - 9) <= 1.2);

    console.log('== 3) الرفضات والحدود ==');
    const one = await api('POST', '/api/jobs', { json: { videos: [aUrl] } });
    check('مقطع واحد → 400', one.status === 400);
    const eleven = await api('POST', '/api/jobs', { json: { videos: Array.from({ length: 11 }, () => aUrl) } });
    check('11 مصدرًا → 400', eleven.status === 400);
    const badProto = await api('POST', '/api/jobs', { json: { videos: ['ftp://example.com/x.mp4', bUrl] } });
    check('بروتوكول غير http → 400', badProto.status === 400);
    const badJson = await api('POST', '/api/jobs', { json: null });
    check('JSON تالف → 400', badJson.status === 400);
    const big = Buffer.alloc(4194304 + 1000, 7); // أكبر من 4MB
    // مهمة رفع جديدة في حالة uploading — عليها نختبر 413 ثم 409
    const inc = await api('POST', '/api/jobs', {
      json: { sources: [
        { kind: 'url', url: aUrl },
        { kind: 'file', name: 'partial.mp4', size: 4194304 * 2, mime: 'video/mp4' },
      ] },
    });
    createdJobs.push(inc.data.jobId);
    const incSeq = inc.data.uploads[0].seq;
    const bigUp = await fetch(`${BASE}/api/upload?job=${inc.data.jobId}&seq=${incSeq}&chunk=0`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: big,
    });
    check('رفع جزء > 4MB → 413', bigUp.status === 413, `الفعلي: ${bigUp.status}`);
    await api('POST', `/api/upload?job=${inc.data.jobId}&seq=${incSeq}&chunk=0`, {
      body: Buffer.alloc(4194304, 1), headers: { 'Content-Type': 'application/octet-stream' },
    });
    const incProc = await api('POST', `/api/jobs/${inc.data.jobId}/process`);
    check('process لمهمة رفعها ناقص → 409', incProc.status === 409, `الفعلي: ${incProc.status}`);

    const missing = await api('GET', '/api/jobs/does-not-exist-123');
    check('GET مهمة غير موجودة → 404', missing.status === 404);

    const wrong = await api('PUT', `/api/jobs/${jobId}`);
    check('طريقة خاطئة → 405', wrong.status === 405);

    console.log('== 4) الحذف الشامل ثم 404 ==');
    const del = await api('DELETE', `/api/jobs/${jobId}`);
    check('DELETE → 200', del.status === 200 && del.data.ok === true);
    const gone = await api('GET', `/api/jobs/${jobId}`);
    check('GET بعد الحذف → 404', gone.status === 404);

    console.log('== 5) التنظيف ==');
    for (const id of createdJobs) {
      await api('DELETE', `/api/jobs/${id}`).catch(() => {});
    }
    createdJobs.length = 0;
    try { fs.rmSync(FIXTURES, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    check('تنظيف كل مهام الاختبار والملفات', true);
  } finally {
    server.kill('SIGTERM');
    if (fail > 0) {
      console.log('\n--- سجل الخادم (آخر 20 سطرًا) ---');
      console.log(serverLog.split('\n').slice(-20).join('\n'));
    }
  }

  console.log(`\nالنتيجة: ${pass} نجاح / ${fail} فشل`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('فشل غير متوقع:', e && e.message);
  process.exit(1);
});
