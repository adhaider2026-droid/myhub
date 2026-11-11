'use strict';

/**
 * lib/storage.js — تخزين البلوبات في Turso:
 * كل Blob يُقسَّم إلى صفوف 2MB (حد HTTP في Turso)، وتُقرأ بصفحات من 8 صفوف.
 * يتضمن بث الناتج بدعم Range عبر Node Readable.
 */

const fs = require('fs');
const { Readable } = require('stream');
const db = require('./db');
const util = require('./util');

const ROW_BYTES = util.ROW_BYTES; // 2MB لكل صف
const PAGE_ROWS = util.PAGE_ROWS; // 8 صفوف لكل استعلام

/* ------------------------------------------------------------------ */
/* كتابة أجزاء المصادر                                                 */
/* ------------------------------------------------------------------ */

/**
 * صف التخزين الأول المقابل لرقم جزء رفع معيّن.
 * جزء الرفع (4MB افتراضيًا) يُقسَّم إلى صفوف 2MB متتالية.
 */
function sourceBaseRow(chunkIndex, chunkBytes) {
  return Math.floor((chunkIndex * chunkBytes) / ROW_BYTES);
}

/** فحص وجود جزء مصدر مسبقًا (لتمييز إعادة المحاولة) */
async function sourceChunkExists(jobId, seq, chunkIndex, chunkBytes) {
  const rows = await db.q(
    'SELECT 1 AS x FROM source_chunks WHERE job_id = ? AND seq = ? AND chunk_index = ? LIMIT 1',
    [jobId, seq, sourceBaseRow(chunkIndex, chunkBytes)]
  );
  return rows.length > 0;
}

/** تخزين جزء مرفوع: INSERT OR REPLACE مقسّمًا إلى صفوف 2MB */
async function appendSourceChunk(jobId, seq, chunkIndex, buf, chunkBytes) {
  if (!buf || !buf.length) throw util.jsonError(400, 'لا يمكن تخزين جزء فارغ');
  const stmts = [];
  const baseRow = sourceBaseRow(chunkIndex, chunkBytes);
  for (let off = 0, i = 0; off < buf.length; off += ROW_BYTES, i++) {
    const end = Math.min(off + ROW_BYTES, buf.length);
    stmts.push({
      sql: 'INSERT OR REPLACE INTO source_chunks (job_id, seq, chunk_index, data) VALUES (?, ?, ?, ?)',
      args: [jobId, seq, baseRow + i, buf.subarray(off, end)],
    });
  }
  await db.batch(stmts);
}

/* ------------------------------------------------------------------ */
/* قراءة أجزاء المصادر إلى ملف مؤقت                                    */
/* ------------------------------------------------------------------ */

/** تجميع كل صفوف مصدر معيّن إلى ملف في /tmp — قراءة بصفحات 8 صفوف */
async function readSourceToTmp(jobId, seq, tmpPath) {
  const sql = `SELECT chunk_index, data FROM source_chunks
               WHERE job_id = ? AND seq = ? AND chunk_index >= ?
               ORDER BY chunk_index ASC LIMIT ${PAGE_ROWS}`;
  const ws = fs.createWriteStream(tmpPath);
  let cursor = 0;
  let totalBytes = 0;

  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (e) => {
      if (!settled) {
        settled = true;
        try { ws.destroy(); } catch (x) { /* تجاهل */ }
        reject(e);
      }
    };
    ws.on('error', fail);
    (async () => {
      try {
        while (true) {
          const rows = await db.q(sql, [jobId, seq, cursor]);
          if (!rows.length) break;
          for (const r of rows) {
            const buf = util.toBuffer(r.data);
            totalBytes += buf.length;
            if (!ws.write(buf)) {
              await new Promise((res) => ws.once('drain', res));
            }
          }
          cursor = Number(rows[rows.length - 1].chunk_index) + 1;
          if (rows.length < PAGE_ROWS) break;
        }
        ws.end(() => {
          if (!settled) {
            settled = true;
            resolve(totalBytes);
          }
        });
      } catch (e) {
        fail(e);
      }
    })();
  });

  return totalBytes;
}

