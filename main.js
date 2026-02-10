const { app, BrowserWindow, shell } = require("electron");
const path = require("path");
const fs = require("fs");

// ─── Paths auflösen ───────────────────────────────────────────────────────────
// Diese Env-Variablen werden von server-electron.js ausgelesen
function setupEnv() {
  process.env.ELECTRON_MODE = "true";
  process.env.ELECTRON_USER_DATA = app.getPath("userData");

  // Ressourcen-Pfad: im Build ist das process.resourcesPath,
  // im Dev-Modus (electron .) ist es der Projektordner selbst
  const isDev = !app.isPackaged;
  process.env.ELECTRON_RESOURCES = isDev
    ? path.join(__dirname)
    : process.resourcesPath;

  // Sicherstellen dass userData/data existiert
  const dataDir = path.join(process.env.ELECTRON_USER_DATA, "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  // Falls noch keine config.local.json im userData vorhanden, Template kopieren
  const userCfg = path.join(process.env.ELECTRON_USER_DATA, "config.local.json");
  if (!fs.existsSync(userCfg)) {
    // Im Build liegt das Template in resources/, im Dev im Projektordner
    const templateCandidates = [
      path.join(process.env.ELECTRON_RESOURCES, "config.local.json"),
      path.join(__dirname, "example_config_local.json"),
      path.join(__dirname, "example.config.local.json"),
    ];
    for (const t of templateCandidates) {
      if (fs.existsSync(t)) {
        fs.copyFileSync(t, userCfg);
        break;
      }
    }
  }
}

// ─── Server starten ───────────────────────────────────────────────────────────
let serverStarted = false;
function startServer() {
  if (serverStarted) return;
  serverStarted = true;
  try {
    require("./server-electron");
  } catch (err) {
    console.error("Server konnte nicht gestartet werden:", err);
  }
}

// ─── Fenster erstellen ────────────────────────────────────────────────────────
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: "Agent Tester – ElevenLabs",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Kein preload nötig – alles läuft über HTTP-API
    },
    show: false, // erst anzeigen wenn geladen
  });

  // Externe Links im Systembrowser öffnen
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  // Kurz warten bis der Express-Server hochgefahren ist
  const PORT = process.env.PORT || 3000;

  function tryLoad(attempt = 0) {
    mainWindow.loadURL(`http://localhost:${PORT}`).catch(() => {
      if (attempt < 10) {
        setTimeout(() => tryLoad(attempt + 1), 300);
      }
    });
  }

  // Nach 800ms laden (Server braucht kurz zum Starten)
  setTimeout(() => tryLoad(), 800);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Dev-Tools nur im Dev-Modus
  if (!app.isPackaged) {
    // mainWindow.webContents.openDevTools();
  }
}

// ─── App-Lifecycle ────────────────────────────────────────────────────────────
setupEnv();
startServer();

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
