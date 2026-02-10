/**
 * server-electron.js
 * Wird von main.js (Electron) gestartet. Identisch zu server.js,
 * aber mit angepassten Pfaden für userData und Resources.
 *
 * Für npm start → server.js (unverändert)
 * Für Electron  → dieser Server (wird via require('./server-electron') geladen)
 */

const express = require("express");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "2mb" }));

// ─── Pfade: Electron vs. npm start ───────────────────────────────────────────

const isElectron = process.env.ELECTRON_MODE === "true";

// Statische Dateien: im Build liegen sie in resources/public (extraResources),
// im Dev-Modus im Projektordner /public
const STATIC_DIR = isElectron
  ? path.join(process.env.ELECTRON_RESOURCES || __dirname, "public")
  : path.join(__dirname, "public");

// Datenspeicherung: im Electron-Build in userData, sonst neben dem Server
const DATA_DIR = isElectron
  ? path.join(process.env.ELECTRON_USER_DATA || __dirname, "data")
  : path.join(__dirname, "data");

// Config: im Electron-Build in userData, sonst neben dem Server
const LOCAL_CFG = isElectron
  ? path.join(process.env.ELECTRON_USER_DATA || __dirname, "config.local.json")
  : path.join(__dirname, "config.local.json");

// Last-Session Datei für Transcript-Persistenz
const LAST_SESSION_FILE = isElectron
  ? path.join(process.env.ELECTRON_USER_DATA || __dirname, "last-session.json")
  : path.join(__dirname, "data", "last-session.json");

// Verzeichnisse anlegen
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

app.use(express.static(STATIC_DIR));

console.log(`[server-electron] Static: ${STATIC_DIR}`);
console.log(`[server-electron] Data:   ${DATA_DIR}`);
console.log(`[server-electron] Config: ${LOCAL_CFG}`);

// ─── Local Config ─────────────────────────────────────────────────────────────

app.get("/api/local-config", (req, res) => {
  try {
    if (!fs.existsSync(LOCAL_CFG)) return res.status(404).json({ error: "Not found" });
    const raw = JSON.parse(fs.readFileSync(LOCAL_CFG, "utf8"));
    const cfg = {};
    if (typeof raw.apiKey === "string") cfg.apiKey = raw.apiKey;
    if (typeof raw.docAgentId === "string") cfg.docAgentId = raw.docAgentId;
    if (typeof raw.patientAgentId === "string") cfg.patientAgentId = raw.patientAgentId;
    if (raw.maxTurns !== undefined) cfg.maxTurns = raw.maxTurns;
    if (raw.silenceTime !== undefined) cfg.silenceTime = raw.silenceTime;
    res.json(cfg);
  } catch (_) {
    res.status(400).json({ error: "Invalid config" });
  }
});

// ─── Config speichern (neu – nur im Electron-Build relevant) ─────────────────

