// Rooted LG TVs (Homebrew Channel): SSH as root on port 22, then take over the Home button.
//
// Rooting itself is done by the owner with the community tools (RootMyTV, DejaVuln, faultmanager);
// this only checks whether a TV is likely rootable and, once Homebrew Channel has root and SSH on,
// installs TV Home, Nuvio Legacy and LG Input Hook, maps Home (and optionally Netflix / Prime /
// Disney+) to TV Home or Nuvio, and opens TV Home at power-on. Everything it adds is undoable.
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const https = require("node:https");
const path = require("node:path");
const { Client, utils } = require("ssh2");
const store = require("../core/store");
const assets = require("../core/assets");
const lg = require("./lg");
const lgHome = require("./lg-home");

const INPUTHOOK_ID = "org.webosbrew.inputhook";
const INPUTHOOK_URL = "https://github.com/Simon34545/lginputhook/releases/download/v1.5.1/org.webosbrew.inputhook_1.5.1_all.ipk";
const KEYBINDS = "/home/root/.config/lginputhook/keybinds.json";
const BOOT_SCRIPT = "/var/lib/webosbrew/init.d/80-tvsetup-home";
const ELEVATE = "/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service";
const TMP = "/tmp/tvsetup-root.ipk";

// Magic Remote button IDs as Input Hook sees them (its "Button IDs.md"); other remotes can be learnt.
const BUTTONS = { home: 773, netflix: 1037, prime: 1038, disney: 1042 };
const PROTECTED = new Set([103, 108, 105, 106, 272, 412, 115, 114, 113, 116]);

let userDataDir = "";
function init(dir) { userDataDir = dir; }

function sq(value) { return `'${String(value).replace(/'/g, "'\\''")}'`; }

// ---------------------------------------------------------------- rootability (Developer Mode TVs)
function versionParts(text) { return String(text || "").split(/[.-]/).map((n) => parseInt(n, 10) || 0); }
function between(v, lo, hi) {
  const a = versionParts(v); const l = versionParts(lo); const h = versionParts(hi);
  const cmp = (x, y) => { for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
  return cmp(a, l) >= 0 && cmp(a, h) <= 0;
}

// webOS version and firmware -> { level: "likely"|"maybe"|"unlikely"|"rooted", text }
function rootOutlook({ webos, firmware, rooted }) {
  if (rooted) return { level: "rooted", title: "Rooted", text: "Homebrew Channel has root on this TV. Pick LG TV (rooted) in TV Setup to take over the Home button." };
  const [major, minor] = versionParts(webos);
  const fw = String(firmware || "");
  const check = "Confirm the exact firmware at cani.rootmy.tv before trying.";
  if (!major) return { level: "maybe", title: "Unknown", text: `TV Setup couldn't read the webOS version. ${check}` };
  if (major < 3 || (major === 3 && minor < 5)) return { level: "maybe", title: "Possibly, with older tools", text: `webOS ${webos} is older than DejaVuln supports; RootMyTV or Chariot cover some of these. ${check}` };
  if (major === 3 || major === 4) return { level: "likely", title: "Likely rootable", text: `webOS ${webos}: DejaVuln and faultmanager haven't been seen patched on webOS 3.5 to 4.x. ${check}` };
  if (major >= 10 || /^33\./.test(fw)) {
    if (between(fw, "33.22.65", "33.30.97")) return { level: "maybe", title: "Possibly, with a new exploit", text: `Firmware ${fw} is in the range a 2026 kernel exploit (chronomaly-webos) was confirmed on. It's new and less proven than the classic tools. ${check}` };
    return { level: "unlikely", title: "Probably not", text: `webOS ${webos}, firmware ${fw || "unknown"}: no public root for this firmware that TV Setup knows of. ${check}` };
  }
  if (major >= 9) return { level: "unlikely", title: "Probably not", text: `webOS ${webos} (2024 models) shipped with DejaVuln patched, and current firmware is patched for faultmanager too. ${check}` };
  return { level: "maybe", title: "Only on older firmware", text: `webOS ${webos}, firmware ${fw || "unknown"}: LG has patched DejaVuln and faultmanager in recent firmware for webOS 5 to 9, but older firmware still works. ${check}` };
}

// ---------------------------------------------------------------- SSH as root
async function phoneKey() {
  const dir = path.join(userDataDir || ".", "tvsetup");
  const file = path.join(dir, "lg-root-key.json");
  try { return JSON.parse(await fsp.readFile(file, "utf8")); } catch {}
  await fsp.mkdir(dir, { recursive: true });
  const pair = utils.generateKeyPairSync("rsa", { bits: 2048, comment: "tvsetup-phone" });
  const key = { private: pair.private, public: pair.public.trim() };
  await fsp.writeFile(file, JSON.stringify(key), { mode: 0o600 });
  return key;
}

function connectRoot(ip, { password = "alpine", port = 22 } = {}) {
  const [host, p] = String(ip).split(":");
  return phoneKey().then((key) => new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", (error) => {
      const m = String(error?.message || error);
      if (/ECONNREFUSED/.test(m)) reject(new Error("The TV refused SSH on port 22. In Homebrew Channel → Settings, turn on SSH Server and restart the TV."));
      else if (/authentication/i.test(m)) reject(new Error("The TV didn't accept the login. If you set your own root password or SSH key, enter that password; otherwise Homebrew Channel's default is alpine."));
      else reject(new Error(`Couldn't connect to the TV: ${m}`));
    });
    client.connect({
      host, port: Number(p || port), username: "root", privateKey: key.private, password,
      authHandler: ["publickey", "password"], readyTimeout: 20000, keepaliveInterval: 10000
    });
  }));
}

