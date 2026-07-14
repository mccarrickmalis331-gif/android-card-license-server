const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = __dirname;
const TOOLS = path.join(ROOT, "tools");
const WORK = path.join(ROOT, "work");
const OUT = path.join(ROOT, "out");
const DATA = path.join(ROOT, "data");
const CARDS_FILE = path.join(DATA, "cards.json");
const PORT = Number(process.env.PORT || 8789);
const DEFAULT_SERVER = process.env.DEFAULT_LICENSE_SERVER || "https://android-license-gateway-phone.pages.dev";
const PUBLIC_URL = (process.env.PUBLIC_URL || "").replace(/\/+$/, "");
const APKTOOL_VERSION = "3.0.2";
const APKTOOL_URL = `https://github.com/iBotPeaches/Apktool/releases/download/v${APKTOOL_VERSION}/apktool_${APKTOOL_VERSION}.jar`;
const LICENSE_DEFAULTS = {
  ADMIN_TOKEN: process.env.ADMIN_TOKEN || "change_this_admin_token",
  APP_ID: process.env.APP_ID || "demo_android_app",
  APP_SECRET: process.env.APP_SECRET || "change_this_app_secret",
  RC4_KEY: process.env.RC4_KEY || "change_this_rc4_key",
  TIMESTAMP_WINDOW_SECONDS: Number(process.env.TIMESTAMP_WINDOW_SECONDS || 300),
  HEARTBEAT_GRACE_SECONDS: Number(process.env.HEARTBEAT_GRACE_SECONDS || 180)
};
const JOBS = new Map();
const JOB_QUEUE = [];
const JOB_TTL_MS = 6 * 60 * 60 * 1000;
let jobRunnerActive = false;

for (const dir of [TOOLS, WORK, OUT, DATA]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(CARDS_FILE)) fs.writeFileSync(CARDS_FILE, "[]", "utf8");

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, corsHeaders());
      return res.end();
    }
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/health") return json(res, { ok: true, service: "apk-license-packer" });
    if (req.method === "GET" && url.pathname.startsWith("/out/")) return file(res, path.join(OUT, decodeURIComponent(url.pathname.slice(5))));
    if (req.method === "GET" && url.pathname === "/api/status") return json(res, { ok: true, tools: await detectTools(), accessUrls: accessUrls() });
    if (req.method === "GET" && url.pathname.startsWith("/api/jobs/")) return jobStatus(res, decodeURIComponent(url.pathname.slice("/api/jobs/".length)));
    if (req.method === "POST" && url.pathname === "/api/process") return await processUpload(req, res, url);
    if (req.method === "GET" && url.pathname === "/admin/cards") return adminJson(req, res, () => ({ ok: true, cards: listCards() }));
    if (req.method === "POST" && url.pathname === "/admin/cards") return adminJson(req, res, async () => createCards(await readJsonBody(req)));
    if (req.method === "DELETE" && url.pathname === "/admin/cards") return adminJson(req, res, () => deleteAllCards());
    if (url.pathname.startsWith("/admin/cards/")) return adminJson(req, res, async () => updateCard(url.pathname.slice("/admin/cards/".length), req.method, await readJsonBody(req).catch(() => ({}))));
    if (req.method === "POST" && url.pathname === "/api/activate") return licenseApi(req, res, activateCard);
    if (req.method === "POST" && url.pathname === "/api/heartbeat") return licenseApi(req, res, heartbeatCard);
    return json(res, { ok: false, message: "not found" }, 404);
  } catch (error) {
    return json(res, { ok: false, message: error.message || String(error) }, 500);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`APK drag dashboard listening on 0.0.0.0:${PORT}`);
});

const jobCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of JOBS) {
    if (job.updatedAt < cutoff && (job.status === "done" || job.status === "failed")) JOBS.delete(id);
  }
}, 60 * 1000);
jobCleanupTimer.unref?.();

async function processUpload(req, res, url) {
  const originalName = safeName(url.searchParams.get("fileName") || "input.apk");
  const serverUrl = normalizeUrl(url.searchParams.get("serverUrl") || DEFAULT_SERVER);
  const appId = url.searchParams.get("appId") || "demo_android_app";
  const appSecret = url.searchParams.get("appSecret") || "change_this_app_secret";
  const rc4Key = url.searchParams.get("rc4Key") || "change_this_rc4_key";
  const cardName = normalizeCardName(url.searchParams.get("cardName") || "默认软件");
  const purchaseUrl = normalizeOptionalUrl(url.searchParams.get("purchaseUrl") || "");
  const jumpText = normalizeOptionalText(url.searchParams.get("jumpText") || "");
  const jumpUrl = normalizeOptionalUrl(url.searchParams.get("jumpUrl") || "");
  const obfuscate = url.searchParams.get("obfuscate") !== "0";
  const useVmp = url.searchParams.get("vmp") === "1";
  const id = new Date().toISOString().replace(/[-:.TZ]/g, "") + "-" + crypto.randomBytes(3).toString("hex");
  const jobDir = path.join(WORK, id);
  const decodedDir = path.join(jobDir, "decoded");
  const javaDir = path.join(jobDir, "java");
  const classesDir = path.join(jobDir, "classes");
  const dexDir = path.join(jobDir, "dex");
  fs.mkdirSync(jobDir, { recursive: true });

  const inputApk = path.join(jobDir, originalName);
  await saveBody(req, inputApk);

  const now = Date.now();
  const job = {
    id,
    status: "queued",
    progress: "APK 已上传，正在等待云端处理",
    createdAt: now,
    updatedAt: now,
    config: { originalName, serverUrl, appId, appSecret, rc4Key, cardName, purchaseUrl, jumpText, jumpUrl, obfuscate, useVmp },
    paths: { jobDir, decodedDir, javaDir, classesDir, dexDir, inputApk }
  };
  JOBS.set(id, job);
  JOB_QUEUE.push(job);
  void runJobQueue();

  return json(res, {
    ok: true,
    queued: true,
    jobId: id,
    status: job.status,
    progress: job.progress,
    statusUrl: `/api/jobs/${encodeURIComponent(id)}`
  }, 202);
}

function jobStatus(res, id) {
  const job = JOBS.get(id);
  if (!job) return json(res, { ok: false, message: "任务不存在或已过期" }, 404);
  return json(res, publicJob(job));
}

