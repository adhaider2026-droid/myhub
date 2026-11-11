"use client";

// لوحة الإدارة — الصفحة الرئيسية: خلفية Aurora + هيدر حالة + بطلة + مؤشرات + شبكة البطاقات.

import { useEffect, useState } from "react";
import HealthHeader from "@/components/dashboard/health-header";
import KeyManager from "@/components/dashboard/key-manager";
import TaskBoard from "@/components/dashboard/task-board";
import ConnectPanel from "@/components/dashboard/connect-panel";
import MediaLibrary from "@/components/dashboard/media-library";
import StatsRow from "@/components/dashboard/stats-row";
import CopyButton from "@/components/dashboard/copy-button";
import { Clapperboard, Images, Sparkles, Wand2 } from "lucide-react";

export interface HealthData {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

const FEATURES = [
  { icon: Images, label: "توليد صور من نص" },
  { icon: Clapperboard, label: "فيديو بصوت متزامن" },
  { icon: Wand2, label: "دمج حتى 10 مقاطع" },
];

export default function Home() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [mcpUrl, setMcpUrl] = useState("");

  useEffect(() => {
    let alive = true;
    const fetchHealth = () =>
      fetch("/api/health")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => alive && setHealth(d))
        .catch(() => alive && setHealth(null));
    fetchHealth();
    setMcpUrl(window.location.origin + "/mcp");
    const t = setInterval(fetchHealth, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      {/* خلفية Aurora زخرفية */}
      <div aria-hidden className="aurora-wrap">
        <div className="aurora-orb orb-1" />
        <div className="aurora-orb orb-2" />
        <div className="aurora-orb orb-3" />
        <div className="grid-veil" />
      </div>

      <HealthHeader health={health} />

      <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 pb-16 pt-8 sm:px-6">
        {/* البطلة */}
        <section className="fade-up glass relative overflow-hidden rounded-2xl px-6 py-9 sm:px-10 sm:py-11">
          <div
            aria-hidden
            className="pointer-events-none absolute -left-24 -top-28 h-72 w-72 rounded-full bg-fuchsia-500/15 blur-3xl"
          />
          <div
            aria-hidden
            className="pointer-events-none absolute -bottom-32 -right-16 h-72 w-72 rounded-full bg-violet-500/15 blur-3xl"
          />
          <div className="relative grid items-center gap-8 lg:grid-cols-[1fr_auto]">
            <div>
              <div className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-violet-400/25 bg-violet-500/10 px-3 py-1 text-[11px] font-semibold text-violet-300">
                <Sparkles className="h-3.5 w-3.5" />
                مدعوم بخادم MCP — اتصل به من أي مساعد ذكي
              </div>
              <h1 className="text-3xl font-extrabold leading-[1.25] tracking-tight sm:text-[2.6rem] sm:leading-[1.2]">
                مركز <span className="text-gradient">الوسائط الذكي</span>
                <br />
                <span className="text-xl font-bold text-foreground/85 sm:text-2xl">
                  صور وفيديو ودمج — من لوحة واحدة
                </span>
              </h1>
              <div className="mt-5 flex flex-wrap items-center gap-2.5">
                {FEATURES.map((f) => (
                  <span
                    key={f.label}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs font-medium text-foreground/80"
                  >
                    <f.icon className="h-3.5 w-3.5 text-violet-300" />
                    {f.label}
                  </span>
                ))}
              </div>
            </div>

            {/* رابط MCP سريع النسخ */}
            <div className="w-full max-w-sm rounded-2xl border border-white/10 bg-black/25 p-4 lg:w-80">
              <p className="mb-2 text-[11px] font-semibold text-muted-foreground">عنوان ربط المساعدات الذكية</p>
              <div className="mb-3 truncate rounded-lg border border-white/10 bg-white/5 px-3 py-2 font-mono text-xs text-emerald-300" dir="ltr">
                {mcpUrl || "https://…/mcp"}
              </div>
              <CopyButton value={mcpUrl} label="نسخ رابط MCP" className="w-full" />
              <p className="mt-2.5 text-center text-[11px] text-muted-foreground">
                الصقه في ChatGPT أو Claude أو Cursor — التفاصيل بالأسفل
              </p>
            </div>
          </div>
        </section>

        {/* شريط المؤشرات */}
        <div className="fade-up delay-1">
          <StatsRow />
        </div>

        {/* المهام (واسعة) + المفاتيح */}
        <div className="grid gap-6 xl:grid-cols-3">
          <div className="fade-up delay-2 xl:col-span-2">
            <TaskBoard />
          </div>
          <div className="fade-up delay-3">
            <KeyManager />
          </div>
        </div>

        {/* مكتبة المقاطع — عرض كامل */}
        <div className="fade-up delay-4">
          <MediaLibrary />
        </div>

        {/* الربط — عرض كامل */}
        <div className="fade-up delay-5">
          <ConnectPanel health={health} />
        </div>
      </main>

      <footer className="relative mt-auto border-t border-white/5 py-5">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-center gap-2 px-4 text-xs text-muted-foreground sm:px-6">
          <span className="h-1.5 w-1.5 rounded-full bg-gradient-to-r from-violet-400 to-fuchsia-400" />
          مركز الوسائط الذكي — توليد الصور والفيديو ودمج المقاطع عبر خادم MCP واحد
        </div>
      </footer>
    </div>
  );
}
