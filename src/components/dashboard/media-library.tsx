"use client";

// مكتبة المقاطع: شبكة معاينات للوسائط المولدة والمدمجة، مع تعديل الاسم/الوصف وحذف
// العنصر (ولمهام الدمج يُنظَّف الناتج والمصادر من خدمة الدمج أيضًا).

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import {
  Clock,
  ExternalLink,
  Film,
  Images,
  Layers,
  LibraryBig,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Video,
} from "lucide-react";
import type { MediaType, TaskStatus, TaskView } from "@/lib/types";

const TYPE_AR: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };
const STATUS_AR: Record<string, string> = { completed: "مكتملة", failed: "فاشلة", processing: "جارية", pending: "معلقة" };
const STATUS_PILL: Record<string, string> = {
  completed: "border-emerald-400/25 bg-emerald-500/10 text-emerald-300",
  failed: "border-rose-400/25 bg-rose-500/10 text-rose-300",
  processing: "border-fuchsia-400/25 bg-fuchsia-500/10 text-fuchsia-300",
  pending: "border-white/10 bg-white/5 text-slate-300",
};

type Filter = "all" | MediaType;

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

function TypeChip({ type }: { type: MediaType }) {
  const map = {
    image: { icon: Images, cls: "text-violet-300 border-violet-400/25 bg-violet-500/10" },
    video: { icon: Video, cls: "text-fuchsia-300 border-fuchsia-400/25 bg-fuchsia-500/10" },
    merge: { icon: Layers, cls: "text-teal-300 border-teal-400/25 bg-teal-500/10" },
  } as const;
  const M = map[type] ?? map.image;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-bold ${M.cls}`}>
      <M.icon className="h-3 w-3" />
      {TYPE_AR[type] ?? type}
    </span>
  );
}

function Preview({ url, type, status }: { url: string | null; type: MediaType; status: TaskStatus }) {
  if (url && type === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt="معاينة الصورة"
        loading="lazy"
        referrerPolicy="no-referrer"
        className="aspect-video w-full bg-black/40 object-cover"
      />
    );
  }
  if (url) {
    return (
      <video
        src={url}
        controls
        preload="metadata"
        className="aspect-video w-full bg-black/60 object-contain"
      />
    );
  }
  // لا نتيجة بعد — بديل بصري حسب الحالة
  const Icon = status === "failed" ? Film : type === "merge" ? Layers : Images;
  return (
    <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-black/30 text-muted-foreground">
      <Icon className="h-8 w-8 opacity-50" />
      <span className={`text-xs ${status === "failed" ? "text-rose-300" : ""}`}>{STATUS_AR[status] ?? status}</span>
    </div>
  );
}

export default function MediaLibrary() {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<TaskView | null>(null);
  const [form, setForm] = useState({ label: "", prompt: "" });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<TaskView | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback((quiet = true) => {
    if (!quiet) setLoading(true);
    fetch("/api/tasks?limit=100")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("http"))))
      .then((d) => setTasks(d.tasks ?? []))
      .catch(() => {
        if (!quiet) toast.error("تعذر جلب المكتبة");
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(false);
    const t = setInterval(() => load(true), 20000);
    return () => clearInterval(t);
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: tasks.length, image: 0, video: 0, merge: 0 };
    for (const t of tasks) if (t.type in c) c[t.type as MediaType]++;
    return c;
  }, [tasks]);

  const filtered = filter === "all" ? tasks : tasks.filter((t) => t.type === filter);

  const openEdit = (t: TaskView) => {
    setEditing(t);
    setForm({ label: t.label ?? "", prompt: t.prompt ?? "" });
  };

  const saveEdit = async () => {
    if (!editing) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/media/${editing.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: form.label, prompt: form.prompt }),
      });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(d?.error ?? "تعذر حفظ التعديلات");
        return;
      }
      toast.success("حُفظت التعديلات");
      setEditing(null);
      load();
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      const res = await fetch(`/api/media/${deleting.id}`, { method: "DELETE" });
      const d = await res.json().catch(() => null);
      if (!res.ok) {
        toast.error(d?.error ?? "تعذر حذف المقطع");
        return;
      }
      toast.success(
        deleting.type === "merge"
          ? d?.mergerCleaned
            ? "حُذف المقطع ونُظفت مصادره وناتجه من خدمة الدمج"
            : "حُذف المقطع — تعذر التنظيف من خدمة الدمج (سيُحذف تلقائيًا بعد 24 ساعة)"
          : "حُذف المقطع من المكتبة",
      );
      setDeleting(null);
      load();
    } finally {
      setBusyId(null);
    }
  };

  const FILTERS: { id: Filter; label: string }[] = [
    { id: "all", label: "الكل" },
    { id: "image", label: "صور" },
    { id: "video", label: "فيديو" },
    { id: "merge", label: "دمج" },
  ];

  return (
    <section className="glass glass-hover rounded-2xl" aria-label="مكتبة المقاطع">
      {/* رأس البطاقة */}
      <div className="flex flex-wrap items-center gap-3 border-b border-white/8 px-5 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-fuchsia-500/25 to-violet-500/10 text-fuchsia-300">
          <LibraryBig className="h-4.5 w-4.5" />
        </span>
        <div>
          <h2 className="text-sm font-bold leading-tight">مكتبة المقاطع</h2>
          <p className="text-[11px] leading-tight text-muted-foreground">
            كل الوسائط المولدة والمدمجة — عدّل الاسم والوصف أو احذف ما لا تحتاجه
          </p>
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

      {/* فلاتر النوع */}
      <div className="flex flex-wrap items-center gap-2 px-5 pt-4">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setFilter(f.id)}
            className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-xs font-bold transition ${
              filter === f.id
                ? "border-transparent bg-gradient-to-l from-violet-600 to-fuchsia-600 text-white shadow-lg shadow-violet-950/40"
                : "border-white/10 bg-white/5 text-muted-foreground hover:border-violet-400/40 hover:text-foreground"
            }`}
          >
            {f.label}
            <span className={`rounded-full px-1.5 text-[10px] tabular-nums ${filter === f.id ? "bg-white/20" : "bg-white/10"}`}>
              {counts[f.id]}
            </span>
          </button>
        ))}
      </div>

      {/* الشبكة */}
      <div className="p-5">
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2.5 py-14 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 text-muted-foreground">
              <LibraryBig className="h-6 w-6 opacity-60" />
            </span>
            <p className="text-sm text-muted-foreground">
              {filter === "all" ? "المكتبة فارغة — أول ما تولّد صورة أو فيديو سيظهر هنا." : "لا توجد عناصر من هذا النوع بعد."}
            </p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {filtered.map((t) => {
              const url = t.result_urls[0] ?? null;
              return (
                <article
                  key={t.id}
                  className="group overflow-hidden rounded-xl border border-white/8 bg-white/[.03] transition-colors hover:border-fuchsia-400/30 hover:bg-white/[.05]"
                >
                  <div className="relative">
                    <Preview url={url} type={t.type} status={t.status} />
                    <div className="absolute right-2 top-2 flex gap-1.5">
                      <TypeChip type={t.type} />
                      {t.status !== "completed" && (
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-bold ${STATUS_PILL[t.status] ?? STATUS_PILL.pending}`}>
                          {STATUS_AR[t.status] ?? t.status}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="space-y-2 p-3.5">
                    <p className={`line-clamp-2 min-h-9 text-xs leading-relaxed ${t.label ? "font-bold text-foreground" : "text-muted-foreground"}`} title={t.label || t.prompt}>
                      {t.label || t.prompt || "—"}
                    </p>
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      <span suppressHydrationWarning>{relTime(t.created_at)}</span>
                      <span className="truncate font-mono opacity-70" dir="ltr">{t.model}</span>
                    </div>

                    <div className="flex items-center gap-1.5 border-t border-white/5 pt-2.5">
                      {url && (
                        <Button asChild size="sm" variant="ghost" className="h-7 gap-1 rounded-lg px-2 text-[11px] text-muted-foreground hover:text-foreground">
                          <a href={url} target="_blank" rel="noreferrer">
                            <ExternalLink className="h-3 w-3" /> فتح
                          </a>
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 gap-1 rounded-lg px-2 text-[11px] text-muted-foreground hover:text-foreground"
                        onClick={() => openEdit(t)}
                      >
                        <Pencil className="h-3 w-3" /> تعديل
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="ms-auto h-7 gap-1 rounded-lg px-2 text-[11px] text-rose-400/90 hover:bg-rose-500/10 hover:text-rose-300"
                        onClick={() => setDeleting(t)}
                        disabled={busyId === t.id}
                      >
                        {busyId === t.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                        حذف
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </div>

      {/* حوار التعديل */}
      <Dialog open={!!editing} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent className="border-white/10 bg-[oklch(0.185_0.022_296)] sm:max-w-md">
          <DialogHeader>
            <DialogTitle>تعديل بيانات المقطع</DialogTitle>
            <DialogDescription>الاسم يظهر في المكتبة، والوصف هو النص الذي وُلّد به المقطع.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="media-label" className="text-xs text-muted-foreground">الاسم</Label>
              <Input
                id="media-label"
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                placeholder="مثال: إعلان المنتج — النسخة الثانية"
                className="border-white/10 bg-white/5"
                maxLength={200}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="media-prompt" className="text-xs text-muted-foreground">الوصف</Label>
              <Textarea
                id="media-prompt"
                value={form.prompt}
                onChange={(e) => setForm((f) => ({ ...f, prompt: e.target.value }))}
                rows={4}
                className="resize-none border-white/10 bg-white/5 text-xs"
                maxLength={4000}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="rounded-lg border-white/10 bg-transparent" onClick={() => setEditing(null)}>
              إلغاء
            </Button>
            <Button
              onClick={saveEdit}
              disabled={saving}
              className="gap-2 rounded-lg bg-gradient-to-l from-violet-600 to-fuchsia-600 font-bold text-white hover:from-violet-500 hover:to-fuchsia-500"
            >
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              حفظ التعديلات
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* حوار تأكيد الحذف */}
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent className="border-white/10 bg-[oklch(0.185_0.022_296)]">
          <AlertDialogHeader>
            <AlertDialogTitle>حذف هذا المقطع نهائيًا؟</AlertDialogTitle>
            <AlertDialogDescription className="leading-relaxed">
              {deleting?.label || deleting?.prompt?.slice(0, 120) || "عنصر بدون اسم"}
              {deleting?.type === "merge" ? (
                <span className="mt-2 block text-amber-300">
                  هذا مقطع دمج — ستُحذف معه المصادر المرفوعة والناتج من خدمة الدمج أيضًا.
                </span>
              ) : (
                <span className="mt-2 block text-muted-foreground">
                  يُحذف السجل من المكتبة نهائيًا. الملفات الأصلية على المزود الخارجي قد تبقى متاحة مؤقتًا حتى انتهاء صلاحيتها لديه.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2">
            <AlertDialogCancel className="rounded-lg border-white/10 bg-transparent">إلغاء</AlertDialogCancel>
            <AlertDialogAction
              className="rounded-lg bg-rose-600 font-bold text-white hover:bg-rose-500"
              onClick={(e) => {
                e.preventDefault();
                confirmDelete();
              }}
            >
              {busyId ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
              حذف نهائي
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
