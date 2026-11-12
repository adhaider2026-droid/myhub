'use strict';

/** GET /api/config — حدود الخدمة والإعدادات العامة */

const util = require('../lib/util');

module.exports = async (req, res) => {
  if (util.handleOptions(req, res)) return;
  if (req.method !== 'GET') return util.methodNotAllowed(res, 'GET, OPTIONS');
  const c = util.cfg();
  util.sendJson(res, 200, {
    version: c.VERSION,
    maxSources: c.MAX_SOURCES,
    sourceMaxMB: c.SOURCE_MAX_MB,
    outputMaxMB: c.OUTPUT_MAX_MB,
    maxTotalDurationSec: c.MAX_TOTAL_DURATION_SEC,
    uploadChunkBytes: c.UPLOAD_CHUNK_BYTES,
  });
};
