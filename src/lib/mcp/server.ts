// خادم MCP — تسجيل الأدوات الخمس وفق المواصفة.
// الأوصاف الإنجليزية الدقيقة يقرأها عميل الذكاء الاصطناعي، أما نتائج الاستدعاء فتُصاغ بالعربية.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MODELS, resolveModel } from "../models";
import { listMedia, refreshTask, runGeneration, runMerge, type GenArgs, type MergeArgs, type ProgressSender, type RunResult } from "../generation";
import { parseUrls } from "../turso";
import type { TaskRow } from "../types";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" };

export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

// ----------------------------- الأوصاف الإنجليزية للأدوات -----------------------------

const IMG_DESC =
  "Generate an image with gpt-image-2-6/flare-text-to-image (automatic failover across all active API keys). " +
  "Returns a ready image URL if completed within the wait window; otherwise returns a task_id — " +
  "call get_task with that task_id every ~10 seconds until completed, then show the URL and stop.";

const VIDEO_DESC =
  "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio, optional image-to-video). " +
  "Videos take minutes: short wait with live progress streaming, then a task_id is returned — " +
  "track it with get_task every ~10 seconds until completed.";

const MERGE_DESC =
  "Merge several clips into one final video in the given order. Pass 'urls' (public direct video links, e.g. from generate_video) " +
  "or 'task_ids' (completed video generation tasks - their result URLs are resolved from the database in this order — ideal after generating several clips). " +
  "Usually fast: short wait with live progress streaming then a merge task_id — track it with get_task. " +
  "IMPORTANT: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.";

const GET_TASK_DESC =
  "Track any task by its id - image/video generation AND merging (reads the database and refreshes live from the provider/merging service while processing). " +
  "Poll every ~10 seconds; when completed the result URLs are included — show them to the user and stop polling.";

const LIST_MEDIA_DESC =
  "Latest stored images/videos/merges with their result URLs from the database (no regeneration) — recall previously generated media.";

// ----------------------------- مخططات المعطيات (مطابقة للمواصفة حرفيًا) -----------------------------

const generateImageSchema = {
  prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
  model: z
    .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
    .default("gpt-image-2-6/flare-text-to-image"),
  aspect_ratio: z
    .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
    .default("auto"),
  resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
  background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
  output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
  wait_seconds: z.number().int().min(0).max(240).default(90),
};

const generateVideoSchema = {
  prompt: z.string().min(1).max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
  image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
  model: z
    .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
    .default("grok-imagine-video-1-5-preview"),
  aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
  resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
  enable_audio: z.boolean().default(true),
  duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
  wait_seconds: z.number().int().min(0).max(240).default(25),
};

const mergeVideosSchema = {
  urls: z
    .array(z.string())
    .min(2)
    .max(10)
    .optional()
    .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
  task_ids: z
    .array(z.string())
    .min(2)
    .max(10)
    .optional()
    .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
  wait_seconds: z.number().int().min(0).max(240).default(60),
};

const getTaskSchema = {
  task_id: z.string().min(1),
};

const listMediaSchema = {
  type: z.enum(["image", "video", "merge"]).optional(),
  status: z.enum(["completed", "failed", "processing"]).optional(),
  limit: z.number().int().min(1).max(50).default(10),
};

// ----------------------------- صياغة الردود العربية -----------------------------

type ToolExtra = {
  _meta?: { progressToken?: string | number };
  signal: AbortSignal;
  sendNotification: (n: unknown) => Promise<void>;
};

/** مرسل تقدم MCP — يعمل فقط إذا زوّد العميل الطلب بـ _meta.progressToken */
function makeProgressSender(extra: ToolExtra): ProgressSender {
  const token = extra._meta?.progressToken;
  if (token === undefined) {
    return async () => {};
  }
  return async (progress, total, message) => {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress, total, message },
      });
    } catch {
      // العميل قد يكون انقطع — نستمر بالعمل وحفظ التقدم في قاعدة البيانات
    }
  };
}

const textResult = (text: string, isError = false) => ({
  content: [{ type: "text" as const, text }],
  ...(isError ? { isError: true } : {}),
});

function statusArabic(s: TaskRow["status"]): string {
  return s === "completed" ? "مكتملة" : s === "failed" ? "فاشلة" : s === "processing" ? "قيد المعالجة" : "معلقة";
}

const typeAr = (t: TaskRow["type"]): string => (t === "image" ? "صورة" : t === "video" ? "فيديو" : "دمج");

/** صياغة مهمة مكتملة وفق القسم 8 من المواصفة */
function formatCompleted(task: TaskRow): string {
  const urls = parseUrls(task.result_urls_json);
  if (task.type === "image") {
    const u = urls[0] ?? "";
    return `✅ تم توليد الصورة بنجاح\n\n![image](${u})\n\nالرابط المباشر: ${u}`;
  }
  if (task.type === "video") {
    return `✅ تم توليد الفيديو بنجاح\n\n${urls.map((u) => `الرابط المباشر: ${u}`).join("\n")}`;
  }
  return `✅ تم دمج المقاطع بنجاح\n\n${urls.map((u) => `الرابط المباشر: ${u}`).join("\n")}\n\n⚠️ ملف الدمج يُحذف من خدمة الدمج بعد ~24 ساعة — شاهده/نزّله سريعًا.`;
}

