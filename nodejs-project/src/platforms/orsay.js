// Older Samsung (2011 to 2014, Orsay Smart Hub): builds Nuvio Lite and serves it, plus an optional
// community Plex widget, through the TV's "develop" User App Sync. The TV asks for
// http://<ip>/widgetlist.xml on port 80 only, so the phone listens on 80 when Android allows it
// (Android 13+ with kernel 5.15+, after Google's 2026 Play System Update) and otherwise on 8080,
// where a PC running Orsay Bridge can do the one-time sync.
//
// The same server is also a relay: the TV's 2014 TLS stack can't open modern HTTPS, so Nuvio Lite
// sends addon, poster and stream requests through /proxy, /img and /stream here (or through the
// Orsay Relay Cloudflare Worker, which has the same routes, so the TV doesn't need the phone).
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const JSZip = require("jszip");

const WIDGET_DIR = path.join(__dirname, "..", "..", "orsay", "nuvio_lite");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const CINEMETA = "https://v3-cinemeta.strem.io";
const STREAM_MODES = ["proxy", "http", "resolve", "direct"];

const DEFAULTS = {
  streamAddons: [],
  metaAddon: CINEMETA,
  catalogs: [
    { name: "Popular Movies", addon: CINEMETA, type: "movie", id: "top" },
    { name: "Popular Series", addon: CINEMETA, type: "series", id: "top" },
    { name: "Featured Movies", addon: CINEMETA, type: "movie", id: "imdbRating" },
    { name: "Featured Series", addon: CINEMETA, type: "series", id: "imdbRating" }
  ],
  relayMode: "phone",   // phone | worker | custom
  relayUrl: "",         // for worker/custom, e.g. http://orsay-relay.you.workers.dev
  streamMode: "proxy",
  plexZip: "",          // path of an uploaded Orsay widget zip (Orca's Plex 2.013)
  key: ""
};

let broadcast = () => {};
let store = null;
let server = null;
let serving = { port: 0, ip: "", widgets: {}, startedAt: 0 };
const stats = { widgetlist: 0, downloads: {}, proxy: 0, streams: 0, lastTv: "", lastError: "" };
const cache = new Map();

function init(deps) {
  broadcast = deps.broadcast || broadcast;
  store = deps.store;
}

function emit(kind, detail = {}) {
  try { broadcast("orsay:event", { kind, ...detail, stats: { ...stats } }); } catch {}
}

// ---------------------------------------------------------------- settings
function normalize(input = {}) {
  const cfg = { ...DEFAULTS, ...input };
  cfg.streamAddons = (Array.isArray(cfg.streamAddons) ? cfg.streamAddons : String(cfg.streamAddons || "").split(/\s+/))
    .map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u));
  cfg.catalogs = (Array.isArray(cfg.catalogs) ? cfg.catalogs : []).filter((c) => c && c.addon && c.type && c.id && c.name);
  if (!cfg.catalogs.length) cfg.catalogs = DEFAULTS.catalogs;
  if (!/^https?:\/\//i.test(cfg.metaAddon || "")) cfg.metaAddon = CINEMETA;
  if (!STREAM_MODES.includes(cfg.streamMode)) cfg.streamMode = "proxy";
  if (!["phone", "worker", "custom"].includes(cfg.relayMode)) cfg.relayMode = "phone";
  cfg.relayUrl = String(cfg.relayUrl || "").trim().replace(/\/+$/, "");
  if (!cfg.key) cfg.key = crypto.randomBytes(9).toString("base64url");
  return cfg;
}

async function getConfig() {
  const settings = await store.getSettings();
  return normalize(settings.orsay || {});
}

async function setConfig(patch = {}) {
  const current = await getConfig();
  const next = normalize({ ...current, ...patch });
  await store.setSettings({ orsay: next });
  return next;
}

function phoneIp(hint) {
  if (hint && /^\d+\.\d+\.\d+\.\d+$/.test(hint)) return hint;
  const all = os.networkInterfaces();
  const order = Object.keys(all).sort((a, b) => (/^wlan/.test(b) ? 1 : 0) - (/^wlan/.test(a) ? 1 : 0));
  for (const name of order) {
    for (const addr of all[name] || []) {
      if (addr.family === "IPv4" && !addr.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(addr.address)) return addr.address;
    }
  }
  return "";
}

function relayBase(cfg, ip, port) {
  if (cfg.relayMode !== "phone" && cfg.relayUrl) return cfg.relayUrl.replace(/^https:/i, "http:");
  return `http://${ip}${port === 80 ? "" : `:${port}`}`;
}

