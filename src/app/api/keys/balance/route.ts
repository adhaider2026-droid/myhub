// GET /api/keys/balance — الرصيد الحي لدى المزودين (kie.ai يدعم استعلام الرصيد، CometAPI لا يوفر نقطة نهاية معلنة).
// يعيد رصيد أول مفتاح غير معطل لكل مزود — مفاتيح الحساب الواحد تشترك بالرصيد نفسه.

import { getKeyPool, maskKey } from "@/lib/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProviderBalance {
  credits: number | null;
  keyLabel: string;
  checkedAt: string;
  error?: string;
}

export async function GET() {
  try {
    const pool = await getKeyPool(["kie"]); // يشمل المستنزف — الرصيد قد أعيد شحنه
    if (!pool.length) return Response.json({ balances: {} as Record<string, ProviderBalance> });

    const key = pool[0];
    const keyLabel = key.label || maskKey(key.api_key);
    const balance: ProviderBalance = {
      credits: null,
      keyLabel,
      checkedAt: new Date().toISOString(),
    };

    try {
      const res = await fetch("https://api.kie.ai/api/v1/chat/credit", {
        headers: { Authorization: `Bearer ${key.api_key}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8000),
      });
      const body = (await res.json().catch(() => null)) as { code?: number; data?: unknown } | null;
      if (body && body.code === 200 && (typeof body.data === "number" || typeof body.data === "string")) {
        const n = Number(body.data);
        if (Number.isFinite(n)) balance.credits = n;
      } else {
        balance.error = "استجابة غير متوقعة من kie.ai";
      }
    } catch (e) {
      balance.error = e instanceof Error ? e.message : "تعذر الاستعلام عن الرصيد";
    }

    return Response.json({ balances: { kie: balance } });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : "خطأ غير متوقع" }, { status: 500 });
  }
}
