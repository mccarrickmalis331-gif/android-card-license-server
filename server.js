const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CONFIG = {
  appId: process.env.APP_ID || "demo_android_app",
  appSecret: process.env.APP_SECRET || "change_this_app_secret",
  rc4Key: process.env.RC4_KEY || "change_this_rc4_key",
  adminToken: process.env.ADMIN_TOKEN || "change_this_admin_token",
  allowedSkewSeconds: 300,
  heartbeatGraceSeconds: 180,
  host: process.env.HOST || "0.0.0.0",
  port: Number(process.env.PORT || 8787)
};

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "cards.json");
const PUBLIC_DIR = path.join(__dirname, "public");

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function md5(input) {
  return crypto.createHash("md5").update(input, "utf8").digest("hex");
}

function randomId(bytes = 12) {
  return crypto.randomBytes(bytes).toString("hex");
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ""), "utf8");
  const bb = Buffer.from(String(b || ""), "utf8");
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function rc4Buffer(key, inputBuffer) {
  const s = new Array(256);
  const keyBuffer = Buffer.from(key, "utf8");
  for (let i = 0; i < 256; i += 1) s[i] = i;

  let j = 0;
  for (let i = 0; i < 256; i += 1) {
    j = (j + s[i] + keyBuffer[i % keyBuffer.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }

  const output = Buffer.alloc(inputBuffer.length);
  let i = 0;
  j = 0;
  for (let n = 0; n < inputBuffer.length; n += 1) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    const k = s[(s[i] + s[j]) & 255];
    output[n] = inputBuffer[n] ^ k;
  }
  return output;
}

function rc4EncryptToHex(obj) {
  const text = JSON.stringify(obj);
  return rc4Buffer(CONFIG.rc4Key, Buffer.from(text, "utf8")).toString("hex");
}

function rc4DecryptFromHex(hex) {
  const decrypted = rc4Buffer(CONFIG.rc4Key, Buffer.from(hex, "hex")).toString("utf8");
  return JSON.parse(decrypted);
}

function signEnvelope(appId, ts, nonce, data) {
  return md5(`${appId}${ts}${nonce}${data}${CONFIG.appSecret}`);
}

function makeEnvelope(payload) {
  const ts = nowSeconds();
  const nonce = randomId(8);
  const data = rc4EncryptToHex({ ...payload, ts });
  return {
    appId: CONFIG.appId,
    ts,
    nonce,
    data,
    sign: signEnvelope(CONFIG.appId, ts, nonce, data)
  };
}

function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ cards: [] }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
}

function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function jsonResponse(res, statusCode, body) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function textResponse(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  res.end(body);
}

function encryptedResponse(res, statusCode, payload) {
  jsonResponse(res, statusCode, makeEnvelope(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid json"));
      }
    });
  });
}

function verifyEnvelope(envelope) {
  if (!envelope || envelope.appId !== CONFIG.appId) {
    throw Object.assign(new Error("invalid app id"), { code: 1001 });
  }

  const ts = Number(envelope.ts);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds() - ts) > CONFIG.allowedSkewSeconds) {
    throw Object.assign(new Error("timestamp expired"), { code: 1002 });
  }

  const expectedSign = signEnvelope(envelope.appId, envelope.ts, envelope.nonce, envelope.data);
  if (!safeEqual(envelope.sign, expectedSign)) {
    throw Object.assign(new Error("invalid sign"), { code: 1003 });
  }

  const payload = rc4DecryptFromHex(envelope.data);
  if (Number(payload.ts) !== ts) {
    throw Object.assign(new Error("payload timestamp mismatch"), { code: 1004 });
  }

  return payload;
}

function durationToSeconds(body) {
  if (Number.isFinite(Number(body.durationSeconds)) && Number(body.durationSeconds) > 0) {
    return Math.floor(Number(body.durationSeconds));
  }

  const value = Number(body.duration);
  const unit = String(body.unit || "").toLowerCase();
  const units = {
    minute: 60,
    hour: 3600,
    day: 86400,
    month: 30 * 86400,
    year: 365 * 86400
  };

  if (!Number.isFinite(value) || value <= 0 || !units[unit]) {
    throw new Error("durationSeconds or duration/unit is required");
  }
  return Math.floor(value * units[unit]);
}

function makeCardKey() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const groups = [];
  for (let g = 0; g < 4; g += 1) {
    let part = "";
    for (let i = 0; i < 4; i += 1) {
      part += alphabet[crypto.randomInt(0, alphabet.length)];
    }
    groups.push(part);
  }
  return groups.join("-");
}

