"use client";

// هيدر اللوحة: زجاج لاصق + شعار متوهج + شارات حالة بنقاط نابضة (Turso / الدمج / التوثيق).

import type { HealthData } from "@/app/page";
import { AudioWaveform, Database, PlugZap, ShieldCheck, ShieldOff } from "lucide-react";

function Pill({
  tone,
  label,
  icon: Icon,
}: {
  tone: "ok" | "warn" | "off";
  label: string;
  icon: typeof Database;
}) {
  const toneCls =
    tone === "ok"
      ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-300"
      : tone === "warn"
        ? "border-amber-400/25 bg-amber-500/10 text-amber-300"
        : "border-white/10 bg-white/5 text-slate-300";
  const dotCls =
    tone === "ok" ? "bg-emerald-400" : tone === "warn" ? "bg-amber-400" : "bg-slate-400";

  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-semibold ${toneCls}`}
    >
      <span className={`h-2 w-2 rounded-full ${dotCls} ${tone !== "off" ? "live-dot" : ""}`} />
      <Icon className="h-3.5 w-3.5 opacity-80" />
      {label}
    </span>
  );
}

export default function HealthHeader({ health }: { health: HealthData | null }) {
  const dbOk = !!health?.ok;
  const mergerOk = health ? health.merger.healthy : false;
  const loaded = health !== null;

  return (
    <header className="sticky top-0 z-40 border-b border-white/8 bg-background/70 backdrop-blur-xl">
      {/* خط ضوئي أسفل الهيدر */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-l from-transparent via-violet-400/50 to-transparent"
      />
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3.5 sm:px-6">
        <div className="flex items-center gap-3">
          {/* شعار متوهج */}
          <span className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-600 text-white shadow-lg shadow-violet-900/50">
            <AudioWaveform className="h-5 w-5" />
            <span
              aria-hidden
              className="absolute inset-0 rounded-xl ring-1 ring-inset ring-white/25"
            />
          </span>
          <div>
            <h1 className="text-base font-extrabold leading-tight">
              مركز <span className="text-gradient">الوسائط الذكي</span>
            </h1>
            <p className="text-[11px] leading-tight text-muted-foreground">
              لوحة إدارة خادم MCP — توليد الصور والفيديو ودمج المقاطع
            </p>
          </div>
        </div>

        <div className="ms-auto flex flex-wrap items-center gap-2">
          {loaded ? (
            dbOk ? (
              <Pill tone="ok" label="قاعدة Turso متصلة" icon={Database} />
            ) : (
              <Pill tone="warn" label="قاعدة البيانات غير متصلة" icon={Database} />
            )
          ) : (
            <Pill tone="off" label="جارٍ فحص الاتصال…" icon={Database} />
          )}
          {loaded ? (
            mergerOk ? (
              <Pill tone="ok" label="خدمة الدمج جاهزة" icon={PlugZap} />
            ) : (
              <Pill tone="warn" label="خدمة الدمج غير متاحة" icon={PlugZap} />
            )
          ) : null}
          {health?.authRequired ? (
            <Pill tone="ok" label="محمي بـ Bearer Token" icon={ShieldCheck} />
          ) : (
            <Pill tone="off" label="بدون توثيق" icon={ShieldOff} />
          )}
        </div>
      </div>
    </header>
  );
}
