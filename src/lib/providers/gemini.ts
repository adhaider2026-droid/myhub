// محوّل Google Gemini — بديل kie.ai لتوليد الفيديو والصور.
// ملاحظة تاريخية: Veo 3.1 Preview على Gemini API أُقفل في 22 أكتوبر 2026،
// والبديل الرسمي هو Gemini Omni Flash عبر واجهة Interactions:
//   POST https://generativelanguage.googleapis.com/v1beta/interactions   (background: true → يعيد id فورًا)
//   GET  https://generativelanguage.googleapis.com/v1beta/interactions/{id}  (poll: in_progress → completed/failed)
// بنية النتيجة: steps[] → model_output → content[] → {type:"video"|"image", uri|data}
// روابط الملفات لدى Google تتطلب المفتاح للتحميل — لذا ننزّل البايتات ونستضيفها عبر media-store
// ثم نعيد رابطنا العام الثابت (بدون أي أثر للمفتاح).

import { ProviderError } from "../errors";
import { saveMediaFile } from "../media-store";
import type { ProviderAdapter, ProviderCheckResult, ProviderInput } from "./types";

const BASE = "https://generativelanguage.googleapis.com/v1beta";
const API_REVISION = "2026-05-20";
const CALL_TIMEOUT_MS = 25000; // إنشاء/استعلام — تنزيل الملف له مهلة مستقلة
const DOWNLOAD_TIMEOUT_MS = 8000; // مهلة تنزيل فيديو/صورة داخل نافذة دالة Netlify (10ث)

// القيم المقبولة فعليًا لدى Gemini Omni (توثيق response_format.resolution) — 480p غير مدعوم فيُهمَل
const VIDEO_RESOLUTIONS = new Set(["360p", "720p", "1080p", "4k"]);

async function callGemini<T>(url: string, apiKey: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json",
        "Api-Revision": API_REVISION,
        ...(init?.headers ?? {}),
      },
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (e) {
    throw new ProviderError(undefined, `network error: ${e instanceof Error ? e.message : String(e)}`);
  }
  const body = (await res.json().catch(() => null)) as
    | { error?: { code?: number; message?: string; status?: string; details?: Array<{ reason?: string }> } ; status?: string }
    | null;
  if (!res.ok || !body || body.error) {
    const err = body?.error;
    // Gemini يعيد المفتاح غير الصالح بحالة 400/INVALID_ARGUMENT وليس 401 — نعيد ترجمة
    // حالة الخطأ إلى رمز HTTP معياري ليصنّفها errors.ts بشكل صحيح (تعطيل المفتاح/نفاد/معطيات)
    const gStatus = (err?.status || "").toUpperCase();
    const reason = err?.details?.find((d) => d.reason)?.reason || "";
    let effective = err?.code ?? res.status;
    if (gStatus === "UNAUTHENTICATED" || reason === "API_KEY_INVALID" || /api key not valid/i.test(err?.message || "")) {
      effective = 401; // مفتاح مرفوض → disabled
    } else if (gStatus === "PERMISSION_DENIED") {
      effective = 403; // محظور → disabled
    } else if (gStatus === "RESOURCE_EXHAUSTED" || gStatus === "FAILED_PRECONDITION") {
      effective = 402; // حصة/فوترة → exhausted
    }
    const msg = err?.message || `HTTP ${res.status}`;
    throw new ProviderError(effective, `gemini: ${gStatus ? `${gStatus} — ` : ""}${msg}`);
  }
  return body as unknown as T;
}

