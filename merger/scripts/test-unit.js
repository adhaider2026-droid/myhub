'use strict';

/**
 * اختبار وحدات محرك الدمج والتخزين:
 * 1) يولّد فيديوهين مختلفي الدقة (أحدهما بلا صوت) بـ ffmpeg
 * 2) يدمجهما عبر mergeFiles مباشرة (بلا HTTP وبلا قاعدة بيانات) ويتحقق من الجودة
 * 3) يختبر تخزين Turso (كتابة/قراءة 5MB + تطابق sha256 + حذف شامل)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const util = require('../lib/util');
const merge = require('../lib/merge');
const storage = require('../lib/storage');

const FIXTURES = path.join(__dirname, '..', '.tmp-fixtures');
util.loadEnvFiles(path.join(__dirname, '..')); // تحميل .env.local/.env يدويًا كما يفعل dev-server
let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log(`  ✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); }
}
function ffmpeg(args) {
  execFileSync(util.ffmpegPath(), args, { stdio: 'pipe' });
}

async function main() {
  fs.mkdirSync(FIXTURES, { recursive: true });
  const aPath = path.join(FIXTURES, 'a.mp4');
  const bPath = path.join(FIXTURES, 'b.mp4');
  const outPath = path.join(os.tmpdir(), `merged-unit-${Date.now()}.mp4`);

  console.log('== 1) توليد مصدري الاختبار بـ ffmpeg ==');
  // a: 640x360 بمدة 5 ثوانٍ مع صوت
  ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30:duration=5',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
    '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'aac', '-shortest', aPath]);
  // b: 1280x720 بمدة 4 ثوانٍ بلا صوت
  ffmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=4',
    '-c:v', 'libx264', '-preset', 'veryfast', bPath]);
  check('توليد a.mp4 (640x360، 5 ثوانٍ، مع صوت)', fs.existsSync(aPath) && fs.statSync(aPath).size > 0);
  check('توليد b.mp4 (1280x720، 4 ثوانٍ، بلا صوت)', fs.existsSync(bPath) && fs.statSync(bPath).size > 0);

  const infoA = await merge.probeFile(aPath);
  const infoB = await merge.probeFile(bPath);
  check('ffprobe: a فيها صوت', infoA.hasAudio === true);
  check('ffprobe: b بلا صوت', infoB.hasAudio === false);

  console.log('== 2) الدمج المباشر عبر mergeFiles ==');
  const progressValues = [];
  const result = await merge.mergeFiles([aPath, bPath], outPath, {
    onProgress: (p) => progressValues.push(p),
  });
  check('اكتمال الدمج', fs.existsSync(outPath) && fs.statSync(outPath).size > 0, `الحجم: ${util.mb(result.size)}MB`);
  check('الدقة = أكبر دقة مدخل (1280x720)', `${result.width}x${result.height}` === '1280x720', `${result.width}x${result.height}`);
  const expectedDur = infoA.duration + infoB.duration;
  check(`المدة ≈ مجموع المدد (${expectedDur.toFixed(1)}ث)`, Math.abs(result.duration - expectedDur) <= 1.2, `${result.duration.toFixed(2)}ث`);
  const outInfo = await merge.probeFile(outPath);
  check('الناتج فيه مسار صوت', outInfo.hasAudio === true);
  check('التقدم وصل 100 وتزايد', progressValues.length > 3 && progressValues[progressValues.length - 1] === 100,
    `${progressValues.length} قراءة`);

  // التحقق من الترميز عبر ffprobe JSON
  const codecOut = execFileSync(util.ffprobePath(), [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name',
    '-of', 'json', outPath,
  ]).toString();
  check('ترميز الفيديو h264', codecOut.includes('h264'));

  console.log('== 3) التخزين في Turso والاسترجاع ==');
  const hasDb = !!process.env.TURSO_DATABASE_URL && !!process.env.TURSO_AUTH_TOKEN;
  if (!hasDb) {
    console.log('  SKIP — متغيرات Turso غير متوفرة');
  } else {
    const db = require('../lib/db');
    await db.ensureSchema();
    const jobId = util.newId();
    const rnd = crypto.randomBytes(5 * 1024 * 1024); // 5MB عشوائي
    let wrote = 0;
    await storage.writeOutput(jobId, rnd, (p) => { wrote = p; });
    check('الكتابة مع تقدم وصل 100', wrote === 100);
    const size = await storage.readOutputSize(jobId);
    check('الحجم المخزن مطابق', size === rnd.length, `${util.mb(size)}MB`);

    // القراءة عبر المولّد وتطابق sha256
    const shaIn = crypto.createHash('sha256').update(rnd).digest('hex');
    const chunks = [];
    for await (const c of storage.outputChunkIterator(jobId, 0, rnd.length - 1)) chunks.push(c);
    const shaOut = crypto.createHash('sha256').update(Buffer.concat(chunks)).digest('hex');
    check('تطابق sha256 بعد الاسترجاع الكامل', shaIn === shaOut);

    // قراءة بنطاق Range جزئي (منتصف الملف)
    const midStart = Math.floor(rnd.length / 3);
    const midEnd = midStart + 999999;
    const midChunks = [];
    for await (const c of storage.outputChunkIterator(jobId, midStart, midEnd)) midChunks.push(c);
    const midBuf = Buffer.concat(midChunks);
    check('تطابق القراءة بنطاق Range جزئي', midBuf.equals(rnd.subarray(midStart, midEnd + 1)));

    await storage.deleteJobData(jobId);
    const after = await storage.readOutputSize(jobId);
    check('الحذف الشامل أفرغ الصفوف', after === 0);
  }

  // نظافة
  try { fs.rmSync(outPath, { force: true }); } catch (e) { /* ignore */ }

  console.log(`\nالنتيجة: ${pass} نجاح / ${fail} فشل`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('فشل غير متوقع:', e && e.message);
  process.exit(1);
});