function publicJob(job) {
  const payload = {
    ok: job.status !== "failed",
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
  if (job.status === "done") payload.result = job.result;
  if (job.status === "failed") payload.message = job.message || "APK 处理失败";
  return payload;
}

function updateJob(job, progress) {
  job.progress = progress;
  job.updatedAt = Date.now();
}

async function runJobQueue() {
  if (jobRunnerActive) return;
  jobRunnerActive = true;
  try {
    while (JOB_QUEUE.length) {
      const job = JOB_QUEUE.shift();
      job.status = "processing";
      job.startedAt = Date.now();
      updateJob(job, "正在准备 Android 构建工具");
      try {
        job.result = await buildApk(job);
        job.status = "done";
        job.finishedAt = Date.now();
        updateJob(job, "处理完成，可以下载 APK");
      } catch (error) {
        job.status = "failed";
        job.finishedAt = Date.now();
        job.message = error && error.message ? error.message : String(error);
        updateJob(job, "处理失败");
        console.error(`APK job ${job.id} failed:`, error);
      } finally {
        try { fs.rmSync(job.paths.jobDir, { recursive: true, force: true }); } catch (_) {}
      }
    }
  } finally {
    jobRunnerActive = false;
  }
}

async function buildApk(job) {
  const { id } = job;
  const { originalName, serverUrl, appId, appSecret, rc4Key, cardName, purchaseUrl, jumpText, jumpUrl, obfuscate, useVmp } = job.config;
  const { jobDir, decodedDir, javaDir, classesDir, dexDir, inputApk } = job.paths;

  const tools = await detectTools();
  if (!tools.java || !tools.javac || !tools.d8 || !tools.zipalign || !tools.apksigner || !tools.androidJar) {
    throw new Error("缺少 Java 或 Android SDK 工具，请先安装 Android Studio/SDK。");
  }
  const apktool = await ensureApktool();

  updateJob(job, "正在解析原 APK");
  await run(tools.java, ["-jar", apktool, "d", "-f", inputApk, "-o", decodedDir], jobDir);
  const manifestPath = path.join(decodedDir, "AndroidManifest.xml");
  let manifest = fs.readFileSync(manifestPath, "utf8");
  const packageName = readPackageName(manifest);
  const launcher = readLauncherActivity(manifest, packageName);
  manifest = removeLauncherFilters(manifest);
  manifest = addInternetPermission(manifest);
  manifest = addLicenseActivity(manifest);
  fs.writeFileSync(manifestPath, manifest, "utf8");

  updateJob(job, "正在重建原 APK 并计算完整性校验");
  const unsignedApk = path.join(jobDir, "unsigned.apk");
  await run(tools.java, ["-jar", apktool, "b", decodedDir, "-o", unsignedApk], jobDir);
  const dexHashes = useVmp ? await originalDexHashes(unsignedApk, jobDir) : [];

  writeJavaSources(javaDir, packageName, launcher, serverUrl, appId, appSecret, rc4Key, cardName, purchaseUrl, jumpText, jumpUrl, useVmp, dexHashes);
  updateJob(job, "正在编译验证窗口、心跳和安全传输模块");
  fs.mkdirSync(classesDir, { recursive: true });
  const javaFiles = listFiles(javaDir).filter((f) => f.endsWith(".java"));
  await run(tools.javac, ["-encoding", "UTF-8", "-source", "8", "-target", "8", "-bootclasspath", tools.androidJar, "-d", classesDir, ...javaFiles], jobDir);
  fs.mkdirSync(dexDir, { recursive: true });
  let obfuscationMessage = "验证模块未混淆";
  if (obfuscate && tools.r8 && tools.jar) {
    updateJob(job, "正在执行 R8 混淆和 VMP+ 保护");
    const classesJar = path.join(jobDir, "license-classes.jar");
    const rules = path.join(jobDir, "r8-rules.pro");
    fs.writeFileSync(rules, [
      `-keep public class ${packageName}.LicenseActivity { public <init>(); public void onCreate(android.os.Bundle); }`,
      "-keepattributes *Annotation*,Signature,InnerClasses,EnclosingMethod",
      "-dontwarn **"
    ].join("\n"), "utf8");
    await run(tools.jar, ["cf", classesJar, "-C", classesDir, "."], jobDir);
    await run(tools.java, ["-cp", tools.r8, "com.android.tools.r8.R8", "--release", "--min-api", "23", "--lib", tools.androidJar, "--pg-conf", rules, "--output", dexDir, classesJar], jobDir);
    obfuscationMessage = "验证模块已使用 R8 混淆";
  } else {
    await run(tools.d8, ["--min-api", "23", "--output", dexDir, ...listFiles(classesDir).filter((f) => f.endsWith(".class"))], jobDir);
    if (obfuscate) obfuscationMessage = "未找到 R8，验证框已注入但未混淆";
  }

  const withDexApk = path.join(jobDir, "with-license.apk");
  fs.copyFileSync(unsignedApk, withDexApk);
  await addDex(withDexApk, path.join(dexDir, "classes.dex"));

  const alignedApk = path.join(jobDir, "aligned.apk");
  updateJob(job, "正在对齐并重新签名 APK");
  await run(tools.zipalign, ["-f", "-p", "4", withDexApk, alignedApk], jobDir);
  const keystore = await ensureKeystore(tools);
  const signedName = originalName.replace(/\.apk$/i, "") + `-${id.slice(-6)}` + (useVmp ? "-license-vmp-plus.apk" : "-license.apk");
  const signedApk = path.join(OUT, signedName);
  await run(tools.apksigner, [
    "sign",
    "--ks", keystore,
    "--ks-pass", "pass:android",
    "--key-pass", "pass:android",
    "--ks-key-alias", "androiddebugkey",
    "--out", signedApk,
    alignedApk
  ], jobDir);

  const finalName = signedName;
  const vmpMessage = useVmp
    ? `已启用内置 VMP+：配置字符串加密、验证结果虚拟机、反调试、${dexHashes.length} 个原始 DEX 完整性校验`
    : "未启用 VMP+ 保护";

  return {
    ok: true,
    file: `/out/${encodeURIComponent(finalName)}`,
    fileName: finalName,
    packageName,
    launcher,
    serverUrl,
    cardName,
    purchaseUrl,
    jumpText,
    jumpUrl,
    obfuscationMessage,
    vmpMessage
  };
}

function loadCards() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CARDS_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return [];
  }
}

function saveCards(cards) {
  fs.writeFileSync(CARDS_FILE, JSON.stringify(cards, null, 2), "utf8");
}

function publicCard(card) {
  const now = nowSeconds();
  return {
    cardKey: card.cardKey,
    cardName: normalizeCardName(card.cardName),
    status: card.status,
    durationSeconds: card.durationSeconds,
    deviceId: card.deviceId || null,
    createdAt: card.createdAt,
    activatedAt: card.activatedAt || null,
    expiresAt: card.expiresAt || null,
    remainingSeconds: card.expiresAt ? Math.max(0, card.expiresAt - now) : null,
    lastHeartbeatAt: card.lastHeartbeatAt || null,
    appVersion: card.appVersion || "",
    note: card.note || ""
  };
}

