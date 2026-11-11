// أنواع مشتركة للمشروع كله (مهمة، مفتاح، محاولة، تصنيف أخطاء)

export type ProviderId = "kie" | "cometapi";
export type TaskProvider = ProviderId | "merger";
export type MediaType = "image" | "video" | "merge";
export type TaskStatus = "pending" | "processing" | "completed" | "failed";
export type KeyStatus = "active" | "exhausted" | "disabled";

/** تصنيف خطأ المزود — يحدد سلوك التبديل التلقائي بين المفاتيح */
export type ErrorClass = "disabled" | "exhausted" | "provider" | "params" | "temporary";

/** سجل محاولة واحدة (نجاح أو فشل) على مفتاح/مزود — يُخزَّن في attempts_json */
export interface AttemptRecord {
  provider: TaskProvider;
  keyId?: string;
  keyLabel?: string;
  ok: boolean;
  errorClass?: ErrorClass;
  error?: string;
  at: string; // ISO timestamp
}

export interface TaskRow {
  id: string; // UUID نولّده نحن (task_id الذي يراه عميل MCP)
  provider: TaskProvider | null;
  provider_task_id: string | null;
  key_id: string | null;
  model: string;
  type: MediaType;
  label: string; // اسم اختياري يعرض في مكتبة المقاطع (افتراضيًا فارغ)
  prompt: string;
  params_json: string; // كل معطيات الطلب الأصلية (لإعادة الإنشاء عند التبديل)
  status: TaskStatus;
  progress: number; // 0..100
  result_urls_json: string | null;
  error_message: string | null;
  attempts_json: string; // سجل كل المحاولات
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** عرض المهمة للواجهة (JSON محلولة جاهزة للعرض) */
export interface TaskView extends Omit<TaskRow, "attempts_json" | "result_urls_json" | "params_json"> {
  attempts: AttemptRecord[];
  result_urls: string[];
}

export interface KeyRow {
  id: string;
  provider: ProviderId;
  label: string;
  api_key: string; // لا يخرج من السيرفر أبدًا — يُقنَّع دائمًا قبل أي استجابة
  status: KeyStatus;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** المفتاح كما يظهر للواجهة — مقنَّع، بلا قيمة كاملة إطلاقًا */
export interface PublicKeyView extends Omit<KeyRow, "api_key"> {
  masked: string;
}
