// نظام المفاتيح المتسلسلة — قلب المشروع.
// قواعد جوهرية: ترتيب تسلسلي صارم بترتيب الإضافة (created_at ASC, id ASC) — ليس round-robin
// وليس «الأقل استخدامًا أولًا». المفتاح المستنزف (exhausted) يبقى في القائمة والقاعدة
// ولا يُستبعد (قد يُشحن رصيده لاحقًا) — الاستثناء الوحيد هو التعطيل اليدوي (disabled).

import type { ErrorClass, KeyRow, ProviderId, PublicKeyView } from "./types";
import { bumpKeyCounters, ensureSchema, getKeyById as dbGetKeyById, getTurso, listKeys, updateKeyStatus } from "./turso";

/**
 * مزود Pollinations مجاني بالكامل ولا يحتاج مفتاحًا — يُحقن كمفتاح مدمج افتراضي
 * في نهاية كل مجموعة مفاتيح، فيعمل التوليد حتى لو لم يضف المستخدم أي مفتاح.
 */
export const BUILTIN_FREE_KEY_ID = "builtin-pollinations-free";

export function builtinFreeKey(): KeyRow {
  return {
    id: BUILTIN_FREE_KEY_ID,
    provider: "pollinations",
    label: "مجاني — بلا مفتاح (Pollinations)",
    api_key: "",
    status: "active",
    usage_count: 0,
    success_count: 0,
    fail_count: 0,
    last_used_at: null,
    last_checked_at: null,
    last_error: null,
    created_at: "",
  };
}

/** إخفاء المفتاح إلزامي في كل الاستجابات والسجلات: أول 7 + •••••••• + آخر 4 (والقصير: أول 3 + ••••) */
export function maskKey(key: string): string {
  if (key.length >= 16) return `${key.slice(0, 7)}••••••••${key.slice(-4)}`;
  return `${key.slice(0, 3)}••••`;
}

export function toPublicKeyView(k: KeyRow): PublicKeyView {
  const { api_key, ...rest } = k;
  return { ...rest, masked: maskKey(api_key) };
}

/**
 * تجلب كل المفاتيح غير المعطّلة لهذه المزودات بالترتيب التسلسلي الصارم.
 * أول مفتاح أُضيف يُجرَّب أولًا، ثم الثاني، ثم الثالث...
 */
export async function getKeyPool(providers: string[]): Promise<KeyRow[]> {
  await ensureSchema();
  const placeholders = providers.map(() => "?").join(", ");
  const rs = await getTurso().execute({
    sql: `SELECT id, provider, label, api_key, status, usage_count, success_count, fail_count,
            last_used_at, last_checked_at, last_error, created_at
          FROM api_keys
          WHERE status != 'disabled' AND provider IN (${placeholders})
          ORDER BY created_at ASC, id ASC`,
    args: providers,
  });
  const rows = rs.rows.map((r) => ({
    id: String(r.id),
    provider: r.provider as KeyRow["provider"],
    label: String(r.label ?? ""),
    api_key: String(r.api_key),
    status: (r.status as KeyRow["status"]) ?? "active",
    usage_count: Number(r.usage_count ?? 0),
    success_count: Number(r.success_count ?? 0),
    fail_count: Number(r.fail_count ?? 0),
    last_used_at: (r.last_used_at as string | null) ?? null,
    last_checked_at: (r.last_checked_at as string | null) ?? null,
    last_error: (r.last_error as string | null) ?? null,
    created_at: String(r.created_at ?? ""),
  }));
  // المزود المجاني يعمل دائمًا — يُضاف في نهاية الترتيب إن لم يوجد مفتاح له
  if (providers.includes("pollinations") && !rows.some((k) => k.provider === "pollinations")) {
    rows.push(builtinFreeKey());
  }
  return rows;
}

/**
 * يُستدعى بعد كل محاولة على مفتاح (نجاح أو فشل):
 * - يحدّث العدّادات دائمًا (usage/success/fail/last_used/last_error)
 * - disabled → يعلّم المفتاح معطلًا تلقائيًا
 * - exhausted → يعلّمه مستنزفًا (يبقى في القاعدة)
 * - نجاح على مفتاح كان مستنزفًا (أُعيد شحنه) → يعيد تنشيطه
 */
export async function getKeyById(keyId: string): Promise<KeyRow | null> {
  if (keyId === BUILTIN_FREE_KEY_ID) return builtinFreeKey();
  return dbGetKeyById(keyId);
}

/**
 * يُستدعى بعد كل محاولة على مفتاح (نجاح أو فشل):
 * - يحدّث العدّادات دائمًا (usage/success/fail/last_used/last_error)
 * - disabled → يعلّم المفتاح معطلًا تلقائيًا
 * - exhausted → يعلّمه مستنزفًا (يبقى في القاعدة)
 * - نجاح على مفتاح كان مستنزفًا (أُعيد شحنه) → يعيد تنشيطه
 */
export async function recordKeyAttempt(
  keyId: string,
  ok: boolean,
  errorClass?: ErrorClass,
  error?: string,
): Promise<void> {
  if (keyId === BUILTIN_FREE_KEY_ID) return; // المفتاح المدمج المجاني بلا عدادات في القاعدة
  const key = await getKeyById(keyId);
  if (!key) return;
  await bumpKeyCounters(keyId, ok, error);
  if (ok) {
    if (key.status !== "active") await updateKeyStatus(keyId, "active", null);
    return;
  }
  if (errorClass === "disabled") await updateKeyStatus(keyId, "disabled", error?.slice(0, 300));
  else if (errorClass === "exhausted") await updateKeyStatus(keyId, "exhausted", error?.slice(0, 300));
}

export { listKeys, updateKeyStatus };
export { insertKey, findDuplicateKey, deleteKey } from "./turso";
