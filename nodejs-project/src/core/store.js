// Small JSON stores in the app's data folder: saved TVs, settings, undo records.
"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

let baseDir = "";

function init(userDataDir) {
  baseDir = path.join(userDataDir, "tvsetup");
}

function file(name) {
  if (!baseDir) throw new Error("store not initialised");
  return path.join(baseDir, name);
}

async function readJson(name, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file(name), "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(name, value) {
  await fsp.mkdir(baseDir, { recursive: true });
  const target = file(name);
  const temp = `${target}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2));
  await fsp.rename(temp, target);
}

// ---- Saved TVs ------------------------------------------------------------------------
// { id, platform, profile, name, model, ip, lastSetup, choices, notes }

async function listDevices() {
  const devices = await readJson("devices.json", []);
  return devices.sort((left, right) => (right.lastUsed || 0) - (left.lastUsed || 0));
}

async function saveDevice(device) {
  const devices = await readJson("devices.json", []);
  const id = device.id || `${device.platform}-${String(device.serial || device.ip || Date.now()).replace(/[^a-z0-9.-]+/gi, "_")}`;
  const index = devices.findIndex((item) => item.id === id);
  const merged = { ...(index >= 0 ? devices[index] : {}), ...device, id, lastUsed: Date.now() };
  if (index >= 0) devices[index] = merged; else devices.push(merged);
  await writeJson("devices.json", devices);
  return merged;
}

async function removeDevice(id) {
  const devices = await readJson("devices.json", []);
  await writeJson("devices.json", devices.filter((item) => item.id !== id));
}

async function getDevice(id) {
  return (await readJson("devices.json", [])).find((item) => item.id === id) || null;
}

// ---- Settings -------------------------------------------------------------------------

const defaultSettings = {
  autoPrepare: true,
  prepareAllPlatforms: false,
  lgAutoExtend: true
};

async function getSettings() {
  return { ...defaultSettings, ...(await readJson("settings.json", {})) };
}

async function setSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  await writeJson("settings.json", next);
  return next;
}

// ---- Undo records (per TV) -----------------------------------------------------------
// Written BEFORE a change reaches the TV, so an interrupted run can still be undone.

async function getUndo(deviceKey) {
  const all = await readJson("undo.json", {});
  return all[deviceKey] || { disabled: [], stockLauncher: "", homeMode: "", settings: {}, accessibility: null };
}

async function updateUndo(deviceKey, mutate) {
  const all = await readJson("undo.json", {});
  const current = all[deviceKey] || { disabled: [], stockLauncher: "", homeMode: "", settings: {}, accessibility: null };
  all[deviceKey] = mutate(current) || current;
  await writeJson("undo.json", all);
  return all[deviceKey];
}

async function clearUndo(deviceKey) {
  const all = await readJson("undo.json", {});
  delete all[deviceKey];
  await writeJson("undo.json", all);
}

module.exports = {
  init, readJson, writeJson,
  listDevices, saveDevice, removeDevice, getDevice,
  getSettings, setSettings,
  getUndo, updateUndo, clearUndo
};
