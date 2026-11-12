// واجهة محوّلات المزودين — كل خطأ يُرمى كـ ProviderError ليُصنَّف في src/lib/errors.ts.

import type { ProviderId } from "../types";

/** معطيات التوليد الموحدة (تُبنى من معطيات الأداة الأصلية) */
export interface ProviderInput {
  prompt: string;
  image_url?: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  enable_audio?: boolean;
  duration?: number;
  /** ريلز المجانية: عدد المشاهد (1..10) ومدة كل مشهد بالثواني (2..8) */
  scenes?: number;
  seconds_per_scene?: number;
}

export interface ProviderCheckResult {
  status: "processing" | "completed" | "failed";
  urls?: string[];
  error?: string;
  progress?: number; // 0..100 إن وفره المزود
}

export interface ProviderAdapter {
  id: ProviderId;
  /** مهمة غير متزامنة (فيديو وبعض الصور): تعيد providerTaskId */
  createTask(apiKey: string, providerModel: string, input: ProviderInput): Promise<{ providerTaskId: string }>;
  /** صور متزامنة إن كان المزود يدعمها (CometAPI يعيد النتيجة فورًا) */
  createImageSync?(apiKey: string, providerModel: string, input: ProviderInput): Promise<{ urls: string[] }>;
  /** استعلام حالة مهمة جارية */
  checkTask(apiKey: string, providerTaskId: string): Promise<ProviderCheckResult>;
}
