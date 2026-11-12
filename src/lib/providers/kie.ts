// محوّل kie.ai — المزود الأساسي. Jobs API الموحد:
//   POST /api/v1/jobs/createTask  {"model": ..., "input": {...}} → {"code":200,"data":{"taskId":"..."}}
//   GET  /api/v1/jobs/recordInfo?taskId=<id> → data.state = waiting|queuing|generating|success|fail
// انتبه: resultJson نص JSON داخل JSON يحتاج JSON.parse ثانيًا (حسب التوثيق الرسمي docs.kie.ai).

import { ProviderError } from "../errors";
import type { ProviderAdapter, ProviderCheckResult, ProviderInput } from "./types";

const BASE = "https://api.kie.ai/api/v1/jobs";
const TIMEOUT_MS = 30000;

function errFrom(status: number, body: { code?: number; msg?: string; message?: string } | null): ProviderError {
  const msg = body?.msg || body?.message || `HTTP ${status}`;
  // بعض أخطاء kie تأتي بحالة HTTP 200 لكن code داخلي != 200 — نرسل الحالة الداخلية للتصنيف
  return new ProviderError(body?.code && body.code !== 200 ? body.code : status, msg);
}

async function callKie<T>(url: string, apiKey: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    // انقطاع شبكة/timeout — بلا حالة HTTP: يصنف temporary
    throw new ProviderError(undefined, `network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await res.json().catch(() => null)) as { code?: number; msg?: string; data?: unknown } | null;
  if (!res.ok || !body || (typeof body.code === "number" && body.code !== 200)) {
    throw errFrom(res.status, body);
  }
  return body as unknown as T;
}

/** استخراج روابط النتائج — resultJson نص JSON داخل JSON (وأحيانًا resultObject/video_url) */
export function extractResultUrls(raw: unknown): string[] {
  let obj: unknown = raw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return [];
    }
  }
  if (Array.isArray(obj)) return obj.filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u));
  if (obj && typeof obj === "object") {
    const o = obj as Record<string, unknown>;
    if (Array.isArray(o.resultUrls)) {
      return (o.resultUrls as unknown[]).filter((u): u is string => typeof u === "string");
    }
    if (typeof o.resultUrl === "string") return [o.resultUrl];
    // بعض الموديلات تعيد resultObject متداخلًا
    let ro: unknown = o.resultObject;
    if (typeof ro === "string") {
      try {
        ro = JSON.parse(ro);
      } catch {
        ro = null;
      }
    }
    if (ro && typeof ro === "object") {
      const r = ro as Record<string, unknown>;
      if (Array.isArray(r.resultUrls)) return (r.resultUrls as unknown[]).filter((u): u is string => typeof u === "string");
      if (typeof r.video_url === "string") return [r.video_url];
      if (typeof r.videoUrl === "string") return [r.videoUrl];
    }
  }
  return [];
}

export const kieAdapter: ProviderAdapter = {
  id: "kie",

  async createTask(apiKey, providerModel, input: ProviderInput) {
    const body = await callKie<{ data: { taskId: string } }>(`${BASE}/createTask`, apiKey, {
      method: "POST",
      body: JSON.stringify({ model: providerModel, input }),
    });
    if (!body?.data?.taskId) throw new ProviderError(502, "kie: استجابة بلا taskId");
    return { providerTaskId: String(body.data.taskId) };
  },

  async checkTask(apiKey, providerTaskId): Promise<ProviderCheckResult> {
    const body = await callKie<{
      data: { state?: string; resultJson?: unknown; failMsg?: string; progress?: number };
    }>(`${BASE}/recordInfo?taskId=${encodeURIComponent(providerTaskId)}`, apiKey, { method: "GET" });
    const d = body?.data ?? {};
    const state = String(d.state ?? "").toLowerCase();

    if (state === "success") {
      const urls = extractResultUrls(d.resultJson);
      if (!urls.length) return { status: "failed", error: "اكتملت المهمة لدى المزود دون روابط نتيجة" };
      return { status: "completed", urls, progress: 100 };
    }
    if (state === "fail") {
      return { status: "failed", error: d.failMsg || "فشل التوليد لدى المزود" };
    }
    // waiting | queuing | generating (وإن ظهرت حالات وسيطة أخرى تعامل كمعالجة)
    const derived = state === "generating" ? 55 : state === "queuing" ? 20 : 10;
    const progress = typeof d.progress === "number" ? Math.max(derived, Math.min(95, d.progress)) : derived;
    return { status: "processing", progress };
  },
};
