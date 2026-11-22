// LG webOS setup through the Developer Mode app: fetch the TV's SSH key from its key server,
// SSH in as "prisoner" on port 9922, upload the IPK over SFTP, install it with the same
// appInstallService call ares-install uses, and keep the Developer Mode session alive.
"use strict";

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const { Client } = require("ssh2");
const assets = require("../core/assets");
const store = require("../core/store");

const NUVIO_ID = "space.nuvio.native.legacy";
const TEMP_DIR = "/media/developer/temp";

function httpGet(url, timeoutMs = 6000) {
  const lib = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const request = lib.get(url, { timeout: timeoutMs, headers: { "User-Agent": "TV-Setup-App" } }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, body }));
    });
    request.on("timeout", () => { request.destroy(); reject(new Error("timed out")); });
    request.on("error", reject);
  });
}

async function fetchKey(ip) {
  try {
    const { status, body } = await httpGet(`http://${ip}:9991/webos_rsa`);
    if (status !== 200 || !/PRIVATE KEY/.test(body)) throw new Error(`key server answered ${status}`);
    return body;
  } catch (error) {
    throw new Error(`Couldn't get the TV's key. In the Developer Mode app, turn on Key Server (${error.message}).`);
  }
}

function connect(ip, privateKey, passphrase) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    client.once("ready", () => resolve(client));
    client.once("error", (error) => {
      const message = String(error?.message || error);
      if (/passphrase|decrypt|bad decrypt|Encrypted/i.test(message)) reject(new Error("That passphrase didn't unlock the key. Check the 6 letters in the Developer Mode app (they're case-sensitive)."));
      else if (/ECONNREFUSED/.test(message)) reject(new Error("The TV refused SSH on port 9922. In the Developer Mode app, make sure Dev Mode Status is ON (the TV restarts when you turn it on)."));
      else if (/authentication/i.test(message)) reject(new Error("The TV didn't accept the key. Turn Key Server off and on in the Developer Mode app, then try again."));
      else reject(new Error(`Couldn't connect to the TV: ${message}`));
    });
    try {
      client.connect({
        host: ip,
        port: 9922,
        username: "prisoner",
        privateKey,
        passphrase,
        readyTimeout: 20000,
        keepaliveInterval: 10000,
        algorithms: {
          serverHostKey: ["ssh-rsa", "rsa-sha2-256", "rsa-sha2-512", "ecdsa-sha2-nistp256", "ssh-ed25519"]
        }
      });
    } catch (error) {
      reject(new Error(/passphrase|decrypt/i.test(error.message) ? "That passphrase didn't unlock the key. Check the 6 letters in the Developer Mode app." : error.message));
    }
  });
}

function exec(client, command, { timeoutMs = 60000, until } = {}) {
  return new Promise((resolve, reject) => {
    client.exec(command, (error, stream) => {
      if (error) { reject(error); return; }
      let out = "";
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); try { stream.close(); } catch {} fn(value); };
      const timer = setTimeout(() => finish(reject, new Error(`The TV didn't finish in ${Math.round(timeoutMs / 1000)}s.`)), timeoutMs);
      stream.on("data", (chunk) => {
        out += chunk.toString("utf8");
        if (until) {
          const verdict = until(out);
          if (verdict === true) finish(resolve, out);
          else if (verdict instanceof Error) finish(reject, verdict);
        }
      });
      stream.stderr.on("data", (chunk) => { out += chunk.toString("utf8"); });
      stream.on("close", () => finish(resolve, out));
    });
  });
}

function upload(client, localPath, remotePath, onProgress) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) { reject(new Error(`The TV didn't open file transfer: ${error.message}`)); return; }
      sftp.fastPut(localPath, remotePath, { step: (transferred, _chunk, total) => onProgress && onProgress(transferred, total) }, (putError) => {
        sftp.end();
        if (putError) reject(new Error(`Upload failed: ${putError.message}`));
        else resolve();
      });
    });
  });
}