// ---------------------------------------------------------------- widgets
async function buildNuvioLite(cfg, relay, phoneRelay = relay) {
  const zip = new JSZip();
  for (const name of await fsp.readdir(WIDGET_DIR)) {
    if (name === "config.js") continue;
    zip.file(name, await fsp.readFile(path.join(WIDGET_DIR, name)));
  }
  const tvConfig = {
    relay,
    phoneRelay, // stream lookups try the phone first: Torrentio refuses cloud relays
    key: cfg.key,
    metaAddon: cfg.metaAddon,
    catalogs: cfg.catalogs,
    streamAddons: cfg.streamAddons,
    streamMode: cfg.streamMode,
    builtAt: new Date().toISOString().slice(0, 16).replace("T", " ")
  };
  zip.file("config.js", `var CFG = ${JSON.stringify(tvConfig, null, 1)};\n`);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 9 } });
}

async function checkWidgetZip(file) {
  const data = await fsp.readFile(file);
  const zip = await JSZip.loadAsync(data);
  const names = Object.keys(zip.files);
  if (!names.some((n) => /(^|\/)config\.xml$/i.test(n))) throw new Error("That zip isn't an Orsay widget (no config.xml inside).");
  if (!names.some((n) => /^config\.xml$/i.test(n))) {
    // Widget wrapped in a folder: TV wants config.xml at the root, so lift it out.
    const prefix = names.find((n) => /config\.xml$/i.test(n)).replace(/config\.xml$/i, "");
    const flat = new JSZip();
    for (const n of names) if (n.startsWith(prefix) && !zip.files[n].dir) flat.file(n.slice(prefix.length), await zip.files[n].async("nodebuffer"));
    return flat.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  }
  return data;
}

async function widgetTable(cfg, relay, phoneRelay) {
  const table = {};
  table.NuvioLite = { title: "Nuvio Lite", desc: "Nuvio-style player for Orsay", data: await buildNuvioLite(cfg, relay, phoneRelay) };
  if (cfg.plexZip && fs.existsSync(cfg.plexZip)) {
    table.Plex = { title: "Plex", desc: "Community Plex for Samsung", data: await checkWidgetZip(cfg.plexZip) };
  }
  return table;
}

function widgetListXml(table, base) {
  const xmlEsc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const items = Object.entries(table).map(([id, w]) => [
    `<widget id="${id}">`, `<title>${xmlEsc(w.title)}</title>`, `<compression size="${w.data.length}" type="zip"/>`,
    `<description>${xmlEsc(w.desc)}</description>`, `<download>${base}/Widget/${id}.zip</download>`, "</widget>"
  ].join("\n"));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rsp stat="ok">\n<list>\n${items.join("\n")}\n</list>\n</rsp>\n`;
}

// ---------------------------------------------------------------- relay
function checkTarget(raw) {
  let u;
  try { u = new URL(String(raw || "")); } catch { throw Object.assign(new Error("bad url"), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error("bad url"), { status: 400 });
  return u;
}

// One request, no redirect following. Resolves with the IncomingMessage.
function request(url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method, headers: { "User-Agent": UA, Accept: "*/*", ...headers }, timeout: 25000 }, resolve);
    req.on("timeout", () => req.destroy(new Error("upstream timeout")));
    req.on("error", reject);
    req.end();
  });
}

async function follow(url, opts = {}, hops = 6) {
  let current = url;
  for (let i = 0; i <= hops; i++) {
    const res = await request(current, opts);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, current);
      continue;
    }
    return { res, finalUrl: current };
  }
  throw Object.assign(new Error("too many redirects"), { status: 508 });
}

function readAll(res, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on("data", (c) => { size += c.length; if (size > limit) { res.destroy(); reject(new Error("too large")); } else chunks.push(c); });
    res.on("end", () => resolve(Buffer.concat(chunks)));
    res.on("error", reject);
  });
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 15 * 60 * 1000) return hit;
  cache.delete(key);
  return null;
}
function cachePut(key, value) {
  if (cache.size > 300) for (const k of [...cache.keys()].slice(0, 75)) cache.delete(k);
  cache.set(key, { ...value, at: Date.now() });
}

async function relayFetch(target, res) {
  stats.proxy++;
  const key = target.href;
  const hit = cacheGet(key);
  if (hit) { res.writeHead(200, { "Content-Type": hit.type, "Content-Length": hit.body.length, "Cache-Control": "max-age=3600" }); return res.end(hit.body); }
  const { res: up } = await follow(target);
  const body = await readAll(up, 15 * 1024 * 1024);
  const type = up.headers["content-type"] || "application/octet-stream";
  if (up.statusCode === 200 && body.length < 3 * 1024 * 1024) cachePut(key, { type, body });
  res.writeHead(up.statusCode, { "Content-Type": type, "Content-Length": body.length, "Cache-Control": "max-age=3600", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

async function relayStream(target, mode, req, res) {
  stats.streams++;
  if (!req.headers.range) emit("stream", { host: target.hostname, mode });
  if (mode === "http" || mode === "resolve") {
    // Find where the addon's link really lands (Torrentio etc. redirect to the debrid CDN), then send the TV there.
    const { res: probe, finalUrl } = await follow(target, { headers: { Range: "bytes=0-0" } });
    probe.destroy();
    const location = mode === "http" ? finalUrl.href.replace(/^https:/i, "http:") : finalUrl.href;
    res.writeHead(302, { Location: location, "Content-Length": 0 });
    return res.end();
  }
  const headers = {};
  if (req.headers.range) headers.Range = req.headers.range;
  const { res: up } = await follow(target, { headers });
  const out = { "Accept-Ranges": up.headers["accept-ranges"] || "bytes" };
  for (const h of ["content-type", "content-length", "content-range", "last-modified", "etag"]) if (up.headers[h]) out[h] = up.headers[h];
  res.writeHead(up.statusCode, out);
  if (req.method === "HEAD") { up.destroy(); return res.end(); }
  up.pipe(res);
  res.on("close", () => up.destroy());
}

// ---------------------------------------------------------------- server
function lanOnly(addr) {
  const a = String(addr || "").replace(/^::ffff:/, "");
  return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/.test(a) || a === "::1";
}

function handler(req, res) {
  const remote = req.socket.remoteAddress;
  if (!lanOnly(remote)) { res.writeHead(403); return res.end(); }
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const fail = (error) => {
    stats.lastError = error.message;
    if (!res.headersSent) { res.writeHead(error.status || 502, { "Content-Type": "text/plain" }); res.end(error.message); } else res.destroy();
  };
  (async () => {
    if (p.toLowerCase() === "/widgetlist.xml") {
      stats.widgetlist++; stats.lastTv = remote.replace(/^::ffff:/, "");
      const base = `http://${serving.ip}${serving.port === 80 ? "" : `:${serving.port}`}`;
      const body = Buffer.from(widgetListXml(serving.widgets, base));
      res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8", "Content-Length": body.length, "Cache-Control": "no-cache" });
      res.end(body);
      emit("widgetlist", { tv: stats.lastTv, total: Object.keys(serving.widgets).length });
      return;
    }
    const wm = p.match(/^\/Widget\/([A-Za-z0-9_]+)\.zip$/);
    if (wm) {
      const w = serving.widgets[wm[1]];
      if (!w) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": "application/zip", "Content-Length": w.data.length });
      res.end(w.data);
      stats.downloads[wm[1]] = (stats.downloads[wm[1]] || 0) + 1;
      emit("download", { id: wm[1], title: w.title, done: Object.keys(stats.downloads).length, total: Object.keys(serving.widgets).length });
      return;
    }
    if (p === "/status") {
      const body = JSON.stringify({ app: "TV Setup Orsay", widgets: Object.keys(serving.widgets), stats });
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(body);
    }
    if (p === "/proxy" || p === "/img" || p === "/stream") {
      if (serving.key && url.searchParams.get("k") !== serving.key) { res.writeHead(403); return res.end("bad key"); }
      const target = checkTarget(url.searchParams.get("u"));
      if (p === "/stream") return relayStream(target, url.searchParams.get("mode") || "proxy", req, res);
      return relayFetch(target, res);
    }
    res.writeHead(404); res.end();
  })().catch(fail);
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handler);
    s.keepAliveTimeout = 30000;
    s.once("error", reject);
    s.listen(port, "0.0.0.0", () => { s.removeListener("error", reject); resolve(s); });
  });
}

