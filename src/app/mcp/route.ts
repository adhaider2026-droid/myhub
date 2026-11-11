// مسار /mcp — خادم MCP عبر Streamable HTTP.
// نستخدم SDK الرسمي: McpServer + WebStandardStreamableHTTPServerTransport (بيئة Web Standard مباشرة،
// وهي نفسها المستخدمة في Cloudflare Workers/Deno — لا جسر Node يدوي ولا JSON-RPC يدويًا).
// الوضع stateless (sessionIdGenerator: undefined) لضمان التوافق الكامل مع Vercel serverless:
// كل طلب مستقل بنقل جديد — لا جلسات في الذاكرة تفقد عبر المثيلات.

import { NextRequest } from "next/server";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createMcpServer } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// نافذة الانتظار قد تمتد حتى 240 ثانية — الدالة تحتاج عمرًا كافيًا (الحد الأعلى حسب خطة Vercel)
export const maxDuration = 300;

const TOOL_NAMES = new Set(["generate_image", "generate_video", "merge_videos", "get_task", "list_media"]);

function withCors(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function jsonRpcError(status: number, code: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function handle(req: NextRequest): Promise<Response> {
  // حماية اختيارية: إذا ضُبط MCP_ACCESS_TOKEN يُطلب Authorization: Bearer <token>
  const requiredToken = process.env.MCP_ACCESS_TOKEN;
  if (requiredToken) {
    const auth = req.headers.get("authorization") ?? "";
    if (auth !== `Bearer ${requiredToken}`) {
      return jsonRpcError(401, -32001, "Unauthorized: مطلوب ترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>");
    }
  }

  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, mcp-session-id, mcp-protocol-version",
      },
    });
  }

  // وضع stateless: قناة SSE الدائمة عبر GET غير مجدية (لا حالة مشتركة بين الطلبات) — نرفضها 405
  if (req.method === "GET") {
    return jsonRpcError(405, -32000, "Method Not Allowed: استخدم POST لرسائل JSON-RPC (وضع stateless)");
  }
  // إنهاء الجلسة — لا جلسات في الوضع stateless: قبول صامت
  if (req.method === "DELETE") {
    return new Response(null, { status: 200 });
  }
  if (req.method !== "POST") {
    return jsonRpcError(405, -32000, "Method Not Allowed");
  }

  // نحلل الجسم مسبقًا لأمرين: (1) رد عربي فوري على الأدوات المجهولة وفق المواصفة،
  // (2) تمرير parsedBody للنقل حتى لا يعيد قراءة الجسم.
  let parsed: unknown;
  try {
    const raw = await req.text();
    parsed = JSON.parse(raw);
  } catch {
    return jsonRpcError(400, -32700, "Parse error: Invalid JSON");
  }

  // أداة مجهولة → رد عربي واضح قبل أي شيء آخر
  if (
    parsed &&
    typeof parsed === "object" &&
    !Array.isArray(parsed) &&
    (parsed as { method?: string }).method === "tools/call"
  ) {
    const params = (parsed as { params?: { name?: string; arguments?: unknown } }).params;
    const name = params?.name;
    if (typeof name === "string" && !TOOL_NAMES.has(name)) {
      const id = (parsed as { id?: unknown }).id ?? null;
      const body = {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            {
              type: "text",
              text: `❌ أداة غير معروفة: ${name}. المتاح: ${[...TOOL_NAMES].join("، ")}`,
            },
          ],
          isError: true,
        },
      };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  }

  // نقل جديد لكل طلب (إلزامي في الوضع stateless) + خادم جديد مربوط به
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — متوافق مع serverless عبر المثيلات
  });
  const server = createMcpServer();
  await server.connect(transport);

  try {
    const response = await transport.handleRequest(req, { parsedBody: parsed });
    return withCors(response);
  } catch (e) {
    return jsonRpcError(400, -32700, `Parse error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export { handle as POST, handle as GET, handle as DELETE, handle as OPTIONS };
