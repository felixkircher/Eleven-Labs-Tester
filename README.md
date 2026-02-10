# ElevenLabs Agent Tester

Web-App zum automatisierten Testen von ElevenLabs Conversational AI Agents (Praxis-Bot ↔ Patient-Bot).

**Ein genaues How-To ist unten bei [Deployment](#deployment).**

## Setup

```bash
npm install
npm start
```

Server läuft auf `http://localhost:3000` (oder `PORT` env-Variable).

## Features

- **Kein Node-RED nötig** — läuft standalone als Node.js Server
- **Live-Transcript** — SSE-Stream zeigt Konversation in Echtzeit
- **Szenario-Management** — Szenarien erstellen, bearbeiten, löschen, importieren/exportieren als JSON
- **Download** — Transcript als .txt herunterladen

## Szenario-JSON Format

**Beispiel:**

```json
[
  {
    "name": "Terminvereinbarung Neupatient",
    "prompt": "Du bist Max Mustermann, geboren am 12.05.1980..."
  },
  {
    "name": "Rezeptbestellung",
    "prompt": "Du bist Lisa Müller...",
    "use_base_prompt": true|false
  }
]
```

## Konfiguration

| Feld | Beschreibung |
|------|-------------|
| API Key | ElevenLabs API Key (`xi-…`) |
| Praxis-Agent ID | Agent-ID des Praxis-Bots |
| Patient-Agent ID | Agent-ID des Test-Patienten (Prompt wird pro Szenario überschrieben) |
| Max Turns | Maximale Gesprächsrunden pro Szenario |
| Silence (ms) | Wartezeit bis eine Antwort als vollständig gilt |
| Base Prompt (Patient) | Basisprompt für Patienten-Bot (kann mit `use_base_prompt` aktiviert werden) |

### Lokale Konfiguration

#### `config.local.json` 
- enthält sensible Informationen wie API Key und Agent IDs
  - **Nicht committen!** — bitte in `.gitignore` hinzufügen

**Beispiel:**

```json
  {
    "apiKey": "API-KEY_residency_eu",
    "docAgentId": "agent_xy",
    "patientAgentId": "agent_yz",
    "maxTurns": 30,
    "silenceTime": 2000
  }  
```

#### `.gitignore`

**Beispiel:**

```
.gitignore
/node_modules
config.local.json
/data
```
### Deployment 

1. **Repository klonen**
   ```bash
   git clone https://github.com/felixkircher/Eleven-Labs-Tester.git
   cd eleven-labs-tester
   ```

2. **Abhängigkeiten installieren**
   ```bash
   npm install
   ```

3. **Lokale Konfiguration erstellen**
   ```bash
   cp config.local.json.example config.local.json
   ```
   - **Fülle die Felder mit deinen API Keys und Agent IDs**

4. **Git ignorieren**
   ```bash
   cp example.gitignore .gitignore
   ```

4. **Server starten**
   ```bash
   npm start
   ```
   - Server läuft auf `http://localhost:3000`