app.post("/api/save-config", (req, res) => {
  try {
    const { apiKey, docAgentId, patientAgentId, maxTurns, silenceTime } = req.body;
    let existing = {};
    if (fs.existsSync(LOCAL_CFG)) {
      try { existing = JSON.parse(fs.readFileSync(LOCAL_CFG, "utf8")); } catch (_) {}
    }
    const updated = { ...existing };
    if (apiKey !== undefined) updated.apiKey = apiKey;
    if (docAgentId !== undefined) updated.docAgentId = docAgentId;
    if (patientAgentId !== undefined) updated.patientAgentId = patientAgentId;
    if (maxTurns !== undefined) updated.maxTurns = parseInt(maxTurns) || 30;
    if (silenceTime !== undefined) updated.silenceTime = parseInt(silenceTime) || 2000;
    fs.writeFileSync(LOCAL_CFG, JSON.stringify(updated, null, 2));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Modus-Flag (damit Frontend erkennt ob Electron) ─────────────────────────

app.get("/api/mode", (req, res) => {
  res.json({ electron: isElectron });
});

// ─── Last-Session (Transcript-Persistenz für Electron) ───────────────────────

app.get("/api/last-session", (req, res) => {
  try {
    if (!fs.existsSync(LAST_SESSION_FILE)) return res.json(null);
    res.json(JSON.parse(fs.readFileSync(LAST_SESSION_FILE, "utf8")));
  } catch (_) {
    res.json(null);
  }
});

app.post("/api/last-session", (req, res) => {
  try {
    fs.writeFileSync(LAST_SESSION_FILE, JSON.stringify(req.body));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Ab hier: identisch zu server.js ─────────────────────────────────────────

const activeRuns = new Map();
const sseClients = new Map();

function broadcast(runId, event, data) {
  const clients = sseClients.get(runId);
  if (!clients) return;
  for (const res of clients) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function cleanupRun(runId) {
  const run = activeRuns.get(runId);
  if (run) {
    if (run.docWs && run.docWs.readyState <= WebSocket.OPEN) run.docWs.close();
    if (run.patientWs && run.patientWs.readyState <= WebSocket.OPEN) run.patientWs.close();
    clearTimeout(run.docTimer);
    clearTimeout(run.patientTimer);
    run.status = "completed";
  }
  const clients = sseClients.get(runId);
  if (clients) {
    for (const res of clients) { res.write(`event: done\ndata: {}\n\n`); res.end(); }
    sseClients.delete(runId);
  }
}

function saveRunToDisk(runId) {
  const run = activeRuns.get(runId);
  if (!run) return;
  fs.writeFileSync(path.join(DATA_DIR, `${runId}.json`), JSON.stringify({
    id: runId, startedAt: run.startedAt, completedAt: Date.now(),
    docAgentId: run.docAgentId, patientAgentId: run.patientAgentId,
    scenarios: run.scenarioResults || [], systemLog: run.systemLog || [],
  }, null, 2));
}

function addRunLog(runId, text, type = "system") {
  const run = activeRuns.get(runId);
  if (run) run.systemLog.push({ time: new Date().toISOString(), text, type });
  broadcast(runId, "log", { type, text });
}

// ─── Loop Detection ───────────────────────────────────────────────────────────

function norm(t) { return t.toLowerCase().replace(/[^a-zäöüß0-9 ]/g, "").replace(/\s+/g, " ").trim(); }

function detectLoop(transcript) {
  if (transcript.length < 3) return false;
  const last3 = transcript.slice(-3).map(m => norm(m.text));
  if (last3[0] === last3[1] && last3[1] === last3[2]) return "3_identical";
  for (const speaker of ["PRAXIS", "PATIENT"]) {
    const msgs = transcript.filter(m => m.speaker === speaker);
    if (msgs.length >= 3) {
      const last3agent = msgs.slice(-3).map(m => norm(m.text));
      if (last3agent[0] === last3agent[1] && last3agent[1] === last3agent[2]) return `${speaker.toLowerCase()}_repeat`;
    }
  }
  if (transcript.length >= 6) {
    const last6 = transcript.slice(-6).map(m => norm(m.text));
    if (last6[0] === last6[2] && last6[2] === last6[4] && last6[1] === last6[3] && last6[3] === last6[5]) return "ping_pong";
  }
  return false;
}

// ─── SSE ──────────────────────────────────────────────────────────────────────

app.get("/api/stream/:runId", (req, res) => {
  const { runId } = req.params;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(`event: connected\ndata: {"runId":"${runId}"}\n\n`);
  if (!sseClients.has(runId)) sseClients.set(runId, new Set());
  sseClients.get(runId).add(res);
  req.on("close", () => {
    const set = sseClients.get(runId);
    if (set) { set.delete(res); if (set.size === 0) sseClients.delete(runId); }
  });
});

// ─── History API ──────────────────────────────────────────────────────────────

app.get("/api/runs", (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json") && f !== "last-session.json");
    const runs = files.map(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
        return { id: d.id, startedAt: d.startedAt, completedAt: d.completedAt, docAgentId: d.docAgentId, patientAgentId: d.patientAgentId, scenarioCount: d.scenarios?.length || 0, scenarioNames: (d.scenarios || []).map(s => s.name) };
      } catch (_) { return null; }
    }).filter(Boolean).sort((a, b) => b.startedAt - a.startedAt);
    res.json(runs);
  } catch (_) { res.json([]); }
});

app.get("/api/runs/:runId", (req, res) => {
  const fp = path.join(DATA_DIR, `${req.params.runId}.json`);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "Run not found" });
  res.json(JSON.parse(fs.readFileSync(fp, "utf8")));
});

app.delete("/api/runs/:runId", (req, res) => {
  const fp = path.join(DATA_DIR, `${req.params.runId}.json`);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  activeRuns.delete(req.params.runId);
  res.json({ ok: true });
});

// ─── Update Patient Agent Prompt ──────────────────────────────────────────────

async function updatePatientPrompt(apiKey, patientId, prompt, baseUrl) {
  const resp = await fetch(`${baseUrl}/v1/convai/agents/${patientId}`, {
    method: "PATCH",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_config: { agent: { prompt: { prompt } } } }),
  });
  if (!resp.ok) { const t = await resp.text(); throw new Error(`(${resp.status}): ${t}`); }
  return resp.json();
}

