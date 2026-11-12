// محوّل Gemini (Google Veo) — توليد فيديو حقيقي عبر Gemini API:
//   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:predictLongRunning
//        (ترويسة x-goog-api-key) → { name: "models/{model}/operations/{id}" }
//   GET  https://generativelanguage.googleapis.com/v1beta/{operation.name} → done + روابط Files API
// ملاحظة: رابط النتيجة من Files API يتطلب المصادقة — نُلحق مفتاح المستخدم نفسه كمعامل key
// ليعمل الرابط مباشرة في المتصفح (المفتاح مقنّع في كل واجهات العرض ولا يُخزَّن في الروابط إلا هنا).

import { ProviderError } from "../errors";
import type { ProviderAdapter, ProviderCheckResult, ProviderInput } from "./types";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 30000;

async function callGemini<T>(url: string, apiKey: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new ProviderError(undefined, `network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await res.json().catch(() => null)) as (T & { error?: { code?: number; message?: string } }) | null;
  if (!res.ok || !body) {
    throw new ProviderError(body?.error?.code ?? res.status, body?.error?.message || `HTTP ${res.status}`);
  }
  return body;
}

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",

  async createTask(apiKey, providerModel, input: ProviderInput) {
    const instance: Record<string, unknown> = { prompt: input.prompt };

    // صورة البداية (image-to-video): تُحوَّل Base64 لأن حقل uri مقصور على روابط Google
    if (input.image_url) {
      let res: Response;
      try {
        res = await fetch(input.image_url, { signal: AbortSignal.timeout(20000) });
      } catch (e) {
        throw new ProviderError(undefined, `network error: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!res.ok) throw new ProviderError(400, `تعذر تنزيل صورة البداية (HTTP ${res.status})`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 8 * 1024 * 1024) {
        throw new ProviderError(400, "صورة البداية فارغة أو أكبر من الحد المسموح (8MB)");
      }
      instance.image = { bytesBase64Encoded: buf.toString("base64") };
    }

    const parameters: Record<string, unknown> = {};
    if (input.aspect_ratio && input.aspect_ratio !== "auto") parameters.aspectRatio = input.aspect_ratio;
    if (input.duration && [4, 6, 8].includes(input.duration)) parameters.durationSeconds = input.duration;

    const body = await callGemini<{ name?: string }>(
      `${BASE}/models/${encodeURIComponent(providerModel)}:predictLongRunning`,
      apiKey,
      { method: "POST", body: JSON.stringify({ instances: [instance], parameters }) },
    );
    if (!body?.name) throw new ProviderError(502, "Gemini: استجابة بلا اسم العملية");
    return { providerTaskId: body.name };
  },

  async checkTask(apiKey, providerTaskId): Promise<ProviderCheckResult> {
    const body = await callGemini<{
      done?: boolean;
      error?: { code?: number; message?: string };
      response?: {
        generateVideoResponse?: {
          generatedVideos?: { video?: { uri?: string } }[];
          generatedSamples?: { video?: { uri?: string } }[];
          raiMediaFilteredReasons?: string[];
        };
      };
    }>(`${BASE}/${providerTaskId}`, apiKey, { method: "GET" });

    if (body?.error?.message) return { status: "failed", error: body.error.message };
    if (!body?.done) return { status: "processing", progress: 45 };

    const gvr = body.response?.generateVideoResponse;
    const list = gvr?.generatedVideos ?? gvr?.generatedSamples ?? [];
    const urls = list
      .map((g) => g?.video?.uri)
      .filter((u): u is string => !!u)
      .map((u) => (u.includes("key=") ? u : `${u}${u.includes("?") ? "&" : "?"}key=${encodeURIComponent(apiKey)}`));
    if (!urls.length) {
      const reasons = gvr?.raiMediaFilteredReasons?.join(" | ");
      return {
        status: "failed",
        error: reasons || "اكتمل التوليد لدى Gemini دون روابط فيديو — جرّب صياغة وصفيًا مختلفًا",
      };
    }
    return { status: "completed", urls, progress: 100 };
  },
};
