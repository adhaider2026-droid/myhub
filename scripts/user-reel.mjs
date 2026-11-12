// توليد ريل مستخدم عبر MCP — المشهد المطلوب من المستخدم
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = process.argv[2] || "http://localhost:3000";

const client = new Client({ name: "user-reel", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
console.log("connected");

const prompt =
  "Scene 1 - The Beginning: Mimo, a cute cheerful little cartoon explorer boy with a red cap, stands in a lush green jungle clearing. " +
  "He looks up in total amazement at a giant glowing GOLDEN banana hanging from a very tall tree, his eyes sparkling with excitement, mouth open in awe, arms raised toward it. " +
  "Mimo says: \"Woooow! That's the biggest banana in the world! I'm going to get it!\" " +
  "Bright colorful 3D animation style, cinematic lighting, vertical composition.";

const t0 = Date.now();
const res = await client.callTool({
  name: "generate_video",
  arguments: {
    model: "reels-free",
    prompt,
    scenes: 2,
    seconds_per_scene: 4,
    aspect_ratio: "9:16",
    wait_seconds: 240,
  },
});
console.log(`generate_video took ${Math.round((Date.now() - t0) / 1000)}s`);
const text = (res.content || []).map((c) => c.text || "").join("\n");
console.log(text.slice(0, 800));
const m = text.match(/task_id:\s*([0-9a-f-]+)/);
if (m) {
  console.log("TASK_ID=" + m[1]);
} else {
  console.log("NO TASK — check response above");
}
await client.close();
