// طبقة قاعدة البيانات Turso (libSQL عبر HTTP) — إلزامية للتوافق مع Vercel (بلا ملفات SQLite محلية).
// ensureSchema تُنشئ الجداول عند أول وصول بـ CREATE TABLE IF NOT EXISTS — لا حاجة لأداة migrations.

import { createClient, type Client, type InValue } from "@libsql/client";
import type { AttemptRecord, KeyRow, MediaType, ProviderId, TaskProvider, TaskRow, TaskStatus } from "./types";

let _client: Client | null = null;
let _schemaPromise: Promise<void> | null = null;

export function getTurso(): Client {
  if (!_client) {
    const url = process.env.TURSO_DATABASE_URL;
    const authToken = process.env.TURSO_AUTH_TOKEN;
    if (!url || !authToken) {
      throw new Error("متغيرات البيئة TURSO_DATABASE_URL و TURSO_AUTH_TOKEN مطلوبة");
    }
    // تحويل libsql:// إلى https:// لضمان الاتصال عبر HTTP البحت (مناسب لـ serverless)
    const httpUrl = url.startsWith("libsql://") ? url.replace("libsql://", "https://") : url;
    _client = createClient({ url: httpUrl, authToken });
  }
  return _client;
}

export async function ensureSchema(): Promise<void> {
  if (!_schemaPromise) {
    _schemaPromise = (async () => {
      const db = getTurso();
      await db.execute(
        `CREATE TABLE IF NOT EXISTS tasks (
          id TEXT PRIMARY KEY,
          provider TEXT,
          provider_task_id TEXT,
          key_id TEXT,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          prompt TEXT DEFAULT '',
          params_json TEXT DEFAULT '{}',
          status TEXT NOT NULL,
          progress INTEGER DEFAULT 0,
          result_urls_json TEXT,
          error_message TEXT,
          attempts_json TEXT DEFAULT '[]',
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          completed_at TEXT
        )`,
      );
      // ترقية تدريجية: عمود الاسم لمكتبة المقاطع (تجاهل الخطأ إن وُجد مسبقًا)
      try {
        await db.execute(`ALTER TABLE tasks ADD COLUMN label TEXT DEFAULT ''`);
      } catch {
        /* العمود موجود مسبقًا */
      }
      await db.execute(
        `CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL,
          label TEXT DEFAULT '',
          api_key TEXT NOT NULL,
          status TEXT DEFAULT 'active',
          usage_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          fail_count INTEGER DEFAULT 0,
          last_used_at TEXT,
          last_checked_at TEXT,
          last_error TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        )`,
      );
    })().catch((e) => {
      _schemaPromise = null; // اسمح بإعادة المحاولة عند الطلب التالي
      throw e;
    });
  }
  return _schemaPromise;
}

export async function dbHealthy(): Promise<boolean> {
  try {
    await ensureSchema();
    await getTurso().execute("SELECT 1");
    return true;
  } catch {
    return false;
  }
}

// ----------------------------- المهام -----------------------------

function mapTask(r: Record<string, unknown>): TaskRow {
  return {
    id: String(r.id),
    provider: (r.provider as TaskProvider | null) ?? null,
    provider_task_id: (r.provider_task_id as string | null) ?? null,
    key_id: (r.key_id as string | null) ?? null,
    model: String(r.model),
    type: r.type as MediaType,
    label: String(r.label ?? ""),
    prompt: String(r.prompt ?? ""),
    params_json: String(r.params_json ?? "{}"),
    status: r.status as TaskStatus,
    progress: Number(r.progress ?? 0),
    result_urls_json: (r.result_urls_json as string | null) ?? null,
    error_message: (r.error_message as string | null) ?? null,
    attempts_json: String(r.attempts_json ?? "[]"),
    created_at: String(r.created_at ?? ""),
    updated_at: String(r.updated_at ?? ""),
    completed_at: (r.completed_at as string | null) ?? null,
  };
}

const TASK_COLS = `id, provider, provider_task_id, key_id, model, type, label, prompt, params_json,
  status, progress, result_urls_json, error_message, attempts_json, created_at, updated_at, completed_at`;

export interface NewTask {
  id: string;
  provider?: TaskProvider;
  provider_task_id?: string;
  key_id?: string;
  model: string;
  type: MediaType;
  prompt: string;
  params_json?: string;
  status?: TaskStatus;
  progress?: number;
}

