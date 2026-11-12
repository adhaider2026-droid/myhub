"use client";

// بطاقة ربط السيرفر: نافذة نقطة نهاية MCP + إعدادات JSON لكل عميل بنوافذ كود + قائمة الأدوات.

import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import CopyButton from "@/components/dashboard/copy-button";
import {
  Check,
  Clapperboard,
  Copy,
  Images,
  LibraryBig,
  Merge,
  Plug,
  Radar,
} from "lucide-react";
import type { HealthData } from "@/app/page";

const TOOLS: { name: string; desc: string; icon: typeof Images; tile: string }[] = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي عبر gpt-image-2-6/flare-text-to-image", icon: Images, tile: "text-violet-300" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن عبر grok-imagine-video-1-5-preview", icon: Clapperboard, tile: "text-fuchsia-300" },
  { name: "merge_videos", desc: "دمج حتى 10 مقاطع في فيديو واحد بالترتيب المطلوب", icon: Merge, tile: "text-teal-300" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال", icon: Radar, tile: "text-amber-300" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها", icon: LibraryBig, tile: "text-emerald-300" },
];

export default function ConnectPanel({ health }: { health: HealthData | null }) {
  const [origin, setOrigin] = useState("");
  const [copiedUrl, setCopiedUrl] = useState(false);

  // نقرأ origin بعد التركيب (وليس أثناء التصيير) لتفادي اختلاف hydration بين الخادم والمتصفح
  useEffect(() => {
    if (typeof window !== "undefined" && !origin) {
      setOrigin(window.location.origin);
    }
  }, [origin]);

  const mcpUrl = `${origin || "https://<نطاق-النشر>"}/mcp`;

  const authBlock = health?.authRequired
    ? `, "headers": { "Authorization": "Bearer <MCP_ACCESS_TOKEN>" }`
    : "";

  const chatgptJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authBlock}\n    }\n  }\n}`;
  const claudeJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${authBlock}\n    }\n  }\n}`;
  const cursorJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${authBlock}\n    }\n  }\n}`;

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopiedUrl(true);
      setTimeout(() => setCopiedUrl(false), 2000);
    } catch {
      /* ignore */
    }
  };

  return (
    <section className="glass glass-hover rounded-2xl" aria-label="ربط السيرفر">
      {/* رأس البطاقة */}
      <div className="flex items-center gap-3 border-b border-white/8 px-5 py-4">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500/25 to-fuchsia-500/10 text-violet-300">
          <Plug className="h-4.5 w-4.5" />
        </span>
        <div>
          <h2 className="text-sm font-bold leading-tight">ربط السيرفر بأي مساعد ذكي</h2>
          <p className="text-[11px] leading-tight text-muted-foreground">انسخ الإعداد المناسب لعميلك — يعمل مع ChatGPT وClaude وCursor وغيرها</p>
        </div>
      </div>

      <div className="grid gap-6 p-5 lg:grid-cols-2">
        {/* العمود الأيمن: نقطة النهاية + إعدادات JSON */}
        <div className="space-y-4">
          {/* نافذة نقطة النهاية */}
          <div className="code-window">
            <div className="code-window-bar">
              <span className="code-dot bg-rose-500/80" />
              <span className="code-dot bg-amber-500/80" />
              <span className="code-dot bg-emerald-500/80" />
              <span className="ms-1.5 font-mono text-[10px] tracking-wider text-muted-foreground" dir="ltr">
                MCP ENDPOINT
              </span>
              <button
                type="button"
                onClick={copyUrl}
                className="ms-auto inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 text-[10px] text-slate-200 transition hover:border-violet-400/40 hover:bg-white/10"
              >
                {copiedUrl ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                {copiedUrl ? "نُسخ" : "نسخ"}
              </button>
            </div>
            <div className="p-3">
              <Input readOnly value={mcpUrl} className="border-transparent bg-transparent font-mono text-xs text-emerald-300" dir="ltr" />
            </div>
          </div>

          {/* تبويبات JSON */}
          <Tabs defaultValue="chatgpt" className="gap-3">
            <TabsList className="grid w-full grid-cols-3 rounded-xl border border-white/10 bg-white/5 p-1">
              <TabsTrigger value="chatgpt" className="rounded-lg text-xs data-[state=active]:bg-gradient-to-l data-[state=active]:from-violet-600 data-[state=active]:to-fuchsia-600 data-[state=active]:text-white">
                ChatGPT
              </TabsTrigger>
              <TabsTrigger value="claude" className="rounded-lg text-xs data-[state=active]:bg-gradient-to-l data-[state=active]:from-violet-600 data-[state=active]:to-fuchsia-600 data-[state=active]:text-white">
                Claude Desktop
              </TabsTrigger>
              <TabsTrigger value="cursor" className="rounded-lg text-xs data-[state=active]:bg-gradient-to-l data-[state=active]:from-violet-600 data-[state=active]:to-fuchsia-600 data-[state=active]:text-white">
                Cursor / Windsurf
              </TabsTrigger>
            </TabsList>

            {(
              [
                {
                  id: "chatgpt",
                  json: chatgptJson,
                  hint: "في ChatGPT: Settings ← Connectors ← Create ← Custom MCP server وضع الرابط في «Server URL».",
                  file: "connector-config.json",
                },
                {
                  id: "claude",
                  json: claudeJson,
                  hint: "أضف القسم إلى ملف claude_desktop_config.json ثم أعد تشغيل التطبيق.",
                  file: "claude_desktop_config.json",
                },
                {
                  id: "cursor",
                  json: cursorJson,
                  hint: "أضف القسم إلى mcp.json في Cursor أو Windsurf أو Cline.",
                  file: "mcp.json",
                },
              ] as const
            ).map((tab) => (
              <TabsContent key={tab.id} value={tab.id} className="space-y-2.5">
                <p className="text-[11px] leading-relaxed text-muted-foreground">{tab.hint}</p>
                <div className="code-window">
                  <div className="code-window-bar">
                    <span className="code-dot bg-rose-500/80" />
                    <span className="code-dot bg-amber-500/80" />
                    <span className="code-dot bg-emerald-500/80" />
                    <span className="ms-1.5 font-mono text-[10px] tracking-wider text-muted-foreground" dir="ltr">
                      {tab.file}
                    </span>
                  </div>
                  <pre
                    className="scroll-slim max-h-52 overflow-auto p-3.5 font-mono text-[11px] leading-relaxed text-emerald-300"
                    dir="ltr"
                  >
                    {tab.json}
                  </pre>
                </div>
                <CopyButton value={tab.json} label="نسخ JSON" className="h-8 rounded-lg border-white/12 bg-white/5 hover:bg-white/10" />
              </TabsContent>
            ))}
          </Tabs>
        </div>

        {/* العمود الأيسر: الأدوات + الملاحظة */}
        <div className="space-y-4">
          <p className="text-xs font-bold text-muted-foreground">الأدوات الخمس المتاحة عبر MCP:</p>
          <div className="space-y-2">
            {TOOLS.map((t) => (
              <div
                key={t.name}
                className="flex items-center gap-3 rounded-xl border border-white/8 bg-white/[.03] px-3 py-2.5 transition-colors hover:border-violet-400/30 hover:bg-white/[.05]"
              >
                <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-white/5 ${t.tile}`}>
                  <t.icon className="h-4 w-4" />
                </span>
                <span className="shrink-0 rounded-md border border-violet-400/20 bg-violet-500/10 px-2 py-0.5 font-mono text-[10px] text-violet-300" dir="ltr">
                  {t.name}
                </span>
                <span className="text-[11px] leading-relaxed text-muted-foreground">{t.desc}</span>
              </div>
            ))}
          </div>

          <Alert className="rounded-xl border-amber-400/20 bg-amber-500/8">
            <AlertDescription className="text-[11px] leading-relaxed text-amber-300/95">
              الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة
              يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
            </AlertDescription>
          </Alert>
        </div>
      </div>
    </section>
  );
}
