const express = require("express");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const activeRuns = new Map();
const sseClients = new Map();

// ─── Helpers ────────────────────────────────────────────────────────

function broadcast(runId, event, data) {
  const clients = sseClients.get(runId);
  if (!clients) return;
  for (const res of clients) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
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
    for (const res of clients) {
      res.write(`event: done\ndata: {}\n\n`);
      res.end();
    }
    sseClients.delete(runId);
  }
}

function saveRunToDisk(runId) {
  const run = activeRuns.get(runId);
  if (!run) return;
  fs.writeFileSync(
    path.join(DATA_DIR, `${runId}.json`),
    JSON.stringify({
      id: runId,
      startedAt: run.startedAt,
      completedAt: Date.now(),
      docAgentId: run.docAgentId,
      patientAgentId: run.patientAgentId,
      scenarios: run.scenarioResults || [],
      systemLog: run.systemLog || [],
    }, null, 2)
  );
}

function addRunLog(runId, text, type = "system") {
  const run = activeRuns.get(runId);
  if (run) run.systemLog.push({ time: new Date().toISOString(), text, type });
  broadcast(runId, "log", { type, text });
}

// ─── Loop Detection ─────────────────────────────────────────────────

function normalize(text) {
  return text.toLowerCase().replace(/[^a-zäöüß0-9 ]/g, "").replace(/\s+/g, " ").trim();
}

function detectLoop(transcript) {
  if (transcript.length < 3) return false;
  const last3 = transcript.slice(-3).map(m => normalize(m.text));
  // All 3 identical
  if (last3[0] === last3[1] && last3[1] === last3[2]) return true;
  // Check alternating pattern: A B A B A B (last 6 messages, 3 pairs)
  if (transcript.length >= 6) {
    const last6 = transcript.slice(-6).map(m => normalize(m.text));
    const pairA = last6[0] === last6[2] && last6[2] === last6[4];
    const pairB = last6[1] === last6[3] && last6[3] === last6[5];
    if (pairA && pairB) return true;
  }
  return false;
}

// ─── SSE Endpoint ───────────────────────────────────────────────────

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

// ─── History API ────────────────────────────────────────────────────