// ─── Skip Scenario ────────────────────────────────────────────────────────────

app.post("/api/skip/:runId", (req, res) => {
  const run = activeRuns.get(req.params.runId);
  if (run && run.skipCurrent) {
    run.skipCurrent();
    res.json({ ok: true });
  } else {
    res.status(404).json({ error: "No active scenario to skip" });
  }
});

// ─── Run a Single Scenario ────────────────────────────────────────────────────

function runScenario(runId, config, scenario, scenarioIndex, totalScenarios) {
  return new Promise((resolve) => {
    const { apiKey, docAgentId, patientAgentId, maxTurns, silenceTime, baseUrl } = config;
    const wsBase = baseUrl.replace("https://", "wss://");

    let turnCount = 0, docBuffer = "", patientBuffer = "";
    let docTimer = null, patientTimer = null;
    let transcript = [], resolved = false;
    const t0 = Date.now();

    function done(reason) {
      if (resolved) return;
      resolved = true;
      const run = activeRuns.get(runId);
      if (run) run.skipCurrent = null;
      clearTimeout(safetyTimer); clearTimeout(docTimer); clearTimeout(patientTimer);
      try { docWs.close(); } catch (_) {}
      try { patientWs.close(); } catch (_) {}
      const dur = ((Date.now() - t0) / 1000).toFixed(1);
      addRunLog(runId, `Szenario "${scenario.name}" beendet (${reason}) – ${dur}s, ${turnCount} Turns, ${transcript.length} Nachrichten`);
      broadcast(runId, "scenario_end", { scenarioIndex, reason, transcript, duration: dur, turnCount });
      resolve({ name: scenario.name, prompt: scenario.prompt, transcript, reason, duration: dur, turnCount });
    }

    const run = activeRuns.get(runId);
    if (run) run.skipCurrent = () => {
      addRunLog(runId, `⭭ Szenario "${scenario.name}" manuell übersprungen`, "warn");
      done("skipped");
    };

    const safetyTimer = setTimeout(() => {
      addRunLog(runId, `⏱ Timeout nach 5min – Szenario wird übersprungen`, "warn");
      done("timeout");
    }, 5 * 60 * 1000);

    function checkForLoop() {
      const loopType = detectLoop(transcript);
      if (loopType) {
        const labels = { "3_identical": "3 identische Nachrichten", "praxis_repeat": "Praxis wiederholt sich 3×", "patient_repeat": "Patient wiederholt sich 3×", "ping_pong": "Ping-Pong-Muster erkannt" };
        addRunLog(runId, `⟳ Loop: ${labels[loopType] || loopType} – Szenario wird übersprungen`, "warn");
        done("loop_detected");
        return true;
      }
      return false;
    }

    function sendMsg(text, ws) {
      if (!text?.trim() || ws.readyState !== WebSocket.OPEN) return;
      addRunLog(runId, `→ ${ws.agentLabel}: "${text.slice(0, 100)}${text.length > 100 ? "…" : ""}"`);
      ws.send(JSON.stringify({ type: "user_message", text }));
    }

    const docWs = (() => { addRunLog(runId, `PRAXIS: Verbinde…`); const ws = new WebSocket(`${wsBase}/v1/convai/conversation?agent_id=${docAgentId}&xi-api-key=${apiKey}`); ws.agentLabel = "PRAXIS"; return ws; })();
    const patientWs = (() => { addRunLog(runId, `PATIENT: Verbinde…`); const ws = new WebSocket(`${wsBase}/v1/convai/conversation?agent_id=${patientAgentId}&xi-api-key=${apiKey}`); ws.agentLabel = "PATIENT"; return ws; })();

    if (run) { run.docWs = docWs; run.patientWs = patientWs; }

    let docReady = false, patientReady = false;
    function checkReady() {
      if (docReady && patientReady) {
        addRunLog(runId, "Beide verbunden ✓ – Praxis begrüßt zuerst…");
        setTimeout(() => sendMsg("Start", docWs), 1500);
      }
    }

    function setup(ws) {
      ws.on("open", () => {
        addRunLog(runId, `${ws.agentLabel}: Verbunden ✓`);
        if (ws.agentLabel === "PRAXIS") docReady = true; else patientReady = true;
        checkReady();
      });
      ws.on("error", (err) => { addRunLog(runId, `${ws.agentLabel}: Fehler – ${err.message}`, "error"); done("ws_error"); });
      ws.on("close", (code) => {
        addRunLog(runId, `${ws.agentLabel}: Geschlossen (${code})`);
        if (ws.agentLabel === "PATIENT") {
          clearTimeout(patientTimer);
          if (patientBuffer.trim()) { const m = patientBuffer.trim(); patientBuffer = ""; transcript.push({ speaker: "PATIENT", text: m }); broadcast(runId, "message", { speaker: "PATIENT", text: m }); }
          done("patient_disconnected");
        } else {
          clearTimeout(docTimer);
          if (docBuffer.trim()) { const m = docBuffer.trim(); docBuffer = ""; transcript.push({ speaker: "PRAXIS", text: m }); broadcast(runId, "message", { speaker: "PRAXIS", text: m }); }
          done("praxis_disconnected");
        }
      });
      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === "ping") { ws.send(JSON.stringify({ type: "pong", event_id: msg.ping_event?.event_id })); return; }
          if (msg.type === "agent_response" && msg.agent_response_event?.agent_response) {
            const txt = msg.agent_response_event.agent_response;
            if (ws.agentLabel === "PRAXIS") {
              broadcast(runId, "token", { speaker: "PRAXIS", text: txt });
              docBuffer += txt + " ";
              clearTimeout(docTimer);
              docTimer = setTimeout(() => {
                const m = docBuffer.trim(); docBuffer = "";
                transcript.push({ speaker: "PRAXIS", text: m });
                broadcast(runId, "message", { speaker: "PRAXIS", text: m });
                if (checkForLoop()) return;
                sendMsg(m, patientWs);
              }, silenceTime);
            } else {
              broadcast(runId, "token", { speaker: "PATIENT", text: txt });
              patientBuffer += txt + " ";
              clearTimeout(patientTimer);
              patientTimer = setTimeout(() => {
                turnCount++;
                const m = patientBuffer.trim(); patientBuffer = "";
                transcript.push({ speaker: "PATIENT", text: m });
                broadcast(runId, "message", { speaker: "PATIENT", text: m, turn: turnCount, maxTurns });
                if (checkForLoop()) return;
                if (turnCount >= maxTurns) { done("max_turns"); return; }
                sendMsg(m, docWs);
              }, silenceTime);
            }
          }
        } catch (_) {}
      });
    }

    setup(docWs); setup(patientWs);
    broadcast(runId, "scenario_start", { scenarioIndex, totalScenarios, name: scenario.name, prompt: scenario.prompt });
  });
}

