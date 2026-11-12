// POST /api/jobs — إنشاء مهمة دمج جديدة (روابط مباشرة أو ملفات تُرفع لاحقًا)
import { handle } from "./_lib/shim.mjs";
import handler from "../../api/jobs.js";

export const config = { path: "/api/jobs" };
export default async (request) => handle(request, handler);
