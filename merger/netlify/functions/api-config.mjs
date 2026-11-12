// GET /api/config — حدود الخدمة والإعدادات العامة
import { handle } from "./_lib/shim.mjs";
import handler from "../../api/config.js";

export const config = { path: "/api/config" };
export default async (request) => handle(request, handler);
