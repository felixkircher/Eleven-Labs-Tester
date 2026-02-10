# HowTo – ElevenLabs Agent Tester

Dieses Tool testet zwei ElevenLabs Conversational AI Agents automatisch gegeneinander: einen **Praxis-Bot** (der echte Empfangsbot) und einen **Patienten-Bot** (der simulierte Anrufer). Pro Szenario übernimmt der Patienten-Bot eine andere Rolle und führt das Gespräch bis zum Ende.

---

## 1. Voraussetzungen

- **Node.js** ≥ 18
- Ein **ElevenLabs-Account** mit zwei konfigurierten Conversational AI Agents
- Dein **API Key** (`xi-…`) aus dem ElevenLabs-Dashboard

---

## 2. Installation & Start

```bash
git clone https://github.com/felixkircher/elevenlabs-tester.git
cd elevenlabs-tester
npm install
npm start
```

Der Server läuft dann auf **http://localhost:3000** (oder über die Umgebungsvariable `PORT`).

---

## 3. Lokale Konfiguration (optional)

Damit API Key und Agent-IDs beim Neustart nicht neu eingegeben werden müssen, kannst du eine `config.local.json` anlegen:

```json
{
  "apiKey": "xi-…",
  "docAgentId": "agent_xy",
  "patientAgentId": "agent_yz",
  "maxTurns": 30,
  "silenceTime": 4000
}
```

> ⚠️ Diese Datei enthält sensible Daten — **nicht committen!**  
> In die `.gitignore` eintragen: `config.local.json`

Die Werte aus dieser Datei werden beim Start automatisch ins Formular geladen. Eingaben im Browser überschreiben sie für die aktuelle Session.

---

## 4. Konfigurationsfelder

| Feld | Beschreibung |
|---|---|
| **API Key** | ElevenLabs API Key (`xi-…`) |
| **Praxis-Agent ID** | Agent-ID des echten Empfangsbots |
| **Patient-Agent ID** | Agent-ID des Test-Patienten — der Prompt wird vor jedem Szenario automatisch überschrieben |
| **Max Turns** | Maximale Anzahl Gesprächsrunden pro Szenario (Standard: 30) |
| **Silence (ms)** | Wartezeit in Millisekunden, nach der eine Antwort als vollständig gilt und weitergeleitet wird (Standard: 2000 ms) |

---

## 5. Base-Prompt (Patient)

Der Base-Prompt enthält allgemeine Verhaltensregeln für den Patienten-Bot, die für *alle* Szenarien gelten — z. B. „Antworte natürlich", „Gib Infos nicht sofort preis" usw.

- Der Toggle oben rechts **aktiviert/deaktiviert** den Base-Prompt global
- Pro Szenario kann er mit `use_base_prompt: false` individuell abgeschaltet werden (z. B. für Off-Topic-Tests)
- Der finale Prompt, der an den Agenten gesendet wird, ist: `[Base-Prompt] + --- + Szenario: [Szenario-Prompt]`

---

## 6. Szenarien

### 6.1 Szenarien auswählen

Jeder aktive Szenario-Card hat eine **Checkbox** links. Nur angehakte Szenarien werden bei „▶ Alle testen" ausgeführt.

- **☑** oben → alle auswählen
- **☐** oben → alle abwählen
- Das Badge `X / Y ausgewählt` zeigt die aktuelle Auswahl an
- Der Start-Button zeigt dynamisch `▶ Alle testen (X)` oder `▶ Auswahl testen (X)`

### 6.2 Szenario erstellen

Klicke auf **`+`** oben rechts in der Szenarienliste:
- **Name** — Anzeigename (z. B. `01 · Neupatient – Terminvereinbarung`)
- **Patienten-Prompt** — Beschreibt die Rolle, die der Patienten-Bot übernehmen soll
- **Base-Prompt verwenden** — Toggle, ob der globale Base-Prompt für dieses Szenario aktiv ist

### 6.3 Szenario bearbeiten

Klicke auf einen Szenario-Card (nicht auf die Buttons) → das Bearbeitungs-Modal öffnet sich.

### 6.4 Szenario löschen

Klicke auf **`×`** im Card → unwiderruflich gelöscht.

### 6.5 Szenarien archivieren

Klicke auf **`⊟`** im Card → das Szenario verschwindet aus der aktiven Liste und wird im **Archiv** am Ende der Liste abgelegt.

- Das Archiv ist eingeklappt und kann mit einem Klick auf **„Archiv (N)"** geöffnet werden
- Archivierte Szenarien nehmen **nicht** an Testläufen teil
- Mit **`↩`** (Wiederherstellen) kommt ein Szenario zurück in die aktive Liste
- Archivierte Szenarien werden beim JSON-Export **nicht** mitexportiert

