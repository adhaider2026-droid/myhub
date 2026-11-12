// تخزين ملفات الوسائط المولّدة (Turso) — يلزم لأن روابط ملفات Google (Files API)
// تتطلب مفتاح الـ API للتحميل ولا تصلح رابطًا عامًا للمعرض، فننزّل البايتات على السيرفر
// ونعيد استضافتها عبر مسار عام: GET /api/media/file/{id}
// الرابط العام يُبنى من PUBLIC_BASE_URL أو من متغير Netlify التلقائي URL.

import { ensureSchema, getTurso } from "./turso";

function publicBase(): string {
  const raw = process.env.PUBLIC_BASE_URL || process.env.URL || "https://mysite-mcp.netlify.app";
  return raw.replace(/\/+$/, "");
}

export interface StoredMedia {
  id: string;
  mime_type: string;
  size_bytes: number;
  data: Uint8Array;
}

/** احفظ بايتات ملف وسيط وأعد رابطه العام الثابت */
export async function saveMediaFile(bytes: Uint8Array, mime: string): Promise<string> {
  await ensureSchema();
  const id = crypto.randomUUID();
  const size = bytes.byteLength;
  // سقف أمان 24MB — فوقه نرفض حتى لا نضغط حدود Turso HTTP
  if (size > 24 * 1024 * 1024) {
    throw new Error(`حجم الوسيط الناتج (${Math.round(size / 1024 / 1024)}MB) يتجاوز سقف التخزين`);
  }
  await getTurso().execute({
    sql: "INSERT INTO media_files (id, mime_type, size_bytes, data) VALUES (?, ?, ?, ?)",
    args: [id, mime, size, bytes],
  });
  return `${publicBase()}/api/media/file/${id}`;
}

/** اجلب ملفًا مخزّنًا للبث عبر GET /api/media/file/{id} — null إن لم يوجد */
export async function getMediaFile(id: string): Promise<StoredMedia | null> {
  await ensureSchema();
  const rs = await getTurso().execute({
    sql: "SELECT id, mime_type, size_bytes, data FROM media_files WHERE id = ?",
    args: [id],
  });
  if (!rs.rows.length) return null;
  const r = rs.rows[0];
  const data = r.data as unknown;
  // libsql قد يعيد BLOB كـ ArrayBuffer أو Uint8Array أو Buffer — وحّدها كلها إلى Uint8Array
  const bytes: Uint8Array =
    data instanceof Uint8Array
      ? data
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : ArrayBuffer.isView(data)
          ? new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength)
          : typeof data === "string"
            ? Uint8Array.from(Buffer.from(data, "base64"))
            : new Uint8Array(0);
  return {
    id: String(r.id),
    mime_type: String(r.mime_type ?? "application/octet-stream"),
    size_bytes: Number(r.size_bytes ?? bytes.byteLength),
    data: bytes,
  };
}
