"use client";

// لوحة المهام: قائمة أحدث المهام تتحدث تلقائيًا كل ~5 ثوانٍ — بطاقات زجاجية وأيقونات متدرجة.

import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import {
  ExternalLink,
  Film,
  Images,
  Layers,
  ListVideo,
  RefreshCw,
} from "lucide-react";
import type { TaskView } from "@/lib/types";

const STATUS_PILL: Record<string, string> = {
  completed: "border-emerald-400/25 bg-emerald-500/10 text-emerald-300",
  failed: "border-rose-400/25 bg-rose-500/10 text-rose-300",
  processing: "border-fuchsia-400/25 bg-fuchsia-500/10 text-fuchsia-300",
  pending: "border-white/10 bg-white/5 text-slate-300",
};
const STATUS_DOT: Record<string, string> = {
  completed: "bg-emerald-400",
  failed: "bg-rose-400",
  processing: "bg-fuchsia-400",
  pending: "bg-slate-400",
};
const STATUS_AR: Record<string, string> = { completed: "مكتملة", failed: "فاشلة", processing: "جارية", pending: "معلقة" };
const TYPE_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };

const TYPE_TILE: Record<string, string> = {
  image: "from-violet-500/30 to-violet-500/5 text-violet-300",
  video: "from-fuchsia-500/30 to-fuchsia-500/5 text-fuchsia-300",
  merge: "from-teal-500/30 to-teal-500/5 text-teal-300",
};

function relTime(raw: string): string {
  if (!raw) return "";
  const d = new Date(raw.includes("T") ? raw : `${raw.replace(" ", "T")}Z`);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (!Number.isFinite(diff)) return raw;
  const rtf = new Intl.RelativeTimeFormat("ar", { numeric: "auto" });
  if (diff < 60) return rtf.format(-Math.floor(diff), "second");
  if (diff < 3600) return rtf.format(-Math.floor(diff / 60), "minute");
  if (diff < 86400) return rtf.format(-Math.floor(diff / 3600), "hour");
  return rtf.format(-Math.floor(diff / 86400), "day");
}

function TypeIcon({ type }: { type: string }) {
  const cls = `flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${TYPE_TILE[type] ?? TYPE_TILE.image}`;
  if (type === "video") return <span className={cls}><Film className="h-4 w-4" /></span>;
  if (type === "merge") return <span className={cls}><Layers className="h-4 w-4" /></span>;
  return <span className={cls}><Images className="h-4 w-4" /></span>;
}

export default function TaskBoard() {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    (quiet = true) => {
      if (!quiet) setLoading(true);
      fetch("/api/tasks?limit=30")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("http"))))
        .then((d) => setTasks(d.tasks ?? []))
        .catch(() => {
          if (!quiet) toast.error("تعذر جلب المهام");
        })
        .finally(() => setLoading(false));
    },
    [],
  );

  const ticks = useRef(0);
  useEffect(() => {
    load(false);
    const t = setInterval(() => {
      load(true);
      // كل ~20 ثانية: استئناف تلقائي للمهام العالقة (بانتظار مفتاح/رصيد) ثم تحديث فوري عند أي تغيّر
      ticks.current += 1;
      if (ticks.current % 4 === 0) {
        fetch("/api/tasks/sweep", { method: "POST" })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d && d.swept > 0) load(true);
          })
          .catch(() => {});
      }
    }, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <section className="glass glass-hover flex h-full flex-col rounded-2xl" aria-label="لوحة المهام">
      {/* رأس البطاقة */}
      <div className="flex items-center gap-3 border-b border-white/8 px-5 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/25 to-fuchsia-500/10 text-violet-300">
          <ListVideo className="h-4.5 w-4.5" />
        </span>
        <div>
          <h2 className="text-sm font-bold leading-tight">لوحة المهام</h2>
          <p className="text-[11px] leading-tight text-muted-foreground">أحدث 30 مهمة — تحديث كل 5 ثوانٍ مع استئناف تلقائي للمعلّقة</p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="ms-auto h-8 w-8 rounded-lg text-muted-foreground hover:text-foreground"
          onClick={() => load(false)}
          title="تحديث الآن"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>

      {/* القائمة */}
      <div className="scroll-slim max-h-[34rem] flex-1 space-y-3 overflow-y-auto p-5 pe-2">
        {tasks.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2.5 py-14 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 text-muted-foreground">
              <ListVideo className="h-6 w-6 opacity-60" />
            </span>
            <p className="text-sm text-muted-foreground">لا توجد مهام بعد — ستظهر هنا أول ما يبدأ التوليد.</p>
          </div>
        ) : (
          tasks.map((t) => (
            <article
              key={t.id}
              className="rounded-xl border border-white/8 bg-white/[.03] p-3.5 transition-colors hover:border-violet-400/30 hover:bg-white/[.05]"
            >
              <div className="flex flex-wrap items-center gap-2.5">
                <TypeIcon type={t.type} />
                <span className="text-sm font-bold">{TYPE_AR[t.type] ?? t.type}</span>
                <span
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_PILL[t.status] ?? STATUS_PILL.pending}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[t.status] ?? STATUS_DOT.pending}`} />
                  {STATUS_AR[t.status] ?? t.status}
                </span>
                <span className="rounded-md border border-white/8 bg-black/25 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground" dir="ltr">
                  {t.model}
                </span>
                <span className="ms-auto text-[11px] text-muted-foreground" suppressHydrationWarning>
                  {relTime(t.created_at)}
                </span>
              </div>

              {t.status === "processing" && (
                <div className="mt-3 flex items-center gap-2.5">
                  <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/8">
                    <Progress value={t.progress} className="absolute inset-0 h-full bg-transparent [&>div]:rounded-full [&>div]:bg-gradient-to-l [&>div]:from-violet-500 [&>div]:to-fuchsia-500" />
                    <span aria-hidden className="shimmer absolute inset-0" />
                  </div>
                  <span className="text-[11px] font-bold text-fuchsia-300 tabular-nums">{t.progress}%</span>
                </div>
              )}

              {t.prompt ? (
                <p className="mt-2.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground" title={t.prompt}>
                  {t.prompt}
                </p>
              ) : null}

              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                {t.attempts.length > 0 && (
                  <Badge variant="secondary" className="border border-white/8 bg-white/5 text-[10px] text-slate-300 hover:bg-white/5">
                    محاولات: {t.attempts.length}
                  </Badge>
                )}
                {t.status === "completed" &&
                  t.result_urls.map((u) => (
                    <Button key={u} asChild size="sm" variant="outline" className="h-7 gap-1 rounded-lg border-white/12 bg-white/5 text-xs hover:border-violet-400/40 hover:bg-white/10">
                      <a href={u} target="_blank" rel="noreferrer">
                        <ExternalLink className="h-3 w-3" /> فتح الرابط
                      </a>
                    </Button>
                  ))}
              </div>

              {t.status === "failed" && t.error_message ? (
                <p className="mt-2.5 rounded-lg border border-rose-400/15 bg-rose-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-rose-300">
                  {t.error_message}
                </p>
              ) : null}

              {t.status === "processing" && t.error_message ? (
                <p className="mt-2.5 rounded-lg border border-amber-400/15 bg-amber-500/10 px-2.5 py-1.5 text-[11px] leading-relaxed text-amber-300">
                  {t.error_message}
                </p>
              ) : null}
            </article>
          ))
        )}
      </div>
    </section>
  );
}
