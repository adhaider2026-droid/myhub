// GET /api/health — حالة النظام: قاعدة البيانات، نقطة MCP، الموديلات، خدمة الدمج، التوثيق.

import { dbHealthy } from "@/lib/turso";
import { modelsSummary } from "@/lib/models";
import { mergerBase, mergerHealthy } from "@/lib/merger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const database = await dbHealthy();
  const merger = { base: mergerBase() ?? "", healthy: await mergerHealthy() };
  const payload = {
    ok: database,
    database: database ? "turso-connected" : "turso-unavailable",
    mcpEndpoint: "/mcp",
    models: modelsSummary(),
    merger,
    authRequired: !!process.env.MCP_ACCESS_TOKEN,
  };
  return Response.json(payload, { status: database ? 200 : 503 });
}
