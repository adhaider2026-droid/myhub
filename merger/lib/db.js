'use strict';

/**
 * lib/db.js — عميل Turso (libSQL) عبر HTTP مع مخطط كسول ودوال المهام.
 * كل شيء يُخزَّن هنا: المهام، بيانات المصادر، أجزاء الملفات، والفيديو الناتج.
 */

const { createClient } = require('@libsql/client');
const util = require('./util');

let _client = null;
let _schemaPromise = null;

function getClient() {
  if (_client) return _client;
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;
  if (!url) throw util.jsonError(500, 'متغير البيئة TURSO_DATABASE_URL غير مضبوط');
  if (!token) throw util.jsonError(500, 'متغير البيئة TURSO_AUTH_TOKEN غير مضبوط');
  // Turso عبر HTTP فقط: حوّل libsql:// إلى https://
  const httpUrl = url.startsWith('libsql://')
    ? 'https://' + url.slice('libsql://'.length)
    : url;
  _client = createClient({ url: httpUrl, authToken: token });
  return _client;
}

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    progress INTEGER DEFAULT 0,
    sources_json TEXT NOT NULL,
    expected_uploads INTEGER DEFAULT 0,
    received_uploads INTEGER DEFAULT 0,
    error TEXT,
    video_url TEXT,
    size INTEGER,
    duration REAL,
    resolution TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    kind TEXT,
    url TEXT,
    name TEXT,
    size INTEGER,
    mime TEXT,
    chunk_count INTEGER,
    received_chunks INTEGER DEFAULT 0,
    ready INTEGER DEFAULT 0,
    duration REAL,
    width INTEGER,
    height INTEGER,
    has_audio INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS source_chunks (
    job_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (job_id, seq, chunk_index)
  )`,
  `CREATE TABLE IF NOT EXISTS output_chunks (
    job_id TEXT NOT NULL,
    chunk_index INTEGER NOT NULL,
    data BLOB NOT NULL,
    PRIMARY KEY (job_id, chunk_index)
  )`,
];

/** أعمدة أضيفت لاحقًا (وضع ريلز الصور) — تُضاف بهدوء إن لم تكن موجودة */
const MIGRATION_STATEMENTS = [
  'ALTER TABLE jobs ADD COLUMN mode TEXT',
  'ALTER TABLE jobs ADD COLUMN options_json TEXT',
];

/** استدعاء كسول: مرة واحدة لكل عملية باردة، وإعادة المحاولة ممكنة عند الفشل */
function ensureSchema() {
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      const c = getClient();
      for (const sql of SCHEMA_STATEMENTS) await c.execute(sql);
      for (const sql of MIGRATION_STATEMENTS) {
        try { await c.execute(sql); } catch (e) { /* العمود موجود مسبقًا — تجاهل */ }
      }
    })().catch((e) => {
      _schemaPromise = null;
      throw e;
    });
  }
  return _schemaPromise;
}

/* ------------------------------------------------------------------ */
/* مساعدات منخفضة المستوى                                              */
/* ------------------------------------------------------------------ */

async function q(sql, args) {
  const rs = await getClient().execute({ sql, args: args || [] });
  return rs.rows;
}

async function run(sql, args) {
  const rs = await getClient().execute({ sql, args: args || [] });
  return rs.rowsAffected != null ? rs.rowsAffected : (rs.rows_affected != null ? rs.rows_affected : 0);
}

async function batch(stmts) {
  if (!stmts || !stmts.length) return null;
  return getClient().batch(stmts, 'write');
}

/* ------------------------------------------------------------------ */
/* تحويل الصفوف إلى كائنات نظيفة                                       */
/* ------------------------------------------------------------------ */

function mapJob(r) {
  return {
    id: String(r.id),
    status: String(r.status),
    progress: Number(r.progress || 0),
    sourcesJson: r.sources_json == null ? '[]' : String(r.sources_json),
    expectedUploads: Number(r.expected_uploads || 0),
    receivedUploads: Number(r.received_uploads || 0),
    error: r.error == null ? null : String(r.error),
    videoUrl: r.video_url == null ? null : String(r.video_url),
    size: r.size == null ? null : Number(r.size),
    duration: r.duration == null ? null : Number(r.duration),
    resolution: r.resolution == null ? null : String(r.resolution),
    mode: r.mode == null ? 'merge' : String(r.mode),
    optionsJson: r.options_json == null ? null : String(r.options_json),
    createdAt: r.created_at == null ? null : String(r.created_at),
    expiresAt: r.expires_at == null ? null : String(r.expires_at),
  };
}

function mapSource(r) {
  return {
    id: String(r.id),
    jobId: String(r.job_id),
    seq: Number(r.seq),
    kind: String(r.kind || 'url'),
    url: r.url == null ? null : String(r.url),
    name: r.name == null ? null : String(r.name),
    size: r.size == null ? null : Number(r.size),
    mime: r.mime == null ? null : String(r.mime),
    chunkCount: Number(r.chunk_count || 0),
    receivedChunks: Number(r.received_chunks || 0),
    ready: !!Number(r.ready || 0),
    duration: r.duration == null ? null : Number(r.duration),
    width: r.width == null ? null : Number(r.width),
    height: r.height == null ? null : Number(r.height),
    hasAudio: !!Number(r.has_audio || 0),
  };
}

/* ------------------------------------------------------------------ */
/* المهام                                                              */
/* ------------------------------------------------------------------ */

async function createJobWithSources(jobId, status, sources, sourcesJson, expectedUploads, expiresAt, mode, optionsJson) {
  const stmts = [
    {
      sql: `INSERT INTO jobs (id, status, progress, sources_json, expected_uploads, received_uploads, expires_at, mode, options_json)
            VALUES (?, ?, 0, ?, ?, 0, ?, ?, ?)`,
      args: [jobId, status, sourcesJson, expectedUploads, expiresAt, mode || 'merge', optionsJson || null],
    },
    ...sources.map((s) => ({
      sql: `INSERT INTO sources (id, job_id, seq, kind, url, name, size, mime, chunk_count, received_chunks, ready)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`,
      args: [
        s.id, jobId, s.seq, s.kind,
        s.kind === 'url' ? s.url : null,
        s.kind === 'file' ? s.name : null,
        s.kind === 'file' ? s.size : null,
        s.kind === 'file' ? (s.mime || 'video/mp4') : null,
        s.kind === 'file' ? s.chunkCount : 0,
      ],
    })),
  ];
  await batch(stmts);
}

async function getJob(id) {
  const rows = await q('SELECT * FROM jobs WHERE id = ?', [id]);
  return rows.length ? mapJob(rows[0]) : null;
}

const JOB_COLUMNS = {
  status: 'status',
  progress: 'progress',
  error: 'error',
  videoUrl: 'video_url',
  size: 'size',
  duration: 'duration',
  resolution: 'resolution',
  receivedUploads: 'received_uploads',
  expectedUploads: 'expected_uploads',
  sourcesJson: 'sources_json',
  expiresAt: 'expires_at',
  mode: 'mode',
  optionsJson: 'options_json',
};

async function updateJob(id, fields) {
  const sets = [];
  const args = [];
  for (const k of Object.keys(fields)) {
    const col = JOB_COLUMNS[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    args.push(fields[k] === undefined ? null : fields[k]);
  }
  if (!sets.length) return 0;
  args.push(id);
  return run(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?`, args);
}