function listCards() {
  return loadCards()
    .map((card) => {
      if (card.status === "active" && card.expiresAt && card.expiresAt <= nowSeconds()) card.status = "expired";
      return publicCard(card);
    })
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function createCards(body) {
  const cards = loadCards();
  const count = Math.max(1, Math.min(200, Math.floor(Number(body.count || 1))));
  const durationSeconds = durationToSeconds(body);
  const cardName = normalizeCardName(body.cardName);
  const created = [];
  for (let i = 0; i < count; i += 1) {
    let cardKey = makeCardKey();
    while (cards.some((card) => card.cardKey === cardKey)) cardKey = makeCardKey();
    const card = {
      cardKey,
      cardName,
      status: "unused",
      durationSeconds,
      deviceId: null,
      createdAt: nowSeconds(),
      activatedAt: null,
      expiresAt: null,
      lastHeartbeatAt: null,
      appVersion: "",
      note: String(body.note || "")
    };
    cards.push(card);
    created.push(publicCard(card));
  }
  saveCards(cards);
  return { ok: true, cards: created };
}

function updateCard(cardKeyRaw, method, body) {
  const cardKey = decodeURIComponent(cardKeyRaw || "").trim().toUpperCase();
  const cards = loadCards();
  const index = cards.findIndex((card) => card.cardKey === cardKey);
  if (index < 0) return { ok: false, message: "card not found" };
  if (method === "DELETE") {
    cards.splice(index, 1);
    saveCards(cards);
    return { ok: true };
  }
  if (method !== "PATCH") return { ok: false, message: "method not allowed" };
  const card = cards[index];
  const action = String(body.action || "");
  if (action === "disable") card.status = "disabled";
  if (action === "enable") card.status = card.activatedAt ? "active" : "unused";
  if (action === "reset") {
    card.status = "unused";
    card.deviceId = null;
    card.activatedAt = null;
    card.expiresAt = null;
    card.lastHeartbeatAt = null;
    card.appVersion = "";
  }
  cards[index] = card;
  saveCards(cards);
  return { ok: true, card: publicCard(card) };
}

function deleteAllCards() {
  const deleted = loadCards().length;
  saveCards([]);
  return { ok: true, deleted };
}

function activateCard(payload) {
  const cardKey = String(payload.cardKey || "").trim().toUpperCase();
  const requestCardName = normalizeCardName(payload.cardName);
  const deviceId = String(payload.deviceId || "").trim();
  if (!cardKey || !deviceId) return { ok: false, code: 1101, message: "cardKey and deviceId are required" };
  const cards = loadCards();
  const card = cards.find((item) => item.cardKey === cardKey);
  if (!card) return { ok: false, code: 2001, message: "card not found" };
  const actualCardName = normalizeCardName(card.cardName);
  if (actualCardName !== requestCardName) return { ok: false, code: 2010, message: "card name mismatch" };
  if (card.status === "disabled") return { ok: false, code: 2005, message: "card disabled" };
  if (card.status === "expired" || (card.expiresAt && card.expiresAt <= nowSeconds())) {
    card.status = "expired";
    saveCards(cards);
    return { ok: false, code: 2004, message: "card expired" };
  }
  if (card.status === "active" && card.deviceId !== deviceId) return { ok: false, code: 2003, message: "device mismatch" };
  if (card.status === "unused") {
    card.status = "active";
    card.deviceId = deviceId;
    card.activatedAt = nowSeconds();
    card.expiresAt = card.activatedAt + card.durationSeconds;
  }
  card.lastHeartbeatAt = nowSeconds();
  card.appVersion = String(payload.appVersion || "");
  card.cardName = actualCardName;
  saveCards(cards);
  return { ok: true, code: 0, message: "activate ok", ...publicCard(card) };
}

function heartbeatCard(payload) {
  const cardKey = String(payload.cardKey || "").trim().toUpperCase();
  const requestCardName = normalizeCardName(payload.cardName);
  const deviceId = String(payload.deviceId || "").trim();
  const cards = loadCards();
  const card = cards.find((item) => item.cardKey === cardKey);
  if (!card) return { ok: false, code: 2001, message: "card not found" };
  const actualCardName = normalizeCardName(card.cardName);
  if (actualCardName !== requestCardName) return { ok: false, code: 2010, message: "card name mismatch" };
  if (card.status !== "active") return { ok: false, code: 2002, message: `card is ${card.status}` };
  if (card.deviceId !== deviceId) return { ok: false, code: 2003, message: "device mismatch" };
  if (card.expiresAt <= nowSeconds()) {
    card.status = "expired";
    saveCards(cards);
    return { ok: false, code: 2004, message: "card expired" };
  }
  card.lastHeartbeatAt = nowSeconds();
  card.appVersion = String(payload.appVersion || "");
  card.cardName = actualCardName;
  saveCards(cards);
  return { ok: true, code: 0, message: "heartbeat ok", ...publicCard(card), nextHeartbeatSeconds: LICENSE_DEFAULTS.HEARTBEAT_GRACE_SECONDS };
}

async function licenseApi(req, res, handler) {
  try {
    const envelope = await readJsonBody(req);
    const payload = openEnvelope(envelope);
    return json(res, makeEnvelope(handler(payload)));
  } catch (error) {
    return json(res, makeEnvelope({ ok: false, code: error.code || 1000, message: error.message || "bad request" }), 400);
  }
}

async function adminJson(req, res, fn) {
  if ((req.headers["x-admin-token"] || "") !== LICENSE_DEFAULTS.ADMIN_TOKEN) return json(res, { ok: false, message: "admin token invalid" }, 401);
  try {
    const result = await fn();
    return json(res, result);
  } catch (error) {
    return json(res, { ok: false, message: error.message || String(error) }, 500);
  }
}

function openEnvelope(envelope) {
  const appId = String(envelope.appId || "");
  const ts = Number(envelope.ts || 0);
  const nonce = String(envelope.nonce || "");
  const data = String(envelope.data || "");
  const sign = String(envelope.sign || "").toLowerCase();
  if (appId !== LICENSE_DEFAULTS.APP_ID) throw Object.assign(new Error("app id invalid"), { code: 1001 });
  if (!ts || Math.abs(nowSeconds() - ts) > LICENSE_DEFAULTS.TIMESTAMP_WINDOW_SECONDS) throw Object.assign(new Error("timestamp expired"), { code: 1002 });
  if (md5(appId + ts + nonce + data + LICENSE_DEFAULTS.APP_SECRET) !== sign) throw Object.assign(new Error("signature invalid"), { code: 1003 });
  const payload = JSON.parse(rc4(Buffer.from(data, "hex"), LICENSE_DEFAULTS.RC4_KEY).toString("utf8"));
  if (Number(payload.ts) !== ts) throw Object.assign(new Error("payload timestamp mismatch"), { code: 1004 });
  return payload;
}

function makeEnvelope(payload) {
  const ts = nowSeconds();
  const nonce = crypto.randomBytes(16).toString("hex");
  payload.ts = ts;
  const data = rc4(Buffer.from(JSON.stringify(payload), "utf8"), LICENSE_DEFAULTS.RC4_KEY).toString("hex");
  const sign = md5(LICENSE_DEFAULTS.APP_ID + ts + nonce + data + LICENSE_DEFAULTS.APP_SECRET);
  return { appId: LICENSE_DEFAULTS.APP_ID, ts, nonce, data, sign };
}

function md5(text) {
  return crypto.createHash("md5").update(text, "utf8").digest("hex");
}

function rc4(input, keyText) {
  const key = Buffer.from(String(keyText), "utf8");
  const s = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(input.length);
  let i = 0;
  j = 0;
  for (let n = 0; n < input.length; n += 1) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = input[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

async function readJsonBody(req) {
  const file = path.join(os.tmpdir(), `body-${Date.now()}-${crypto.randomBytes(3).toString("hex")}.json`);
  await saveBody(req, file);
  const text = fs.readFileSync(file, "utf8");
  fs.unlink(file, () => {});
  return text ? JSON.parse(text) : {};
}

async function detectTools() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), "AppData", "Local", "Android", "Sdk");
  const javaHome = process.env.JAVA_HOME || (fs.existsSync("D:\\android\\jbr") ? "D:\\android\\jbr" : "");
  const buildTools = newestDir(path.join(sdk, "build-tools"));
  const platform = newestDir(path.join(sdk, "platforms"));
  return {
    sdk,
    java: firstExisting([path.join(javaHome, "bin", "java.exe"), path.join(javaHome, "bin", "java"), "java"]),
    javac: firstExisting([path.join(javaHome, "bin", "javac.exe"), path.join(javaHome, "bin", "javac"), "javac"]),
    keytool: firstExisting([path.join(javaHome, "bin", "keytool.exe"), path.join(javaHome, "bin", "keytool"), "keytool"]),
    jar: firstExisting([path.join(javaHome, "bin", "jar.exe"), path.join(javaHome, "bin", "jar"), "jar"]),
    d8: firstExisting([path.join(buildTools || "", "d8.bat"), path.join(buildTools || "", "d8")]),
    r8: firstExisting([path.join(buildTools || "", "lib", "d8.jar")]),
    zipalign: firstExisting([path.join(buildTools || "", "zipalign.exe"), path.join(buildTools || "", "zipalign")]),
    apksigner: firstExisting([path.join(buildTools || "", "apksigner.bat"), path.join(buildTools || "", "apksigner")]),
    androidJar: platform ? path.join(platform, "android.jar") : "",
    apktool: fs.existsSync(path.join(TOOLS, `apktool_${APKTOOL_VERSION}.jar`)) ? path.join(TOOLS, `apktool_${APKTOOL_VERSION}.jar`) : "",
    vmp: "builtin-vmp-plus"
  };
}

