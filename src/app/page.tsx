"use client";

// لوحة الإدارة — صفحة واحدة: هيدر الحالة + ثلاث بطاقات (المفاتيح، المهام، الربط).

import { useEffect, useState } from "react";
import HealthHeader from "@/components/dashboard/health-header";
import KeyManager from "@/components/dashboard/key-manager";
import TaskBoard from "@/components/dashboard/task-board";
import ConnectPanel from "@/components/dashboard/connect-panel";

export interface HealthData {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: { canonical: string; type: string; providers: string[] }[];
  merger: { base: string; healthy: boolean };
  authRequired: boolean;
}

export default function Home() {
  const [health, setHealth] = useState<HealthData | null>(null);

  useEffect(() => {
    let alive = true;
    const fetchHealth = () =>
      fetch("/api/health")
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => alive && setHealth(d))
        .catch(() => alive && setHealth(null));
    fetchHealth();
    const t = setInterval(fetchHealth, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="flex min-h-screen flex-col">
      <HealthHeader health={health} />
      <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-16 pt-6 sm:px-6">
        <div className="grid gap-6 xl:grid-cols-3">
          <KeyManager />
          <TaskBoard />
          <ConnectPanel health={health} />
        </div>
      </main>
      <footer className="mt-auto border-t py-4 text-center text-xs text-muted-foreground">
        MCP Media Generator — توليد الصور والفيديو ودمج المقاطع عبر خادم MCP واحد
      </footer>
    </div>
  );
}
