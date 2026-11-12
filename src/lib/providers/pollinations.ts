// محوّل Pollinations — مزودان في واحد، كلاهما مجاني بالكامل بلا مفتاح ولا رصيد:
//
// 1) ريلز مجانية (موديل reels-free): 
//    - السكربت: text.pollinations.ai يقسّم الوصف إلى مشاهد بصرية (مجاني)
//    - الصور:   image.pollinations.ai يولّد كل مشهد بالأبعاد العمودية 9:16 (مجاني)
//    - التجميع: خدمة الدمج على السيرفر (ffmpeg) بوضع slideshow:
//               حركة كاميرا سينمائية + انتقالات ناعمة + مسار صوت صامت → MP4 عمودي
// 2) صور مفردة مجانية (تُجرَّب أولًا لموديل الصور قبل المزودين المدفوعين):
//    - رابط توليد ثابت (prompt + seed) — تُولَّد عند أول جلب ثم تُخزَّن مؤقتًا لدى المزود
//    - نعيد رابط Pollinations نفسه نتيجةً (عام وقابل لإعادة الجلب بلا إعادة استضافة)
//
// لا يحتاج مفتاحًا: getKeyPool يُحقن مفتاحًا مدمجًا وهميًا له (builtinFreeKey في keys.ts).

import { ProviderError } from "../errors";
import { createMergeJob, getMergeJob, postMergeProcess } from "../merger";
import type { ProviderAdapter, ProviderCheckResult, ProviderInput } from "./types";

const TEXT_TIMEOUT_MS = 25000;
const IMAGE_POLL_TIMEOUT_MS = 8500; // ضمن نافذة دالة Netlify (10ث) — الفشل يعاد في الاستعلام التالي
/** علامة موديل الصور المفردة في providerModel — تميّزها عن موديل الريلز (اسم نموذج الصور) */
export const POLLINATIONS_SINGLE_IMAGE = "free-image";

/** قفل ذاكرة يمنع إطلاق المعالجة المتزامن لنفس jobId (الحجز الذري لدى الخدمة هو الضمانة الحقيقية) */
const processInFlight = new Set<string>();