async function start({ ip: ipHint, ports } = {}) {
  await stop();
  const cfg = await getConfig();
  await store.setSettings({ orsay: cfg }); // persists a newly generated key
  const ip = phoneIp(ipHint);
  if (!ip) throw new Error("Connect the phone to the same Wi-Fi as the TV first.");
  let lastError = null;
  for (const port of ports || [80, 8080, 8081]) {
    try { server = await listen(port); serving.port = server.address().port; break; } catch (error) { lastError = error; }
  }
  if (!server) throw new Error(`Couldn't open a port on the phone (${lastError?.code || lastError?.message}).`);
  serving.ip = ip;
  serving.key = cfg.key;
  serving.startedAt = Date.now();
  stats.widgetlist = 0; stats.downloads = {}; stats.lastError = "";
  try {
    serving.widgets = await widgetTable(cfg, relayBase(cfg, ip, serving.port), relayBase({ relayMode: "phone" }, ip, serving.port));
  } catch (error) { await stop(); throw error; }
  emit("started", { port: serving.port, ip });
  return status();
}

async function stop() {
  if (server) { const s = server; server = null; await new Promise((r) => s.close(() => r())); s.closeAllConnections?.(); emit("stopped"); }
  serving = { port: 0, ip: "", widgets: {}, startedAt: 0, key: "" };
}

function status() {
  return {
    running: Boolean(server),
    port: serving.port,
    ip: serving.ip,
    port80: serving.port === 80,
    syncIp: serving.port === 80 ? serving.ip : "",
    widgets: Object.entries(serving.widgets).map(([id, w]) => ({ id, title: w.title, kb: Math.ceil(w.data.length / 1024) })),
    stats: { ...stats }
  };
}

module.exports = { init, getConfig, setConfig, start, stop, status, normalize, buildNuvioLite, widgetListXml, checkWidgetZip, relayBase, DEFAULTS, STREAM_MODES };