app.get("/api/runs", (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith(".json"));
    const runs = files.map(f => {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8"));
        return {
          id: d.id, startedAt: d.startedAt, completedAt: d.completedAt,
          docAgentId: d.docAgentId, patientAgentId: d.patientAgentId,
          scenarioCount: d.scenarios?.length || 0,
          scenarioNames: (d.scenarios || []).map(s => s.name),
        };
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

// ─── Update Patient Agent Prompt ────────────────────────────────────

async function updatePatientPrompt(apiKey, patientId, prompt, baseUrl) {
  const resp = await fetch(`${baseUrl}/v1/convai/agents/${patientId}`, {
    method: "PATCH",
    headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({ conversation_config: { agent: { prompt: { prompt } } } }),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Patient update failed (${resp.status}): ${text}`);
  }
  return resp.json();
}

// ─── Run a Single Scenario ──────────────────────────────────────────

function runScenario(runId, config, scenario, scenarioIndex, totalScenarios) {
  return new Promise((resolve) => {
    const { apiKey, docAgentId, patientAgentId, maxTurns, silenceTime, baseUrl } = config;
    const wsBase = baseUrl.replace("https://", "wss://");

    let turnCount = 0;
    let docBuffer = "";
    let patientBuffer = "";
    let docTimer = null;
    let patientTimer = null;
    let transcript = [];
    let resolved = false;
    let scenarioStartTime = Date.now();
    let loopWarnings = 0;

    function done(reason) {
      if (resolved) return;
      resolved = true;
      clearTimeout(safetyTimer);
      clearTimeout(docTimer);
      clearTimeout(patientTimer);
      try { docWs.close(); } catch (_) {}
      try { patientWs.close(); } catch (_) {}
      const duration = ((Date.now() - scenarioStartTime) / 1000).toFixed(1);
      addRunLog(runId, `Szenario "${scenario.name}" beendet (${reason}) — ${duration}s, ${turnCount} Turns, ${transcript.length} Nachrichten`);
      broadcast(runId, "scenario_end", { scenarioIndex, reason, transcript, duration, turnCount });
      resolve({ name: scenario.name, prompt: scenario.prompt, transcript, reason, duration, turnCount });
    }

    const safetyTimer = setTimeout(() => {
      addRunLog(runId, `⏱ Szenario "${scenario.name}" Timeout nach 5 Minuten — wird übersprungen`, "warn");
      done("timeout");
    }, 5 * 60 * 1000);

    function checkForLoop() {
      if (detectLoop(transcript)) {
        loopWarnings++;
        addRunLog(runId, `⚠ Loop erkannt (${loopWarnings}/1) — Gespräch wiederholt sich, Szenario wird beendet`, "warn");
        broadcast(runId, "log", { type: "warn", text: `Loop erkannt: Letzte Nachrichten wiederholen sich — Szenario wird übersprungen` });
        done("loop_detected");
        return true;
      }
      return false;
    }

    function connectAgent(agentId, label) {
      addRunLog(runId, `${label}: Verbinde WebSocket…`);
      const ws = new WebSocket(`${wsBase}/v1/convai/conversation?agent_id=${agentId}&xi-api-key=${apiKey}`);
      ws.agentLabel = label;
      return ws;
    }

    function sendUserMessage(text, targetWs) {
      if (!text || !text.trim() || targetWs.readyState !== WebSocket.OPEN) return;
      addRunLog(runId, `→ ${targetWs.agentLabel}: "${text.slice(0, 100)}${text.length > 100 ? "…" : ""}"`);
      targetWs.send(JSON.stringify({ type: "user_message", text }));
    }

    const docWs = connectAgent(docAgentId, "PRAXIS");
    const patientWs = connectAgent(patientAgentId, "PATIENT");

    const run = activeRuns.get(runId);
    if (run) { run.docWs = docWs; run.patientWs = patientWs; }

    let docReady = false;
    let patientReady = false;

    function checkBothReady() {
      if (docReady && patientReady) {
        addRunLog(runId, "Beide Agents verbunden ✓ — Praxis begrüßt zuerst…");
        setTimeout(() => sendUserMessage("Start", docWs), 1500);
      }
    }

    function setupAgent(ws) {
      ws.on("open", () => {
        addRunLog(runId, `${ws.agentLabel}: Verbunden ✓`);
        if (ws.agentLabel === "PRAXIS") docReady = true;
        else patientReady = true;
        checkBothReady();
      });

      ws.on("error", (err) => {
        addRunLog(runId, `${ws.agentLabel}: WebSocket Fehler — ${err.message}`, "error");
        done("ws_error");
      });

      ws.on("close", (code) => {
        addRunLog(runId, `${ws.agentLabel}: WebSocket geschlossen (Code: ${code})`);
        if (ws.agentLabel === "PATIENT") {
          clearTimeout(patientTimer);
          if (patientBuffer.trim()) {
            const m = patientBuffer.trim(); patientBuffer = "";
            transcript.push({ speaker: "PATIENT", text: m });
            broadcast(runId, "message", { speaker: "PATIENT", text: m });
          }
          done("patient_disconnected");
        } else if (ws.agentLabel === "PRAXIS") {
          clearTimeout(docTimer);
          if (docBuffer.trim()) {
            const m = docBuffer.trim(); docBuffer = "";
            transcript.push({ speaker: "PRAXIS", text: m });
            broadcast(runId, "message", { speaker: "PRAXIS", text: m });
          }
          done("praxis_disconnected");
        }
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", event_id: msg.ping_event?.event_id }));
            return;
          }
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
                sendUserMessage(m, patientWs);
              }, silenceTime);
            } else if (ws.agentLabel === "PATIENT") {
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
                sendUserMessage(m, docWs);
              }, silenceTime);
            }
          }
        } catch (_) {}
      });
    }

    setupAgent(docWs);
    setupAgent(patientWs);

    broadcast(runId, "scenario_start", { scenarioIndex, totalScenarios, name: scenario.name, prompt: scenario.prompt });
  });
}

// ─── Start Test Run ─────────────────────────────────────────────────

app.post("/api/start", async (req, res) => {
  const { apiKey, docAgentId, patientAgentId, scenarios, maxTurns = 30, silenceTime = 2000, scenarioIndices } = req.body;

  if (!apiKey || !docAgentId || !patientAgentId || !scenarios?.length) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const baseUrl = "https://api.eu.residency.elevenlabs.io";
  const runId = uuidv4();

  activeRuns.set(runId, {
    status: "running", startedAt: Date.now(),
    docAgentId, patientAgentId,
    scenarioResults: [], systemLog: [],
  });

  res.json({ runId, scenarioIndices: scenarioIndices || scenarios.map((_, i) => i) });

  const config = { apiKey, docAgentId, patientAgentId, maxTurns, silenceTime, baseUrl };

  addRunLog(runId, `═══ Test Run gestartet ═══`);
  addRunLog(runId, `${scenarios.length} Szenario(s) | Max Turns: ${maxTurns} | Silence: ${silenceTime}ms`);
  addRunLog(runId, `Praxis-Agent: ${docAgentId}`);
  addRunLog(runId, `Patient-Agent: ${patientAgentId}`);
  addRunLog(runId, `Loop-Erkennung: aktiv (3 gleiche Nachrichten oder Ping-Pong-Muster)`);

  const results = [];

  for (let i = 0; i < scenarios.length; i++) {
    const run = activeRuns.get(runId);
    if (!run || run.status === "stopped") { addRunLog(runId, "Test manuell gestoppt.", "warn"); break; }

    const scenario = scenarios[i];
    addRunLog(runId, `\n── Szenario ${i + 1}/${scenarios.length}: "${scenario.name}" ──`);
    addRunLog(runId, `Prompt: "${scenario.prompt.slice(0, 150)}${scenario.prompt.length > 150 ? "…" : ""}"`);

    try {
      addRunLog(runId, "Patient-Prompt aktualisieren…");
      await updatePatientPrompt(apiKey, patientAgentId, scenario.prompt, baseUrl);
      addRunLog(runId, "Patient-Prompt aktualisiert ✓");
      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      addRunLog(runId, `Fehler: ${err.message}`, "error");
      continue;
    }

    try {
      const result = await runScenario(runId, config, scenario, i + 1, scenarios.length);
      results.push(result);
      const rd = activeRuns.get(runId);
      if (rd) rd.scenarioResults.push(result);
    } catch (err) {
      addRunLog(runId, `Szenario fehlgeschlagen: ${err.message}`, "error");
    }

    if (i < scenarios.length - 1) {
      addRunLog(runId, "Cooldown 2s…");
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  addRunLog(runId, `\n═══ Test Run abgeschlossen ═══ ${results.length}/${scenarios.length} Szenarien durchlaufen`);

  // Summary
  const looped = results.filter(r => r.reason === "loop_detected").length;
  const timedOut = results.filter(r => r.reason === "timeout").length;
  const clean = results.filter(r => ["patient_disconnected", "praxis_disconnected"].includes(r.reason)).length;
  addRunLog(runId, `Zusammenfassung: ${clean} sauber beendet, ${looped} Loops erkannt, ${timedOut} Timeouts`);

  broadcast(runId, "run_complete", { totalScenarios: scenarios.length, completedScenarios: results.length, looped, timedOut, clean });
  saveRunToDisk(runId);
  cleanupRun(runId);
});

// ─── Stop ───────────────────────────────────────────────────────────

app.post("/api/stop/:runId", (req, res) => {
  const run = activeRuns.get(req.params.runId);
  if (run) { run.status = "stopped"; saveRunToDisk(req.params.runId); cleanupRun(req.params.runId); res.json({ ok: true }); }
  else res.status(404).json({ error: "Run not found" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n  🧪 ElevenLabs Agent Tester → http://localhost:${PORT}\n`));
