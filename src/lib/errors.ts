// تصنيف أخطاء المزودين — جدول 4.2 في المواصفة.
// التصنيف يحدد سلوك التبديل: تعطيل المفتاح / تعليمه مستنزفًا / الانتقال للتالي / توقف فوري.

import type { ErrorClass } from "./types";

/** خطأ يرميه أي محوّل مزود — status قد يكون غير معرف (انقطاع شبكة/timeout) */
export class ProviderError extends Error {
  constructor(
    public status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

const AUTH_PATTERNS = /(invalid api key|unauthorized|forbidden|authentication|apikey غير صالح)/i;
const EXHAUSTED_PATTERNS = /(insufficient|quota|balance|credit|out of credits|exhausted|充值|رصيد)/i;
// يشمل: model not found / unsupported model / "model name ... is not supported" (صيغة kie الفعلية)
const MODEL_PATTERNS = /(model not found|unsupported model|unknown model|not a valid model|invalid model|model does not exist|model[^.]{0,40}not supported)/i;
// أخطاء حقول مطلوبة لدى kie تصل بحالة 500 داخليًا — معطيات وليست مؤقتة
const FIELD_PATTERNS = /(field (is )?required|validation error|missing (required )?(field|param))/i;

/**
 * يصنف خطأ المزود إلى فئة واحدة:
 * - disabled:  مفتاح مرفوض (401/403 أو رسالة توثيق) → يُعلَّم disabled تلقائيًا وينتقل للتالي
 * - exhausted: نفاد رصيد (402 أو رسالة رصيد — تُفحص قبل 400 لأن بعض المزودين يرسلونها بحالة 400)
 * - provider:  الموديل غير مدعوم لدى هذا المزود → انتقل للمزود/المفتاح التالي
 * - params:    خطأ معطيات الطلب → توقف فورًا (تبديل المفاتيح لن يحل خطأ معطيات)
 * - temporary: 429/5xx/انقطاع شبكة/timeout → انتقل للتالي الآن والمفتاح يبقى سليمًا
 */
export function classifyProviderError(err: unknown): ErrorClass {
  const status = err instanceof ProviderError ? err.status : undefined;
  const msg = err instanceof Error ? err.message : String(err);

  if (status === 401 || status === 403) return "disabled";
  if (AUTH_PATTERNS.test(msg)) return "disabled";
  // نفاد الرصيد قبل فحص 400/422 — بعض المزودين يرسلون نفاد الرصيد بحالة 400
  if (status === 402 || EXHAUSTED_PATTERNS.test(msg)) return "exhausted";

  if (status === 400 || status === 404 || status === 422) {
    if (MODEL_PATTERNS.test(msg)) return "provider";
    // 404 عام (مثل مهمة غير موجودة عند الاستعلام) لا علاقة له بالمعطيات — نعامله كمؤقت
    if (status === 404) return "temporary";
    return "params";
  }
  // بعض المزودين (kie) يرسلون أخطاء الحقول بحالة 500 داخليًا — معطيات وليست مؤقتة
  if (FIELD_PATTERNS.test(msg)) return "params";
  return "temporary";
}

/** هل رسالة الفشل من فئة مشكلات مفتاح/رصيد (تستخدم لقرار إعادة الإنشاء في منتصف المهمة) */
export function isKeyRelatedMessage(msg: string | null | undefined): boolean {
  if (!msg) return false;
  return /(insufficient|balance|credit|quota|402|401|unauthorized)/i.test(msg);
}

/**
 * تنقية السبب قبل خروجه للعميل:
 * القاعدة الذهبية — نموذج الذكاء الاصطناعي لا يرى أبدًا أي ذكر لمفاتيح أو رصيد.
 */
export function sanitizeReason(msg: string | null | undefined): string {
  const m = (msg || "").trim() || "خطأ غير معروف";
  if (isKeyRelatedMessage(m)) return "خطأ مؤقت لدى المزود — تُعاد المحاولة تلقائيًا";
  return m;
}
