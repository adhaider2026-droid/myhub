// POST /api/jobs/<id>/process — تنفيذ الدمج كاملًا (سحب ← ترميز ← تخزين)
//
// على Netlify هذه **دالة خلفية (Background Function)**:
// - يستلم المتصل 202 فورًا (Netlify يعيدها تلقائيًا مع تجاهل جسم الاستجابة).
// - الدمج يجري هنا حتى 15 دقيقة (أطول بكتير من حد الدوال المتزامنة 60 ثانية)،
//   والتقدم يُكتب في Turso فورًا فيستطله العميل من GET /api/jobs/<id>.
// - كل خطأ يسجَّل في القاعدة كحالة failed من داخل processJob — لا نعيد رميه هنا
//   حتى لا يفعّل Netlify إعادة المحاولة التلقائية على مهمة فشلت فعلًا.
// - خطأ 202 «قيد المعالجة بالفعل» يعني أن استدعاءً آخر يدمج الآن — تجاهل صامت.
// bundle v3 — يجرّ التجميع النظيف عند تغيّر lib/ (تجاوز كاش تجميع الدوال)

import { handle } from "./_lib/shim.mjs";
import handler from "../../api/jobs/[id]/process.js";

export const config = { path: "/api/jobs/:id/process", background: true };

export default async (request) => {
  try {
    await handle(request, handler);
  } catch (e) {
    // الدالة الخلفية لا تعيد استجابة للعميل — أي خطأ هنا تجاهل صامت
    // (processJob سجّل سبب الفشل في قاعدة البيانات أصلًا)
  }
  return new Response(null, { status: 202 });
};
