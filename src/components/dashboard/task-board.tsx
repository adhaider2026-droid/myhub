"use client";

// لوحة المهام: شرائح إحصائيات + قائمة أحدث المهام تتحدث تلقائيًا كل ~5 ثوانٍ.

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { toast } from "sonner";
import { ClipboardList, ExternalLink, RefreshCw } from "lucide-react";
import type { TaskView } from "@/lib/types";

const STATUS_BADGE: Record<string, string> = {
  completed: "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15",
  failed: "bg-rose-500/15 text-rose-400 hover:bg-rose-500/15",
  processing: "bg-violet-500/15 text-violet-300 hover:bg-violet-500/15",
  pending: "bg-slate-500/15 text-slate-300 hover:bg-slate-500/15",
};
const STATUS_AR: Record<string, string> = { completed: "مكتملة", failed: "فاشلة", processing: "جارية", pending: "معلقة" };
const TYPE_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const TYPE_ICON: Record<string, string> = { image: "🖼️", video: "🎬", merge: "🔗" };

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

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

export default function TaskBoard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    (quiet = true) => {
      if (!quiet) setLoading(true);
      fetch("/api/tasks?limit=30")
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("http"))))
        .then((d) => {
          setStats(d.stats ?? null);
          setTasks(d.tasks ?? []);
        })
        .catch(() => {
          if (!quiet) toast.error("تعذر جلب المهام");
        })
        .finally(() => setLoading(false));
    },
    [],
  );

  useEffect(() => {
    load(false);
    const t = setInterval(() => load(true), 5000);
    return () => clearInterval(t);
  }, [load]);

  const statCards: { label: string; value: number; cls: string }[] = [
    { label: "الإجمالي", value: stats?.total ?? 0, cls: "text-slate-200" },
    { label: "مكتملة", value: stats?.completed ?? 0, cls: "text-emerald-400" },
    { label: "فاشلة", value: stats?.failed ?? 0, cls: "text-rose-400" },
    { label: "جارية", value: stats?.processing ?? 0, cls: "text-violet-300" },
  ];

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClipboardList className="h-4 w-4 text-primary" /> لوحة المهام
          <Button size="icon" variant="ghost" className="ms-auto h-7 w-7" onClick={() => load(false)} title="تحديث الآن">
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {/* شرائح الإحصائيات */}
        <div className="grid grid-cols-4 gap-2">
          {statCards.map((s) => (
            <div key={s.label} className="rounded-xl border bg-card/60 px-2 py-2.5 text-center">
              <div className={`text-lg font-bold leading-none ${s.cls}`}>{s.value}</div>
              <div className="mt-1 text-[11px] text-muted-foreground">{s.label}</div>
            </div>
          ))}
        </div>

        {/* قائمة المهام */}
        <div className="scroll-slim max-h-96 flex-1 space-y-3 overflow-y-auto pe-1">
          {tasks.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">لا توجد مهام بعد — ستظهر هنا أول ما يبدأ التوليد.</p>
          ) : (
            tasks.map((t) => (
              <div key={t.id} className="rounded-xl border bg-card/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm">
                    {TYPE_ICON[t.type]} {TYPE_AR[t.type] ?? t.type}
                  </span>
                  <Badge variant="secondary" className={STATUS_BADGE[t.status] ?? ""}>
                    {STATUS_AR[t.status] ?? t.status}
                  </Badge>
                  <span className="font-mono text-[11px] text-muted-foreground" dir="ltr">
                    {t.model}
                  </span>
                  <span className="ms-auto text-[11px] text-muted-foreground">{relTime(t.created_at)}</span>
                </div>

                {t.status === "processing" && (
                  <div className="mt-2 flex items-center gap-2">
                    <Progress value={t.progress} className="h-2 flex-1" />
                    <span className="text-[11px] font-medium text-violet-300">{t.progress}%</span>
                  </div>
                )}

                {t.prompt ? (
                  <p className="mt-2 line-clamp-2 text-xs text-muted-foreground" title={t.prompt}>
                    {t.prompt}
                  </p>
                ) : null}

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {t.attempts.length > 0 && (
                    <Badge variant="secondary" className="bg-slate-500/10 text-slate-300 hover:bg-slate-500/10">
                      محاولات: {t.attempts.length}
                    </Badge>
                  )}
                  {t.status === "completed" &&
                    t.result_urls.map((u) => (
                      <Button key={u} asChild size="sm" variant="outline" className="h-7 gap-1 text-xs">
                        <a href={u} target="_blank" rel="noreferrer">
                          <ExternalLink className="h-3 w-3" /> فتح الرابط
                        </a>
                      </Button>
                    ))}
                </div>

                {t.status === "failed" && t.error_message ? (
                  <p className="mt-2 rounded-lg bg-rose-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-rose-300">
                    {t.error_message}
                  </p>
                ) : null}
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
