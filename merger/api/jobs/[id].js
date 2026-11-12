'use strict';

/** GET /api/jobs/<id> — الحالة والتقدم | DELETE /api/jobs/<id> — حذف شامل فوري */

const util = require('../../lib/util');
const db = require('../../lib/db');

module.exports = async (req, res) => {
  if (util.handleOptions(req, res)) return;

  const id = String((req.query && req.query.id) || '').trim();
  if (!id) return util.sendError(res, 400, 'معرّف المهمة مطلوب');

  try {
    await db.ensureSchema();
    const job = await db.getJob(id);
    if (!job) return util.sendError(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها (تُحذف تلقائيًا بعد 24 ساعة)');

    if (req.method === 'GET') {
      const origin = util.getOrigin(req);
      const body = {
        jobId: job.id,
        status: job.status,
        progress: job.progress,
        videoUrl: job.videoUrl,
        downloadUrl: job.videoUrl ? `${job.videoUrl}?download=1` : null,
        size: job.size,
        duration: job.duration,
        resolution: job.resolution,
        error: job.error || undefined,
        createdAt: job.createdAt,
        expiresAt: job.expiresAt,
        sources: job.status === 'uploading'
          ? (await db.getSources(id)).map((s) => ({
              seq: s.seq, kind: s.kind, name: s.name, size: s.size,
              chunkCount: s.chunkCount, receivedChunks: s.receivedChunks, ready: s.ready,
            }))
          : undefined,
      };
      return util.sendJson(res, 200, body);
    }

    if (req.method === 'DELETE') {
      await db.deleteJobRows(id);
      return util.sendJson(res, 200, { ok: true, deleted: id });
    }

    return util.methodNotAllowed(res, 'GET, DELETE, OPTIONS');
  } catch (e) {
    const code = e && e.statusCode ? e.statusCode : 500;
    return util.sendError(res, code, e && e.message ? e.message : 'خطأ غير متوقع');
  }
};
