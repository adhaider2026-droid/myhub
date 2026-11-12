// GET /api/media/file/{id} — يبث ملف وسائط مخزّنًا في Turso (فيديو/صورة مولّدة).
// هذا هو الرابط العام الذي يُحفظ في result_urls لنواتج Gemini — بلا مفاتيح وبلا تسجيل دخول.

import { getMediaFile } from "@/lib/media-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return Response.json({ error: "معرّف غير صالح" }, { status: 400 });
    }
    const file = await getMediaFile(id);
    if (!file || !file.data.byteLength) {
      return Response.json({ error: "الملف غير موجود" }, { status: 404 });
    }
    return new Response(file.data as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": file.mime_type,
        "Content-Length": String(file.data.byteLength),
        // الملفات المولّدة لا تتغير أبدًا — تخزين مؤقت كامل
        "Cache-Control": "public, max-age=31536000, immutable",
        "Accept-Ranges": "none",
      },
    });
  } catch {
    return Response.json({ error: "خطأ غير متوقع" }, { status: 500 });
  }
}
