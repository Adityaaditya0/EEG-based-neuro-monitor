// =============================================================================
//  NeuroWatch EEG — Node.js WebSocket Relay Server
//  Bridges ESP32-S3 (hardware) → Browser Dashboard (viewer)
//  Stores patient credentials in MongoDB Atlas
//  Records EEG data as CSV files
// =============================================================================

const WebSocket = require("ws");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { MongoClient } = require("mongodb");

// ---------------------------------------------------------------------------
//  CONFIG
// ---------------------------------------------------------------------------
const PORT = 8080;
const MAX_HISTORY = 1000;
const PING_INTERVAL = 15000;

// MongoDB Atlas URI — set your connection string here
const MONGO_URI = process.env.MONGO_URI || "PASTE_YOUR_ATLAS_URI_HERE";
const DB_NAME = "neurowatch";

// CSV data directory
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------------------------------------------------------------------
//  STATE
// ---------------------------------------------------------------------------
let esp32Socket = null;
let packetCount = 0;
let lastPacketTime = 0;
let sampleRate = 0;
let rateCounter = 0;
let lastRateTime = Date.now();
const packetHistory = [];

const browsers = new Map();
let browserIdSeq = 0;

// MongoDB
let db = null;

// CSV recording state
let csvStream = null;
let csvFilePath = null;
let csvSessionName = null;

// ---------------------------------------------------------------------------
//  HELPERS
// ---------------------------------------------------------------------------
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "127.0.0.1";
}

function timestamp() {
  return new Date().toISOString().replace("T", " ").slice(0, 23);
}

function log(tag, msg) {
  console.log(`[${timestamp()}] [${tag}] ${msg}`);
}

function broadcastToBrowsers(data) {
  browsers.forEach((meta, ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
      meta.packetsSent++;
    }
  });
}

function buildStatusMessage() {
  return JSON.stringify({
    type: "status",
    esp32: esp32Socket !== null && esp32Socket.readyState === WebSocket.OPEN,
    browsers: browsers.size,
    packets: packetCount,
    sampleRate: Math.round(sampleRate),
    uptime: Math.floor(process.uptime()),
    serverTime: Date.now(),
  });
}

// ---------------------------------------------------------------------------
//  CSV RECORDING
// ---------------------------------------------------------------------------
function startCsvSession(patientName) {
  // Close existing stream if any
  if (csvStream) { try { csvStream.end(); } catch { } }

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const safeName = (patientName || "unknown").replace(/[^a-zA-Z0-9_-]/g, "_");
  csvSessionName = `${safeName}_${ts}`;
  csvFilePath = path.join(DATA_DIR, `${csvSessionName}.csv`);

  // Write CSV header
  const header = "timestamp,FP1,FP2,F7,F8,O1,O2,EarL,EarR\n";
  csvStream = fs.createWriteStream(csvFilePath, { flags: "a" });
  csvStream.write(header);
  log("CSV", `Recording started: ${csvFilePath}`);
}

function writeCsvRow(pkt) {
  if (!csvStream) return;
  try {
    const ts = pkt.ts || Date.now();
    const ch = pkt.ch || [];
    const row = `${ts},${ch[0] || 0},${ch[1] || 0},${ch[2] || 0},${ch[3] || 0},${ch[4] || 0},${ch[5] || 0},${ch[6] || 0},${ch[7] || 0}\n`;
    csvStream.write(row);
  } catch (e) {
    log("CSV", `Write error: ${e.message}`);
  }
}

function stopCsvSession() {
  if (csvStream) {
    csvStream.end();
    csvStream = null;
    log("CSV", "Recording stopped");
  }
}

// ---------------------------------------------------------------------------
//  MONGODB
// ---------------------------------------------------------------------------
async function connectMongo() {
  if (MONGO_URI === "PASTE_YOUR_ATLAS_URI_HERE") {
    log("MONGO", "⚠ No MongoDB URI set — patient data will NOT be saved to DB.");
    log("MONGO", "  Set MONGO_URI env variable or edit server.js line 23.");
    return;
  }
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    log("MONGO", `Connected to MongoDB Atlas — database: ${DB_NAME}`);
  } catch (e) {
    log("MONGO", `Connection failed: ${e.message}`);
    log("MONGO", "Server will continue without database. Patient data won't be saved.");
  }
}

