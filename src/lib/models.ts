// سجل الموديلات — الاسم canonical كما يراه عميل MCP، واسم providerModel كما يُرسل لكل مزود.
// الأسماء الحقيقية مأخوذة من التوثيق الرسمي وقابلة للتجاوز بمتغيرات البيئة:
// GEMINI_VIDEO_MODEL / GEMINI_IMAGE_MODEL / KIE_IMAGE_MODEL / KIE_VIDEO_MODEL /
// COMETAPI_IMAGE_MODEL / COMETAPI_VIDEO_MODEL / POLLINATIONS_IMAGE_MODEL.
// ملاحظة: Veo 3.1 Preview أُقفل على Gemini API في 22-10-2026 — البديل الرسمي Gemini Omni Flash (واجهة Interactions).

import type { MediaType, ProviderId } from "./types";

export interface ModelDef {
  canonical: string; // الاسم كما يراه عميل MCP
  aliases: string[]; // صيغ بديلة نقبلها ونوحدّها (شرطات/نقاط)
  type: MediaType;
  providers: ProviderId[]; // من يستطيع خدمته — تُجرَّب مفاتيحهم كلها بالترتيب
  providerModel: Record<ProviderId, string>; // اسم الموديل كما يُرسل لكل مزود
}

// ملاحظة (متحقق منها بنداءات حقيقية على api.kie.ai): الاسم المقبول فعليًا هو بالشرطات
// "gpt-image-2-6/flare-text-to-image" — الصيغة بالنقاط تُرفض برسالة model not supported.
const KIE_IMAGE_MODEL = process.env.KIE_IMAGE_MODEL || "gpt-image-2-6/flare-text-to-image";
const KIE_VIDEO_MODEL = process.env.KIE_VIDEO_MODEL || "grok-imagine-video-1-5-preview";
// توثيق CometAPI: صور gpt-image-2.6-flare عبر /v1/images/generations، وفيديو grok-imagine عبر /grok/v1/videos/generations
const COMETAPI_IMAGE_MODEL = process.env.COMETAPI_IMAGE_MODEL || "gpt-image-2.6-flare";
const COMETAPI_VIDEO_MODEL = process.env.COMETAPI_VIDEO_MODEL || "grok-imagine-video";
// Gemini API — فيديو عبر Omni Flash (بديل Veo المُقفل)، وصور عبر موديل صور Gemini (مدفوع)
const GEMINI_VIDEO_MODEL = process.env.GEMINI_VIDEO_MODEL || "gemini-omni-1.2-flash";
const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
// موديل صور Pollinations المجاني (flux افتراضيًا) لموديل الريلز
const POLLINATIONS_IMAGE_MODEL = process.env.POLLINATIONS_IMAGE_MODEL || "flux";

export const MODELS: ModelDef[] = [
  {
    // الصور: Pollinations مجاني بلا مفتاح (يُحقن آليًا آخر المجموعة)، ثم مفاتيح المزودين إن وُجدت
    canonical: "gpt-image-2-6/flare-text-to-image",
    aliases: ["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image", "gemini-3.1-flash-image"],
    type: "image",
    providers: ["gemini", "kie", "cometapi", "pollinations"],
    providerModel: { kie: KIE_IMAGE_MODEL, cometapi: COMETAPI_IMAGE_MODEL, gemini: GEMINI_IMAGE_MODEL, pollinations: "free-image" },
  },
  {
    // الفيديو: Gemini Omni Flash هو المسار الأساسي (بديل Veo المُقفل) — أسماء grok القديمة بقيت بديلة
    // لتبقى المهام والعملاء القدامى تعمل على نفس خط Gemini الجديد.
    canonical: "gemini-omni-1.2-flash",
    aliases: [
      "gemini-omni-1.2-flash",
      "gemini-omni-1-2-flash",
      "grok-imagine-video-1-5-preview",
      "grok-imagine-video-1.5-preview",
    ],
    type: "video",
    providers: ["gemini", "kie", "cometapi"],
    providerModel: { kie: KIE_VIDEO_MODEL, cometapi: COMETAPI_VIDEO_MODEL, gemini: GEMINI_VIDEO_MODEL, pollinations: "" },
  },
  {
    // ريلز مجانية بالكامل: صور Pollinations + تجميع ffmpeg على خدمتنا — بلا مفتاح ولا حدود رصيد
    canonical: "reels-free",
    aliases: ["reels-free", "reels", "free-reels", "ريلز"],
    type: "video",
    providers: ["pollinations"],
    providerModel: { kie: "", cometapi: "", gemini: "", pollinations: POLLINATIONS_IMAGE_MODEL },
  },
];

/** توحيد الصيغ البديلة: النقاط تعادل الشرطات (2.6 == 2-6) */
export function normalizeModelName(name: string): string {
  return name.trim().replace(/\./g, "-").toLowerCase();
}

/** يحل اسم الموديل (مع قبول الصيغ البديلة) إلى تعريفه — null إن كان مجهولًا */
export function resolveModel(name: string | undefined | null): ModelDef | null {
  if (!name) return null;
  const n = normalizeModelName(name);
  for (const m of MODELS) {
    if (m.aliases.some((a) => normalizeModelName(a) === n) || normalizeModelName(m.canonical) === n) {
      return m;
    }
  }
  return null;
}

/** ملخص الموديلات لاستجابة /api/health */
export function modelsSummary(): { canonical: string; type: string; providers: ProviderId[] }[] {
  return MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers }));
}
