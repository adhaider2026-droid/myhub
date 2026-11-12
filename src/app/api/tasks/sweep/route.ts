// POST /api/tasks/sweep — استئناف تلقائي للمهام العالقة في «بانتظار توفر مفتاح صالح».
// تجلب أقدم المهام قيد المعالجة وتعيد تفعيلها لدى المزود:
//   - مهمة لم تُنشأ بعد على أي مزود → إعادة إنشاء (بهدئة 45 ثانية بين المحاولات)
//   - مهمة منشأة بالفعل → استعلام حية من المزود (تقدم/اكتمال/فشل)
// تُستدعى من لوحة المهام كل ~20 ثانية تلقائيًا، ويمكن استدعاؤها يدويًا بأي عميل.
// استئنافٌ مطابق تمامًا لما يفعله get_task عبر MCP — نفس منطق refreshTask.

import { listRecentTasks, parseAttempts } from "@/lib/turso";
import { refreshTask } from "@/lib/generation";
import type { TaskRow } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** أقصى عدد مهام تُستأنف في الاستدعاء الواحد (الأقدم أولًا) */
const MAX_PER_SWEEP = 3;
/** تهدئة قبل إعادة إنشاء مهمة لم تُنشأ بعد على أي مزود — حتى لا نضغط المزودين */
const CREATION_COOLDOWN_MS = 45_000;
/** سقف زمني لكل تحديث فردي حتى لا تتجاوز مهلة الدالة (Netlify ~10 ثوانٍ) */
const RACE_CAP_MS = 8_500;

function raceCap<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([p, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
}

interface SweepItem {
  id: string;
  status: TaskRow["status"];
  progress: number;
  timedOut: boolean;
}

export async function POST() {
  try {
    const rows = await listRecentTasks(60, { status: "processing" });
    // الأقدم أولًا: نية المستخدم الأولى تستحق أول رصيد متاح
    const oldest = [...rows].reverse();

    const due: TaskRow[] = [];
    const now = Date.now();
    for (const t of oldest) {
      if (due.length >= MAX_PER_SWEEP) break;
      const pendingCreation = !t.provider_task_id || !t.provider;
      if (pendingCreation) {
        // مهمة فشل إنشاؤها سابقًا → احترم التهدئة منذ آخر محاولة
        const attempts = parseAttempts(t.attempts_json);
        const lastAt = attempts.length ? new Date(attempts[attempts.length - 1].at).getTime() : 0;
        if (now - lastAt < CREATION_COOLDOWN_MS) continue;
      }
      due.push(t);
    }

    if (!due.length) return Response.json({ swept: 0, results: [] as SweepItem[] });

    const settled = await Promise.allSettled(
      due.map(async (t): Promise<SweepItem> => {
        const updated = await raceCap(refreshTask(t.id), RACE_CAP_MS);
        if (updated === "timeout") return { id: t.id, status: t.status, progress: t.progress, timedOut: true };
        return { id: t.id, status: updated?.status ?? t.status, progress: updated?.progress ?? t.progress, timedOut: false };
      }),
    );

    const results: SweepItem[] = settled.map((s, i) =>
      s.status === "fulfilled"
        ? s.value
        : { id: due[i].id, status: due[i].status, progress: due[i].progress, timedOut: false },
    );

    return Response.json({ swept: results.length, results });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "خطأ غير متوقع" }, { status: 500 });
  }
}
