'use strict';

/** GET /api/cron — حذف كل المهام المنتهية الصلاحية (jobs+sources+source_chunks+output_chunks) */

const util = require('../lib/util');
const db = require('../lib/db');

module.exports = async (req, res) => {
  if (util.handleOptions(req, res)) return;
  if (req.method !== 'GET') return util.methodNotAllowed(res, 'GET, OPTIONS');
  try {
    await db.ensureSchema();
    const deleted = await db.cleanupExpired();
    util.sendJson(res, 200, { deleted });
  } catch (e) {
    util.sendError(res, (e && e.statusCode) || 500, (e && e.message) || 'خطأ غير متوقع أثناء التنظيف');
  }
};
