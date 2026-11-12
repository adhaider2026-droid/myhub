'use strict';

/**
 * dev-server.js — خادم تطوير محلي يحاكي بيئة Vercel:
 * يحمّل .env.local/.env يدويًا، يحلل المسارات الديناميكية ويضعها في req.query،
 * يخدم public/ استاتيكيًا، ويستدعي نفس وحدات api/ نفسها بتوقيع (req, res).
 * + مسار اختبار GET /files/<name> يخدم merger/.tmp-fixtures بروابط "عامة" محلية.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const util = require('./lib/util');

const ROOT = __dirname;
util.loadEnvFiles(ROOT);

const PORT = Number(process.env.MERGER_PORT || 3001);

// خادم ثنائي بسيط لملفات fixtures مع دعم Range بسيط
function serveFile(req, res, filePath, mime) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return util.sendError(res, 404, 'الملف غير موجود');
  }
  util.setCors(res);
  const total = stat.size;
  const range = String(req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  let start = 0;
  let end = total - 1;
  if (range) {
    if (range[1] !== '') start = Number(range[1]);
    if (range[2] !== '') end = Number(range[2]);
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
  } else {
    res.statusCode = 200;
  }
  res.setHeader('Content-Type', mime);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Length', String(end - start + 1));
  const stream = fs.createReadStream(filePath, { start, end });
  stream.pipe(res);
}

/** يوزع المسار إلى وحدة api/ المناسبة ويضع بارامترات المسار في req.query */
function route(req, res, pathname, query) {
  const m = pathname.match(/^\/api\/jobs\/([^/]+)(\/process|\/video)?\/?$/);
  if (pathname === '/api/config') return require('./api/config');
  if (pathname === '/api/cron') return require('./api/cron');
  if (pathname === '/api/jobs' || pathname === '/api/jobs/') return require('./api/jobs');
  if (pathname === '/api/upload') return require('./api/upload');
  if (m) {
    req.query = Object.assign({}, query, { id: decodeURIComponent(m[1]) });
    if (m[2] === '/process') return require('./api/jobs/[id]/process');
    if (m[2] === '/video') return require('./api/jobs/[id]/video');
    return require('./api/jobs/[id]');
  }
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());
  req.query = query;

  try {
    // ملفات الاختبار المحلية "العامة"
    const filesMatch = pathname.match(/^\/files\/([\w.\-]+)$/);
    if (filesMatch) {
      const fixturePath = path.join(ROOT, '.tmp-fixtures', filesMatch[1]);
      const mime = /\.webm$/i.test(filesMatch[1]) ? 'video/webm'
        : /\.mov$/i.test(filesMatch[1]) ? 'video/quicktime'
        : 'video/mp4';
      return serveFile(req, res, fixturePath, mime);
    }

    // الواجهة الثابتة
    if (pathname === '/' || pathname === '/index.html') {
      return serveFile(req, res, path.join(ROOT, 'public', 'index.html'), 'text/html; charset=utf-8');
    }
    if (pathname === '/favicon.ico') {
      res.statusCode = 204;
      return res.end();
    }

    // نقاط API
    const handler = route(req, res, pathname, query);
    if (handler) {
      return await handler(req, res);
    }

    return util.sendError(res, 404, 'المسار غير موجود');
  } catch (e) {
    console.error('[dev-server] خطأ غير معالج:', e && e.message);
    if (!res.headersSent) {
      return util.sendError(res, 500, e && e.message ? e.message : 'خطأ غير متوقع');
    }
    try { res.end(); } catch (e2) { /* ignore */ }
  }
});

server.listen(PORT, () => {
  console.log(`\n🎬 خدمة دمج الفيديوهات v2 تعمل الآن: http://localhost:${PORT}`);
  console.log(`   الواجهة: http://localhost:${PORT}/`);
  console.log(`   التوثيق: http://localhost:${PORT}/api/config\n`);
});
