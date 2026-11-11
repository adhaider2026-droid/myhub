// منسّق التوليد والدمج — ينفذ سياسة «لا توقف أبدًا»:
// 1) تجربة المرشحين بالترتيب التسلسلي الصارم (بترتيب إضافة المفاتيح).
// 2) عند أي خطأ مفتاح/رصيد: تبديل صامت فوري وإعادة إنشاء نفس المهمة بنفس task_id.
// 3) فشل الإنشاء على كل المفاتيح → المهمة تبقى processing وتُعاد المحاولة مع كل get_task
//    (بتهدئة ~45 ثانية حتى لا نضغط المزودين).
// 4) نموذج الذكاء الاصطناعي لا يرى أبدًا خطأ مفتاح أو رصيد.

import {
  ensureSchema,
  getTask,
  insertTask,
  listRecentTasks,
  parseAttempts,
  parseUrls,
  updateTask,
  type TaskPatch,
} from "./turso";
import { getKeyById, getKeyPool, recordKeyAttempt } from "./keys";
import { classifyProviderError, isKeyRelatedMessage, ProviderError, sanitizeReason } from "./errors";
import { resolveModel, type ModelDef } from "./models";
import { cometapiAdapter, kieAdapter } from "./providers";
import type { ProviderAdapter, ProviderCheckResult, ProviderInput } from "./providers/types";
import {
  createMergeJob,
  getMergeJob,
  mergerConfigured,
  postMergeProcess,
} from "./merger";
import type { AttemptRecord, KeyRow, MediaType, ProviderId, TaskRow } from "./types";

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = { kie: kieAdapter, cometapi: cometapiAdapter };

/** مرسل تقدم MCP — يبث إشعارات notifications/progress كل ~3 ثوانٍ (إن وفر العميل progressToken) */
export type ProgressSender = (progress: number, total: number, message: string) => Promise<void>;

export interface GenArgs {
  prompt: string;
  model: string;
  aspect_ratio?: string;
  resolution?: string;
  background?: string;
  output_format?: string;
  image_url?: string;
  enable_audio?: boolean;
  duration?: number;
  wait_seconds: number;
}