/** حجز المهمة للمعالجة بشكل ذرّي — يعيد true فقط لو نجحت */
async function claimForProcessing(id) {
  const ra = await run(
    `UPDATE jobs SET status = 'processing', progress = 5, error = NULL
     WHERE id = ? AND status IN ('queued', 'failed')`,
    [id]
  );
  return ra === 1;
}

/* ------------------------------------------------------------------ */
/* المصادر                                                             */
/* ------------------------------------------------------------------ */

async function getSources(jobId) {
  const rows = await q('SELECT * FROM sources WHERE job_id = ? ORDER BY seq ASC', [jobId]);
  return rows.map(mapSource);
}

const SOURCE_COLUMNS = {
  receivedChunks: 'received_chunks',
  ready: 'ready',
  duration: 'duration',
  width: 'width',
  height: 'height',
  hasAudio: 'has_audio',
};

async function updateSource(id, fields) {
  const sets = [];
  const args = [];
  for (const k of Object.keys(fields)) {
    const col = SOURCE_COLUMNS[k];
    if (!col) continue;
    sets.push(`${col} = ?`);
    args.push(fields[k] === undefined ? null : fields[k]);
  }
  if (!sets.length) return 0;
  args.push(id);
  return run(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`, args);
}

async function sumFileReceivedChunks(jobId) {
  const rows = await q(
    `SELECT COALESCE(SUM(received_chunks), 0) AS s FROM sources WHERE job_id = ? AND kind = 'file'`,
    [jobId]
  );
  return Number((rows[0] && rows[0].s) || 0);
}

/** مزامنة لقطة المصادر داخل jobs.sources_json مع جدول sources */
async function syncSourcesJson(jobId) {
  const sources = await getSources(jobId);
  const json = JSON.stringify(sources.map((s) => ({
    seq: s.seq,
    kind: s.kind,
    url: s.url,
    name: s.name,
    size: s.size,
    mime: s.mime,
    chunkCount: s.chunkCount,
    receivedChunks: s.receivedChunks,
    ready: s.ready,
    duration: s.duration,
    width: s.width,
    height: s.height,
    hasAudio: s.hasAudio,
  })));
  await updateJob(jobId, { sourcesJson: json });
}

/* ------------------------------------------------------------------ */
/* الحذف والتنظيف                                                      */
/* ------------------------------------------------------------------ */

/** حذف شامل في batch واحد: jobs + sources + source_chunks + output_chunks */
async function deleteJobRows(jobId) {
  await batch([
    { sql: 'DELETE FROM jobs WHERE id = ?', args: [jobId] },
    { sql: 'DELETE FROM sources WHERE job_id = ?', args: [jobId] },
    { sql: 'DELETE FROM source_chunks WHERE job_id = ?', args: [jobId] },
    { sql: 'DELETE FROM output_chunks WHERE job_id = ?', args: [jobId] },
  ]);
}

/** حذف أجزاء المصادر بعد نجاح الدمج (يبقى الناتج فقط) */
async function deleteSourceChunks(jobId) {
  await run('DELETE FROM source_chunks WHERE job_id = ?', [jobId]);
}

/** حذف كل المهام المنتهية الصلاحية (بدون لمس المهام قيد المعالجة) */
async function cleanupExpired(limit) {
  const maxRows = limit || 500;
  const rows = await q(
    `SELECT id, expires_at FROM jobs WHERE status != 'processing' ORDER BY created_at ASC LIMIT ?`,
    [maxRows]
  );
  const now = Date.now();
  const ids = [];
  for (const r of rows) {
    const t = Date.parse(String(r.expires_at || ''));
    if (Number.isFinite(t) && t <= now) ids.push(String(r.id));
  }
  for (const id of ids) {
    try {
      await deleteJobRows(id);
    } catch (e) { /* نتجاهل الأفراد ونكمل */ }
  }
  return ids.length;
}

module.exports = {
  getClient,
  ensureSchema,
  q,
  run,
  batch,
  createJobWithSources,
  getJob,
  updateJob,
  claimForProcessing,
  getSources,
  updateSource,
  sumFileReceivedChunks,
  syncSourcesJson,
  deleteJobRows,
  deleteSourceChunks,
  cleanupExpired,
  mapJob,
  mapSource,
};
