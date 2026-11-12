// GET /api/jobs/<id> — الحالة والتقدم | DELETE — حذف فوري شامل
import { handle } from "./_lib/shim.mjs";
import handler from "../../api/jobs/[id].js";

export const config = { path: "/api/jobs/:id" };
export default async (request) => handle(request, handler);
