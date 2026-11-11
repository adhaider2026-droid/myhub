'use strict';

/** GET /api/jobs/<id>/video — بث الناتج بدعم Range (206 + Content-Range) و?download=1 للتحميل */

const util = require('../../../lib/util');
const db = require('../../../lib/db');
const storage = require('../../../lib/storage');

module.exports = async (req, res) => {
  if (util.handleOptions(req, res)) return;
  if (req.method !== 'GET' && req.method !== 'HEAD') return util.methodNotAllowed(res, 'GET, HEAD, OPTIONS');

  const id = String((req.query && req.query.id) || '').trim();
  if (!id) return util.sendError(res, 400, 'معرّف المهمة مطلوب');

  try {
    await db.ensureSchema();
    const job = await db.getJob(id);
    if (!job) return util.sendError(res, 404, 'المهمة غير موجودة أو انتهت صلاحيتها');
    if (job.status !== 'done') {
      return util.sendError(res, 409, `الفيديو الناتج غير متاح بعد — حالة المهمة الحالية: ${job.status}`);
    }

    const totalSize = (await storage.readOutputSize(id)) || job.size || 0;
    if (!totalSize) return util.sendError(res, 404, 'ملف الناتج غير موجود');

    const download = req.query.download === '1' || req.query.download === 'true';
    const fileName = `merged-${id}.mp4`;

    // تحليل ترويسة Range: bytes=start-end
    const rangeHeader = String(req.headers.range || '');
    const m = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
    let start = 0;
    let end = totalSize - 1;
    let isRange = false;

    if (m) {
      const s = m[1] === '' ? null : Number(m[1]);
      const e2 = m[2] === '' ? null : Number(m[2]);
      if (s === null && e2 !== null) {
        // آخر N بايت: bytes=-N
        start = Math.max(0, totalSize - e2);
        end = totalSize - 1;
      } else if (s !== null) {
        start = Math.min(s, totalSize - 1);
        end = e2 === null ? totalSize - 1 : Math.min(e2, totalSize - 1);
      }
      if (start > end) {
        res.statusCode = 416;
        res.setHeader('Content-Range', `bytes */${totalSize}`);
        return res.end();
      }
      isRange = true;
    }

    const length = end - start + 1;
    util.setCors(res);
    res.statusCode = isRange ? 206 : 200;
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(length));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader(
      'Content-Disposition',
      `${download ? 'attachment' : 'inline'}; filename="${fileName}"`
    );
    if (isRange) res.setHeader('Content-Range', `bytes ${start}-${end}/${totalSize}`);

    if (req.method === 'HEAD') return res.end();

    const stream = storage.outputNodeStream(id, totalSize, start, end);
    stream.on('error', () => {
      try { res.destroy(new Error('خطأ أثناء قراءة الناتج من قاعدة البيانات')); } catch (e2) { /* ignore */ }
    });
    stream.pipe(res);
  } catch (e) {
    const code = e && e.statusCode ? e.statusCode : 500;
    return util.sendError(res, code, e && e.message ? e.message : 'خطأ غير متوقع');
  }
};
