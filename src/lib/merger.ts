// عميل خدمة دمج الفيديو Video Merger API v2 — بلا مفاتيح أو توثيق.
// العنوان من MERGER_API_BASE. المخرجات MP4 (H.264 + AAC) — لا resolution/fps، الناتج ثابت.
// روابط النتائج فقط — لا ننزّل أي وسائط إلى سيرفرنا.

import { ProviderError } from "./errors";

export function mergerBase(): string | null {
  const b = process.env.MERGER_API_BASE?.trim();
  return b ? b.replace(/\/+$/, "") : null;
}

export function mergerConfigured(): boolean {
  return !!mergerBase();
}

export interface MergeJobStatus {
  rawStatus: string;
  state: "queued" | "processing" | "completed" | "failed";
  progress: number; // 0..100 (يُعالَج إن جاء كسرًا 0..1)
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
}

const DONE_STATES = /^(done|completed|complete|success|succeeded|finished)$/i;
const FAILED_STATES = /^(error|failed|failure|cancelled)$/i;

/** تحليل دفاعي لحالة مهمة الدمج (حسب 7.2): قد يرد الجسم فيه error بدون حقل status → failed فورًا */
export function normalizeMergeStatus(raw: {
  status?: string;
  progress?: unknown;
  videoUrl?: string;
  downloadUrl?: string;
  error?: string;
  jobId?: string;
}): MergeJobStatus {
  const status = (raw.status ?? "").trim();
  let state: MergeJobStatus["state"];
  if (raw.error && !status) state = "failed";
  else if (DONE_STATES.test(status)) state = "completed";
  else if (FAILED_STATES.test(status)) state = "failed";
  else state = status.toLowerCase() === "queued" ? "queued" : "processing";

  let progress = typeof raw.progress === "number" ? raw.progress : Number(raw.progress) || 0;
  if (!Number.isFinite(progress) || progress < 0) progress = 0;
  if (progress <= 1) progress = progress * 100; // يأتي أحيانًا كسرًا 0..1
  if (state === "completed") progress = 100;
  if (state === "failed") progress = Math.min(progress, 95);

  return {
    rawStatus: status,
    state,
    progress: Math.round(progress),
    videoUrl: raw.videoUrl,
    downloadUrl: raw.downloadUrl,
    error: raw.error,
  };
}

async function callMerger<T>(path: string, init?: RequestInit, timeoutMs = 15000): Promise<{ res: Response; body: T | null }> {
  const base = mergerBase();
  if (!base) throw new ProviderError(undefined, "MERGER_API_BASE غير مضبوط");
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new ProviderError(undefined, `network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: string; message?: string }) | null;
  if (!res.ok) {
    const msg = body?.error || body?.message || `HTTP ${res.status}`;
    throw new ProviderError(res.status, String(msg));
  }
  return { res, body: body as T };
}

/** فحص جهوزية الخدمة: GET /api/config بمهلة 4 ثوانٍ */
export async function mergerHealthy(): Promise<boolean> {
  const base = mergerBase();
  if (!base) return false;
  try {
    const res = await fetch(`${base}/api/config`, { signal: AbortSignal.timeout(4000) });
    return res.ok;
  } catch {
    return false;
  }
}

export interface CreatedMergeJob {
  jobId: string;
  status?: string;
}

/** POST /api/jobs {"videos": [...]} → {jobId, status, statusUrl, processUrl, expiresAt} */
export async function createMergeJob(urls: string[]): Promise<CreatedMergeJob> {
  const { body } = await callMerger<Record<string, unknown>>(
    "/api/jobs",
    { method: "POST", body: JSON.stringify({ videos: urls }) },
  );
  const jobId = body?.jobId ?? body?.jobid ?? body?.id;
  if (!jobId) throw new ProviderError(502, "خدمة الدمج: استجابة بلا jobId");
  return { jobId: String(jobId), status: typeof body?.status === "string" ? body.status : undefined };
}

export interface MergeProcessResult {
  done: boolean;
  videoUrl?: string;
  downloadUrl?: string;
  size?: number;
  duration?: number;
  resolution?: string;
  error?: string;
}

/** POST /api/jobs/{id}/process — يستغرق ~10-15 ثانية (blocking).
 *  نجاح → {"status":"done","videoUrl":...} | فشل → HTTP 500 + {"error":"..."} (فشل حتمي نهائي). */
export async function postMergeProcess(jobId: string): Promise<MergeProcessResult> {
  const { body } = await callMerger<MergeProcessResult & { status?: string }>(
    `/api/jobs/${encodeURIComponent(jobId)}/process`,
    { method: "POST" },
    120000, // العملية متزامنة وقد تستغرق وقتًا
  );
  const status = String(body?.status ?? "").toLowerCase();
  if (status === "done" || status === "completed" || status === "success") {
    return { done: true, videoUrl: body?.videoUrl, downloadUrl: body?.downloadUrl, size: body?.size, duration: body?.duration, resolution: body?.resolution };
  }
  // 202 أو أي حالة أخرى = ما زالت قيد المعالجة
  return { done: false };
}

/** GET /api/jobs/{id} — الحالة + التقدم + الرابط عند الاكتمال.
 *  404 → المهمة غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة). */
export async function getMergeJob(jobId: string): Promise<MergeJobStatus & { jobId: string }> {
  const { body } = await callMerger<Record<string, unknown>>(`/api/jobs/${encodeURIComponent(jobId)}`, {
    method: "GET",
  });
  const raw = body ?? {};
  const norm = normalizeMergeStatus({
    status: typeof raw.status === "string" ? raw.status : undefined,
    progress: raw.progress,
    videoUrl: typeof raw.videoUrl === "string" ? raw.videoUrl : undefined,
    downloadUrl: typeof raw.downloadUrl === "string" ? raw.downloadUrl : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    jobId: typeof raw.jobId === "string" ? raw.jobId : jobId,
  });
  // رابط النتيجة: فضّل videoUrl ثم downloadUrl، وإن غابا وُلّد رابط البث المباشر
  if (norm.state === "completed") {
    norm.videoUrl = norm.videoUrl || norm.downloadUrl || `${mergerBase()}/api/jobs/${jobId}/video`;
  }
  return { ...norm, jobId };
}

/** DELETE /api/jobs/{id} — حذف فوري (تنظيف اختياري) */
export async function deleteMergeJob(jobId: string): Promise<void> {
  await callMerger(`/api/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE" });
}