export type RunResult =
  | { kind: "completed"; task: TaskRow }
  | { kind: "processing"; task: TaskRow }
  | { kind: "failed"; task: TaskRow; reason: string }
  | { kind: "no_keys"; model: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** تقدم مشتق من الزمن المنقضي إن لم يوفره المزود (صورة ~45ث، فيديو ~180ث) */
function derivedProgress(type: MediaType, elapsedMs: number): number {
  const expectedMs = type === "image" ? 45000 : 180000;
  return Math.round(Math.min(10 + (elapsedMs / expectedMs) * 80, 92));
}

/** يبني معطيات المزود من معطيات الأداة — omit القيم "auto" لتجنب رفضها لدى المزود */
function buildProviderInput(def: ModelDef, args: GenArgs): ProviderInput {
  const input: ProviderInput = { prompt: args.prompt };
  if (def.type === "image") {
    if (args.aspect_ratio && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
    if (args.resolution) input.resolution = args.resolution;
    // background يُطبق فقط عند 1K وفق توثيق kie — نتجاهله في المستويات الأعلى
    if (args.background && args.background !== "auto" && (args.resolution ?? "1K") === "1K") {
      input.background = args.background;
    }
    if (args.output_format) input.output_format = args.output_format;
  } else {
    if (args.aspect_ratio && args.aspect_ratio !== "auto") input.aspect_ratio = args.aspect_ratio;
    if (args.resolution) input.resolution = args.resolution;
    if (args.enable_audio !== undefined) input.enable_audio = args.enable_audio;
    if (args.duration) input.duration = args.duration;
    if (args.image_url) input.image_url = args.image_url;
  }
  return input;
}

/** يسجل المحاولة في attempts_json للمهمة وفي عدّادات المفتاح (دائمًا، نجاحًا أو فشلًا) */
async function logAttempt(
  taskId: string,
  provider: ProviderId | "merger",
  key: KeyRow | undefined,
  ok: boolean,
  errorClass?: AttemptRecord["errorClass"],
  error?: string,
): Promise<void> {
  const attempt: AttemptRecord = {
    provider,
    keyId: key?.id,
    keyLabel: key?.label || undefined,
    ok,
    errorClass,
    error: error?.slice(0, 300),
    at: new Date().toISOString(),
  };
  await updateTask(taskId, { attempt });
  if (key) await recordKeyAttempt(key.id, ok, errorClass, error);
}

interface CreationOutcome {
  status: "created" | "image-sync" | "exhausted-all" | "invalid-params";
  provider?: ProviderId;
  providerTaskId?: string;
  keyId?: string;
  urls?: string[];
  reason?: string;
}

/**
 * تجربة المرشحين بالترتيب بدءًا من startIndex:
 * - disabled/exhausted → علّم المفتاح وانتقل للتالي
 * - provider → الموديل غير مدعوم هنا، انتقل للتالي
 * - temporary → انتقل للتالي الآن (المفتاح يبقى سليمًا)
 * - params → توقف فورًا (فشل معطيات حتمي)
 */
async function attemptCreation(
  taskId: string,
  def: ModelDef,
  args: GenArgs,
  pool: KeyRow[],
  startIndex: number,
): Promise<CreationOutcome> {
  for (let i = Math.max(0, startIndex); i < pool.length; i++) {
    const key = pool[i];
    const provider = key.provider as ProviderId;
    const adapter = PROVIDERS[provider];

    // صور متزامنة إن دعم المزود ذلك (CometAPI تعيد النتيجة فورًا)
    if (def.type === "image" && adapter.createImageSync) {
      try {
        const { urls } = await adapter.createImageSync(key.api_key, def.providerModel[provider], buildProviderInput(def, args));
        await logAttempt(taskId, provider, key, true);
        return { status: "image-sync", urls, provider, keyId: key.id };
      } catch (e) {
        const cls = classifyProviderError(e);
        await logAttempt(taskId, provider, key, false, cls, errMessage(e));
        if (cls === "params") return { status: "invalid-params", reason: errMessage(e) };
        continue;
      }
    }

    try {
      const { providerTaskId } = await adapter.createTask(key.api_key, def.providerModel[provider], buildProviderInput(def, args));
      await logAttempt(taskId, provider, key, true);
      return { status: "created", provider, providerTaskId, keyId: key.id };
    } catch (e) {
      const cls = classifyProviderError(e);
      await logAttempt(taskId, provider, key, false, cls, errMessage(e));
      if (cls === "params") return { status: "invalid-params", reason: errMessage(e) };
      continue; // disabled / exhausted / provider / temporary → المرشح التالي
    }
  }
  return { status: "exhausted-all" };
}

/** إعادة الإنشاء على المفتاح التالي بنفس task_id بعد فشل مفتاح/رصيد في منتصف المهمة */
async function recreateOnNextKey(task: TaskRow, def: ModelDef, args: GenArgs, failedKeyId: string | null): Promise<CreationOutcome> {
  const pool = await getKeyPool(def.providers);
  const idx = failedKeyId ? pool.findIndex((k) => k.id === failedKeyId) : -1;
  return attemptCreation(task.id, def, args, pool, idx + 1);
}

/** خاتمة إعادة الإنشاء داخل مسار الاستعلام (refresh) — تحدّث المهمة وتعيدها */
async function applyCreationOutcome(task: TaskRow, out: CreationOutcome): Promise<TaskRow> {
  if (out.status === "created") {
    const patch: TaskPatch = {
      provider: out.provider,
      provider_task_id: out.providerTaskId,
      key_id: out.keyId,
      status: "processing",
      error_message: null,
      progress: Math.max(task.progress, 5),
    };
    return (await updateTask(task.id, patch))!;
  }
  if (out.status === "image-sync") {
    return (await updateTask(task.id, { status: "completed", progress: 100, result_urls: out.urls }))!;
  }
  if (out.status === "invalid-params") {
    return (await updateTask(task.id, { status: "failed", error_message: sanitizeReason(out.reason) }))!;
  }
  // exhausted-all: أبقِ المهمة processing — بانتظار توفر مفتاح صالح (تُعاد المحاولة مع كل get_task)
  return (await updateTask(task.id, { error_message: "بانتظار توفر مفتاح صالح…" }))!;
}

/**
 * التدفق لأداة generate_image / generate_video (حسب القسم 6 من المواصفة):
 * سجّل أولًا → جرّب المرشحين بالترتيب → نافذة انتظار ببث تقدم → اكتمال/فشل/انتهاء النافذة.
 */
export async function runGeneration(
  def: ModelDef,
  args: GenArgs,
  progress?: ProgressSender,
  signal?: AbortSignal,
): Promise<RunResult> {
  await ensureSchema();
  const pool = await getKeyPool(def.providers);
  if (!pool.length) return { kind: "no_keys", model: def.canonical };

  const taskId = crypto.randomUUID();
  let task = await insertTask({
    id: taskId,
    model: def.canonical,
    type: def.type,
    prompt: args.prompt,
    params_json: JSON.stringify({ ...args }),
    status: "processing",
    progress: 0,
  });

  const creation = await attemptCreation(taskId, def, args, pool, 0);
  if (creation.status === "invalid-params") {
    task = (await updateTask(taskId, { status: "failed", error_message: sanitizeReason(creation.reason) }))!;
    return { kind: "failed", task, reason: task.error_message! };
  }
  if (creation.status === "exhausted-all") {
    // فشل الإنشاء على كل المفاتيح → processing مع رسالة داخلية؛ تُعاد المحاولة مع كل get_task
    task = (await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" }))!;
    return { kind: "processing", task };
  }
  if (creation.status === "image-sync") {
    task = (await updateTask(taskId, {
      provider: creation.provider,
      key_id: creation.keyId,
      status: "completed",
      progress: 100,
      result_urls: creation.urls,
    }))!;
    return { kind: "completed", task };
  }

  let provider = creation.provider!;
  let providerTaskId = creation.providerTaskId!;
  let keyIndex = pool.findIndex((k) => k.id === creation.keyId);
  let pollKey = await getKeyById(creation.keyId!);
  task = (await updateTask(taskId, { provider, provider_task_id: providerTaskId, key_id: pollKey!.id, progress: 5 }))!;

  // نافذة الانتظار: استعلم كل 3 ثوانٍ وابث تقدمًا حيًا
  const total = args.wait_seconds;
  const deadline = Date.now() + total * 1000;
  const startedAt = Date.now();

  while (Date.now() < deadline) {
    if (signal?.aborted) break; // انقطع العميل — تبقى المهمة قابلة للمتابعة عبر get_task
    await sleep(3000);

    const adapter = PROVIDERS[provider];
    let st: ProviderCheckResult;
    try {
      st = await adapter.checkTask(pollKey!.api_key, providerTaskId);
    } catch (e) {
      const cls = classifyProviderError(e);
      await logAttempt(taskId, provider, pollKey!, false, cls, errMessage(e));
      if (cls === "disabled" || cls === "exhausted") {
        // فشل مفتاح/رصيد في منتصف المهمة → إعادة إنشاء بنفس task_id على المفتاح التالي (صامت تمامًا)
        const re = await attemptCreation(taskId, def, args, pool, keyIndex + 1);
        if (re.status === "created") {
          provider = re.provider!;
          providerTaskId = re.providerTaskId!;
          keyIndex = pool.findIndex((k) => k.id === re.keyId);
          pollKey = await getKeyById(re.keyId!);
          task = (await updateTask(taskId, { provider, provider_task_id: providerTaskId, key_id: pollKey!.id }))!;
          continue;
        }
        if (re.status === "invalid-params") {
          task = (await updateTask(taskId, { status: "failed", error_message: sanitizeReason(re.reason) }))!;
          return { kind: "failed", task, reason: task.error_message! };
        }
        // exhausted-all → بانتظار مفتاح صالح، تُستأنف عبر get_task
        task = (await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" }))!;
        return { kind: "processing", task };
      }
      if (cls === "params") {
        task = (await updateTask(taskId, { status: "failed", error_message: sanitizeReason(errMessage(e)) }))!;
        return { kind: "failed", task, reason: task.error_message! };
      }
      continue; // temporary → استمر بالاستعلام
    }

    if (st.status === "completed" && st.urls?.length) {
      task = (await updateTask(taskId, { status: "completed", progress: 100, result_urls: st.urls }))!;
      return { kind: "completed", task };
    }
    if (st.status === "failed") {
      if (isKeyRelatedMessage(st.error)) {
        const re = await attemptCreation(taskId, def, args, pool, keyIndex + 1);
        if (re.status === "created") {
          provider = re.provider!;
          providerTaskId = re.providerTaskId!;
          keyIndex = pool.findIndex((k) => k.id === re.keyId);
          pollKey = await getKeyById(re.keyId!);
          task = (await updateTask(taskId, { provider, provider_task_id: providerTaskId, key_id: pollKey!.id }))!;
          continue;
        }
        if (re.status === "invalid-params") {
          task = (await updateTask(taskId, { status: "failed", error_message: sanitizeReason(re.reason) }))!;
          return { kind: "failed", task, reason: task.error_message! };
        }
        task = (await updateTask(taskId, { error_message: "بانتظار توفر مفتاح صالح…" }))!;
        return { kind: "processing", task };
      }
      task = (await updateTask(taskId, { status: "failed", error_message: sanitizeReason(st.error || "فشل التوليد لدى المزود") }))!;
      return { kind: "failed", task, reason: task.error_message! };
    }

    const pct = Math.max(task.progress, Math.min(st.progress ?? derivedProgress(def.type, Date.now() - startedAt), 95));
    task = (await updateTask(taskId, { progress: pct }))!;
    await progress?.(pct, total, `قيد التوليد… ${pct}%`);
  }

  // انتهت النافذة والنتيجة لم تظهر → أعد المهمة بحالة processing والعميل يتابع بـ get_task
  return { kind: "processing", task: (await getTask(taskId))! };
}

export interface MergeArgs {
  urls?: string[];
  task_ids?: string[];
  wait_seconds?: number;
}

export type MergeResult =
  | { kind: "invalid"; message: string }
  | { kind: "completed"; task: TaskRow }
  | { kind: "processing"; task: TaskRow }
  | { kind: "failed"; task: TaskRow; reason: string };

function statusArabic(s: TaskRow["status"]): string {
  return s === "completed" ? "مكتملة" : s === "failed" ? "فاشلة" : s === "processing" ? "قيد المعالجة" : "معلقة";
}

/**
 * تدفق merge_videos (حسب القسم 7.3):
 * حل task_ids بالترتيب ثم urls المباشرة → تحقق صارم (2..10، http/https) →
 * سجّل المهمة أولًا → POST /api/jobs → process خلفيًا وبمرة واحدة فقط → استعلام كل 3 ثوانٍ.
 */
export async function runMerge(
  args: MergeArgs,
  progress?: ProgressSender,
  signal?: AbortSignal,
): Promise<MergeResult> {
  await ensureSchema();

  // 1) حل task_ids: روابط المهام المكتملة أُولًا ثم urls المباشرة بنفس ترتيبها
  const problems: string[] = [];
  const resolved: string[] = [];
  for (const tid of args.task_ids ?? []) {
    const t = await getTask(String(tid).trim());
    if (!t) problems.push(`- ${tid}: مهمة غير موجودة`);
    else if (t.status !== "completed") problems.push(`- ${tid}: الحالة «${statusArabic(t.status)}» وليست مكتملة`);
    else {
      const urls = parseUrls(t.result_urls_json);
      if (!urls.length) problems.push(`- ${tid}: مكتملة لكن دون روابط نتيجة`);
      else resolved.push(urls[0]);
    }
  }
  const urls = [...resolved, ...(args.urls ?? [])].map((u) => String(u).trim()).filter(Boolean);

  // 2) تحقق صارم
  if (urls.length < 2) {
    const details = problems.length ? `\n\nتفاصيل المعرّفات المرفوضة:\n${problems.join("\n")}` : "";
    return { kind: "invalid", message: `❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.${details}` };
  }
  if (urls.length > 10) {
    return { kind: "invalid", message: "❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى)." };
  }
  if (urls.some((u) => !/^https?:\/\//i.test(u) || /\s/.test(u))) {
    return { kind: "invalid", message: "❌ الروابط يجب أن تكون روابط فيديو مباشرة عامة (http/https) من دون مسافات." };
  }
  if (!mergerConfigured()) {
    return { kind: "invalid", message: "❌ خدمة الدمج غير مهيأة على السيرفر — اضبط متغير البيئة MERGER_API_BASE ثم أعد المحاولة." };
  }

  // 3) سجّل مهمة الدمج في Turso أولًا
  const taskId = crypto.randomUUID();
  const waitSeconds = Math.max(0, Math.min(240, args.wait_seconds ?? 60));
  let task = await insertTask({
    id: taskId,
    provider: "merger",
    model: "video-merger",
    type: "merge",
    prompt: `دمج ${urls.length} مقاطع فيديو`,
    params_json: JSON.stringify({ urls, wait_seconds: waitSeconds }),
    status: "processing",
    progress: 0,
  });

  // 4) أنشئ مهمة لدى خدمة الدمج ثم أطلق process خلفيًا وبمرة واحدة فقط (قفل في الذاكرة)
  let jobId: string;
  try {
    const created = await createMergeJob(urls);
    jobId = created.jobId;
  } catch (e) {
    const cls = classifyProviderError(e);
    await logAttempt(taskId, "merger", undefined, false, cls, errMessage(e));
    if (cls === "params") {
      task = (await updateTask(taskId, { status: "failed", error_message: sanitizeReason(errMessage(e)) }))!;
      return { kind: "failed", task, reason: task.error_message! };
    }
    // خطأ شبكتنا نحن — مؤقت: تُستأنف المهمة تلقائيًا مع get_task
    task = (await updateTask(taskId, { error_message: "خدمة الدمج غير متاحة حاليًا — تُستأنف المحاولة تلقائيًا مع get_task" }))!;
    return { kind: "processing", task };
  }
  task = (await updateTask(taskId, { provider_task_id: jobId }))!;
  fireMergeProcess(taskId, jobId);

  // 5) نافذة انتظار مع استعلام كل 3 ثوانٍ وبث تقدم — تحديث الحالة يُكتب في Turso فورًا كل مرة
  const deadline = Date.now() + waitSeconds * 1000;
  while (Date.now() < deadline) {
    if (signal?.aborted) break;
    await sleep(3000);

    let st;
    try {
      st = await getMergeJob(jobId);
    } catch (e) {
      if (e instanceof ProviderError && e.status === 404) {
        task = (await updateTask(taskId, {
          status: "failed",
          error_message: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
        }))!;
        return { kind: "failed", task, reason: task.error_message! };
      }
      continue; // أخطاء شبكتنا نحن = مؤقتة → استمر بالاستعلام حتى انتهاء النافذة
    }

    if (st.state === "completed" && st.videoUrl) {
      task = (await updateTask(taskId, { status: "completed", progress: 100, result_urls: [st.videoUrl] }))!;
      return { kind: "completed", task };
    }
    if (st.state === "failed") {
      // أي خطأ HTTP معلن من الخدمة = فشل نهائي فوري — لا إعادة محاولة
      task = (await updateTask(taskId, { status: "failed", error_message: sanitizeReason(st.error || "فشل الدمج لدى الخدمة") }))!;
      return { kind: "failed", task, reason: task.error_message! };
    }
    const pct = Math.max(task.progress, Math.min(st.progress || 0, 95));
    task = (await updateTask(taskId, { progress: pct }))!;
    await progress?.(pct, waitSeconds, `قيد الدمج… ${pct}%`);
  }

  return { kind: "processing", task: (await getTask(taskId))! };
}

/**
 * refreshTask — يستدعيه get_task: يحدّث المهمة الجارية حية من المزود/خدمة الدمج
 * مع نفس منطق إعادة المحاولة/التبديل، ثم يعيد الصياغة العربية للعرض.
 */
export async function refreshTask(taskId: string): Promise<TaskRow | null> {
  await ensureSchema();
  let task = await getTask(taskId);
  if (!task) return null;
  if (task.status === "completed" || task.status === "failed") return task;

  if (task.type === "merge") return refreshMergeTask(task);

  const def = resolveModel(task.model);
  if (!def) return task;

  // حالة لم تُنشأ بعد على أي مزود (فشل كل المفاتيح عند الإنشاء) → أعد المحاولة بعد تهدئة ~45 ثانية
  if (!task.provider_task_id || !task.provider || task.provider === "merger") {
    const attempts = parseAttempts(task.attempts_json);
    const lastAt = attempts.length ? new Date(attempts[attempts.length - 1].at).getTime() : 0;
    if (Date.now() - lastAt < 45000) return task;
    const args = JSON.parse(task.params_json || "{}") as GenArgs;
    const pool = await getKeyPool(def.providers);
    if (!pool.length) return task;
    const out = await attemptCreation(task.id, def, args, pool, 0);
    return applyCreationOutcome(task, out);
  }

  const key = task.key_id ? await getKeyById(task.key_id) : null;
  if (!key) return task;
  const adapter = PROVIDERS[task.provider as ProviderId];
  const args = JSON.parse(task.params_json || "{}") as GenArgs;

  let st: ProviderCheckResult;
  try {
    st = await adapter.checkTask(key.api_key, task.provider_task_id);
  } catch (e) {
    const cls = classifyProviderError(e);
    await logAttempt(task.id, task.provider as ProviderId, key, false, cls, errMessage(e));
    if (cls === "disabled" || cls === "exhausted") {
      const out = await recreateOnNextKey(task, def, args, key.id);
      return applyCreationOutcome(task, out);
    }
    if (cls === "params") {
      return (await updateTask(task.id, { status: "failed", error_message: sanitizeReason(errMessage(e)) }))!;
    }
    return task; // temporary → ابقَ معالجة حتى الاستعلام القادم
  }

  if (st.status === "completed" && st.urls?.length) {
    return (await updateTask(task.id, { status: "completed", progress: 100, result_urls: st.urls }))!;
  }
  if (st.status === "failed") {
    if (isKeyRelatedMessage(st.error)) {
      const out = await recreateOnNextKey(task, def, args, key.id);
      return applyCreationOutcome(task, out);
    }
    return (await updateTask(task.id, { status: "failed", error_message: sanitizeReason(st.error) }))!;
  }
  const pct = Math.max(task.progress, Math.min(st.progress ?? derivedProgress(def.type, Date.now() - new Date(task.created_at + "Z").getTime()), 95));
  return (await updateTask(task.id, { progress: pct }))!;
}

/** get_task لمهمة دمج: حدّث من GET /api/jobs/{id}؛ نفّذ process إن لم يُنفذ بعد؛ 404 → فشل نهائي */
async function refreshMergeTask(task: TaskRow): Promise<TaskRow> {
  if (!mergerConfigured()) return task;

  const args = JSON.parse(task.params_json || "{}") as MergeArgs;
  let jobId = task.provider_task_id;

  if (!jobId) {
    try {
      jobId = (await createMergeJob(args.urls ?? [])).jobId;
    } catch (e) {
      const cls = classifyProviderError(e);
      await logAttempt(task.id, "merger", undefined, false, cls, errMessage(e));
      if (cls === "params") {
        return (await updateTask(task.id, { status: "failed", error_message: sanitizeReason(errMessage(e)) }))!;
      }
      return task; // خطأ شبكة → المحاولة التالية
    }
    task = (await updateTask(task.id, { provider_task_id: jobId }))!;
  }
  // إن كانت processing ولم يُنفَّذ process بعد فنفّذه الآن (القفل يمنع التزامن مع الاستدعاء الأصلي)
  fireMergeProcess(task.id, jobId);

  try {
    const st = await getMergeJob(jobId);
    if (st.state === "completed" && st.videoUrl) {
      return (await updateTask(task.id, { status: "completed", progress: 100, result_urls: [st.videoUrl] }))!;
    }
    if (st.state === "failed") {
      return (await updateTask(task.id, { status: "failed", error_message: sanitizeReason(st.error || "فشل الدمج لدى الخدمة") }))!;
    }
    return (await updateTask(task.id, { progress: Math.max(task.progress, Math.min(st.progress || 0, 95)) }))!;
  } catch (e) {
    if (e instanceof ProviderError && e.status === 404) {
      return (await updateTask(task.id, {
        status: "failed",
        error_message: "مهمة الدمج غير موجودة في الخدمة (حُذفت أو انتهت صلاحيتها بعد 24 ساعة)",
      }))!;
    }
    return task; // أخطاء شبكتنا نحن = مؤقتة
  }
}

/** قفل الذاكرة: يمنع تنفيذ POST .../process المتزامن مع get_task لنفس jobId */
const processInFlight = new Set<string>();

/**
 * أطلق POST /api/jobs/{id}/process خلفيًا وبمرة واحدة فقط لكل jobId.
 * أي خطأ HTTP معلن من الخدمة = فشل نهائي فوري؛ أخطاء شبكتنا نحن = مؤقتة وتُحسم عند الاستعلام.
 */
export async function fireMergeProcess(taskId: string, jobId: string): Promise<void> {
  if (processInFlight.has(jobId)) return;
  processInFlight.add(jobId);
  void (async () => {
    try {
      const r = await postMergeProcess(jobId);
      if (r.done && r.videoUrl) {
        await updateTask(taskId, { status: "completed", progress: 100, result_urls: [r.videoUrl] });
      } else if (r.done && !r.videoUrl) {
        // اكتملت دون رابط مباشر — ولّد رابط البث الافتراضي عبر getMergeJob عند الاستعلام
      }
    } catch (e) {
      if (e instanceof ProviderError && e.status !== undefined) {
        // فشل معلن من الخدمة (مثل مصدر يرفض التحميل) — فشل حتمي: تكرار المحاولة يعطي النتيجة نفسها
        await updateTask(taskId, { status: "failed", error_message: sanitizeReason(errMessage(e)) });
      }
      // أخطاء شبكتنا نحن → لا نعلّم فشلًا؛ الاستعلام التالي يفصل الحالة
    } finally {
      processInFlight.delete(jobId);
    }
  })();
}

/** list_media — أحدث الوسائط المخزنة بروابطها (بدون إعادة توليد) */
export async function listMedia(limit: number, filters?: { type?: MediaType; status?: TaskRow["status"] }): Promise<TaskRow[]> {
  await ensureSchema();
  return listRecentTasks(limit, filters);
}

export { postMergeProcess, getMergeJob };
