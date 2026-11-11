"use client";

// شريط المؤشرات: إحصائيات المهام + المفاتيح النشطة — يُحدَّث تلقائيًا كل 10 ثوانٍ.

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  KeyRound,
  ListChecks,
  Loader2,
  XCircle,
} from "lucide-react";

interface Stats {
  total: number;
  completed: number;
  failed: number;
  processing: number;
}

const CARDS: {
  key: keyof Stats | "keys";
  label: string;
  icon: typeof ListChecks;
  tile: string;
  value: string;
}[] = [
  {
    key: "total",
    label: "إجمالي المهام",
    icon: ListChecks,
    tile: "from-violet-500/25 to-violet-500/5 text-violet-300",
    value: "text-violet-200",
  },
  {
    key: "completed",
    label: "مكتملة",
    icon: CheckCircle2,
    tile: "from-emerald-500/25 to-emerald-500/5 text-emerald-300",
    value: "text-emerald-300",
  },
  {
    key: "processing",
    label: "قيد التنفيذ",
    icon: Loader2,
    tile: "from-fuchsia-500/25 to-fuchsia-500/5 text-fuchsia-300",
    value: "text-fuchsia-300",
  },
  {
    key: "failed",
    label: "فاشلة",
    icon: XCircle,
    tile: "from-rose-500/25 to-rose-500/5 text-rose-300",
    value: "text-rose-300",
  },
  {
    key: "keys",
    label: "مفاتيح نشطة",
    icon: KeyRound,
    tile: "from-teal-500/25 to-teal-500/5 text-teal-300",
    value: "text-teal-300",
  },
];

export default function StatsRow() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [activeKeys, setActiveKeys] = useState<number | null>(null);

  const load = useCallback(() => {
    fetch("/api/tasks?limit=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setStats(d.stats ?? null))
      .catch(() => undefined);
    fetch("/api/keys")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) {
          const keys: { status: string }[] = d.keys ?? [];
          setActiveKeys(keys.filter((k) => k.status === "active").length);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const values: Record<string, number | null> = {
    total: stats?.total ?? null,
    completed: stats?.completed ?? null,
    processing: stats?.processing ?? null,
    failed: stats?.failed ?? null,
    keys: activeKeys,
  };

  return (
    <section aria-label="مؤشرات عامة" className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
      {CARDS.map((c) => (
        <div key={c.key} className="glass glass-hover flex items-center gap-3.5 rounded-2xl p-4">
          <span
            className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br ${c.tile}`}
          >
            <c.icon className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <div className={`text-2xl font-extrabold leading-none tabular-nums ${c.value}`}>
              {values[c.key] ?? "—"}
            </div>
            <div className="mt-1.5 truncate text-[11px] font-medium text-muted-foreground">{c.label}</div>
          </div>
        </div>
      ))}
    </section>
  );
}