/** سجّل المهمة في Turso قبل أي نداء خارجي — حتى لو انقطع الاتصال تبقى قابلة للتتبع */
export async function insertTask(t: NewTask): Promise<TaskRow> {
  await ensureSchema();
  await getTurso().execute({
    sql: `INSERT INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      t.id,
      t.provider ?? null,
      t.provider_task_id ?? null,
      t.key_id ?? null,
      t.model,
      t.type,
      t.prompt,
      t.params_json ?? "{}",
      t.status ?? "pending",
      t.progress ?? 0,
    ],
  });
  return (await getTask(t.id))!;
}

export async function getTask(id: string): Promise<TaskRow | null> {
  await ensureSchema();
  const rs = await getTurso().execute({ sql: `SELECT ${TASK_COLS} FROM tasks WHERE id = ?`, args: [id] });
  return rs.rows.length ? mapTask(rs.rows[0] as unknown as Record<string, unknown>) : null;
}

export interface TaskPatch {
  provider?: TaskProvider;
  provider_task_id?: string;
  key_id?: string;
  status?: TaskStatus;
  progress?: number;
  result_urls?: string[];
  error_message?: string | null;
  attempt?: AttemptRecord; // يُلحق بسجل المحاولات تلقائيًا
}

/** تحديث جزئي: يضيف attempts ويضبط completed_at تلقائيًا عند الاكتمال */
export async function updateTask(id: string, patch: TaskPatch): Promise<TaskRow | null> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];

  if (patch.attempt) {
    const cur = await getTask(id);
    const arr: AttemptRecord[] = cur ? parseAttempts(cur.attempts_json) : [];
    arr.push(patch.attempt);
    sets.push("attempts_json = ?");
    args.push(JSON.stringify(arr).slice(0, 60000)); // سقف للحجم avoids نمو لا نهائي
  }
  if (patch.provider !== undefined) {
    sets.push("provider = ?");
    args.push(patch.provider);
  }
  if (patch.provider_task_id !== undefined) {
    sets.push("provider_task_id = ?");
    args.push(patch.provider_task_id);
  }
  if (patch.key_id !== undefined) {
    sets.push("key_id = ?");
    args.push(patch.key_id);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    args.push(patch.status);
    if (patch.status === "completed") sets.push("completed_at = datetime('now')");
  }
  if (patch.progress !== undefined) {
    sets.push("progress = ?");
    args.push(Math.round(Math.max(0, Math.min(100, patch.progress))));
  }
  if (patch.result_urls !== undefined) {
    sets.push("result_urls_json = ?");
    args.push(JSON.stringify(patch.result_urls));
  }
  if (patch.error_message !== undefined) {
    sets.push("error_message = ?");
    args.push(patch.error_message);
  }
  if (!sets.length) return getTask(id);

  sets.push("updated_at = datetime('now')");
  await getTurso().execute({
    sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
    args: [...args, id],
  });
  return getTask(id);
}

export async function listRecentTasks(
  limit: number,
  filters?: { type?: MediaType; status?: TaskStatus },
): Promise<TaskRow[]> {
  await ensureSchema();
  const where: string[] = [];
  const args: InValue[] = [];
  if (filters?.type) {
    where.push("type = ?");
    args.push(filters.type);
  }
  if (filters?.status) {
    where.push("status = ?");
    args.push(filters.status);
  }
  const sql = `SELECT ${TASK_COLS} FROM tasks ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY created_at DESC, id DESC LIMIT ?`;
  args.push(Math.max(1, Math.min(200, limit)));
  const rs = await getTurso().execute({ sql, args });
  return rs.rows.map((r) => mapTask(r as unknown as Record<string, unknown>));
}

export async function taskStats(): Promise<{ total: number; completed: number; failed: number; processing: number }> {
  await ensureSchema();
  const rs = await getTurso().execute(`SELECT status, COUNT(*) AS c FROM tasks GROUP BY status`);
  let total = 0,
    completed = 0,
    failed = 0,
    processing = 0;
  for (const row of rs.rows) {
    const c = Number(row.c);
    total += c;
    if (row.status === "completed") completed = c;
    else if (row.status === "failed") failed = c;
    else if (row.status === "processing" || row.status === "pending") processing += c;
  }
  return { total, completed, failed, processing };
}

export async function deleteTask(id: string): Promise<void> {
  await ensureSchema();
  await getTurso().execute({ sql: "DELETE FROM tasks WHERE id = ?", args: [id] });
}

/** تعديل بيانات المكتبة (الاسم/الوصف) — منفصل عن updateTask حتى لا يُلمس منطق التوليد */
export async function updateTaskMeta(
  id: string,
  patch: { label?: string; prompt?: string },
): Promise<TaskRow | null> {
  await ensureSchema();
  const sets: string[] = [];
  const args: InValue[] = [];
  if (patch.label !== undefined) {
    sets.push("label = ?");
    args.push(patch.label.slice(0, 200));
  }
  if (patch.prompt !== undefined) {
    sets.push("prompt = ?");
    args.push(patch.prompt.slice(0, 4000));
  }
  if (!sets.length) return getTask(id);
  sets.push("updated_at = datetime('now')");
  await getTurso().execute({
    sql: `UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
    args: [...args, id],
  });
  return getTask(id);
}