// ---------------------------------------------------------------------------
//  HTTP SERVER
// ---------------------------------------------------------------------------
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error("Invalid JSON")); }
    });
  });
}

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // ── API: Save patient ─────────────────────────────────────────────────────
  if (req.method === "POST" && req.url === "/api/patient") {
    try {
      const data = await parseBody(req);
      const { name, age, gender, doctorId, esp32Ip } = data;

      if (!name || !esp32Ip) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Name and ESP32 IP are required." }));
        return;
      }

      const patient = {
        name,
        age: age || null,
        gender: gender || null,
        doctorId: doctorId || null,
        esp32Ip,
        createdAt: new Date(),
      };

      let patientId = null;

      if (db) {
        const result = await db.collection("patients").insertOne(patient);
        patientId = result.insertedId.toString();
        log("MONGO", `Patient saved: ${name} (ID: ${patientId})`);
      } else {
        patientId = "local-" + Date.now();
        log("MONGO", `DB not connected — using local ID: ${patientId}`);
      }

      // Start CSV recording for this patient
      startCsvSession(name);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, patientId, csvFile: csvSessionName }));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── API: List patients ────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/api/patients") {
    if (!db) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }
    const patients = await db.collection("patients").find().sort({ createdAt: -1 }).limit(50).toArray();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(patients));
    return;
  }

  // ── API: Export CSV ───────────────────────────────────────────────────────
  if (req.method === "GET" && req.url === "/api/export") {
    if (!csvFilePath || !fs.existsSync(csvFilePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "No CSV data available." }));
      return;
    }
    const filename = path.basename(csvFilePath);
    res.writeHead(200, {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    });
    fs.createReadStream(csvFilePath).pipe(res);
    return;
  }

  // ── Serve EEG data JSON ─────────────────────────────────────────────────
  if (req.url === "/eeg_data.json") {
    const jsonPath = path.join(__dirname, "eeg_data.json");
    if (fs.existsSync(jsonPath)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      fs.createReadStream(jsonPath).pipe(res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "eeg_data.json not found. Run: node download_eeg.js" }));
    }
    return;
  }

  // ── Serve AI Model JSON ──────────────────────────────────────────────────
  if (req.url === "/ai_model.json") {
    const jsonPath = path.join(__dirname, "ai_model.json");
    if (fs.existsSync(jsonPath)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      fs.createReadStream(jsonPath).pipe(res);
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "ai_model.json not found. Run: node ai_train.js" }));
    }
    return;
  }

  // ── Status API ────────────────────────────────────────────────────────────
  if (req.url === "/status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      esp32Connected: esp32Socket !== null,
      browserClients: browsers.size,
      totalPackets: packetCount,
      sampleRate: Math.round(sampleRate),
      uptime: process.uptime(),
    }));
    return;
  }

  // ── History API ───────────────────────────────────────────────────────────
  if (req.url === "/history") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(packetHistory.slice(-250)));
    return;
  }

  // ── Serve login page (root) ──────────────────────────────────────────────
  if (req.url === "/" || req.url === "/login") {
    const htmlPath = path.join(__dirname, "login.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(htmlPath).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h2>NeuroWatch — login.html not found</h2>`);
    }
    return;
  }

  // ── Serve dashboard ──────────────────────────────────────────────────────
  if (req.url === "/dashboard") {
    const htmlPath = path.join(__dirname, "dashboard.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(htmlPath).pipe(res);
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<h2>NeuroWatch — dashboard.html not found</h2>`);
    }
    return;
  }

  // ── Serve analysis page ──────────────────────────────────────────────────
  if (req.url === "/analysis") {
    const htmlPath = path.join(__dirname, "analysis.html");
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(htmlPath).pipe(res);
    } else {
      res.writeHead(404); res.end("analysis.html not found");
    }
    return;
  }

  // ── API: List recorded CSV sessions ──────────────────────────────────────
  if (req.method === "GET" && req.url === "/api/sessions") {
    const files = fs.existsSync(DATA_DIR)
      ? fs.readdirSync(DATA_DIR)
          .filter(f => f.endsWith(".csv"))
          .map(f => {
            const stat = fs.statSync(path.join(DATA_DIR, f));
            return { name: f, size: stat.size, mtime: stat.mtime };
          })
          .sort((a, b) => new Date(b.mtime) - new Date(a.mtime))
      : [];
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(files));
    return;
  }

  // ── API: Return CSV content for a session ─────────────────────────────────
  if (req.method === "GET" && req.url.startsWith("/api/session/")) {
    const fname = decodeURIComponent(req.url.replace("/api/session/", ""));
    const fpath = path.join(DATA_DIR, path.basename(fname));
    if (!fs.existsSync(fpath) || !fname.endsWith(".csv")) {
      res.writeHead(404); res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/csv" });
    fs.createReadStream(fpath).pipe(res);
    return;
  }

  res.writeHead(404); res.end("Not found");
});

// ---------------------------------------------------------------------------
//  WEBSOCKET SERVER
// ---------------------------------------------------------------------------
const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", (ws, req) => {
  const urlPath = req.url || "/";
  const remoteIP = req.socket.remoteAddress;

  // ── ESP32 connection ──────────────────────────────────────────────────────
  if (urlPath === "/esp32") {
    if (esp32Socket && esp32Socket.readyState === WebSocket.OPEN) {
      log("ESP32", `New connection from ${remoteIP} — replacing previous ESP32`);
      esp32Socket.terminate();
    }

    esp32Socket = ws;
    log("ESP32", `Connected from ${remoteIP}`);
    broadcastToBrowsers(buildStatusMessage());

    ws.on("message", (rawData) => {
      const data = rawData.toString();
      packetCount++;
      lastPacketTime = Date.now();

      rateCounter++;
      const now = Date.now();
      const elapsed = (now - lastRateTime) / 1000;
      if (elapsed >= 1.0) {
        sampleRate = rateCounter / elapsed;
        rateCounter = 0;
        lastRateTime = now;
      }

      try {
        const parsed = JSON.parse(data);
        parsed.srv = now;
        const enriched = JSON.stringify(parsed);

        // Record to CSV
        writeCsvRow(parsed);

        packetHistory.push(enriched);
        if (packetHistory.length > MAX_HISTORY) packetHistory.shift();

        broadcastToBrowsers(enriched);
      } catch (e) {
        log("ESP32", `Bad JSON from ESP32: ${data.slice(0, 80)}`);
      }
    });

    ws.on("close", (code) => {
      log("ESP32", `Disconnected (code=${code})`);
      esp32Socket = null;
      broadcastToBrowsers(buildStatusMessage());
    });

    ws.on("error", (err) => {
      log("ESP32", `Error: ${err.message}`);
    });

    return;
  }

  // ── Browser viewer connection ─────────────────────────────────────────────
  const id = ++browserIdSeq;
  browsers.set(ws, { id, connectedAt: Date.now(), packetsSent: 0 });
  log("Browser", `Client #${id} connected from ${remoteIP}  (total=${browsers.size})`);

  ws.send(buildStatusMessage());

  const replayCount = Math.min(packetHistory.length, 250);
  for (let i = packetHistory.length - replayCount; i < packetHistory.length; i++) {
    ws.send(packetHistory[i]);
  }
  log("Browser", `Sent ${replayCount} history packets to client #${id}`);

  ws.on("message", (rawData) => {
    try {
      const msg = JSON.parse(rawData.toString());
      if (msg.type === "ping") ws.send(buildStatusMessage());
      else if (msg.type === "sim_data" && msg.pkt) writeCsvRow(msg.pkt);
    } catch { }
  });

  ws.on("close", () => {
    browsers.delete(ws);
    log("Browser", `Client #${id} disconnected  (total=${browsers.size})`);
  });

  ws.on("error", (err) => {
    log("Browser", `Client #${id} error: ${err.message}`);
    browsers.delete(ws);
  });

  const pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingTimer);
    }
  }, PING_INTERVAL);
});

