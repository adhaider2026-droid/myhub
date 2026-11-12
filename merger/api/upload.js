'use strict';

/** POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB) */

const util = require('../lib/util');
const db = require('../lib/db');
const storage = require('../lib/storage');

module.exports = async (req, res) => {
  if (util.handleOptions(req, res)) return;
  if (req.method !== 'POST') return util.methodNotAllowed(res, 'POST, OPTIONS');

  const q = req.query || {};
  const jobId = String(q.job || '').trim();
  const seq = Number(q.seq);
  const chunkIndex = Number(q.chunk);
  if (!jobId || !Number.isInteger(seq) || !Number.isInteger(chunkIndex) || seq < 0 || chunkIndex < 0) {
    return util.sendError(res, 400, 'المعطيات مطلوبة: job معرّف المهمة، seq ترتيب المصدر، chunk ترتيب الجزء');
  }

  try {
    await db.ensureSchema();
    const cfgV = util.cfg();
    const job = await db.getJob(jobId);
    if (!job) return util.sendError(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها');
    if (job.status !== 'uploading') {
      return util.sendError(res, 409, `حالة المهمة (${job.status}) لا تسمح بالرفع — الرفع مسموح فقط أثناء uploading`);
    }

    const sources = await db.getSources(jobId);
    const source = sources.find((s) => s.seq === seq && s.kind === 'file');
    if (!source) return util.sendError(res, 404, 'مصدر الملف غير موجود في هذه المهمة');
    if (source.ready) return util.sendError(res, 409, 'هذا المصدر مكتمل الرفع مسبقًا');
    if (chunkIndex >= source.chunkCount) {
      return util.sendError(res, 400, `ترتيب الجزء (${chunkIndex}) خارج النطاق — عدد الأجزاء المتوقع: ${source.chunkCount}`);
    }

    const buf = await util.readRawBody(req, cfgV.UPLOAD_CHUNK_BYTES);
    if (!buf.length) return util.sendError(res, 400, 'جسم الطلب فارغ — أرسل البيانات الثنائية الخام');
    if (chunkIndex < source.chunkCount - 1 && buf.length !== cfgV.UPLOAD_CHUNK_BYTES) {
      return util.sendError(res, 400, `حجم الجزء الوسيط غير صالح (${buf.length} بايت) — المتوقع ${cfgV.UPLOAD_CHUNK_BYTES}`);
    }

    await storage.appendSourceChunk(jobId, seq, chunkIndex, buf, cfgV.UPLOAD_CHUNK_BYTES);

    // حدّث عدّاد الأجزاء المستلمة للمصدر ومزامنة القائمة
    // ملاحظة: التخزين يقسم كل جزء رفع إلى صفوف 2MB (ROW_BYTES) — لذا نحول عدد الصفوف
    // إلى وحدات أجزاء الرفع قبل العد حتى لا يُعلن الاكتمال مبكرًا.
    const rowsForSeq = (await db.q(
      'SELECT COUNT(*) AS c FROM source_chunks WHERE job_id = ? AND seq = ?',
      [jobId, seq]
    ))[0].c;
    const rowsPerChunk = Math.max(1, Math.round(cfgV.UPLOAD_CHUNK_BYTES / util.ROW_BYTES));
    const receivedNow = Math.ceil(Number(rowsForSeq) / rowsPerChunk);
    await db.updateSource(source.id, { receivedChunks: receivedNow });
    await db.syncSourcesJson(jobId);

    const freshSources = await db.getSources(jobId);
    const allReceived = await db.sumFileReceivedChunks(jobId);
    const totalExpected = freshSources
      .filter((s) => s.kind === 'file')
      .reduce((s, x) => s + x.chunkCount, 0);
    let doneAll = false;
    if (allReceived >= totalExpected) {
      // كل الأجزاء وصلت → علّم المصادر جاهزة والمهمة queued
      for (const s of freshSources) {
        if (s.kind === 'file' && !s.ready) {
          await db.updateSource(s.id, { ready: 1 });
        }
      }
      await db.updateJob(jobId, { status: 'queued', receivedUploads: freshSources.filter((s) => s.kind === 'file').length });
      doneAll = true;
    } else {
      await db.updateJob(jobId, { receivedUploads: job.receivedUploads + 1 });
    }

    return util.sendJson(res, 200, {
      ok: true,
      received: Number(receivedNow),
      total: source.chunkCount,
      done: doneAll,
    });
  } catch (e) {
    const code = e && e.statusCode ? e.statusCode : 500;
    return util.sendError(res, code, e && e.message ? e.message : 'خطأ غير متوقع');
  }
};