### 6.6 Szenarien importieren / exportieren

**Export:** Klicke auf **`↓`** — speichert alle aktiven (nicht archivierten) Szenarien als `scenarios.json`.

**Import:** Klicke auf **`↑`** — wähle eine `.json`-Datei. Format:

```json
[
  {
    "name": "Terminvereinbarung Neupatient",
    "prompt": "Du bist Max Mustermann, geboren am 12.05.1980…"
  },
  {
    "name": "Off-Topic Test",
    "prompt": "Du fragst nach komplett anderen Dingen…",
    "use_base_prompt": false
  }
]
```

Importierte Szenarien werden zur bestehenden Liste **hinzugefügt** (nicht ersetzt).

---

## 7. Test ausführen

### 7.1 Alle (ausgewählten) Szenarien testen

Klicke **`▶ Alle testen`** bzw. **`▶ Auswahl testen (X)`** — der Server:
1. Aktualisiert den Patienten-Agenten-Prompt via ElevenLabs API
2. Verbindet beide Agents per WebSocket
3. Startet das Gespräch (Praxis begrüßt zuerst)
4. Leitet Nachrichten hin und her, bis ein Abbruchkriterium erfüllt ist
5. Speichert den Transcript und wechselt automatisch zum nächsten Szenario

### 7.2 Einzelnes Szenario testen

Klicke auf **`▶`** im jeweiligen Card — läuft sofort, unabhängig von der Checkbox-Auswahl.

### 7.3 Szenario überspringen

Während ein Test läuft, erscheint der **`⭭`-Button** — klicke ihn, um das aktuelle Szenario abzubrechen und zum nächsten zu springen.

### 7.4 Test stoppen

**`■ Stopp`** beendet den gesamten Testlauf sofort. Das bereits laufende Szenario wird abgebrochen.

---

## 8. Abbruchkriterien pro Szenario

| Grund | Bedeutung |
|---|---|
| `patient_disconnected` | Patient hat aufgelegt (normales Ende) |
| `praxis_disconnected` | Praxis hat aufgelegt (normales Ende) |
| `max_turns` | Maximale Turnanzahl erreicht |
| `loop_detected` | Loop erkannt (3× identisch, per-Agent-Wiederholung, Ping-Pong) |
| `timeout` | Szenario läuft > 5 Minuten ohne Ende |
| `skipped` | Manuell übersprungen |
| `ws_error` | WebSocket-Verbindungsfehler |

---

## 9. Transcript, Log & Historie

### Transcript-Tab
Live-Ansicht des Gesprächs. Praxis-Nachrichten erscheinen links (blau), Patienten-Nachrichten rechts (orange). Systemnachrichten erscheinen zentriert.

### System Log-Tab
Technisches Log aller Serveraktionen: Verbindungsaufbau, Prompt-Updates, Loop-Erkennungen, Fehler.

### Historie-Tab
Alle abgeschlossenen Test-Runs werden automatisch gespeichert (unter `/data/`). Klicke auf einen Run, um den vollständigen Transcript nachzulesen. Runs können exportiert (`.txt`) oder gelöscht werden.

---

## 10. Export

- **`⬇ Export`** (oben rechts) — exportiert den aktuellen Transcript als `.txt`-Datei  
- Im **Historie-Tab** kann jeder gespeicherte Run einzeln exportiert werden  
- **`⬇`** im Szenario-Modal → JSON-Export aller aktiven Szenarien

---

## 11. Tipps & Hinweise

- **Silence-Zeit erhöhen**, wenn Agents abgeschnitten werden oder Antworten unvollständig wirken (z. B. auf 3000 ms)
- **Max Turns senken** für schnellere Tests (z. B. 10–15 für einfache Szenarien)
- Die **Szenario-Reihenfolge** entspricht der Ausführungsreihenfolge — per Drag & Drop kann noch nicht umgeordnet werden
- Zwischen zwei Szenarien wartet der Server automatisch **2 Sekunden** (Cooldown), damit die Agent-Konfiguration übernommen wird
- Der **API Key** wird nur im `sessionStorage` des Browsers gespeichert — er verlässt das Gerät nur in Richtung ElevenLabs-API
- Die `config.local.json` wird serverseitig gelesen und **niemals** an den Browser weitergegeben — außer den fünf expliziten Konfigurationsfeldern (kein apiKey im Klartext im HTML-Source)

> ⚠️ **Achtung:** Der Patienten-Agent-Prompt wird bei jedem Szenario **dauerhaft** in ElevenLabs überschrieben — nicht nur für die Dauer des Tests. Nach einem Testlauf hat der Agent den Prompt des zuletzt ausgeführten Szenarios.
