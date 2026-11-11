// PATCH /api/keys/{id} — تعطيل/تنشيط يدوي.
// DELETE /api/keys/{id} — حذف.

import { deleteKey, getKeyById, toPublicKeyView, updateKeyStatus } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { status?: string } | null;
  if (body?.status !== "active" && body?.status !== "disabled") {
    return Response.json({ error: "الحالة المقبولة: active أو disabled" }, { status: 400 });
  }
  const existing = await getKeyById(id);
  if (!existing) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  await updateKeyStatus(id, body.status, null);
  const updated = await getKeyById(id);
  return Response.json({ key: toPublicKeyView(updated!) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const ok = await deleteKey(id);
  if (!ok) return Response.json({ error: "المفتاح غير موجود" }, { status: 404 });
  return Response.json({ ok: true });
}