// ─── Start Test Run ───────────────────────────────────────────────────────────

app.post("/api/start", async (req, res) => {
  const { apiKey, docAgentId, patientAgentId, scenarios, maxTurns = 30, silenceTime = 2000, scenarioIndices, basePrompt } = req.body;
  if (!apiKey || !docAgentId || !patientAgentId || !scenarios?.length) return res.status(400).json({ error: "Missing required fields" });

  const baseUrl = "https://api.eu.residency.elevenlabs.io";
  const runId = uuidv4();
  activeRuns.set(runId, { status: "running", startedAt: Date.now(), docAgentId, patientAgentId, scenarioResults: [], systemLog: [] });
  res.json({ runId, scenarioIndices: scenarioIndices || scenarios.map((_, i) => i) });

  const config = { apiKey, docAgentId, patientAgentId, maxTurns, silenceTime, baseUrl };

  addRunLog(runId, `══ Test Run gestartet ══`);
  addRunLog(runId, `${scenarios.length} Szenario(s) | Max Turns: ${maxTurns} | Silence: ${silenceTime}ms`);
  addRunLog(runId, `Praxis: ${docAgentId} | Patient: ${patientAgentId}`);
  if (basePrompt) addRunLog(runId, `Base-Prompt aktiv (${basePrompt.length} Zeichen)`);
  addRunLog(runId, `Loop-Erkennung: 3× identisch, per-Agent 3× Wiederholung, Ping-Pong`);

  const results = [];
  for (let i = 0; i < scenarios.length; i++) {
    const run = activeRuns.get(runId);
    if (!run || run.status === "stopped") { addRunLog(runId, "Test gestoppt.", "warn"); break; }

    const sc = scenarios[i];
    addRunLog(runId, `\n── Szenario ${i + 1}/${scenarios.length}: "${sc.name}" ──`);

    const useBase = sc.use_base_prompt !== false && basePrompt;
    const finalPrompt = useBase ? `${basePrompt}\n\n---\n\nSzenario:\n${sc.prompt}` : sc.prompt;
    addRunLog(runId, `Base-Prompt: ${useBase ? "aktiv" : "deaktiviert"} | Prompt (${finalPrompt.length} Zeichen): "${finalPrompt.slice(0, 150)}…"`);

    try {
      addRunLog(runId, "Patient-Prompt aktualisieren…");
      await updatePatientPrompt(apiKey, patientAgentId, finalPrompt, baseUrl);
      addRunLog(runId, "Patient-Prompt aktualisiert ✓");
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      addRunLog(runId, `Fehler: ${err.message}`, "error");
      continue;
    }

    try {
      const result = await runScenario(runId, config, sc, i + 1, scenarios.length);
      results.push(result);
      const rd = activeRuns.get(runId);
      if (rd) rd.scenarioResults.push(result);
    } catch (err) {
      addRunLog(runId, `Fehler: ${err.message}`, "error");
    }

    if (i < scenarios.length - 1) { addRunLog(runId, "Cooldown 2s…"); await new Promise(r => setTimeout(r, 2000)); }
  }

  const looped = results.filter(r => r.reason === "loop_detected").length;
  const timedOut = results.filter(r => r.reason === "timeout").length;
  const skipped = results.filter(r => r.reason === "skipped").length;
  const clean = results.filter(r => ["patient_disconnected", "praxis_disconnected"].includes(r.reason)).length;
  addRunLog(runId, `\n══ Abgeschlossen ══ ${results.length}/${scenarios.length} – ${clean} sauber, ${looped} Loops, ${timedOut} Timeouts, ${skipped} übersprungen`);
  broadcast(runId, "run_complete", { totalScenarios: scenarios.length, completedScenarios: results.length, looped, timedOut, skipped, clean });
  saveRunToDisk(runId);
  cleanupRun(runId);
});

app.post("/api/stop/:runId", (req, res) => {
  const run = activeRuns.get(req.params.runId);
  if (run) { run.status = "stopped"; saveRunToDisk(req.params.runId); cleanupRun(req.params.runId); res.json({ ok: true }); }
  else res.status(404).json({ error: "Run not found" });
});

// ─── Server starten ───────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, "127.0.0.1", () => {
  console.log(`\n  🧪 ElevenLabs Agent Tester (Electron) → http://localhost:${PORT}\n`);
});
