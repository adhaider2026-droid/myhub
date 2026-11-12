'use strict';

/** POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا بشكل متزامن: سحب ← ترميز ← تخزين */

const util = require('../../../lib/util');
const db = require('../../../lib/db');
const merge = require('../../../lib/merge');

module.exports = async (req, res) => {
  if (util.handleOptions(req, res)) return;
  if (req.method !== 'POST') return util.methodNotAllowed(res, 'POST, OPTIONS');

  const id = String((req.query && req.query.id) || '').trim();
  if (!id) return util.sendError(res, 400, 'معرّف المهمة مطلوب');

  try {
    await db.ensureSchema();
    await db.cleanupExpired(100); // تنظيف كسول عند كل دمج
    const origin = util.getOrigin(req);
    const payload = await merge.processJob(id, origin);
    return util.sendJson(res, 200, payload);
  } catch (e) {
    // حالة "قيد المعالجة فعله" → 202 مع جسم الحالة
    if (e && e.statusCode === 202 && e.payload) {
      return util.sendJson(res, 202, e.payload);
    }
    const code = e && e.statusCode ? e.statusCode : 500;
    return util.sendError(res, code, e && e.message ? e.message : 'فشل غير متوقع أثناء الدمج');
  }
};