// ---------------------------------------------------------------------------
//  PERIODIC STATUS BROADCAST
// ---------------------------------------------------------------------------
setInterval(() => {
  broadcastToBrowsers(buildStatusMessage());
  if (esp32Socket && Date.now() - lastPacketTime > 5000 && lastPacketTime > 0) {
    log("ESP32", "No data for 5s — possible stall");
  }
}, 2000);

// ---------------------------------------------------------------------------
//  START
// ---------------------------------------------------------------------------
async function start() {
  await connectMongo();

  httpServer.listen(PORT, () => {
    const localIP = getLocalIP();
    console.log("");
    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║         NeuroWatch EEG WebSocket Server                 ║");
    console.log("╠══════════════════════════════════════════════════════════╣");
    console.log(`║  Login page:   http://${localIP}:${PORT}`.padEnd(58) + "║");
    console.log(`║  Dashboard:    http://${localIP}:${PORT}/dashboard`.padEnd(58) + "║");
    console.log(`║  ESP32 target: ws://${localIP}:${PORT}/esp32`.padEnd(58) + "║");
    console.log(`║  Status API:   http://${localIP}:${PORT}/status`.padEnd(58) + "║");
    console.log(`║  CSV Export:   http://${localIP}:${PORT}/api/export`.padEnd(58) + "║");
    console.log("╠══════════════════════════════════════════════════════════╣");
    console.log(`║  MongoDB: ${db ? "Connected ✓" : "Not configured ✗"}`.padEnd(58) + "║");
    console.log(`║  CSV Dir:  ${DATA_DIR}`.padEnd(58) + "║");
    console.log("╚══════════════════════════════════════════════════════════╝");
    console.log("");
  });
}

start();

process.on("SIGINT", () => {
  log("SERVER", "Shutting down...");
  stopCsvSession();
  wss.clients.forEach(ws => ws.terminate());
  httpServer.close(() => process.exit(0));
});