// Upload through `cat` so it works whether or not the TV's SSH server has SFTP.
function putBuffer(client, data, remote, onProgress) {
  return new Promise((resolve, reject) => {
    client.exec(`cat > ${remote}`, (error, stream) => {
      if (error) { reject(error); return; }
      stream.on("close", resolve).on("error", reject);
      // Drain both sides: an unread stream never ends, so "close" would never come.
      stream.on("data", () => {});
      stream.stderr.on("data", () => {});
      let sent = 0;
      const chunk = 256 * 1024;
      const pump = () => {
        while (sent < data.length) {
          const piece = data.subarray(sent, sent + chunk);
          sent += piece.length;
          onProgress?.(sent, data.length);
          if (!stream.write(piece)) { stream.once("drain", pump); return; }
        }
        stream.end();
      };
      pump();
    });
  }).then(async () => {
    const size = (await lg.exec(client, `wc -c < ${remote}`, { timeoutMs: 15000 })).trim();
    if (Number(size) !== data.length) throw new Error(`Upload to the TV came out ${size} of ${data.length} bytes.`);
  });
}

async function installBuffer(client, data, onProgress) {
  await putBuffer(client, data, TMP, onProgress);
  const payload = JSON.stringify({ id: "com.ares.defaultName", ipkUrl: TMP, subscribe: true });
  try {
    return await lg.exec(client, `luna-send -i -f luna://com.webos.appInstallService/dev/install ${sq(payload)}`, {
      timeoutMs: 6 * 60 * 1000,
      until: (text) => {
        if (/"state"\s*:\s*"installed"/i.test(text)) return true;
        const failed = text.match(/"state"\s*:\s*"(?:install failed|failed)[^"]*"|"errorText"\s*:\s*"([^"]+)"|"returnValue"\s*:\s*false/i);
        if (failed) return new Error(`The TV refused the install${failed[1] ? `: ${failed[1]}` : ""}.`);
        return false;
      }
    });
  } finally {
    await lg.exec(client, `rm -f ${TMP}`).catch(() => {});
  }
}

async function appVersion(client, id) {
  const out = await lg.exec(client, `luna-send -n 1 -f luna://com.webos.applicationManager/getAppInfo ${sq(JSON.stringify({ id }))}`, { timeoutMs: 10000 }).catch(() => "");
  return (out.match(/"version"\s*:\s*"([^"]+)"/) || [])[1] || "";
}

function download(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "TV-Setup" }, timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume(); resolve(download(new URL(res.headers.location, url).href, redirects - 1)); return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`Download failed (HTTP ${res.statusCode}).`)); return; }
      const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => resolve(Buffer.concat(chunks))); res.on("error", reject);
    }).on("error", reject).on("timeout", function () { this.destroy(new Error("Download timed out.")); });
  });
}