function findCard(db, cardKey) {
  return db.cards.find(card => card.cardKey === String(cardKey || "").trim().toUpperCase());
}

function publicCard(card) {
  const now = nowSeconds();
  return {
    cardKey: card.cardKey,
    status: card.status,
    durationSeconds: card.durationSeconds,
    deviceId: card.deviceId,
    createdAt: card.createdAt,
    activatedAt: card.activatedAt,
    expiresAt: card.expiresAt,
    remainingSeconds: card.expiresAt ? Math.max(0, card.expiresAt - now) : null,
    lastHeartbeatAt: card.lastHeartbeatAt,
    appVersion: card.appVersion || "",
    note: card.note
  };
}

function validateActiveCard(card, deviceId) {
  if (!card) return { ok: false, code: 2001, message: "card not found" };
  if (card.status !== "active") return { ok: false, code: 2002, message: `card is ${card.status}` };
  if (card.deviceId !== deviceId) return { ok: false, code: 2003, message: "device mismatch" };
  if (card.expiresAt <= nowSeconds()) {
    card.status = "expired";
    return { ok: false, code: 2004, message: "card expired" };
  }
  return { ok: true, code: 0, message: "ok" };
}

async function handleAdminCards(req, res) {
  if (req.headers["x-admin-token"] !== CONFIG.adminToken) {
    return jsonResponse(res, 401, { ok: false, message: "invalid admin token" });
  }

  const body = await readBody(req);
  const count = Math.max(1, Math.min(500, Math.floor(Number(body.count || 1))));
  const durationSeconds = durationToSeconds(body);
  const db = loadDb();
  const created = [];

  for (let i = 0; i < count; i += 1) {
    let cardKey = makeCardKey();
    while (findCard(db, cardKey)) cardKey = makeCardKey();

    const card = {
      cardKey,
      status: "unused",
      durationSeconds,
      deviceId: null,
      createdAt: nowSeconds(),
      activatedAt: null,
      expiresAt: null,
      lastHeartbeatAt: null,
      note: String(body.note || "")
    };
    db.cards.push(card);
    created.push(publicCard(card));
  }

  saveDb(db);
  return jsonResponse(res, 200, { ok: true, cards: created });
}

async function handleActivate(req, res) {
  const envelope = await readBody(req);
  const payload = verifyEnvelope(envelope);
  const cardKey = String(payload.cardKey || "").trim().toUpperCase();
  const deviceId = String(payload.deviceId || "").trim();

  if (!cardKey || !deviceId) {
    return encryptedResponse(res, 400, { ok: false, code: 1101, message: "cardKey and deviceId are required" });
  }

  const db = loadDb();
  const card = findCard(db, cardKey);
  if (!card) {
    return encryptedResponse(res, 404, { ok: false, code: 2001, message: "card not found" });
  }
  if (card.status === "disabled") {
    return encryptedResponse(res, 403, { ok: false, code: 2005, message: "card disabled" });
  }
  if (card.status === "expired" || (card.expiresAt && card.expiresAt <= nowSeconds())) {
    card.status = "expired";
    saveDb(db);
    return encryptedResponse(res, 403, { ok: false, code: 2004, message: "card expired" });
  }
  if (card.status === "active" && card.deviceId !== deviceId) {
    return encryptedResponse(res, 403, { ok: false, code: 2003, message: "device mismatch" });
  }

  if (card.status === "unused") {
    card.status = "active";
    card.deviceId = deviceId;
    card.activatedAt = nowSeconds();
    card.expiresAt = card.activatedAt + card.durationSeconds;
  }

  card.lastHeartbeatAt = nowSeconds();
  card.appVersion = String(payload.appVersion || "");
  saveDb(db);

  return encryptedResponse(res, 200, {
    ok: true,
    code: 0,
    message: "activate ok",
    ...publicCard(card)
  });
}

async function handleHeartbeat(req, res) {
  const envelope = await readBody(req);
  const payload = verifyEnvelope(envelope);
  const cardKey = String(payload.cardKey || "").trim().toUpperCase();
  const deviceId = String(payload.deviceId || "").trim();
  const db = loadDb();
  const card = findCard(db, cardKey);
  const active = validateActiveCard(card, deviceId);

  if (!active.ok) {
    if (card) saveDb(db);
    return encryptedResponse(res, 403, active);
  }

  card.lastHeartbeatAt = nowSeconds();
  card.appVersion = String(payload.appVersion || "");
  saveDb(db);

  return encryptedResponse(res, 200, {
    ok: true,
    code: 0,
    message: "heartbeat ok",
    ...publicCard(card),
    nextHeartbeatSeconds: CONFIG.heartbeatGraceSeconds
  });
}

