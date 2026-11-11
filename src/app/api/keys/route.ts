// GET /api/keys — القائمة كاملة مع إخفاء المفاتيح دائمًا (maskKey).
// POST /api/keys — إضافة مفتاح مع رفض التكرار لنفس المزود.

import { findDuplicateKey, insertKey, listKeys, toPublicKeyView } from "@/lib/keys";
import type { ProviderId } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PROVIDERS: ProviderId[] = ["kie", "cometapi"];

export async function GET() {
  try {
    const keys = await listKeys();
    return Response.json({ keys: keys.map(toPublicKeyView) });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "خطأ غير متوقع" }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => null)) as
      | { provider?: string; api_key?: string; label?: string }
      | null;
    const provider = body?.provider as ProviderId | undefined;
    const apiKey = body?.api_key?.trim();
    if (!provider || !PROVIDERS.includes(provider)) {
      return Response.json({ error: "المزود غير صالح — القيم المقبولة: kie أو cometapi" }, { status: 400 });
    }
    if (!apiKey) {
      return Response.json({ error: "قيمة المفتاح مطلوبة" }, { status: 400 });
    }
    if (await findDuplicateKey(provider, apiKey)) {
      return Response.json({ error: "هذا المفتاح مضاف مسبقًا لنفس المزود" }, { status: 409 });
    }
    const key = await insertKey(provider, apiKey, body?.label?.trim() || "");
    return Response.json({ key: toPublicKeyView(key) }, { status: 201 });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "خطأ غير متوقع" }, { status: 500 });
  }
}