async function ensureApktool() {
  const jar = path.join(TOOLS, `apktool_${APKTOOL_VERSION}.jar`);
  if (fs.existsSync(jar)) return jar;
  const response = await fetch(APKTOOL_URL);
  if (!response.ok) throw new Error(`下载 apktool 失败：${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(jar, buffer);
  return jar;
}

async function ensureKeystore(tools) {
  const keystore = path.join(TOOLS, "debug.keystore");
  if (fs.existsSync(keystore)) return keystore;
  await run(tools.keytool, [
    "-genkeypair",
    "-v",
    "-keystore", keystore,
    "-storepass", "android",
    "-alias", "androiddebugkey",
    "-keypass", "android",
    "-keyalg", "RSA",
    "-keysize", "2048",
    "-validity", "10000",
    "-dname", "CN=Android Debug,O=Android,C=US"
  ], ROOT);
  return keystore;
}

function readPackageName(manifest) {
  const match = manifest.match(/<manifest[\s\S]*?\spackage="([^"]+)"/);
  if (!match) throw new Error("无法读取 APK 包名");
  return match[1];
}

function readLauncherActivity(manifest, packageName) {
  const activityRegex = /<activity\b[\s\S]*?<\/activity>/g;
  let match;
  while ((match = activityRegex.exec(manifest))) {
    const block = match[0];
    if (block.includes("android.intent.action.MAIN") && block.includes("android.intent.category.LAUNCHER")) {
      const name = (block.match(/android:name="([^"]+)"/) || [])[1];
      if (!name) break;
      return normalizeActivityName(name, packageName);
    }
  }
  throw new Error("没有找到原 APP 启动 Activity");
}

function removeLauncherFilters(manifest) {
  return manifest.replace(/<intent-filter>[\s\S]*?android\.intent\.action\.MAIN[\s\S]*?android\.intent\.category\.LAUNCHER[\s\S]*?<\/intent-filter>/g, "");
}

function addInternetPermission(manifest) {
  if (manifest.includes('android.permission.INTERNET')) return manifest;
  return manifest.replace(/<application\b/, '    <uses-permission android:name="android.permission.INTERNET" />\n\n    <application');
}

function addLicenseActivity(manifest) {
  const activity = `
        <activity android:name=".LicenseActivity" android:theme="@android:style/Theme.Material.NoActionBar" android:screenOrientation="portrait" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
`;
  return manifest.replace(/<\/application>/, `${activity}    </application>`);
}

function normalizeActivityName(name, packageName) {
  if (name.startsWith(".")) return packageName + name;
  if (!name.includes(".")) return packageName + "." + name;
  return name;
}

function normalizeOptionalUrl(value) {
  let u = (value || "").trim();
  if (!u) return "";
  if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://" + u;
  return u;
}

function normalizeOptionalText(value) {
  return (value || "").trim().replace(/\s+/g, " ").slice(0, 32);
}

function normalizeCardName(value) {
  return (value || "默认软件").trim().replace(/\s+/g, " ").slice(0, 48) || "默认软件";
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function makeCardKey() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let raw = "";
  for (let i = 0; i < 16; i += 1) raw += alphabet[crypto.randomInt(alphabet.length)];
  return raw.replace(/(.{4})/g, "$1-").replace(/-$/, "");
}

function durationToSeconds(body) {
  if (Number.isFinite(Number(body.durationSeconds)) && Number(body.durationSeconds) > 0) {
    return Math.floor(Number(body.durationSeconds));
  }
  const amount = Math.max(1, Math.floor(Number(body.duration || 1)));
  const unit = String(body.unit || "day");
  const map = { minute: 60, hour: 3600, day: 86400, month: 2592000, year: 31536000 };
  return amount * (map[unit] || map.day);
}

function writeJavaSources(root, packageName, launcher, serverUrl, appId, appSecret, rc4Key, cardName, purchaseUrl, jumpText, jumpUrl, useVmp, dexHashes) {
  const dir = path.join(root, ...packageName.split("."));
  fs.mkdirSync(dir, { recursive: true });
  const pkg = `package ${packageName};`;
  const stringKey = (crypto.randomBytes(1)[0] || 91) & 255;
  const vmKey = (crypto.randomBytes(1)[0] || 167) & 255;
  const encoded = (value, key = stringKey) => {
    const bytes = Buffer.from(String(value), "utf8");
    for (let i = 0; i < bytes.length; i++) bytes[i] ^= key;
    return bytes.toString("base64");
  };
  const configString = (name, value) => useVmp
    ? `  static final String ${name} = VmpRuntime.s("${encoded(value)}", ${stringKey});`
    : `  static final String ${name} = "${javaString(value)}";`;
  const vmProgram = encoded(Buffer.from([17, 18, 33, 19, 33, 127]).toString("latin1"), vmKey);
  const dexNames = (dexHashes || []).map((item) => `"${javaString(item.name)}"`).join(",");
  const dexValues = (dexHashes || []).map((item) => `"${item.sha256}"`).join(",");
  fs.writeFileSync(path.join(dir, "LicenseResult.java"), `${pkg}
final class LicenseResult {
  final boolean ok; final int code; final String message; final long expiresAt; final long remainingSeconds; final long nextHeartbeatSeconds;
  LicenseResult(boolean ok, int code, String message, long expiresAt, long remainingSeconds, long nextHeartbeatSeconds) {
    this.ok = ok; this.code = code; this.message = message; this.expiresAt = expiresAt; this.remainingSeconds = remainingSeconds; this.nextHeartbeatSeconds = nextHeartbeatSeconds;
  }
}
`, "utf8");
  fs.writeFileSync(path.join(dir, "LicenseConfig.java"), `${pkg}
import android.content.Context; import android.content.SharedPreferences; import java.util.*;
final class LicenseConfig {
${configString("DEFAULT_BASE_URL", serverUrl)}
${configString("APP_ID", appId)}
${configString("APP_SECRET", appSecret)}
${configString("RC4_KEY", rc4Key)}
${configString("CARD_NAME", cardName)}
${configString("PURCHASE_URL", purchaseUrl)}
${configString("JUMP_TEXT", jumpText)}
${configString("JUMP_URL", jumpUrl)}
  static final String APP_VERSION = "1.0";
  private static final String PREFS = "license_config"; private static final String KEY_BASE_URL = "base_url";
  static String getBaseUrl(Context c){ return normalize(c.getSharedPreferences(PREFS,0).getString(KEY_BASE_URL, DEFAULT_BASE_URL)); }
  static void saveBaseUrl(Context c, String v){ c.getSharedPreferences(PREFS,0).edit().putString(KEY_BASE_URL, normalize(v)).apply(); }
  static List<String> getBaseUrls(Context c){ ArrayList<String> u = new ArrayList<>(); add(u, getBaseUrl(c)); add(u, DEFAULT_BASE_URL); return u; }
  private static void add(ArrayList<String> u, String v){ if(v.length()>0 && !u.contains(v)) u.add(v); }
  private static String normalize(String v){ String u = v == null ? "" : v.trim(); if(u.length()==0) u = DEFAULT_BASE_URL; if(!u.startsWith("http://") && !u.startsWith("https://")) u = "https://" + u; while(u.endsWith("/")) u = u.substring(0,u.length()-1); return u; }
}
`, "utf8");
  if (useVmp) {
    fs.writeFileSync(path.join(dir, "VmpRuntime.java"), `${pkg}
import android.content.*; import android.os.Debug; import android.util.Base64; import java.io.*; import java.security.*; import java.util.*; import java.util.zip.*;
final class VmpRuntime {
  private static final String VM = "${vmProgram}"; private static final int VM_KEY = ${vmKey};
  private static final String[] DEX_NAMES = new String[]{${dexNames}};
  private static final String[] DEX_HASHES = new String[]{${dexValues}};
  private static volatile int integrityState;
  static String s(String value, int key){ return new String(bytes(value,key), java.nio.charset.StandardCharsets.UTF_8); }
  private static byte[] bytes(String value,int key){ byte[] data=Base64.decode(value,Base64.DEFAULT); for(int i=0;i<data.length;i++)data[i]=(byte)(data[i]^key); return data; }
  static boolean check(Context context){
    if(Debug.isDebuggerConnected()||Debug.waitingForDebugger()||traced())return false;
    if(integrityState==0){ synchronized(VmpRuntime.class){ if(integrityState==0)integrityState=verifyDex(context)?1:-1; } }
    return integrityState==1;
  }
  private static boolean traced(){ try{ BufferedReader r=new BufferedReader(new FileReader("/proc/self/status")); String line; while((line=r.readLine())!=null){ if(line.startsWith("TracerPid:")){ r.close(); return Integer.parseInt(line.substring(10).trim())!=0; } } r.close(); }catch(Exception ignored){} return false; }
  private static boolean verifyDex(Context context){
    if(DEX_NAMES.length==0)return true;
    try{ ZipFile zip=new ZipFile(context.getApplicationInfo().sourceDir); for(int i=0;i<DEX_NAMES.length;i++){ ZipEntry e=zip.getEntry(DEX_NAMES[i]); if(e==null){zip.close();return false;} InputStream in=zip.getInputStream(e); String actual=sha256(in); in.close(); if(!DEX_HASHES[i].equalsIgnoreCase(actual)){zip.close();return false;} } zip.close(); return true; }catch(Exception e){return false;}
  }
  private static String sha256(InputStream in)throws Exception{ MessageDigest md=MessageDigest.getInstance("SHA-256"); byte[] buf=new byte[8192]; int n; while((n=in.read(buf))>0)md.update(buf,0,n); StringBuilder out=new StringBuilder(); for(byte b:md.digest())out.append(String.format(Locale.US,"%02x",b&255)); return out.toString(); }
  static boolean accept(boolean ok,int code,long expiresAt){
    byte[] program=bytes(VM,VM_KEY); long[] stack=new long[8]; int sp=0;
    for(int pc=0;pc<program.length;pc++){ switch(program[pc]&255){
      case 17: stack[sp++]=ok?1:0; break;
      case 18: stack[sp++]=code==0?1:0; break;
      case 19: stack[sp++]=(expiresAt<=0||expiresAt>System.currentTimeMillis()/1000L)?1:0; break;
      case 33: if(sp<2)return false; stack[sp-2]=(stack[sp-2]!=0&&stack[sp-1]!=0)?1:0; sp--; break;
      case 127: return sp==1&&stack[0]!=0;
      default: return false;
    }} return false;
  }
}
`, "utf8");
  }
  fs.writeFileSync(path.join(dir, "LicenseClient.java"), `${pkg}
import android.content.*; import org.json.*; import java.io.*; import java.net.*; import java.nio.charset.*; import java.security.*; import java.util.*;
final class LicenseClient {
  private final Context context; LicenseClient(Context c){ context = c.getApplicationContext(); }
  LicenseResult activate(String cardKey, String deviceId, String appVersion) throws Exception { JSONObject p = new JSONObject().put("cardKey",cardKey).put("cardName",LicenseConfig.CARD_NAME).put("deviceId",deviceId).put("appVersion",appVersion); return request("/api/activate", p); }
  LicenseResult heartbeat(String cardKey, String deviceId, String appVersion) throws Exception { JSONObject p = new JSONObject().put("cardKey",cardKey).put("cardName",LicenseConfig.CARD_NAME).put("deviceId",deviceId).put("appVersion",appVersion); return request("/api/heartbeat", p); }
  private LicenseResult request(String path, JSONObject payload) throws Exception { ${useVmp ? 'if(!VmpRuntime.check(context))throw new SecurityException("runtime integrity check failed"); ' : ''}JSONObject env = makeEnvelope(payload); Exception last = null; for(String base: LicenseConfig.getBaseUrls(context)){ try { return once(base, path, env); } catch(Exception e){ last = e; } } throw last == null ? new IllegalStateException("network verify failed") : last; }
  private LicenseResult once(String base, String path, JSONObject env) throws Exception { HttpURLConnection c=(HttpURLConnection)new URL(base+path).openConnection(); c.setRequestMethod("POST"); c.setConnectTimeout(20000); c.setReadTimeout(20000); c.setDoOutput(true); c.setRequestProperty("Content-Type","application/json; charset=utf-8"); OutputStream o=c.getOutputStream(); o.write(env.toString().getBytes(StandardCharsets.UTF_8)); o.close(); InputStream in=c.getResponseCode()>=400?c.getErrorStream():c.getInputStream(); JSONObject data = open(new JSONObject(readAll(in))); boolean ok=data.optBoolean("ok",false); int code=data.optInt("code",-1); long expiresAt=data.optLong("expiresAt",0); ${useVmp ? 'ok=VmpRuntime.accept(ok,code,expiresAt); ' : ''}return new LicenseResult(ok, code, data.optString("message",""), expiresAt, data.optLong("remainingSeconds",0), data.optLong("nextHeartbeatSeconds",180)); }
  private JSONObject makeEnvelope(JSONObject p) throws Exception { long ts=System.currentTimeMillis()/1000L; String nonce=UUID.randomUUID().toString().replace("-",""); p.put("ts",ts); String data=hex(rc4(p.toString().getBytes(StandardCharsets.UTF_8), LicenseConfig.RC4_KEY)); String sign=md5(LicenseConfig.APP_ID+ts+nonce+data+LicenseConfig.APP_SECRET); return new JSONObject().put("appId",LicenseConfig.APP_ID).put("ts",ts).put("nonce",nonce).put("data",data).put("sign",sign); }
  private JSONObject open(JSONObject e) throws Exception { String appId=e.optString("appId"), nonce=e.optString("nonce"), data=e.optString("data"), sign=e.optString("sign"); long ts=e.optLong("ts"); if(!LicenseConfig.APP_ID.equals(appId)) throw new IllegalStateException("app id mismatch"); if(Math.abs(System.currentTimeMillis()/1000L-ts)>300) throw new IllegalStateException("server timestamp invalid"); if(!md5(appId+ts+nonce+data+LicenseConfig.APP_SECRET).equalsIgnoreCase(sign)) throw new IllegalStateException("response signature invalid"); JSONObject p=new JSONObject(new String(rc4(fromHex(data), LicenseConfig.RC4_KEY), StandardCharsets.UTF_8)); if(p.optLong("ts")!=ts) throw new IllegalStateException("response timestamp mismatch"); return p; }
  private static String readAll(InputStream in) throws Exception { BufferedReader r=new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8)); StringBuilder b=new StringBuilder(); String l; while((l=r.readLine())!=null)b.append(l); r.close(); return b.toString(); }
  private static String md5(String s) throws Exception { MessageDigest md=MessageDigest.getInstance("MD5"); return hex(md.digest(s.getBytes(StandardCharsets.UTF_8))); }
  private static String hex(byte[] a){ StringBuilder b=new StringBuilder(a.length*2); for(byte x:a)b.append(String.format(Locale.US,"%02x",x&255)); return b.toString(); }
  private static byte[] fromHex(String h){ byte[] o=new byte[h.length()/2]; for(int i=0;i<o.length;i++)o[i]=(byte)Integer.parseInt(h.substring(i*2,i*2+2),16); return o; }
  private static byte[] rc4(byte[] input, String key){ int[] s=new int[256]; byte[] kb=key.getBytes(StandardCharsets.UTF_8); for(int i=0;i<256;i++)s[i]=i; int j=0; for(int i=0;i<256;i++){ j=(j+s[i]+(kb[i%kb.length]&255))&255; int t=s[i];s[i]=s[j];s[j]=t;} byte[] out=new byte[input.length]; int i=0; j=0; for(int n=0;n<input.length;n++){ i=(i+1)&255; j=(j+s[i])&255; int t=s[i];s[i]=s[j];s[j]=t; out[n]=(byte)(input[n]^s[(s[i]+s[j])&255]); } return out; }
}
`, "utf8");
  fs.writeFileSync(path.join(dir, "LicenseActivity.java"), `${pkg}
