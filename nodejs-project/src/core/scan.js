// Finds TVs and streaming boxes on the phone's Wi-Fi by probing well-known ports, then asks
// each one for its name where that's possible without a pairing prompt.
"use strict";

const net = require("node:net");
const http = require("node:http");
const { yearFromModel } = require("../platforms/samsung-year");

// port -> what an open port says about the device
const PROBES = [
  { port: 5555, tag: "adb" },        // Android TV / Google TV / Fire TV with network debugging on
  { port: 26101, tag: "tizen-dev" }, // Samsung with Developer Mode on
  { port: 8001, tag: "samsung" },    // any Samsung Smart TV (REST API)
  { port: 55000, tag: "samsung-legacy" }, // Samsung 2010-2015 remote-control port (Orsay, early Tizen)
  { port: 9922, tag: "webos-dev" },  // LG with Developer Mode on
  { port: 3000, tag: "webos" },      // any LG webOS TV (second-screen API)
  { port: 8008, tag: "cast" }        // Google TV / Android TV / Chromecast / Sony (Cast)
];

function probe(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (open) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function getJson(url, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; if (body.length > 200000) request.destroy(); });
      response.on("end", () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
    request.on("timeout", () => { request.destroy(); resolve(null); });
    request.on("error", () => resolve(null));
  });
}

async function identify(host, tags) {
  const info = { ip: host, tags, name: "", model: "", maker: "", platform: "", devMode: false, os: "" };
  if (tags.includes("samsung") || tags.includes("tizen-dev") || tags.includes("samsung-legacy")) {
    info.platform = "samsung";
    info.maker = "Samsung";
    info.devMode = tags.includes("tizen-dev");
    const json = tags.includes("samsung") || tags.includes("tizen-dev") ? await getJson(`http://${host}:8001/api/v2/`) : null;
    if (json?.device) {
      info.name = json.device.name || json.name || "";
      info.model = json.device.modelName || json.device.model || "";
      info.os = json.device.OS || "Tizen";
      info.apiModel = String(json.device.model || "");
    } else {
      // 2015 sets answer the older multiscreen API; 2010-2014 sets only have the remote port.
      const ms = tags.includes("samsung") ? await getJson(`http://${host}:8001/ms/1.0/`) : null;
      if (ms) { info.name = ms.DeviceName || ms.name || ""; info.model = ms.ModelName || ms.Model || ""; info.os = "Tizen"; }
      if (!info.model && tags.includes("samsung-legacy")) { info.legacy = true; info.os = "Smart Hub (2015 or older)"; }
    }
    const age = yearFromModel(info.model, info.apiModel);
    info.year = age.year;
    if (info.legacy || (age.year && age.year < 2018)) info.tooOld = true;
  } else if (tags.includes("webos") || tags.includes("webos-dev")) {
    info.platform = "lg";
    info.maker = "LG";
    info.devMode = tags.includes("webos-dev");
    info.os = "webOS";
  } else if (tags.includes("adb") || tags.includes("cast")) {
    info.platform = "android";
    info.devMode = tags.includes("adb");
    const json = tags.includes("cast") ? await getJson(`http://${host}:8008/setup/eureka_info?params=name,device_info,build_info`) : null;
    if (json) {
      info.name = json.name || "";
      info.model = json.device_info?.model_name || "";
      info.maker = json.device_info?.manufacturer || "";
      info.os = json.build_info?.cast_build_revision ? "Google Cast" : "";
    }
  }
  info.profile = guessProfile(info);
  return info;
}

function guessProfile(info) {
  const text = `${info.maker} ${info.model} ${info.name}`.toLowerCase();
  if (info.platform === "samsung") return info.tooOld ? "samsung-old" : "samsung";
  if (info.platform === "lg") return "lg";
  if (/nvidia|shield/.test(text)) return "shield";
  if (/\bonn\b|walmart/.test(text)) return "onn";
  if (/sony|bravia/.test(text)) return "sony";
  if (/amazon|fire ?tv|aft/.test(text)) return "firetv";
  if (/chromecast|google tv streamer/.test(text)) return "chromecast";
  if (info.platform === "android") return "androidtv";
  return "";
}

// subnetIp: the phone's Wi-Fi IPv4, e.g. 192.168.86.163. Scans the /24.
async function scan(subnetIp, { onProgress, onFound, timeoutMs = 450, concurrency = 96 } = {}) {
  const match = String(subnetIp || "").match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error("Connect the phone to the TV's Wi-Fi network first.");
  const prefix = `${match[1]}.${match[2]}.${match[3]}.`;
  const self = Number(match[4]);
  const tasks = [];
  for (let host = 1; host <= 254; host += 1) {
    if (host === self) continue;
    for (const probeDef of PROBES) tasks.push({ host: `${prefix}${host}`, ...probeDef });
  }
  const open = new Map();
  let completed = 0;
  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      if (await probe(task.host, task.port, timeoutMs)) {
        if (!open.has(task.host)) open.set(task.host, []);
        open.get(task.host).push(task.tag);
      }
      completed += 1;
      if (onProgress && completed % 40 === 0) onProgress(completed / tasks.length);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const results = [];
  for (const [host, tags] of open) {
    // A router or NAS with only port 3000/8001 open is not a TV: require a TV-specific signal.
    const tvLike = tags.some((tag) => ["adb", "tizen-dev", "webos-dev", "cast", "samsung-legacy"].includes(tag)) ||
      (tags.includes("samsung") && tags.length >= 1) || (tags.includes("webos") && tags.length >= 1);
    if (!tvLike) continue;
    const info = await identify(host, tags);
    if (info.platform === "samsung" && !info.model && !tags.includes("tizen-dev") && !tags.includes("samsung-legacy")) continue;
    results.push(info);
    if (onFound) onFound(info);
  }
  if (onProgress) onProgress(1);
  return results.sort((left, right) => Number(left.ip.split(".").pop()) - Number(right.ip.split(".").pop()));
}

async function check(address, platform) {
  const [host, customPort] = String(address).split(":");
  const ports = { android: [Number(customPort) || 5555], samsung: [26101, 8001], "samsung-old": [26101, 8001, 55000], lg: [9922, 3000, 9991] }[platform] || [];
  const out = {};
  await Promise.all(ports.map(async (port) => { out[port] = await probe(host, port, 1500); }));
  if (platform === "android" && customPort) out[5555] = out[Number(customPort)];
  return out;
}

module.exports = { scan, identify, check, guessProfile, PROBES };
