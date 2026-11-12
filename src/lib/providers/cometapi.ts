// محوّل CometAPI — المزود الثاني.
// صور متزامنة عبر نقطة متوافقة مع OpenAI: POST /v1/images/generations (تعيد الرابط فورًا).
// فيديو غير متزامن عبر نقطة grok: POST /grok/v1/videos/generations ثم GET /grok/v1/videos/{id}
// (الحالة SUCCESS/FAILURE، التقدم كسلسلة "45%"، الرابط داخل data.data.video.url) — وفق التوثيق الرسمي.

import { ProviderError } from "../errors";
import type { ProviderAdapter, ProviderCheckResult, ProviderInput } from "./types";

const BASE = "https://api.cometapi.com";
const TIMEOUT_MS = 30000;

async function callComet<T>(url: string, apiKey: string, init?: RequestInit): Promise<T> {
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
    throw new ProviderError(undefined, `network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const msg =
      (body?.error && typeof body.error === "object" && ((body.error as Record<string, unknown>).message as string)) ||
      (typeof body?.error === "string" ? body.error : null) ||
      (typeof body?.message === "string" ? body.message : null) ||
      `HTTP ${res.status}`;
    throw new ProviderError(res.status, String(msg));
  }
  return body as unknown as T;
}

function parseProgress(p: unknown): number | undefined {
  if (typeof p === "number") return Math.max(0, Math.min(100, p));
  if (typeof p === "string") {
    const m = p.match(/(\d+(?:\.\d+)?)/);
    if (m) return Math.max(0, Math.min(100, Number(m[1])));
  }
  return undefined;
}

export const cometapiAdapter: ProviderAdapter = {
  id: "cometapi",

  /** صور متزامنة — تعيد الرابط (أو b64_json نحوله data URI) فورًا */
  async createImageSync(apiKey, providerModel, input: ProviderInput) {
    const body = await callComet<{ data?: { url?: string; b64_json?: string }[] }>(
      `${BASE}/v1/images/generations`,
      apiKey,
      {
        method: "POST",
        body: JSON.stringify({
          model: providerModel,
          prompt: input.prompt,
          n: 1,
          response_format: "url",
        }),
      },
    );
    const first = body?.data?.[0];
    if (first?.url) return { urls: [first.url] };
    if (first?.b64_json) return { urls: [`data:image/png;base64,${first.b64_json}`] };
    throw new ProviderError(502, "cometapi: استجابة بلا صورة");
  },

  async createTask(apiKey, providerModel, input: ProviderInput) {
    const body = await callComet<{ request_id?: string; id?: string; task_id?: string; data?: { request_id?: string } }>(
      `${BASE}/grok/v1/videos/generations`,
      apiKey,
      {
        method: "POST",
        body: JSON.stringify({
          model: providerModel,
          prompt: input.prompt,
          duration: input.duration,
          aspect_ratio: input.aspect_ratio,
          resolution: input.resolution,
        }),
      },
    );
    const id =
      body?.request_id ??
      body?.id ??
      body?.task_id ??
      body?.data?.request_id;
    if (!id) throw new ProviderError(502, "cometapi: استجابة بلا معرّف مهمة");
    return { providerTaskId: String(id) };
  },

  async checkTask(apiKey, providerTaskId): Promise<ProviderCheckResult> {
    const body = await callComet<{
      data?: { status?: string; progress?: unknown; fail_reason?: string; data?: { video?: { url?: string } } };
    }>(`${BASE}/grok/v1/videos/${encodeURIComponent(providerTaskId)}`, apiKey, { method: "GET" });
    const d = body?.data ?? {};
    const status = String(d.status ?? "").toLowerCase();

    if (status === "success" || status === "succeeded" || status === "completed" || status === "done") {
      const url = d.data?.video?.url;
      if (!url) return { status: "failed", error: "اكتملت المهمة لدى المزود دون رابط فيديو" };
      return { status: "completed", urls: [url], progress: 100 };
    }
    if (status === "failure" || status === "failed" || status === "error" || status === "cancelled") {
      return { status: "failed", error: d.fail_reason || "فشل التوليد لدى المزود" };
    }
    return { status: "processing", progress: parseProgress(d.progress) ?? 40 };
  },
};
