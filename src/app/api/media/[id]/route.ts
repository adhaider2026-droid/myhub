// PATCH /api/media/{id} — تعديل اسم/وصف المقطع في مكتبة المقاطع.
// DELETE /api/media/{id} — حذف المقطع؛ ولمهام الدمج يُنظّف أيضًا المصادر والناتج من خدمة الدمج.

import { deleteTask, getTask, parseAttempts, parseUrls, updateTaskMeta } from "@/lib/turso";
import { deleteMergeJob, mergerConfigured } from "@/lib/merger";
import type { TaskRow, TaskView } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function toView(t: TaskRow): TaskView {
  const { attempts_json, result_urls_json, params_json, ...rest } = t;
  return { ...rest, attempts: parseAttempts(attempts_json), result_urls: parseUrls(result_urls_json) };
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const body = (await req.json().catch(() => null)) as { label?: unknown; prompt?: unknown } | null;
    if (!body) return Response.json({ error: "جسم الطلب مطلوب" }, { status: 400 });

    const patch: { label?: string; prompt?: string } = {};
    if (body.label !== undefined) {
      if (typeof body.label !== "string") return Response.json({ error: "الاسم يجب أن يكون نصًا" }, { status: 400 });
      patch.label = body.label.trim().slice(0, 200);
    }
    if (body.prompt !== undefined) {
      if (typeof body.prompt !== "string") return Response.json({ error: "الوصف يجب أن يكون نصًا" }, { status: 400 });
      patch.prompt = body.prompt.trim().slice(0, 4000);
    }
    if (!Object.keys(patch).length) return Response.json({ error: "لا يوجد ما يُحدَّث" }, { status: 400 });

    const existing = await getTask(id);
    if (!existing) return Response.json({ error: "المقطع غير موجود" }, { status: 404 });

    const updated = await updateTaskMeta(id, patch);
    return Response.json({ task: updated ? toView(updated) : null });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "خطأ غير متوقع" }, { status: 500 });
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    const task = await getTask(id);
    if (!task) return Response.json({ error: "المقطع غير موجود" }, { status: 404 });

    // مهام الدمج: نظّف المصادر المرفوعة والناتج من خدمة الدمج (أفضل جهد — لا نعطل الحذف إن فشل)
    let mergerCleaned = false;
    if (task.type === "merge" && task.provider_task_id && mergerConfigured()) {
      try {
        await deleteMergeJob(task.provider_task_id);
        mergerCleaned = true;
      } catch {
        mergerCleaned = false;
      }
    }

    await deleteTask(id);
    return Response.json({ ok: true, mergerCleaned });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "خطأ غير متوقع" }, { status: 500 });
  }
}