// ----------------------------- المفاتيح -----------------------------

function mapKey(r: Record<string, unknown>): KeyRow {
  return {
    id: String(r.id),
    provider: r.provider as ProviderId,
    label: String(r.label ?? ""),
    api_key: String(r.api_key),
    status: (r.status as KeyRow["status"]) ?? "active",
    usage_count: Number(r.usage_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: (r.last_used_at as string | null) ?? null,
    last_checked_at: (r.last_checked_at as string | null) ?? null,
    last_error: (r.last_error as string | null) ?? null,
    created_at: String(r.created_at ?? ""),
  };
}

export async function insertKey(provider: ProviderId, apiKey: string, label: string): Promise<KeyRow> {
  await ensureSchema();
  const id = crypto.randomUUID();
  await getTurso().execute({
    sql: `INSERT INTO api_keys (id, provider, label, api_key) VALUES (?, ?, ?, ?)`,
    args: [id, provider, label, apiKey],
  });
  return (await getKeyById(id))!;
}

export async function listKeys(): Promise<KeyRow[]> {
  await ensureSchema();
  const rs = await getTurso().execute(
    `SELECT id, provider, label, api_key, status, usage_count, success_count, fail_count,
            last_used_at, last_checked_at, last_error, created_at
     FROM api_keys ORDER BY created_at ASC, id ASC`,
  );
  return rs.rows.map((r) => mapKey(r as unknown as Record<string, unknown>));
}

/** يجلب المفتاح بالقيمة الخام — حتى المعطل؛ نحتاجه للاستعلام لدى المزود بعد الإنشاء */
export async function getKeyById(id: string): Promise<KeyRow | null> {
  await ensureSchema();
  const rs = await getTurso().execute({
    sql: `SELECT id, provider, label, api_key, status, usage_count, success_count, fail_count,
            last_used_at, last_checked_at, last_error, created_at FROM api_keys WHERE id = ?`,
    args: [id],
  });
  return rs.rows.length ? mapKey(rs.rows[0] as unknown as Record<string, unknown>) : null;
}

export async function findDuplicateKey(provider: ProviderId, apiKey: string): Promise<boolean> {
  await ensureSchema();
  const rs = await getTurso().execute({
    sql: "SELECT id FROM api_keys WHERE provider = ? AND api_key = ? LIMIT 1",
    args: [provider, apiKey],
  });
  return rs.rows.length > 0;
}

export async function updateKeyStatus(id: string, status: KeyRow["status"], lastError?: string | null): Promise<void> {
  await ensureSchema();
  const sets = ["status = ?", "last_checked_at = datetime('now')"];
  const args: InValue[] = [status];
  if (lastError !== undefined) {
    sets.push("last_error = ?");
    args.push(lastError);
  }
  await getTurso().execute({ sql: `UPDATE api_keys SET ${sets.join(", ")} WHERE id = ?`, args: [...args, id] });
}

/** يحدّث عدّادات المفتاح دائمًا بعد كل محاولة (نجاح أو فشل) */
export async function bumpKeyCounters(
  id: string,
  ok: boolean,
  lastError?: string | null,
): Promise<void> {
  await ensureSchema();
  await getTurso().execute({
    sql: `UPDATE api_keys SET
      usage_count = usage_count + 1,
      success_count = success_count + ?,
      fail_count = fail_count + ?,
      last_used_at = datetime('now'),
      last_checked_at = datetime('now'),
      last_error = COALESCE(?, last_error)
      WHERE id = ?`,
    args: [ok ? 1 : 0, ok ? 0 : 1, ok ? null : (lastError ?? null), id],
  });
}

export async function deleteKey(id: string): Promise<boolean> {
  await ensureSchema();
  const rs = await getTurso().execute({ sql: "DELETE FROM api_keys WHERE id = ?", args: [id] });
  return rs.rowsAffected > 0;
}

// ----------------------------- محللات JSON -----------------------------

export function parseAttempts(json: string | null | undefined): AttemptRecord[] {
  try {
    const arr = JSON.parse(json || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function parseUrls(json: string | null | undefined): string[] {
  try {
    const arr = JSON.parse(json || "[]");
    return Array.isArray(arr) ? arr.filter((u): u is string => typeof u === "string") : [];
  } catch {
    return [];
  }
}
