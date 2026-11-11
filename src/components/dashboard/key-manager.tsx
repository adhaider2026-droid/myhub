"use client";

// مدير المفاتيح: إضافة (مزود + تسمية + مفتاح)، قائمة مقنعة دائمًا، شارات حالة، عدّادات، تعطيل/تنشيط/حذف.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { KeyRound, Loader2, Power, PowerOff, Trash2 } from "lucide-react";
import type { PublicKeyView } from "@/lib/types";

const STATUS_PILL: Record<string, string> = {
  active: "border-emerald-400/25 bg-emerald-500/10 text-emerald-300",
  exhausted: "border-amber-400/25 bg-amber-500/10 text-amber-300",
  disabled: "border-white/10 bg-white/5 text-slate-400",
};
const STATUS_DOT: Record<string, string> = {
  active: "bg-emerald-400",
  exhausted: "bg-amber-400",
  disabled: "bg-slate-500",
};
const STATUS_AR: Record<string, string> = { active: "نشط", exhausted: "مستنزف", disabled: "معطل" };

const PROVIDER_TILE: Record<string, string> = {
  kie: "from-violet-500 to-fuchsia-600",
  cometapi: "from-teal-500 to-emerald-600",
};

export default function KeyManager() {
  const [keys, setKeys] = useState<PublicKeyView[]>([]);
  const [provider, setProvider] = useState<string>("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    fetch("/api/keys")
      .then((r) => r.json())
      .then((d) => setKeys(d.keys ?? []))
      .catch(() => toast.error("تعذر جلب المفاتيح"));
  }, []);

  useEffect(load, [load]);

  const add = async () => {
    if (!apiKey.trim()) {
      toast.error("أدخل قيمة المفتاح أولًا");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const d = await res.json();
      if (!res.ok) {
        toast.error(d.error ?? "تعذر إضافة المفتاح");
        return;
      }
      toast.success("تمت إضافة المفتاح — سيُجرَّب أولًا حسب ترتيب الإضافة");
      setApiKey("");
      setLabel("");
      load();
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (k: PublicKeyView) => {
    setBusyId(k.id);
    try {
      const next = k.status === "disabled" ? "active" : "disabled";
      const res = await fetch(`/api/keys/${k.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      if (!res.ok) {
        const d = await res.json();
        toast.error(d.error ?? "تعذر تحديث الحالة");
        return;
      }
      toast.success(next === "disabled" ? "تم تعطيل المفتاح" : "تم تنشيط المفتاح");
      load();
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (k: PublicKeyView) => {
    setBusyId(k.id);
    try {
      const res = await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
      if (!res.ok) {
        const d = await res.json();
        toast.error(d.error ?? "تعذر حذف المفتاح");
        return;
      }
      toast.success("تم حذف المفتاح");
      load();
    } finally {
      setBusyId(null);
    }
  };

  const activeCount = keys.filter((k) => k.status === "active").length;

  return (
    <section className="glass glass-hover flex h-full flex-col rounded-2xl" aria-label="مدير المفاتيح">
      {/* رأس البطاقة */}
      <div className="flex items-center gap-3 border-b border-white/8 px-5 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-teal-500/25 to-emerald-500/10 text-teal-300">
          <KeyRound className="h-4.5 w-4.5" />
        </span>
        <div>
          <h2 className="text-sm font-bold leading-tight">مدير المفاتيح</h2>
          <p className="text-[11px] leading-tight text-muted-foreground">
            {keys.length > 0 ? `${keys.length} مفتاح — منها ${activeCount} نشط` : "أضف مفتاحك الأول لتشغيل التوليد"}
          </p>
        </div>
      </div>

      <div className="flex flex-1 flex-col gap-4 p-5">
        {/* نموذج الإضافة */}
        <div className="grid gap-3 rounded-xl border border-white/8 bg-black/20 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">المزود</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger className="w-full border-white/10 bg-white/5 text-foreground">
                  <SelectValue placeholder="اختر المزود" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="kie">kie.ai</SelectItem>
                  <SelectItem value="cometapi">CometAPI</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">تسمية اختيارية</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="مثال: المفتاح الرئيسي"
                className="border-white/10 bg-white/5 placeholder:text-muted-foreground/50"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">المفتاح</Label>
            <Input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="الصق مفتاح API هنا"
              type="password"
              className="border-white/10 bg-white/5 font-mono text-left placeholder:text-muted-foreground/50"
              dir="ltr"
            />
          </div>
          <Button
            onClick={add}
            disabled={saving}
            className="w-full gap-2 rounded-lg bg-gradient-to-l from-violet-600 to-fuchsia-600 font-bold text-white shadow-lg shadow-violet-950/50 hover:from-violet-500 hover:to-fuchsia-500"
          >
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            إضافة المفتاح
          </Button>
        </div>

        {/* النص التوضيحي */}
        <p className="rounded-xl border border-amber-400/20 bg-amber-500/8 px-3.5 py-2.5 text-[11px] leading-relaxed text-amber-300/95">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
        </p>

        {/* القائمة — مقنعة دائمًا */}
        <div className="scroll-slim max-h-96 flex-1 space-y-3 overflow-y-auto pe-1">
          {keys.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2.5 py-12 text-center">
              <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white/5 text-muted-foreground">
                <KeyRound className="h-6 w-6 opacity-60" />
              </span>
              <p className="text-sm text-muted-foreground">لا توجد مفاتيح بعد — أضف أول مفتاح لتشغيل التوليد.</p>
            </div>
          ) : (
            keys.map((k) => {
              const total = k.success_count + k.fail_count;
              const rate = total > 0 ? Math.round((k.success_count / total) * 100) : null;
              return (
                <div
                  key={k.id}
                  className="rounded-xl border border-white/8 bg-white/[.03] p-3.5 transition-colors hover:border-teal-400/30 hover:bg-white/[.05]"
                >
                  <div className="flex flex-wrap items-center gap-2.5">
                    <span
                      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-sm font-extrabold text-white shadow-md ${PROVIDER_TILE[k.provider] ?? PROVIDER_TILE.kie}`}
                    >
                      {k.provider === "kie" ? "K" : "C"}
                    </span>
                    <span className="font-mono text-xs text-slate-200" dir="ltr">
                      {k.masked}
                    </span>
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${STATUS_PILL[k.status] ?? STATUS_PILL.disabled}`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_DOT[k.status] ?? STATUS_DOT.disabled}`} />
                      {STATUS_AR[k.status] ?? k.status}
                    </span>
                    {k.label ? <span className="text-xs text-muted-foreground">{k.label}</span> : null}
                    <div className="ms-auto flex items-center gap-1">
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 rounded-lg"
                        title={k.status === "disabled" ? "تنشيط" : "تعطيل"}
                        onClick={() => toggle(k)}
                        disabled={busyId === k.id}
                      >
                        {k.status === "disabled" ? <Power className="h-3.5 w-3.5 text-emerald-400" /> : <PowerOff className="h-3.5 w-3.5 text-amber-400" />}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7 rounded-lg"
                        title="حذف"
                        onClick={() => remove(k)}
                        disabled={busyId === k.id}
                      >
                        <Trash2 className="h-3.5 w-3.5 text-rose-400" />
                      </Button>
                    </div>
                  </div>

                  <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-muted-foreground">
                    <span>استخدام: <b className="tabular-nums text-slate-200">{k.usage_count}</b></span>
                    <span className="text-emerald-400">نجاح: <b className="tabular-nums">{k.success_count}</b></span>
                    <span className="text-rose-400">فشل: <b className="tabular-nums">{k.fail_count}</b></span>
                    {rate !== null && (
                      <span className="ms-auto inline-flex min-w-24 items-center gap-2">
                        <span className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
                          <span
                            className="block h-full rounded-full bg-gradient-to-l from-emerald-500 to-teal-400"
                            style={{ width: `${rate}%` }}
                          />
                        </span>
                        <b className="tabular-nums text-slate-300">{rate}%</b>
                      </span>
                    )}
                    {k.last_error ? (
                      <span className="w-full truncate text-rose-300" title={k.last_error}>
                        آخر خطأ: {k.last_error}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </section>
  );
}