/** أطلق POST .../process خلفيًا وبمرة واحدة لكل مهمة تجميع */
function fireSlideshowProcess(jobId: string): void {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  void (async () => {
    try {
      await postMergeProcess(jobId);
    } catch (e) {
      /* أي فشل يظهر عند الاستعلام التالي — و queued يُعاد إطلاقه هناك */
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

/** أبعاد الريل — العمودي 9:16 افتراضيًا مع دعم 16:9 و1:1 */
function dimsFor(aspect: string | undefined): { width: number; height: number } {
  switch (aspect) {
    case "16:9":
      return { width: 1280, height: 720 };
    case "1:1":
      return { width: 1024, height: 1024 };
    default:
      return { width: 720, height: 1280 };
  }
}

/** تقسيم الوصف إلى مشاهد بصرية إنجليزية عبر text.pollinations.ai — وبديل آمن عند أي فشل */
async function buildScenePrompts(prompt: string, scenes: number): Promise<string[]> {
  const meta =
    `Return ONLY a JSON array of ${scenes} strings. Each string is a vivid, detailed English text-to-image prompt ` +
    `for one sequential scene of a short vertical video about: "${prompt}". ` +
    `Keep a consistent visual style across all scenes, cinematic lighting, photorealistic detail. ` +
    `No text, no watermarks. No markdown, no commentary — just the JSON array.`;
  try {
    const res = await fetch(`https://text.pollinations.ai/${encodeURIComponent(meta)}`, {
      signal: AbortSignal.timeout(TEXT_TIMEOUT_MS),
    });
    if (res.ok) {
      const raw = await res.text();
      const start = raw.indexOf("[");
      const end = raw.lastIndexOf("]");
      if (start >= 0 && end > start) {
        const arr = JSON.parse(raw.slice(start, end + 1)) as unknown;
        if (Array.isArray(arr)) {
          const list = arr.map((x) => String(x).trim()).filter(Boolean).slice(0, scenes);
          while (list.length < scenes) list.push(prompt);
          return list;
        }
      }
    }
  } catch (e) {
    /* تعذر توليد السكربت — نستخدم الوصف الأصلي لكل المشاهد */
  }
  return Array.from({ length: scenes }, () => prompt);
}

/** ابنِ رابط توليد صورة مفردة ثابتًا (نفس الوصف + نفس seed = نفس النتيجة) */
function singleImageUrl(prompt: string, aspect: string | undefined): string {
  const { width, height } = dimsFor(aspect);
  const seed = Math.floor(Math.random() * 1_000_000_000);
  const p = encodeURIComponent(prompt.replace(/\s+/g, " ").trim().slice(0, 1500));
  return `https://image.pollinations.ai/prompt/${p}?width=${width}&height=${height}&seed=${seed}&nologo=true`;
}

export const pollinationsAdapter: ProviderAdapter = {
  id: "pollinations",

  async createTask(_apiKey, providerModel, input: ProviderInput) {
    // أ) صورة مفردة مجانية — نعيد الرابط نفسه كمعرّف مهمة (الاستعلام يجلب الصورة ويتحقق منها)
    if (providerModel === POLLINATIONS_SINGLE_IMAGE) {
      return { providerTaskId: singleImageUrl(input.prompt, input.aspect_ratio) };
    }

    // ب) ريلز مجانية عبر خدمة التجميع
    if (!process.env.MERGER_API_BASE) {
      throw new ProviderError(500, "خدمة التجميع غير مهيأة على السيرفر (MERGER_API_BASE)");
    }
    const scenes = Math.max(1, Math.min(10, Math.floor(Number(input.scenes) || 4)));
    const perScene = Math.max(2, Math.min(8, Math.floor(Number(input.seconds_per_scene) || 4)));
    const { width, height } = dimsFor(input.aspect_ratio);

    const scenePrompts = await buildScenePrompts(input.prompt, scenes);
    const imageUrls = scenePrompts.map((sp) => {
      const styled = `${sp}, cinematic, high quality, detailed`;
      const seed = Math.floor(Math.random() * 1000000000);
      return (
        `https://image.pollinations.ai/prompt/${encodeURIComponent(styled)}` +
        `?width=${width}&height=${height}&seed=${seed}&nologo=true&model=${encodeURIComponent(providerModel || "flux")}`
      );
    });

    // مهمة تجميع بوضع الريلز على خدمة الدمج — نفس بنية المهام الموجودة
    const { jobId } = await createMergeJob(imageUrls, {
      mode: "slideshow",
      options: { sceneDuration: perScene, transition: "fade", width, height },
    });
    fireSlideshowProcess(jobId);
    return { providerTaskId: jobId };
  },

  async checkTask(_apiKey, providerTaskId): Promise<ProviderCheckResult> {
    // صورة مفردة: المعرّف رابط Pollinations مباشر
    if (/^https?:\/\//i.test(providerTaskId)) {
      let res: Response;
      try {
        res = await fetch(providerTaskId, { signal: AbortSignal.timeout(IMAGE_POLL_TIMEOUT_MS) });
      } catch {
        return { status: "processing" }; // التوليد جارٍ لدى المزود — المحاولة التالية تجلب النسخة المخزنة
      }
      if (res.ok) {
        const mime = (res.headers.get("content-type") || "").toLowerCase();
        if (mime.startsWith("image/")) return { status: "completed", urls: [providerTaskId], progress: 100 };
        return { status: "processing" };
      }
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        return { status: "failed", error: "رفض المزود المجاني توليد هذه الصورة — جرّب صياغة أخرى للوصف" };
      }
      return { status: "processing" };
    }

    // ريلز: استعلام مهمة التجميع
    const st = await getMergeJob(providerTaskId);
    if (st.rawStatus.toLowerCase() === "queued") fireSlideshowProcess(providerTaskId); // أمان: أعد الإطلاق إن سقط الإطلاق الأول
    if (st.state === "completed" && st.videoUrl) {
      return { status: "completed", urls: [st.videoUrl], progress: 100 };
    }
    if (st.state === "failed") {
      return { status: "failed", error: st.error || "فشل تجميع الريل لدى الخدمة" };
    }
    const pct = st.progress > 0 ? 15 + Math.min(st.progress, 95) * 0.8 : 20;
    return { status: "processing", progress: Math.min(95, Math.round(pct)) };
  },
};