/* ------------------------------------------------------------------ */
/* الناتج                                                              */
/* ------------------------------------------------------------------ */

/** كتابة الفيديو الناتج كصفوف 2MB مع تقدم اختياري 0..100 */
async function writeOutput(jobId, buf, onProgress) {
  if (!buf || !buf.length) throw util.jsonError(500, 'لا يمكن تخزين ناتج فارغ');
  const client = db.getClient();
  const total = buf.length;
  let written = 0;
  for (let idx = 0, off = 0; off < total; idx++, off += ROW_BYTES) {
    const end = Math.min(off + ROW_BYTES, total);
    await client.execute({
      sql: 'INSERT OR REPLACE INTO output_chunks (job_id, chunk_index, data) VALUES (?, ?, ?)',
      args: [jobId, idx, buf.subarray(off, end)],
    });
    written = end;
    if (typeof onProgress === 'function') {
      onProgress(Math.min(100, Math.round((written / total) * 100)));
    }
  }
  return total;
}

/** الحجم الكلي للناتج المخزن (بايت) */
async function readOutputSize(jobId) {
  const rows = await db.q(
    'SELECT COALESCE(SUM(LENGTH(data)), 0) AS s FROM output_chunks WHERE job_id = ?',
    [jobId]
  );
  return Number((rows[0] && rows[0].s) || 0);
}

/**
 * مولّد يمرّ على صفوف الناتج بالترتيب ويقلّم أول/آخر جزء حسب المدى المطلوب.
 * يقرأ بصفحات من 8 صفوف مرتّبة حسب chunk_index.
 */
async function* outputChunkIterator(jobId, start, end) {
  const sql = `SELECT chunk_index, data FROM output_chunks
               WHERE job_id = ? AND chunk_index >= ?
               ORDER BY chunk_index ASC LIMIT ${PAGE_ROWS}`;
  let cursorRow = Math.floor(start / ROW_BYTES);
  let pos = start;
  while (pos <= end) {
    const rows = await db.q(sql, [jobId, cursorRow]);
    if (!rows.length) break;
    for (const r of rows) {
      const idx = Number(r.chunk_index);
      const buf = util.toBuffer(r.data);
      const rowStart = idx * ROW_BYTES;
      const rowEnd = rowStart + buf.length - 1;
      const from = Math.max(rowStart, start);
      const to = Math.min(rowEnd, end);
      if (to >= from) yield buf.subarray(from - rowStart, to - rowStart + 1);
      pos = rowEnd + 1;
      if (pos > end) break;
    }
    if (rows.length < PAGE_ROWS) break;
    cursorRow = Math.floor(pos / ROW_BYTES);
  }
}

/**
 * بث الناتج كـ Node Readable مع دعم Range — يعمل مع 206/Content-Range.
 * يعالج الضغط العكسي (backpressure) تلقائيًا عبر Readable.from.
 */
function outputNodeStream(jobId, totalSize, start, end) {
  const s = Math.max(0, Math.min(Number(start) || 0, Number(totalSize) - 1));
  const e = Math.max(s, Math.min(Number(end) === 0 ? 0 : Number(end) || Number(totalSize) - 1, Number(totalSize) - 1));
  return Readable.from(outputChunkIterator(jobId, s, e));
}

/* ------------------------------------------------------------------ */
/* الحذف الشامل — إعادة تصدير حذف db (batch واحد لكل الجداول)          */
/* ------------------------------------------------------------------ */

async function deleteJobData(jobId) {
  return db.deleteJobRows(jobId);
}

module.exports = {
  ROW_BYTES,
  PAGE_ROWS,
  sourceBaseRow,
  sourceChunkExists,
  appendSourceChunk,
  readSourceToTmp,
  writeOutput,
  readOutputSize,
  outputChunkIterator,
  outputNodeStream,
  deleteJobData,
};
