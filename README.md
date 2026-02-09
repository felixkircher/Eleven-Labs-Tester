# ElevenLabs Agent Tester

Web-App zum automatisierten Testen von ElevenLabs Conversational AI Agents (Praxis-Bot ↔ Patient-Bot).

## Setup

```bash
npm install
npm start
```

Server läuft auf `http://localhost:3000` (oder `PORT` env-Variable).

## Features

- **Kein Node-RED nötig** — läuft standalone als Node.js Server
- **Multi-User** — jeder Test-Run bekommt eine eigene ID, mehrere Nutzer können gleichzeitig testen
- **Kein Login** — API Key wird nur im Browser-Session gespeichert und pro Request an den Server geschickt
- **Live-Transcript** — SSE-Stream zeigt Konversation in Echtzeit
- **Szenario-Management** — Szenarien erstellen, bearbeiten, löschen, importieren/exportieren als JSON
- **Download** — Transcript als .txt herunterladen

## Szenario-JSON Format

```json
[
  {
    "name": "Terminvereinbarung Neupatient",
    "prompt": "Du bist Max Mustermann, geboren am 12.05.1980..."
  },
  {
    "name": "Rezeptbestellung",
    "prompt": "Du bist Lisa Müller..."
  }
]
```

## Konfiguration

| Feld | Beschreibung |
|------|-------------|
| API Key | ElevenLabs API Key (`xi-…`) |
| Praxis-Agent ID | Agent-ID des Praxis-Bots |
| Patient-Agent ID | Agent-ID des Test-Patienten (Prompt wird pro Szenario überschrieben) |
| Region | `eu` oder `us` |
| Max Turns | Maximale Gesprächsrunden pro Szenario |
| Silence (ms) | Wartezeit bis eine Antwort als vollständig gilt |

## Deployment

Für Produktion empfohlen: hinter einem Reverse-Proxy (nginx/caddy) mit HTTPS.

```bash
PORT=8080 node server.js
```

Oder mit PM2:

```bash
pm2 start server.js --name agent-tester
```