import android.app.*; import android.os.*; import android.content.*; import android.graphics.Color; import android.graphics.drawable.*; import android.provider.Settings; import android.view.*; import android.widget.*;
public class LicenseActivity extends Activity {
  EditText cardInput; TextView statusText; Button button; boolean loading=false;
  public void onCreate(Bundle b){ super.onCreate(b); ${useVmp ? 'if(!VmpRuntime.check(this)){ finish(); return; } ' : ''}requestWindowFeature(Window.FEATURE_NO_TITLE); getWindow().setBackgroundDrawable(new ColorDrawable(Color.rgb(3,14,24))); if(Build.VERSION.SDK_INT>=21){ getWindow().setStatusBarColor(Color.rgb(14,18,35)); getWindow().setNavigationBarColor(Color.rgb(3,14,24)); } getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE); buildUi(); cardInput.setText(getPreferences(0).getString("card","")); button.setOnClickListener(new View.OnClickListener(){ public void onClick(View v){ activate(); }}); if(cardInput.getText().toString().trim().length()>0) heartbeat(); }
  void buildUi(){ FrameLayout screen=new FrameLayout(this); GradientDrawable bg=new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,new int[]{Color.rgb(14,18,35),Color.rgb(3,14,24)}); screen.setBackground(bg); LinearLayout root=new LinearLayout(this); root.setGravity(Gravity.CENTER); root.setOrientation(LinearLayout.VERTICAL); root.setPadding(dp(22),0,dp(22),0); LinearLayout box=new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); box.setPadding(dp(22),dp(22),dp(22),dp(22)); GradientDrawable panel=new GradientDrawable(); panel.setColor(Color.rgb(22,29,47)); panel.setStroke(dp(1),Color.rgb(49,68,90)); panel.setCornerRadius(dp(10)); box.setBackground(panel); TextView title=t("卡密验证",26,Color.rgb(243,255,249),true); cardInput=input("XXXX-XXXX-XXXX-XXXX",18); button=new Button(this); button.setText("验证并进入"); button.setTextColor(Color.rgb(6,18,15)); button.setTextSize(17); button.setAllCaps(false); GradientDrawable bb=new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,new int[]{Color.rgb(81,231,197),Color.rgb(255,238,97)}); bb.setCornerRadius(dp(10)); button.setBackground(bb); statusText=t("",14,Color.rgb(215,255,245),false); statusText.setVisibility(View.GONE); box.addView(title); add(box,cardInput,24,58); add(box,button,18,60); add(box,statusText,16,-2); int w=getResources().getDisplayMetrics().widthPixels - dp(44); if(w>dp(520)) w=dp(520); if(w<dp(260)) w=dp(260); root.addView(box,new LinearLayout.LayoutParams(w,-2)); screen.addView(root,new FrameLayout.LayoutParams(-1,-1)); addLinks(screen); setContentView(screen,new ViewGroup.LayoutParams(-1,-1)); }
  TextView t(String s,int sp,int c,boolean bold){ TextView v=new TextView(this); v.setText(s); v.setTextSize(sp); v.setTextColor(c); if(bold)v.setTypeface(null,1); return v; }
  EditText input(String h,int sp){ EditText e=new EditText(this); e.setHint(h); e.setSingleLine(true); e.setTextColor(Color.WHITE); e.setHintTextColor(Color.rgb(120,144,156)); e.setTextSize(sp); e.setPadding(dp(14),0,dp(14),0); GradientDrawable d=new GradientDrawable(); d.setColor(Color.rgb(27,40,60)); d.setStroke(dp(1),Color.rgb(48,72,99)); d.setCornerRadius(dp(10)); e.setBackground(d); return e; }
  void add(LinearLayout box, View v, int top, int height){ LinearLayout.LayoutParams lp=new LinearLayout.LayoutParams(-1, height < 0 ? -2 : dp(height)); lp.topMargin=dp(top); box.addView(v,lp); }
  void addLinks(FrameLayout screen){ LinearLayout links=new LinearLayout(this); links.setOrientation(LinearLayout.VERTICAL); links.setGravity(Gravity.RIGHT); int count=0; count+=addLink(links,LicenseConfig.JUMP_TEXT,LicenseConfig.JUMP_URL); count+=addLink(links,"卡密购买地址",LicenseConfig.PURCHASE_URL); if(count==0)return; FrameLayout.LayoutParams lp=new FrameLayout.LayoutParams(-2,-2,Gravity.RIGHT|Gravity.BOTTOM); lp.setMargins(dp(12),0,dp(12),dp(12)); screen.addView(links,lp); }
  int addLink(LinearLayout links,String text,final String url){ if(text==null||text.trim().length()==0||url==null||url.trim().length()==0)return 0; TextView v=t(text,13,Color.rgb(215,255,245),false); v.setPadding(dp(10),dp(6),dp(10),dp(6)); v.setGravity(Gravity.RIGHT); v.setOnClickListener(new View.OnClickListener(){ public void onClick(View view){ try { startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(url))); } catch(Exception e){ toast("无法打开链接"); } }}); links.addView(v,new LinearLayout.LayoutParams(-2,-2)); return 1; }
  int dp(int v){ return (int)(v*getResources().getDisplayMetrics().density+0.5f); }
  void activate(){ if(loading) return; final String card=cardInput.getText().toString().trim(); if(card.length()==0){ setLoading(false,"请输入卡密"); return; } setLoading(true,"验证中..."); new Thread(new Runnable(){ public void run(){ try { LicenseResult r=new LicenseClient(LicenseActivity.this).activate(card, deviceId(), LicenseConfig.APP_VERSION); if(r.ok){ getPreferences(0).edit().putString("card",card.toUpperCase()).apply(); runOnUiThread(new Runnable(){ public void run(){ enterMain(); }}); } else { final String msg=r.message; runOnUiThread(new Runnable(){ public void run(){ setLoading(false,"验证失败：" + msg); }}); } } catch(final Exception e){ runOnUiThread(new Runnable(){ public void run(){ setLoading(false,"验证失败：" + (e.getMessage()==null?"网络验证失败":e.getMessage())); }}); } }}).start(); }
  void heartbeat(){ setLoading(true,"正在验证..."); new Thread(new Runnable(){ public void run(){ try { String card=cardInput.getText().toString().trim(); LicenseResult r=new LicenseClient(LicenseActivity.this).heartbeat(card, deviceId(), LicenseConfig.APP_VERSION); if(r.ok) { runOnUiThread(new Runnable(){ public void run(){ enterMain(); }}); } else { final String msg=r.message; runOnUiThread(new Runnable(){ public void run(){ setLoading(false,"验证失败：" + msg); }}); } } catch(final Exception e){ runOnUiThread(new Runnable(){ public void run(){ setLoading(false,"验证失败：" + (e.getMessage()==null?"心跳验证失败":e.getMessage())); }}); } }}).start(); }
  String deviceId(){ String id=Settings.Secure.getString(getContentResolver(), Settings.Secure.ANDROID_ID); return id==null||id.trim().length()==0?"unknown-device":id; }
  void setLoading(boolean l,String m){ loading=l; cardInput.setEnabled(!l); button.setEnabled(!l); statusText.setText(m == null ? "" : m); statusText.setVisibility(m == null || m.length()==0 ? View.GONE : View.VISIBLE); }
  void toast(String m){ Toast.makeText(this,m,Toast.LENGTH_SHORT).show(); }
  void enterMain(){ try { startActivity(new Intent(this, Class.forName("${javaString(launcher)}"))); finish(); } catch(Exception e){ setLoading(false,"原启动页打开失败：" + e.getMessage()); } }
}
`, "utf8");
}

async function addDex(apk, dexPath) {
  const entries = await zipList(apk);
  let n = 2;
  while (entries.includes(`classes${n}.dex`)) n++;
  const entryName = `classes${n}.dex`;
  const entryDir = path.join(path.dirname(apk), "dex-entry");
  fs.rmSync(entryDir, { recursive: true, force: true });
  fs.mkdirSync(entryDir, { recursive: true });
  fs.copyFileSync(dexPath, path.join(entryDir, entryName));
  try {
    await run(jarCommand(), ["uf", apk, "-C", entryDir, entryName], path.dirname(apk));
  } finally {
    fs.rmSync(entryDir, { recursive: true, force: true });
  }
}

async function zipList(apk) {
  const out = await runCapture(jarCommand(), ["tf", apk], path.dirname(apk));
  return out.split(/\r?\n/).filter(Boolean);
}

async function originalDexHashes(apk, jobDir) {
  const names = (await zipList(apk)).filter((name) => /^classes(?:\d+)?\.dex$/.test(name));
  const extractDir = path.join(jobDir, "vmp-original-dex");
  fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const result = [];
  try {
    for (const name of names) {
      await run(jarCommand(), ["xf", apk, name], extractDir);
      const file = path.join(extractDir, name);
      result.push({ name, sha256: crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") });
    }
    return result;
  } finally {
    fs.rmSync(extractDir, { recursive: true, force: true });
  }
}

function jarCommand() {
  const javaHome = process.env.JAVA_HOME || (fs.existsSync("D:\\android\\jbr") ? "D:\\android\\jbr" : "");
  return firstExisting([path.join(javaHome, "bin", "jar.exe"), path.join(javaHome, "bin", "jar"), "jar"]) || "jar";
}

function newestDir(parent) {
  if (!fs.existsSync(parent)) return "";
  const dirs = fs.readdirSync(parent).filter((d) => fs.statSync(path.join(parent, d)).isDirectory()).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return dirs[0] ? path.join(parent, dirs[0]) : "";
}

function firstExisting(candidates) {
  for (const c of candidates) if (c && (c === "java" || c === "javac" || fs.existsSync(c))) return c;
  return "";
}

function accessUrls() {
  const urls = PUBLIC_URL ? [PUBLIC_URL] : [`http://127.0.0.1:${PORT}`];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) urls.push(`http://${entry.address}:${PORT}`);
    }
  }
  return [...new Set(urls)];
}

function listFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? listFiles(full) : full;
  });
}

function saveBody(req, filePath) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(filePath);
    req.pipe(out);
    req.on("error", reject);
    out.on("finish", resolve);
    out.on("error", reject);
  });
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const useShell = /\.(bat|cmd)$/i.test(command);
    const env = { ...process.env };
    if (!env.JAVA_HOME && fs.existsSync("D:\\android\\jbr")) env.JAVA_HOME = "D:\\android\\jbr";
    const child = spawn(command, args, { cwd, shell: useShell, env });
    let text = "";
    child.stdout.on("data", (d) => text += d.toString());
    child.stderr.on("data", (d) => text += d.toString());
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(text) : reject(new Error(`${path.basename(command)} failed (${code})\n${text.slice(-3000)}`)));
  });
}

async function runCapture(command, args, cwd) {
  return run(command, args, cwd);
}

function normalizeUrl(url) {
  let value = String(url || "").trim();
  if (!value) value = DEFAULT_SERVER;
  if (!/^https?:\/\//i.test(value)) value = "https://" + value;
  return value.replace(/\/+$/, "");
}

function safeName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 120) || "input.apk";
}

function javaString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function ps(value) {
  return String(value).replace(/'/g, "''");
}

function json(res, body, status = 200) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...corsHeaders() });
  res.end(JSON.stringify(body));
}

