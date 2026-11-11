'use strict';

/** POST /api/jobs — إنشاء مهمة دمج جديدة من روابط مباشرة أو ملفات تُرفع لاحقًا */

const util = require('../lib/util');
const db = require('../lib/db');

module.exports = async (req, res) => {
  if (util.handleOptions(req, res)) return;
  if (req.method !== 'POST') return util.methodNotAllowed(res, 'POST, OPTIONS');

  try {
    await db.ensureSchema();
    const cfgV = util.cfg();
    const body = await util.readJsonBody(req, 1024 * 1024);

    // بناء قائمة المصادر من videos أو sources
    let raw = [];
    if (Array.isArray(body.videos)) {
      raw = body.videos.map((v) => ({ kind: 'url', url: typeof v === 'string' ? v.trim() : '' }));
    } else if (Array.isArray(body.sources)) {
      raw = body.sources.map((s) => {
        if (!s || typeof s !== 'object') return null;
        if (s.kind === 'url') return { kind: 'url', url: String(s.url || '').trim() };
        if (s.kind === 'file') {
          return {
            kind: 'file',
            name: String(s.name || 'video').slice(0, 200),
            size: Number(s.size),
            mime: s.mime ? String(s.mime).slice(0, 100) : 'video/mp4',
          };
        }
        return null;
      });
    } else {
      return util.sendError(res, 400, 'يجب إرسال "videos" كمصفوفة روابط أو "sources" كمصفوفة مصادر kind=url|file');
    }

    if (raw.some((s) => !s)) {
      return util.sendError(res, 400, 'صيغة المصادر غير صالحة — كل مصدر يجب أن يكون {kind:"url",url} أو {kind:"file",name,size,mime}');
    }
    if (raw.length < 2) {
      return util.sendError(res, 400, `يلزم مصدران على الأقل لدمج الفيديوهات — استُلم ${raw.length} فقط`);
    }
    if (raw.length > cfgV.MAX_SOURCES) {
      return util.sendError(res, 400, `عدد المصادر (${raw.length}) تجاوز الحد الأقصى (${cfgV.MAX_SOURCES})`);
    }

    const maxBytes = cfgV.SOURCE_MAX_MB * 1024 * 1024;
    for (let i = 0; i < raw.length; i++) {
      const s = raw[i];
      if (s.kind === 'url') {
        if (!/^https?:\/\/\S+$/i.test(s.url)) {
          return util.sendError(res, 400, `المصدر رقم ${i + 1}: الرابط غير صالح — يجب أن يكون رابط فيديو مباشر http/https`);
        }
      } else {
        if (!Number.isFinite(s.size) || s.size <= 0) {
          return util.sendError(res, 400, `المصدر رقم ${i + 1} (${s.name}): حجم الملف غير صالح`);
        }
        if (s.size > maxBytes) {
          return util.sendError(res, 413, `حجم الملف "${s.name}" (${util.mb(s.size)}MB) تجاوز الحد المسموح (${cfgV.SOURCE_MAX_MB}MB)`);
        }
        s.chunkCount = Math.ceil(s.size / cfgV.UPLOAD_CHUNK_BYTES);
      }
    }

    // تنظيف كسول للمهام المنتهية عند كل إنشاء
    try { await db.cleanupExpired(); } catch (e) { /* التنظيف أفضل جهد */ }

    const jobId = util.newId();
    const expiresAt = new Date(Date.now() + cfgV.JOB_TTL_HOURS * 3600 * 1000).toISOString();

    const sources = raw.map((s, seq) => ({
      id: util.newId(),
      seq,
      kind: s.kind,
      url: s.kind === 'url' ? s.url : null,
      name: s.kind === 'file' ? s.name : null,
      size: s.kind === 'file' ? s.size : null,
      mime: s.kind === 'file' ? (s.mime || 'video/mp4') : null,
      chunkCount: s.kind === 'file' ? s.chunkCount : 0,
    }));

    const expectedUploads = sources.reduce((t, s) => t + (s.kind === 'file' ? s.chunkCount : 0), 0);
    const status = expectedUploads > 0 ? 'uploading' : 'queued';

    const sourcesJson = JSON.stringify(sources.map((s) => ({
      seq: s.seq,
      kind: s.kind,
      url: s.url,
      name: s.name,
      size: s.size,
      mime: s.mime,
      chunkCount: s.chunkCount,
      receivedChunks: 0,
      ready: false,
    })));

    await db.createJobWithSources(jobId, status, sources, sourcesJson, expectedUploads, expiresAt);

    const origin = util.getOrigin(req);
    const payload = {
      jobId,
      status,
      statusUrl: `${origin}/api/jobs/${jobId}`,
      processUrl: `${origin}/api/jobs/${jobId}/process`,
      expiresAt,
    };

    if (expectedUploads > 0) {
      payload.uploadChunkBytes = cfgV.UPLOAD_CHUNK_BYTES;
      payload.uploads = sources
        .filter((s) => s.kind === 'file')
        .map((s) => ({
          seq: s.seq,
          name: s.name,
          size: s.size,
          mime: s.mime,
          totalChunks: s.chunkCount,
          uploadUrl: `${origin}/api/upload?job=${jobId}&seq=${s.seq}&chunk=0`,
        }));
    }

    util.sendJson(res, 201, payload);
  } catch (e) {
    util.sendError(res, (e && e.statusCode) || 500, (e && e.message) || 'خطأ غير متوقع أثناء إنشاء المهمة');
  }
};