async function installIpk(client, ipkPath, onProgress) {
  const remote = `${TEMP_DIR}/tvsetup.ipk`;
  await exec(client, `mkdir -p ${TEMP_DIR}; rm -f ${remote}`).catch(() => {});
  await upload(client, ipkPath, remote, onProgress);
  const payload = JSON.stringify({ id: "com.ares.defaultName", ipkUrl: remote, subscribe: true });
  const output = await exec(client, `luna-send-pub -i -f luna://com.webos.appInstallService/dev/install '${payload}'`, {
    timeoutMs: 6 * 60 * 1000,
    until: (text) => {
      if (/"state"\s*:\s*"installed"/i.test(text)) return true;
      const failed = text.match(/"state"\s*:\s*"(?:install failed|failed)[^"]*"|"errorText"\s*:\s*"([^"]+)"|"returnValue"\s*:\s*false/i);
      if (failed) return new Error(`The TV refused the install${failed[1] ? `: ${failed[1]}` : ""}.`);
      return false;
    }
  });
  await exec(client, `rm -f ${remote}`).catch(() => {});
  return output;
}

async function launchApp(client, appId) {
  return exec(client, `luna-send-pub -n 1 -f luna://com.webos.applicationManager/launch '${JSON.stringify({ id: appId })}'`, { timeoutMs: 20000 });
}

async function readSessionToken(client) {
  const out = await exec(client, "cat /var/luna/preferences/devmode_enabled 2>/dev/null", { timeoutMs: 10000 }).catch(() => "");
  return out.trim().match(/^[A-Za-z0-9+/=_-]{8,}$/) ? out.trim() : "";
}

// "Developer Mode" sessions expire after ~50 hours unless extended; apps stop opening when they do.
async function extendSession(token) {
  if (!token) throw new Error("No Developer Mode session token saved for this TV yet.");
  const reset = await httpGet(`https://developer.lge.com/secure/ResetDevModeSession.dev?sessionToken=${encodeURIComponent(token)}`, 15000);
  const check = await httpGet(`https://developer.lge.com/secure/CheckDevModeSession.dev?sessionToken=${encodeURIComponent(token)}`, 15000).catch(() => null);
  let remaining = "";
  try { remaining = JSON.parse(check?.body || "{}").errorMsg || ""; } catch {}
  let resetOk = false;
  try { resetOk = JSON.parse(reset.body).result === "success"; } catch {}
  if (!resetOk && !/^\d+:\d\d:\d\d$/.test(remaining)) throw new Error("LG didn't accept the session token. Open the Developer Mode app on the TV and sign in again.");
  return { remaining };
}

async function inspect({ ip, passphrase }) {
  const saved = (await store.getDevice(`lg-${ip}`))?.lg || {};
  passphrase = passphrase || saved.passphrase || "";
  if (!passphrase) throw new Error("Enter the 6-character passphrase from the Developer Mode app.");
  const key = await fetchKey(ip).catch((error) => { if (saved.key) return saved.key; throw error; });
  const client = await connect(ip, key, passphrase);
  try {
    const info = await exec(client, "cat /var/run/nyx/os_info.json 2>/dev/null; echo; luna-send-pub -n 1 -f luna://com.webos.service.tv.systemproperty/getSystemInfo '{\"keys\":[\"modelName\",\"sdkVersion\",\"firmwareVersion\"]}' 2>/dev/null", { timeoutMs: 15000 }).catch(() => "");
    const model = (info.match(/"modelName"\s*:\s*"([^"]+)"/) || [])[1] || "";
    const webos = (info.match(/"webos_release"\s*:\s*"([^"]+)"/) || info.match(/"sdkVersion"\s*:\s*"([^"]+)"/) || [])[1] || "";
    const apps = await exec(client, `luna-send-pub -n 1 -f luna://com.webos.applicationManager/getAppInfo '{"id":"${NUVIO_ID}"}'`, { timeoutMs: 15000 }).catch(() => "");
    const installedVersion = (apps.match(/"version"\s*:\s*"([^"]+)"/) || [])[1] || "";
    const token = await readSessionToken(client);
    const deviceKey = `lg-${ip}`;
    await store.saveDevice({ id: deviceKey, platform: "lg", profile: "lg", ip, name: model ? `LG ${model}` : "LG TV", model, os: webos ? `webOS ${webos}` : "webOS", lg: { key, passphrase, token } });
    return {
      platform: "lg", profile: "lg", ip, deviceKey,
      name: model ? `LG ${model}` : "LG TV", model, os: webos ? `webOS ${webos}` : "webOS",
      installed: { nuvio: installedVersion ? [NUVIO_ID] : [], nuvioVersion: installedVersion },
      sessionTokenSaved: Boolean(token),
      recommendations: { nuvio: "nuvio-legacy-lg" }
    };
  } finally {
    client.end();
  }
}

function stepsFor(choices) {
  const steps = [{ id: "connect", label: "Connect to the TV" }];
  if (choices.nuvio !== "skip") steps.push({ id: "nuvio", label: "Install Nuvio Legacy" });
  steps.push({ id: "session", label: "Keep Developer Mode from expiring" });
  steps.push({ id: "finish", label: "Open Nuvio" });
  return steps;
}

async function run({ ip, choices, passphrase }, job) {
  let client;
  const deviceKey = `lg-${ip}`;
  const saved = (await store.getDevice(deviceKey))?.lg || {};
  await job.run("connect", async (step) => {
    step.detail("Getting the TV's key…");
    const key = await fetchKey(ip).catch((error) => { if (saved.key) return saved.key; throw error; });
    step.detail("Signing in to the TV…");
    client = await connect(ip, key, passphrase || saved.passphrase);
    await store.saveDevice({ id: deviceKey, platform: "lg", profile: "lg", ip, lg: { ...saved, key, passphrase: passphrase || saved.passphrase } });
    return "Connected";
  });
  try {
    if (choices.nuvio !== "skip") {
      await job.run("nuvio", async (step) => {
        const started = Date.now();
        const file = await assets.get("nuvio-legacy-lg", choices.nuvio === "highcache" ? "highcache" : "default", {
          onProgress: (received, total) => total && step.progress(received / total * 0.5, `Downloading, ${(received / 1048576).toFixed(1)} of ${(total / 1048576).toFixed(1)} MB`)
        });
        const uploadStarted = Date.now();
        await installIpk(client, file.path, (sent, total) => {
          const seconds = Math.max(0.5, (Date.now() - uploadStarted) / 1000);
          step.progress(0.5 + sent / total * 0.4, `Uploading to the TV, ${(sent / 1048576).toFixed(1)} of ${(total / 1048576).toFixed(1)} MB at ${(sent / 1048576 / seconds).toFixed(1)} MB/s`);
        });
        job.log(`Download+install took ${Math.round((Date.now() - started) / 1000)}s.`);
        return `Nuvio Legacy ${file.tag} installed`;
      });
    }
    await job.run("session", async () => {
      const token = await readSessionToken(client) || saved.token;
      if (!token) return "Couldn't read the session token; extend it from the Developer Mode app when it runs low.";
      await store.saveDevice({ id: deviceKey, platform: "lg", profile: "lg", ip, lg: { ...saved, ...(await store.getDevice(deviceKey))?.lg, token } });
      const { remaining } = await extendSession(token).catch((error) => { job.log(error.message); return { remaining: "" }; });
      return remaining ? `Session extended (${remaining} left). The app extends it each time it opens.` : "Token saved; the app extends the session each time it opens.";
    }, { optional: true });
    await job.run("finish", async () => {
      await launchApp(client, NUVIO_ID);
      await store.saveDevice({ id: deviceKey, platform: "lg", profile: "lg", ip, lastSetup: Date.now() });
      return "Nuvio is opening on the TV";
    }, { optional: true });
  } finally {
    client?.end();
  }
  return { deviceKey };
}

// Called when the phone app opens: extends every saved LG TV's session over the internet.
async function extendAll(log = () => {}) {
  const results = [];
  for (const device of await store.listDevices()) {
    if (device.platform !== "lg" || !device.lg?.token) continue;
    try {
      const { remaining } = await extendSession(device.lg.token);
      await store.saveDevice({ id: device.id, lgSession: { extendedAt: Date.now(), remaining } });
      results.push({ id: device.id, ok: true, remaining });
    } catch (error) {
      log(`${device.name}: ${error.message}`);
      results.push({ id: device.id, ok: false, error: error.message });
    }
  }
  return results;
}

module.exports = { inspect, run, stepsFor, extendAll, extendSession, fetchKey, connect, exec, installIpk, NUVIO_ID };
