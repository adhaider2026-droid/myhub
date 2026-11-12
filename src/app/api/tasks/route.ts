// GET /api/tasks — الإحصائيات + أحدث المهام للوحة المتابعة الحية.

import { listRecentTasks, parseAttempts, parseUrls, taskStats } from "@/lib/turso";
import type { MediaType, TaskStatus, TaskView } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 30)));
    const type = url.searchParams.get("type") as MediaType | null;
    const status = url.searchParams.get("status") as TaskStatus | null;

    const [stats, rows] = await Promise.all([
      taskStats(),
      listRecentTasks(limit, {
        type: type ?? undefined,
        status: status ?? undefined,
      }),
    ]);

    const tasks: TaskView[] = rows.map((t) => {
      const { attempts_json, result_urls_json, params_json, ...rest } = t;
      return { ...rest, attempts: parseAttempts(attempts_json), result_urls: parseUrls(result_urls_json) };
    });

    return Response.json({ stats, tasks });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "خطأ غير متوقع" }, { status: 500 });
  }
}
