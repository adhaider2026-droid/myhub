// GET /api/debug — تشخيص مؤقت: فحص الثنائيات ومسار التنزيل وقت التشغيل
import fs from "node:fs";
import { createRequire } from "node:module";
import utilCjs from "../../lib/util.js";
import mergeCjs from "../../lib/merge.js";
import fsp from "node:fs/promises";

export const config = { path: "/api/debug" };

export default async () => {
  const checks = [];
  const require = createRequire(import.meta.url);

  try {
    const m = require("ffprobe-static");
    checks.push({ name: "ffprobe-static", resolved: m?.path, exists: m?.path ? fs.existsSync(m.path) : false });
  } catch (e) {
    checks.push({ name: "ffprobe-static", error: String(e?.message || e).slice(0, 200) });
  }

  try {
    const p = await util.ensureBinary("ffprobe");
    checks.push({ name: "ensureBinary ffprobe", resolved: p, exists: fs.existsSync(p), runnable: fs.accessSync(p, fs.constants.X_OK) === undefined });
  } catch (e) {
    checks.push({ name: "ensureBinary ffprobe", error: String(e?.message || e).slice(0, 300) });
  }

  // اختبار حقيقي لمسار الدمج: probeImage عبر نفس سلسلة الاستيراد التي تستخدمها دالة المعالجة
  try {
    const tmpDir = await fsp.mkdtemp("/tmp/dbg-");
    const buf = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const imgPath = `${tmpDir}/px.png`;
    await fsp.writeFile(imgPath, buf);
    const info = await mergeCjs.probeImage(imgPath);
    checks.push({ name: "mergeCjs.probeImage", ok: true, info });
    await fsp.rm(tmpDir, { recursive: true, force: true });
  } catch (e) {
    checks.push({ name: "mergeCjs.probeImage", error: String(e?.message || e).slice(0, 300) });
  }

  return Response.json({ cwd: process.cwd(), utilKeys: Object.keys(utilCjs || {}).slice(0, 20), checks });
};