async function handleListCards(req, res) {
  if (req.headers["x-admin-token"] !== CONFIG.adminToken) {
    return jsonResponse(res, 401, { ok: false, message: "invalid admin token" });
  }
  const db = loadDb();
  return jsonResponse(res, 200, { ok: true, cards: db.cards.map(publicCard) });
}

async function handleUpdateCard(req, res, cardKey) {
  if (req.headers["x-admin-token"] !== CONFIG.adminToken) {
    return jsonResponse(res, 401, { ok: false, message: "invalid admin token" });
  }

  const body = await readBody(req);
  const db = loadDb();
  const card = findCard(db, decodeURIComponent(cardKey));
  if (!card) {
    return jsonResponse(res, 404, { ok: false, message: "card not found" });
  }

  if (body.action === "disable") {
    card.status = "disabled";
  } else if (body.action === "enable") {
    card.status = card.expiresAt && card.expiresAt <= nowSeconds() ? "expired" : "active";
    if (!card.activatedAt) card.status = "unused";
  } else if (body.action === "reset") {
    card.status = "unused";
    card.deviceId = null;
    card.activatedAt = null;
    card.expiresAt = null;
    card.lastHeartbeatAt = null;
    card.appVersion = "";
  } else if (body.action === "note") {
    card.note = String(body.note || "");
  } else {
    return jsonResponse(res, 400, { ok: false, message: "unsupported action" });
  }

  saveDb(db);
  return jsonResponse(res, 200, { ok: true, card: publicCard(card) });
}

async function handleDeleteCard(req, res, cardKey) {
  if (req.headers["x-admin-token"] !== CONFIG.adminToken) {
    return jsonResponse(res, 401, { ok: false, message: "invalid admin token" });
  }

  const db = loadDb();
  const key = String(decodeURIComponent(cardKey || "")).trim().toUpperCase();
  const before = db.cards.length;
  db.cards = db.cards.filter(card => card.cardKey !== key);
  if (db.cards.length === before) {
    return jsonResponse(res, 404, { ok: false, message: "card not found" });
  }

  saveDb(db);
  return jsonResponse(res, 200, { ok: true });
}

async function handleDeleteAllCards(req, res) {
  if (req.headers["x-admin-token"] !== CONFIG.adminToken) {
    return jsonResponse(res, 401, { ok: false, message: "invalid admin token" });
  }

  const db = loadDb();
  const deleted = db.cards.length;
  db.cards = [];
  saveDb(db);
  return jsonResponse(res, 200, { ok: true, deleted });
}

function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return jsonResponse(res, 403, { ok: false, message: "forbidden" });
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return false;
  }

  const ext = path.extname(filePath).toLowerCase();
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8"
  };
  textResponse(res, 200, fs.readFileSync(filePath), types[ext] || "application/octet-stream");
  return true;
}

async function route(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/health") {
      return jsonResponse(res, 200, { ok: true, now: nowSeconds() });
    }
    if (req.method === "POST" && url.pathname === "/admin/cards") {
      return handleAdminCards(req, res);
    }
    if (req.method === "GET" && url.pathname === "/admin/cards") {
      return handleListCards(req, res);
    }
    if (req.method === "DELETE" && url.pathname === "/admin/cards") {
      return handleDeleteAllCards(req, res);
    }
    const cardMatch = url.pathname.match(/^\/admin\/cards\/([^/]+)$/);
    if (cardMatch && req.method === "PATCH") {
      return handleUpdateCard(req, res, cardMatch[1]);
    }
    if (cardMatch && req.method === "DELETE") {
      return handleDeleteCard(req, res, cardMatch[1]);
    }
    if (req.method === "POST" && url.pathname === "/api/activate") {
      return handleActivate(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/heartbeat") {
      return handleHeartbeat(req, res);
    }

    if (req.method === "GET" && serveStatic(req, res, url)) {
      return;
    }

    return jsonResponse(res, 404, { ok: false, message: "not found" });
  } catch (error) {
    const code = error.code || 5000;
    const status = code >= 1000 && code < 2000 ? 400 : 500;
    return jsonResponse(res, status, { ok: false, code, message: error.message });
  }
}

http.createServer(route).listen(CONFIG.port, CONFIG.host, () => {
  console.log(`card license server listening on http://${CONFIG.host}:${CONFIG.port}`);
});