async function inputHookIpk() {
  const file = path.join(userDataDir || ".", "packages", "inputhook", path.basename(INPUTHOOK_URL));
  try { return await fsp.readFile(file); } catch {}
  const data = await download(INPUTHOOK_URL);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, data);
  return data;
}

async function readKeybinds(client) {
  const out = await lg.exec(client, `cat ${KEYBINDS} 2>/dev/null`, { timeoutMs: 10000 }).catch(() => "");
  try { const j = JSON.parse(out.trim() || "{}"); return j && typeof j === "object" && !Array.isArray(j) ? j : {}; } catch { return {}; }
}

async function writeKeybinds(client, binds) {
  const b64 = Buffer.from(JSON.stringify(binds, null, 1)).toString("base64");
  await lg.exec(client, `mkdir -p $(dirname ${KEYBINDS}) && echo ${b64} | base64 -d > ${KEYBINDS}.new && mv ${KEYBINDS}.new ${KEYBINDS}`, { timeoutMs: 15000 });
}

// ---------------------------------------------------------------- inspect
async function inspect({ ip, password }) {
  const client = await connectRoot(ip, { password: password || "alpine" });
  try {
    const id = (await lg.exec(client, "id -u", { timeoutMs: 8000 })).trim();
    if (id !== "0") throw new Error("Connected, but not as root. Turn on SSH in Homebrew Channel (root status must say ok).");
    const info = await lg.exec(client, "cat /var/run/nyx/os_info.json 2>/dev/null; echo; luna-send -n 1 -f luna://com.webos.service.tv.systemproperty/getSystemInfo '{\"keys\":[\"modelName\",\"firmwareVersion\",\"sdkVersion\"]}' 2>/dev/null", { timeoutMs: 15000 }).catch(() => "");
    const model = (info.match(/"modelName"\s*:\s*"([^"]+)"/) || [])[1] || "";
    const webos = (info.match(/"webos_release"\s*:\s*"([^"]+)"/) || info.match(/"sdkVersion"\s*:\s*"([^"]+)"/) || [])[1] || "";
    const firmware = (info.match(/"firmwareVersion"\s*:\s*"([^"]+)"/) || [])[1] || "";
    // Leave this phone's key on the TV so later connections don't need the password.
    const key = await phoneKey();
    await lg.exec(client, `mkdir -p /home/root/.ssh && chmod 700 /home/root/.ssh && touch /home/root/.ssh/authorized_keys && (grep -qF ${sq(key.public.split(" ")[1])} /home/root/.ssh/authorized_keys || echo ${sq(key.public)} >> /home/root/.ssh/authorized_keys) && chmod 600 /home/root/.ssh/authorized_keys`, { timeoutMs: 10000 });
    const binds = await readKeybinds(client);
    const nuvioVersion = await appVersion(client, lg.NUVIO_ID);
    const homeVersion = await appVersion(client, lgHome.HOME_ID);
    const hookVersion = await appVersion(client, INPUTHOOK_ID);
    const boot = (await lg.exec(client, `[ -x ${BOOT_SCRIPT} ] && echo on`, { timeoutMs: 8000 }).catch(() => "")).includes("on");
    const deviceKey = `lg-${ip}`;
    const name = model ? `LG ${model}` : "LG TV";
    await store.saveDevice({ id: deviceKey, platform: "lg", profile: "lg-rooted", ip, name, model, os: webos ? `webOS ${webos}` : "webOS", lgRoot: { firmware, rooted: true } });
    return {
      platform: "lg", profile: "lg-rooted", rootMode: true, ip, deviceKey, name, model, os: webos ? `webOS ${webos}` : "webOS", firmware,
      installed: { nuvio: nuvioVersion ? [lg.NUVIO_ID] : [], nuvioVersion, home: homeVersion, inputHook: hookVersion },
      takeover: { home: binds[BUTTONS.home]?.id === lgHome.HOME_ID, boot, binds },
      rooted: true,
      recommendations: { nuvio: "nuvio-legacy-lg" }
    };
  } finally {
    client.end();
  }
}