function formatProcessing(task: TaskRow): string {
  return `⏳ المهمة قيد المعالجة — task_id: ${task.id}\n\nتابع بـ get_task كل ~10 ثوانٍ حتى تكتمل.`;
}

/** صياغة استجابة get_task حسب الحالة والنوع */
export function formatTaskForClient(task: TaskRow): string {
  if (task.status === "completed") return formatCompleted(task);
  if (task.status === "failed") return `❌ فشلت المهمة: ${task.error_message ?? "سبب غير معروف"}`;
  return formatProcessing(task);
}

function formatRunResult(result: RunResult): { text: string; isError: boolean } {
  if (result.kind === "completed") return { text: formatCompleted(result.task), isError: false };
  if (result.kind === "processing") return { text: formatProcessing(result.task), isError: false };
  if (result.kind === "failed") return { text: `❌ فشلت المهمة: ${result.reason}`, isError: true };
  return {
    text: `❌ لا توجد مفاتيح نشطة لخدمة ${result.model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
    isError: false,
  };
}

// ----------------------------- إنشاء الخادم والأدوات -----------------------------

export function createMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  server.registerTool(
    "generate_image",
    { title: "Generate Image", description: IMG_DESC, inputSchema: generateImageSchema },
    async (args, extra) => {
      const def = resolveModel(args.model);
      if (!def || def.type !== "image") {
        return textResult(
          `❌ موديل غير معروف: ${args.model}. المتاح: ${MODELS.map((m) => m.canonical).join("، ")}`,
          true,
        );
      }
      const progress = makeProgressSender(extra as unknown as ToolExtra);
      const result = await runGeneration(def, { ...(args as unknown as GenArgs), model: def.canonical }, progress, extra.signal);
      const f = formatRunResult(result);
      return textResult(f.text, f.isError);
    },
  );

  server.registerTool(
    "generate_video",
    { title: "Generate Video", description: VIDEO_DESC, inputSchema: generateVideoSchema },
    async (args, extra) => {
      const def = resolveModel(args.model);
      if (!def || def.type !== "video") {
        return textResult(
          `❌ موديل غير معروف: ${args.model}. المتاح: ${MODELS.map((m) => m.canonical).join("، ")}`,
          true,
        );
      }
      const progress = makeProgressSender(extra as unknown as ToolExtra);
      const result = await runGeneration(def, { ...(args as unknown as GenArgs), model: def.canonical }, progress, extra.signal);
      const f = formatRunResult(result);
      return textResult(f.text, f.isError);
    },
  );

  server.registerTool(
    "merge_videos",
    { title: "Merge Videos", description: MERGE_DESC, inputSchema: mergeVideosSchema },
    async (args, extra) => {
      const mArgs = args as unknown as MergeArgs;
      const progress = makeProgressSender(extra as unknown as ToolExtra);
      const result = await runMerge(mArgs, progress, extra.signal);
      if (result.kind === "invalid") return textResult(result.message, true);
      if (result.kind === "completed") return textResult(formatCompleted(result.task));
      if (result.kind === "processing") return textResult(formatProcessing(result.task));
      return textResult(`❌ فشلت المهمة: ${result.reason}`, true);
    },
  );

  server.registerTool(
    "get_task",
    { title: "Get Task", description: GET_TASK_DESC, inputSchema: getTaskSchema },
    async (args) => {
      const task = await refreshTask(args.task_id);
      if (!task) return textResult(`❌ لا توجد مهمة بهذا المعرّف: ${args.task_id}`, true);
      const out = formatTaskForClient(task);
      return textResult(out, task.status === "failed");
    },
  );

  server.registerTool(
    "list_media",
    { title: "List Media", description: LIST_MEDIA_DESC, inputSchema: listMediaSchema },
    async (args) => {
      const tasks = await listMedia(args.limit ?? 10, { type: args.type, status: args.status });
      if (!tasks.length) {
        return textResult("لا توجد وسائط مخزنة بعد — جرّب generate_image أو generate_video أولًا.");
      }
      const icons: Record<TaskRow["type"], string> = { image: "🖼️", video: "🎬", merge: "🔗" };
      const lines: string[] = [`📁 أحدث الوسائط المخزنة (${tasks.length}):`];
      tasks.forEach((t, i) => {
        lines.push(`${i + 1}. ${icons[t.type]} ${typeAr(t.type)} | ${statusArabic(t.status)} | \`${t.model}\` | ${(t.created_at ?? "").slice(0, 19).replace("T", " ")}`);
        const urls = parseUrls(t.result_urls_json);
        if (t.status === "completed" && urls.length) {
          lines.push(`   الرابط: ${urls.join("  |  ")}`);
          if (t.type === "merge") lines.push("   ⚠️ ملف الدمج يُحذف بعد ~24 ساعة — نزّله سريعًا.");
        }
        if (t.status === "processing") lines.push(`   task_id: ${t.id} (تابع بـ get_task)`);
        if (t.status === "failed" && t.error_message) lines.push(`   السبب: ${t.error_message}`);
      });
      return textResult(lines.join("\n"));
    },
  );

  return server;
}
