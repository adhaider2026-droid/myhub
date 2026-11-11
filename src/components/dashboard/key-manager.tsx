"use client";

// مدير المفاتيح: إضافة (مزود + تسمية + مفتاح)، قائمة مقنعة دائمًا، شارات حالة، عدّادات، تعطيل/تنشيط/حذف.

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { KeyRound, Loader2, Power, PowerOff, Trash2 } from "lucide-react";
import type { PublicKeyView } from "@/lib/types";

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15",
  exhausted: "bg-amber-500/15 text-amber-400 hover:bg-amber-500/15",
  disabled: "bg-slate-500/15 text-slate-400 hover:bg-slate-500/15",
};
const STATUS_AR: Record<string, string> = { active: "نشط", exhausted: "مستنزف", disabled: "معطل" };

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

  return (
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="h-4 w-4 text-primary" /> مدير المفاتيح
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {/* نموذج الإضافة */}
        <div className="grid gap-3 rounded-xl border bg-card/60 p-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">المزود</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="اختر المزود" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="kie">kie.ai</SelectItem>
                  <SelectItem value="cometapi">CometAPI</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">تسمية اختيارية</Label>
              <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="مثال: المفتاح الرئيسي" />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">المفتاح</Label>
            <Input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="الصق مفتاح API هنا"
              type="password"
              className="font-mono text-left"
              dir="ltr"
            />
          </div>
          <Button onClick={add} disabled={saving} className="w-full gap-2">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            إضافة المفتاح
          </Button>
        </div>

        {/* النص التوضيحي الثابت */}
        <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-300">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
        </p>

        {/* القائمة — مقنعة دائمًا */}
        <div className="scroll-slim max-h-96 flex-1 space-y-3 overflow-y-auto pe-1">
          {keys.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">لا توجد مفاتيح بعد — أضف أول مفتاح لتشغيل التوليد.</p>
          ) : (
            keys.map((k) => (
              <div key={k.id} className="rounded-xl border bg-card/60 p-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-slate-200" dir="ltr">
                    {k.masked}
                  </span>
                  <Badge variant="secondary" className="bg-primary/10 text-primary hover:bg-primary/10">
                    {k.provider === "kie" ? "kie.ai" : "CometAPI"}
                  </Badge>
                  <Badge variant="secondary" className={STATUS_BADGE[k.status] ?? ""}>
                    {STATUS_AR[k.status] ?? k.status}
                  </Badge>
                  {k.label ? <span className="text-xs text-muted-foreground">{k.label}</span> : null}
                  <div className="ms-auto flex items-center gap-1.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      title={k.status === "disabled" ? "تنشيط" : "تعطيل"}
                      onClick={() => toggle(k)}
                      disabled={busyId === k.id}
                    >
                      {k.status === "disabled" ? <Power className="h-3.5 w-3.5 text-emerald-400" /> : <PowerOff className="h-3.5 w-3.5 text-amber-400" />}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      title="حذف"
                      onClick={() => remove(k)}
                      disabled={busyId === k.id}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-rose-400" />
                    </Button>
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                  <span>استخدام: {k.usage_count}</span>
                  <span className="text-emerald-400">نجاح: {k.success_count}</span>
                  <span className="text-rose-400">فشل: {k.fail_count}</span>
                  {k.last_error ? (
                    <span className="max-w-full truncate text-rose-300" title={k.last_error}>
                      آخر خطأ: {k.last_error}
                    </span>
                  ) : null}
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