// ---------------------------------------------------------------- take over Home
function stepsFor(choices) {
  const steps = [{ id: "connect", label: "Connect as root" }];
  if (choices.nuvio !== "skip") steps.push({ id: "nuvio", label: "Install Nuvio Legacy" });
  steps.push({ id: "home", label: "Install TV Home" });
  if (choices.takeHome || Object.values(choices.shortcuts || {}).some(Boolean) || choices.extraKeys?.length) steps.push({ id: "hook", label: "Take over the remote's buttons" });
  steps.push({ id: "boot", label: choices.bootHome ? "Open TV Home at power-on" : "Power-on behaviour" });
  steps.push({ id: "finish", label: "Open TV Home" });
  return steps;
}

// Bindings TV Setup owns, so undo removes only these.
function plannedBinds(choices) {
  const out = {};
  if (choices.takeHome) out[BUTTONS.home] = { action: "launch", id: lgHome.HOME_ID };
  for (const [button, target] of Object.entries(choices.shortcuts || {})) {
    if (target && BUTTONS[button]) out[BUTTONS[button]] = { action: "launch", id: target === "nuvio" ? lg.NUVIO_ID : lgHome.HOME_ID };
  }
  for (const k of choices.extraKeys || []) {
    const code = Number(k.code);
    if (Number.isInteger(code) && code > 0 && !PROTECTED.has(code)) out[code] = { action: "launch", id: k.target === "nuvio" ? lg.NUVIO_ID : lgHome.HOME_ID };
  }
  return out;
}

async function run({ ip, choices = {}, password }, job) {
  const deviceKey = `lg-${ip}`;
  let client;
  await job.run("connect", async () => {
    client = await connectRoot(ip, { password: password || "alpine" });
    const id = (await lg.exec(client, "id -u", { timeoutMs: 8000 })).trim();
    if (id !== "0") throw new Error("Connected, but not as root. Check Homebrew Channel's root status.");
    return "Connected as root";
  });
  try {
    if (choices.nuvio !== "skip") {
      await job.run("nuvio", async (step) => {
        const file = await assets.get("nuvio-legacy-lg", choices.nuvio === "highcache" ? "highcache" : "default", {
          onProgress: (received, total) => total && step.progress(received / total * 0.5, `Downloading, ${(received / 1048576).toFixed(1)} of ${(total / 1048576).toFixed(1)} MB`)
        });
        await installBuffer(client, await fsp.readFile(file.path), (sent, total) => step.progress(0.5 + sent / total * 0.4, "Uploading to the TV…"));
        return `Nuvio Legacy ${file.tag} installed`;
      }, { optional: true });
    }
    await job.run("home", async (step) => {
      const present = await lgHome.detectApps((c, cmd, o) => lg.exec(c, cmd.replace(/luna-send-pub/g, "luna-send"), o), client);
      const tiles = lgHome.chooseTiles(present, { listWorked: present.size >= 3 });
      await installBuffer(client, lgHome.buildIpk(tiles), (sent, total) => step.progress(sent / total * 0.8, "Installing TV Home…"));
      return `TV Home installed with ${tiles.length} tiles`;
    });
    const wanted = plannedBinds(choices);
    if (stepsFor(choices).some((step) => step.id === "hook")) {
      await job.run("hook", async (step) => {
        if (!(await appVersion(client, INPUTHOOK_ID))) {
          step.detail("Downloading LG Input Hook…");
          await installBuffer(client, await inputHookIpk(), (sent, total) => step.progress(sent / total * 0.5, "Installing LG Input Hook…"));
        }
        step.detail("Giving Input Hook root…");
        await lg.exec(client, `[ -x ${ELEVATE} ] && ${ELEVATE} ${INPUTHOOK_ID}.service; true`, { timeoutMs: 30000 });
        const existing = await readKeybinds(client);
        const record = (await store.getDevice(deviceKey))?.lgRoot || {};
        for (const code of record.binds || []) if (!(code in wanted)) delete existing[code];
        await writeKeybinds(client, { ...existing, ...wanted });
        await lg.exec(client, `luna-send -n 1 luna://${INPUTHOOK_ID}.service/start '{}' >/dev/null 2>&1; luna-send -n 1 luna://${INPUTHOOK_ID}.service/autostart '{}' >/dev/null 2>&1; true`, { timeoutMs: 30000 });
        await store.saveDevice({ id: deviceKey, lgRoot: { ...record, binds: Object.keys(wanted).map(Number) } });
        const names = Object.keys(wanted).map((c) => Object.entries(BUTTONS).find(([, v]) => v === Number(c))?.[0] || `button ${c}`);
        return `${names.join(", ")} now open ${Object.values(wanted).every((b) => b.id === lgHome.HOME_ID) ? "TV Home" : "TV Home or Nuvio"}`;
      });
    }
    await job.run("boot", async () => {
      if (!choices.bootHome) {
        await lg.exec(client, `rm -f ${BOOT_SCRIPT}`, { timeoutMs: 8000 });
        return "LG's normal power-on";
      }
      const script = `#!/bin/sh\n# TV Setup: open TV Home after the TV starts.\n(sleep 20; luna-send -n 1 luna://com.webos.applicationManager/launch '{"id":"${lgHome.HOME_ID}"}' >/dev/null 2>&1) &\n`;
      await lg.exec(client, `mkdir -p /var/lib/webosbrew/init.d && echo ${Buffer.from(script).toString("base64")} | base64 -d > ${BOOT_SCRIPT} && chmod 755 ${BOOT_SCRIPT}`, { timeoutMs: 10000 });
      return "TV Home opens when the TV turns on";
    });
    await job.run("finish", async () => {
      await lg.exec(client, `luna-send -n 1 luna://com.webos.applicationManager/launch ${sq(JSON.stringify({ id: lgHome.HOME_ID }))}`, { timeoutMs: 20000 });
      await store.saveDevice({ id: deviceKey, platform: "lg", profile: "lg-rooted", ip, lastSetup: Date.now(), choices: { ...choices } });
      return "TV Home is open. Press Home to try it.";
    }, { optional: true });
  } finally {
    client?.end();
  }
  return { deviceKey };
}

