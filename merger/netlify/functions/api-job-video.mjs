// POST /api/jobs/<id>/video — بث الناتج بدعم Range (206 + Content-Range)
// استجابة تدفقية عبر Readable — لا حد حجم للمخرجات الكبيرة.
import { handle } from "./_lib/shim.mjs";
import handler from "../../api/jobs/[id]/video.js";

export const config = { path: "/api/jobs/:id/video" };
export default async (request) => handle(request, handler);
