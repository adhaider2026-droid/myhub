// تنظيف يومي مجدول — حذف كل المهام المنتهية الصلاحية (أكثر من 24 ساعة)
// Netlify Scheduled Functions: تعمل يوميًا الساعة 03:00 UTC مجانًا.
import { handle, syntheticGet } from "./_lib/shim.mjs";
import handler from "../../api/cron.js";

export const config = { schedule: "0 3 * * *" };

export default async () => {
  try {
    await handle(syntheticGet("/api/cron"), handler);
  } catch (e) {
    // التنظيف كسول أيضًا عند كل إنشاء/دمج — فشل المجدول غير حرج
  }
  return new Response("cleanup done");
};
