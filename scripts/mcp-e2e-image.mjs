// E2E: يتصل بخادم MCP عبر Streamable HTTP ويولّد صورة مجانية (بلا أي مفاتيح)
// الاستخدام: node scripts/mcp-e2e-image.mjs <baseUrl>
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.argv[2] || "http://localhost:3000").replace(/\/+$/, "");
const url = `${base}/mcp`;

const client = new Client({ name: "e2e-tester", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(new URL(url));
await client.connect(transport);
console.log("connected to", url);

const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));

const t0 = Date.now();
const res = await client.callTool({
  name: "generate_image",
  arguments: {
    prompt: "a cute orange cat wearing sunglasses, studio lighting, vertical photo",
    aspect_ratio: "9:16",
    wait_seconds: 200,
  },
});
const secs = Math.round((Date.now() - t0) / 1000);
console.log(`generate_image took ${secs}s`);
const text = (res.content || []).map((c) => c.text || "").join("\n");
console.log(text.slice(0, 1200));
const m = text.match(/https?:\/\/\S+/g);
if (m) {
  const imageUrl = m[m.length - 1];
  const r = await fetch(imageUrl, { method: "GET" });
  console.log("IMAGE CHECK:", r.status, r.headers.get("content-type"), "bytes:", r.headers.get("content-length"));
  if (!r.ok) process.exit(1);
  console.log("E2E IMAGE OK");
} else {
  console.log("NO URL FOUND IN RESPONSE");
  process.exit(2);
}
await client.close();
process.exit(0);