/** ينزّل صورة مرجعية عامة ويحوّلها base64 لإدخال image-to-video */
async function fetchImageAsBase64(url: string): Promise<{ data: string; mime: string }> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (e) {
    throw new ProviderError(400, `تعذر جلب الصورة المرجعية: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) {
    throw new ProviderError(400, `تعذر جلب الصورة المرجعية (HTTP ${res.status}) — تأكد أنها رابط مباشر عام`);
  }
  const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  const buf = new Uint8Array(await res.arrayBuffer());
  return { data: Buffer.from(buf).toString("base64"), mime: mime.startsWith("image/") ? mime : "image/jpeg" };
}

/** يبني جسم طلب interactions لمهمة فيديو أو صورة */
function buildRequestBody(model: string, input: ProviderInput, type: "image" | "video"): Record<string, unknown> {
  const parts: Array<Record<string, unknown>> = [];
  if (type === "video" && input.image_url) {
    // الصورة المرجعية تُحفظ في معطيات المهمة أصلًا كرابط عام — أعد تنزيلها هنا
    parts.push({ type: "__image_needs_fetch__", url: input.image_url });
  }
  parts.push({ type: "text", text: input.prompt });

  const body: Record<string, unknown> = {
    model,
    input: parts,
    background: true, // تنفيذ خلفي — يعيد id فورًا ونستعلم لاحقًا
    store: true, // مطلوب للتنفيذ الخلفي (التخزين مجاني النسخ لمدة قصيرة)
  };

  if (type === "video") {
    const rf: Record<string, unknown> = { type: "video", delivery: "uri" };
    if (input.aspect_ratio === "9:16" || input.aspect_ratio === "16:9") rf.aspect_ratio = input.aspect_ratio;
    const res = (input.resolution || "").toLowerCase();
    if (VIDEO_RESOLUTIONS.has(res)) rf.resolution = res;
    if (input.duration && input.duration >= 3 && input.duration <= 15) rf.duration = `${Math.round(input.duration)}s`;
    body.response_format = rf;
  } else {
    body.response_format = { type: "image" };
  }
  return body;
}

interface MediaHit {
  kind: "video" | "image";
  mime: string;
  uri?: string;
  b64?: string;
}

/** يمشي على بنية الاستجابة كاملة ويجمع أول عنصر وسائط بأي صيغة معروفة */
function walkForMedia(node: unknown, hit: { found?: MediaHit }, depth = 0): void {
  if (hit.found || depth > 12 || node == null) return;
  if (Array.isArray(node)) {
    for (const item of node) walkForMedia(item, hit, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  const o = node as Record<string, unknown>;

  const mime = typeof o.mime_type === "string" ? o.mime_type : typeof o.mimeType === "string" ? o.mimeType : "";
  const isVideo = o.type === "video" || mime.startsWith("video/");
  const isImage = o.type === "image" || mime.startsWith("image/");
  if (isVideo || isImage) {
    const uri = typeof o.uri === "string" ? o.uri : typeof o.fileUri === "string" ? o.fileUri : undefined;
    const b64 =
      typeof o.data === "string"
        ? o.data
        : typeof o.bytesBase64Encoded === "string"
          ? o.bytesBase64Encoded
          : // صيغة generateContent القديمة احتياطًا
            (() => {
              const inline = o.inlineData as Record<string, unknown> | undefined;
              return inline && typeof inline.data === "string" ? inline.data : undefined;
            })();
    if (uri || b64) {
      hit.found = { kind: isVideo ? "video" : "image", mime: mime || (isVideo ? "video/mp4" : "image/png"), uri, b64 };
      return;
    }
  }
  const inline = o.inlineData as Record<string, unknown> | undefined;
  if (inline) walkForMedia(inline, hit, depth + 1);
  for (const v of Object.values(o)) walkForMedia(v, hit, depth + 1);
}

interface InteractionResponse {
  id?: string;
  status?: string;
  error?: { message?: string };
  steps?: Array<Record<string, unknown>>;
}

/** ينزّل وسائط النتيجة ويستضيفها محليًا — يعيد رابطنا العام */
async function materializeMedia(apiKey: string, hit: MediaHit): Promise<string[]> {
  if (hit.uri) {
    let res: Response;
    try {
      res = await fetch(hit.uri, {
        headers: { "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
      });
    } catch {
      // مهلة التنزيل → لا تُفشل المهمة؛ الاستعلام التالي (get_task) يعيد المحاولة والملف ما زال لدى Google
      return [];
    }
    if (!res.ok) {
      // 401/403 → مشكلة مفتاح؛ غير ذلك اعتبرها مؤقتة (الملف قد لا يكون جاهزًا بعد)
      throw new ProviderError(res.status === 401 || res.status === 403 ? res.status : undefined, `تعذر تنزيل الناتج من Google (HTTP ${res.status})`);
    }
    const mime = (res.headers.get("content-type") || hit.mime).split(";")[0].trim() || hit.mime;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const url = await saveMediaFile(bytes, mime);
    return [url];
  }
  if (hit.b64) {
    const bytes = Uint8Array.from(Buffer.from(hit.b64, "base64"));
    const url = await saveMediaFile(bytes, hit.mime);
    return [url];
  }
  return [];
}

export const geminiAdapter: ProviderAdapter = {
  id: "gemini",

  async createTask(apiKey, providerModel, input: ProviderInput) {
    const type = providerModel.includes("image") ? "image" : "video";
    const body = buildRequestBody(providerModel, input, type);

    // الصورة المرجعية: ننزّلها الآن ونحوّلها base64 قبل الإرسال
    if (Array.isArray(body.input)) {
      const parts = body.input as Array<Record<string, unknown>>;
      const imgPart = parts.find((p) => p.type === "__image_needs_fetch__");
      if (imgPart) {
        const { data, mime } = await fetchImageAsBase64(String(imgPart.url));
        imgPart.type = "image";
        imgPart.data = data;
        imgPart.mime_type = mime;
        delete imgPart.url;
      }
    }

    const created = await callGemini<InteractionResponse>(`${BASE}/interactions`, apiKey, {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!created?.id) throw new ProviderError(502, "gemini: استجابة الإنشاء بلا معرّف مهمة");
    return { providerTaskId: created.id };
  },

  async checkTask(apiKey, providerTaskId): Promise<ProviderCheckResult> {
    const st = await callGemini<InteractionResponse>(`${BASE}/interactions/${encodeURIComponent(providerTaskId)}`, apiKey, {
      method: "GET",
    });

    if (st.status === "failed" || st.status === "cancelled") {
      // ابحث عن رسالة خطأ داخل الخطوات إن وُجدت
      let msg = (st as { error?: { message?: string } })?.error?.message || "";
      if (!msg && Array.isArray(st.steps)) {
        const errStep = st.steps.find((s) => (s as { type?: string }).type === "error") as { error?: { message?: string } } | undefined;
        msg = errStep?.error?.message || "";
      }
      return { status: "failed", error: msg || "فشل توليد الفيديو لدى Gemini" };
    }

    if (st.status === "completed") {
      const hit: { found?: MediaHit } = {};
      walkForMedia(st.steps ?? st, hit);
      if (!hit.found) {
        return { status: "failed", error: "اكتمل التوليد لدى Gemini دون ناتج وسائط" };
      }
      const urls = await materializeMedia(apiKey, hit.found);
      // [] = انتهت مهلة التنزيل فقط → أبقِ المهمة معالجة وتُحسم في الاستعلام التالي
      if (!urls.length) return { status: "processing", progress: 97 };
      return { status: "completed", urls, progress: 100 };
    }

    // in_progress | requires_action (لا ننتظر تفاعلًا هنا) | حالات أخرى → معالجة
    return { status: "processing" };
  },
};