function html(res, body) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...corsHeaders() });
  res.end(body);
}

function file(res, filePath) {
  if (!filePath.startsWith(OUT) || !fs.existsSync(filePath)) return json(res, { ok: false, message: "file not found" }, 404);
  res.writeHead(200, { "content-type": "application/vnd.android.package-archive", "content-disposition": `attachment; filename="${path.basename(filePath)}"`, ...corsHeaders() });
  fs.createReadStream(filePath).pipe(res);
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "*",
    "access-control-allow-private-network": "true"
  };
}

function page() {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>APK 楠岃瘉妗嗕竴閿伐鍏?/title><style>
body{margin:0;background:#f5f7fb;color:#172033;font-family:Arial,"Microsoft YaHei",sans-serif}.wrap{max-width:980px;margin:auto;padding:24px}.panel{background:white;border:1px solid #dde4ef;border-radius:8px;padding:18px;margin-top:14px}.drop{border:2px dashed #8aa4c4;border-radius:8px;padding:34px;text-align:center;background:#f8fbff}.drop.drag{background:#eaf4ff}input{width:100%;height:38px;border:1px solid #dde4ef;border-radius:6px;padding:8px;box-sizing:border-box}button{height:40px;border:0;border-radius:6px;background:#1769aa;color:white;font-weight:700;padding:0 14px}.muted{color:#667085}.row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.status{white-space:pre-wrap;background:#111827;color:#d7fff5;padding:14px;border-radius:8px;min-height:120px}@media(max-width:760px){.row{grid-template-columns:1fr}}</style></head><body><main class="wrap">
<h1>缁熶竴楠岃瘉鍚庡彴 路 APK 淇濇姢</h1><p class="muted">鎶婂凡缁忕紪璇戝ソ鐨?APK 鎷栬繘鏉ワ紝鏈満鑷姩鍔犲叆鍗″瘑绐楀彛銆佸績璺炽€丮D5 绛惧悕銆丷C4 鍔犲瘑鍜屾椂闂存埑鏍￠獙锛屽啀娣锋穯楠岃瘉妯″潡骞堕噸鏂扮鍚嶃€?/p><p><a href="${DEFAULT_SERVER}" target="_blank">鎵撳紑鍗″瘑绠＄悊鍚庡彴</a></p><p id="access" class="muted">姝ｅ湪璇诲彇鎵嬫満璁块棶鍦板潃...</p>
<section class="panel"><div id="drop" class="drop"><b>鎷栨嫿 APK 鍒拌繖閲?/b><p class="muted">鎴栫偣鍑婚€夋嫨 APK 鏂囦欢</p><input id="file" type="file" accept=".apk" style="display:none"></div></section>
<section class="panel"><div class="row"><label>缁熶竴鍚庡彴鍦板潃<input id="server" value="${DEFAULT_SERVER}"></label><label>鍗″瘑璐拱鍦板潃<input id="purchaseUrl" placeholder="涓嶅～鍒?APK 涓嶆樉绀鸿喘涔板叆鍙?></label><label>App ID<input id="appId" value="demo_android_app"></label><label>App Secret<input id="secret" type="password" value="change_this_app_secret"></label><label>RC4 Key<input id="rc4" type="password" value="change_this_rc4_key"></label></div><p><label><input id="obfuscate" type="checkbox" checked> 浣跨敤 R8 娣锋穯鏂板姞鍏ョ殑楠岃瘉妯″潡</label></p><p><label><input id="vmp" type="checkbox"> 澶勭悊瀹屾垚鍚庤皟鐢?VMP 澹?/label></p><button id="start" disabled>涓€閿姞鍏ラ獙璇佸苟淇濇姢 APK</button></section>
<section class="panel"><h2>鐘舵€?/h2><div id="status" class="status">绛夊緟 APK...</div><p id="download"></p></section>
<section class="panel"><h2>VMP 澹冲伐鍏蜂綅缃?/h2><p class="muted">鎶婁綘鐨?VMP 鍔犲浐宸ュ叿鏀惧埌锛?b>${ROOT.replace(/\\/g, "\\\\")}\\\\tools\\\\vmp\\\\packer.bat</b>銆傝剼鏈渶瑕佹敮鎸佷袱涓弬鏁帮細杈撳叆 APK銆佽緭鍑?APK銆?/p></section>
</main><script>
let selected=null; const drop=document.getElementById('drop'), file=document.getElementById('file'), start=document.getElementById('start'), statusBox=document.getElementById('status'), dl=document.getElementById('download');
drop.onclick=()=>file.click(); file.onchange=()=>setFile(file.files[0]); drop.ondragover=e=>{e.preventDefault();drop.classList.add('drag')}; drop.ondragleave=()=>drop.classList.remove('drag'); drop.ondrop=e=>{e.preventDefault();drop.classList.remove('drag');setFile(e.dataTransfer.files[0])};
function setFile(f){ if(!f||!f.name.toLowerCase().endsWith('.apk')) return log('璇烽€夋嫨 APK 鏂囦欢'); selected=f; start.disabled=false; log('宸查€夋嫨锛?+f.name+'\\n鐐瑰嚮寮€濮嬪鐞?); }
function log(t){ statusBox.textContent=t; }
async function waitJob(id){ for(let i=0;i<600;i++){ await new Promise(resolve=>setTimeout(resolve,2000)); const r=await fetch('/api/jobs/'+encodeURIComponent(id),{cache:'no-store'}); const j=await r.json(); if(!r.ok)throw new Error(j.message||'读取任务失败'); log((j.progress||'云端正在处理 APK')+'\\n\\n任务号：'+id); if(j.status==='done'&&j.result)return j.result; if(j.status==='failed')throw new Error(j.message||'APK 处理失败'); } throw new Error('APK 处理超过 20 分钟'); }
start.onclick=async()=>{ if(!selected)return; start.disabled=true; dl.innerHTML=''; log('正在上传 APK...'); const qs=new URLSearchParams({fileName:selected.name,serverUrl:server.value,purchaseUrl:purchaseUrl.value,appId:appId.value,appSecret:secret.value,rc4Key:rc4.value,obfuscate:obfuscate.checked?'1':'0',vmp:vmp.checked?'1':'0'}); try{ const r=await fetch('/api/process?'+qs,{method:'POST',body:selected}); const first=await r.json(); if(!r.ok||!first.ok)throw new Error(first.message||'提交失败'); const b=first.queued?await waitJob(first.jobId):first; log('处理完成\\n包名：'+b.packageName+'\\n原启动页：'+b.launcher+'\\n统一后台：'+b.serverUrl+'\\n安全传输：心跳 + MD5 + RC4 + 时间戳\\n'+b.obfuscationMessage+'\\n'+b.vmpMessage); dl.innerHTML='<a href="'+b.file+'">下载 '+b.fileName+'</a>'; }catch(e){ log('处理失败：\\n'+e.message); } finally{ start.disabled=false; } };
fetch('/api/status').then(r=>r.json()).then(b=>{ if(!b.ok)return; console.log(b.tools); const phone=(b.accessUrls||[]).filter(x=>!x.includes('127.0.0.1')); access.textContent=phone.length?'瀹夊崜鎵嬫満涓庣數鑴戣繛鎺ュ悓涓€ Wi-Fi 鍚庢墦寮€锛?+phone.join(' 鎴?'):'鐢佃剳璁块棶锛歨ttp://127.0.0.1:${PORT}'; });
</script></body></html>`;
}