// Learn a remote button through Input Hook's log (it must be running).
async function learnButton({ ip, password, seconds = 12 }) {
  const client = await connectRoot(ip, { password: password || "alpine" });
  try {
    const out = await lg.exec(client, `timeout ${seconds} sh -c 'tail -n 0 -F /tmp/lginput-hook-*.log 2>/dev/null' | grep -m 1 -E 'keyid=[0-9]+, state=1'; true`, { timeoutMs: (seconds + 8) * 1000 });
    const code = Number((out.match(/keyid=(\d+), state=1/) || [])[1] || 0);
    if (!code) throw new Error("No button press came through. Make sure LG Input Hook is running (run Take over once), then try again.");
    const name = Object.entries(BUTTONS).find(([, v]) => v === code)?.[0];
    return { code, name: name ? name[0].toUpperCase() + name.slice(1) : `Button ${code}`, protected: PROTECTED.has(code) };
  } finally {
    client.end();
  }
}

async function undo({ ip, password }) {
  const deviceKey = `lg-${ip}`;
  const record = (await store.getDevice(deviceKey))?.lgRoot || {};
  const client = await connectRoot(ip, { password: password || "alpine" });
  try {
    const binds = await readKeybinds(client);
    for (const code of record.binds || []) delete binds[code];
    await writeKeybinds(client, binds);
    await lg.exec(client, `rm -f ${BOOT_SCRIPT}`, { timeoutMs: 8000 });
    await store.saveDevice({ id: deviceKey, lgRoot: { ...record, binds: [] } });
    return { ok: true };
  } finally {
    client.end();
  }
}

module.exports = { init, rootOutlook, inspect, run, stepsFor, plannedBinds, learnButton, undo, connectRoot, BUTTONS, INPUTHOOK_ID, KEYBINDS, BOOT_SCRIPT };
