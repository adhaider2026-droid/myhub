// POST /api/upload?job=<id>&seq=<n>&chunk=<k> — رفع أجزاء الملفات (ثنائي ≤4MB)
import { handle } from "./_lib/shim.mjs";
import handler from "../../api/upload.js";

export const config = { path: "/api/upload" };
export default async (request) => handle(request, handler);
