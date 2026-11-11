"use client";

// هيدر اللوحة: شارة حالة Turso (خضراء/حمراء) + حالة خدمة الدمج + وضع التوثيق.

import { Badge } from "@/components/ui/badge";
import type { HealthData } from "@/app/page";
import { Activity, Database, PlugZap, ShieldCheck, ShieldOff } from "lucide-react";

export default function HealthHeader({ health }: { health: HealthData | null }) {
  const dbOk = !!health?.ok;
  const mergerOk = health ? health.merger.healthy : false;

  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-3 px-4 py-3 sm:px-6">
        <div className="flex items-center gap-2">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Activity className="h-5 w-5" />
          </span>
          <div>
            <h1 className="text-base font-bold leading-tight">مولّد الوسائط MCP</h1>
            <p className="text-xs text-muted-foreground leading-tight">
              توليد الصور والفيديو بالذكاء الاصطناعي ودمج المقاطع — خادم MCP واحد
            </p>
          </div>
        </div>

        <div className="ms-auto flex flex-wrap items-center gap-2">
          {dbOk ? (
            <Badge className="gap-1 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15" variant="secondary">
              <Database className="h-3.5 w-3.5" /> Turso متصل
            </Badge>
          ) : (
            <Badge className="gap-1 bg-rose-500/15 text-rose-400 hover:bg-rose-500/15" variant="secondary">
              <Database className="h-3.5 w-3.5" /> غير متصل
            </Badge>
          )}
          {mergerOk ? (
            <Badge className="gap-1 bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/15" variant="secondary">
              <PlugZap className="h-3.5 w-3.5" /> خدمة الدمج جاهزة
            </Badge>
          ) : (
            <Badge className="gap-1 bg-amber-500/15 text-amber-400 hover:bg-amber-500/15" variant="secondary">
              <PlugZap className="h-3.5 w-3.5" /> خدمة الدمج غير متاحة
            </Badge>
          )}
          {health?.authRequired ? (
            <Badge className="gap-1 bg-amber-500/15 text-amber-400 hover:bg-amber-500/15" variant="secondary">
              <ShieldCheck className="h-3.5 w-3.5" /> محمي بـ Bearer Token
            </Badge>
          ) : (
            <Badge className="gap-1 bg-slate-500/15 text-slate-300 hover:bg-slate-500/15" variant="secondary">
              <ShieldOff className="h-3.5 w-3.5" /> بدون توثيق
            </Badge>
          )}
        </div>
      </div>
    </header>
  );
}
