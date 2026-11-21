// Minimal stand-in for the Electron APIs used by the upstream installer
// (src/main.js), so the same Samsung logic runs under nodejs-mobile on Android.
const path = require("node:path");
const { EventEmitter } = require("node:events");

const handlers = new Map();
const bus = new EventEmitter();

const dataDir = process.env.NUVIO_DATA_DIR || path.join(__dirname, "..", "data");

const app = Object.assign(new EventEmitter(), {
  setName() {},
  getName() {
    return "Nuvio TV Installer";
  },
  setAppUserModelId() {},
  getPath(name) {
    if (name === "userData") return path.join(dataDir, "userData");
    if (name === "appData") return dataDir;
    if (name === "temp") return path.join(dataDir, "tmp");
    return dataDir;
  },
  whenReady() {
    return Promise.resolve();
  },
  quit() {}
});

class BrowserWindow {
  constructor() {}
  loadFile() {}
  static getAllWindows() {
    return [];
  }
  static fromWebContents() {
    return null;
  }
}

const ipcMain = {
  handle(channel, handler) {
    handlers.set(channel, handler);
  }
};

const shell = {
  openExternal(url) {
    // The Android UI listens for this and opens the Samsung login in-app.
    bus.emit("message", "installer:openExternal", { url });
    return Promise.resolve();
  }
};

const clipboard = {
  writeText(text) {
    bus.emit("message", "installer:clipboard", { text: String(text || "") });
  }
};

const dialog = {
  async showOpenDialog() {
    return { canceled: true, filePaths: [] };
  },
  async showMessageBox() {
    return { response: 1 };
  }
};

module.exports = { app, BrowserWindow, clipboard, dialog, ipcMain, shell, handlers, bus };
