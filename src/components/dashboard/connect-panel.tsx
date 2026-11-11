"use client";

// بطاقة ربط السيرفر: رابط <origin>/mcp جاهز للنسخ + JSON لكل عميل + رقائق الأدوات الخمس + ملاحظة كهرمانية.

import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import CopyButton from "@/components/dashboard/copy-button";
import { Plug } from "lucide-react";
import type { HealthData } from "@/app/page";

const TOOLS: { name: string; desc: string }[] = [
  { name: "generate_image", desc: "توليد صورة من وصف نصي عبر gpt-image-2-6/flare-text-to-image" },
  { name: "generate_video", desc: "توليد فيديو بصوت متزامن عبر grok-imagine-video-1-5-preview" },
  { name: "merge_videos", desc: "دمج حتى 10 مقاطع في فيديو واحد بالترتيب المطلوب" },
  { name: "get_task", desc: "تتبع أي مهمة بمعرّفها حتى الاكتمال" },
  { name: "list_media", desc: "استرجاع أحدث الوسائط المخزنة بروابطها" },
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
    <Card className="flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Plug className="h-4 w-4 text-primary" /> ربط السيرفر
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        {/* رابط MCP */}
        <div className="flex items-center gap-2">
          <Input readOnly value={mcpUrl} className="font-mono text-xs" dir="ltr" />
          <button
            onClick={copyUrl}
            className="shrink-0 rounded-md border px-3 py-2 text-xs transition hover:bg-accent"
            type="button"
          >
            {copiedUrl ? "✓ نُسخ" : "نسخ"}
          </button>
        </div>

        {/* تبويبات JSON */}
        <Tabs defaultValue="chatgpt" className="gap-3">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="chatgpt" className="text-xs">ChatGPT</TabsTrigger>
            <TabsTrigger value="claude" className="text-xs">Claude Desktop</TabsTrigger>
            <TabsTrigger value="cursor" className="text-xs">Cursor / Windsurf</TabsTrigger>
          </TabsList>
          <TabsContent value="chatgpt" className="space-y-2">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              في ChatGPT: Settings ← Connectors ← Create ← Custom MCP server وضع الرابط في «Server URL».
            </p>
            <pre className="scroll-slim max-h-56 overflow-auto rounded-xl border bg-slate-950/60 p-3 font-mono text-[11px] leading-relaxed text-emerald-300" dir="ltr">
              {chatgptJson}
            </pre>
            <CopyButton value={chatgptJson} label="نسخ JSON" />
          </TabsContent>
          <TabsContent value="claude" className="space-y-2">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              أضف القسم إلى ملف claude_desktop_config.json ثم أعد تشغيل التطبيق.
            </p>
            <pre className="scroll-slim max-h-56 overflow-auto rounded-xl border bg-slate-950/60 p-3 font-mono text-[11px] leading-relaxed text-emerald-300" dir="ltr">
              {claudeJson}
            </pre>
            <CopyButton value={claudeJson} label="نسخ JSON" />
          </TabsContent>
          <TabsContent value="cursor" className="space-y-2">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              أضف القسم إلى mcp.json في Cursor أو Windsurf أو Cline.
            </p>
            <pre className="scroll-slim max-h-56 overflow-auto rounded-xl border bg-slate-950/60 p-3 font-mono text-[11px] leading-relaxed text-emerald-300" dir="ltr">
              {cursorJson}
            </pre>
            <CopyButton value={cursorJson} label="نسخ JSON" />
          </TabsContent>
        </Tabs>

        {/* رقائق الأدوات */}
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">الأدوات الخمس المتاحة:</p>
          <div className="space-y-1.5">
            {TOOLS.map((t) => (
              <div key={t.name} className="flex flex-wrap items-center gap-2 rounded-lg border bg-card/60 px-2.5 py-1.5">
                <Badge variant="secondary" className="bg-primary/10 font-mono text-[10px] text-primary hover:bg-primary/10">
                  {t.name}
                </Badge>
                <span className="text-[11px] text-muted-foreground">{t.desc}</span>
              </div>
            ))}
          </div>
        </div>

        {/* الملاحظة الكهرمانية */}
        <Alert className="border-amber-500/25 bg-amber-500/10">
          <AlertDescription className="text-[11px] leading-relaxed text-amber-300">
            الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال المهمة
            يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبث تقدم حي (Progress notifications) حتى لا تنقطع العملية.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}
