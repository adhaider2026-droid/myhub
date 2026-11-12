// E2E: توليد ريل مجاني بالكامل عبر reels-free (بلا أي مفتاح) — مشاهد قليلة لسرعة الاختبار
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.argv[2] || "http://localhost:3000").replace(/\/+$/, "");
const url = `${base}/mcp`;

const client = new Client({ name: "e2e-reels-tester", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url)));
console.log("connected");

const t0 = Date.now();
const res = await client.callTool({
  name: "generate_video",
  arguments: {
    model: "reels-free",
    prompt: "A cozy coffee shop in the morning, warm light, steam rising from a fresh cup",
    scenes: 2,
    seconds_per_scene: 3,
    aspect_ratio: "9:16",
    wait_seconds: 240,
  },
});
const secs = Math.round((Date.now() - t0) / 1000);
console.log(`generate_video(reels-free) took ${secs}s`);
const text = (res.content || []).map((c) => c.text || "").join("\n");
console.log(text.slice(0, 1500));
const m = text.match(/https?:\/\/\S+/g);
if (m) {
  const videoUrl = m[m.length - 1];
  const r = await fetch(videoUrl, { method: "GET" });
  console.log("VIDEO CHECK:", r.status, r.headers.get("content-type"), "bytes:", r.headers.get("content-length"));
  console.log(r.ok ? "E2E REELS OK" : "VIDEO FETCH FAILED");
  process.exit(r.ok ? 0 : 1);
} else {
  console.log("NO URL — task likely still processing (acceptable for long renders)");
  process.exit(2);
}
