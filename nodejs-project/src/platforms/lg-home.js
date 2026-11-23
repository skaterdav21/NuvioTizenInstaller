// "TV Home" for LG webOS: a clean launcher web app generated on the phone with the apps that are
// actually installed on that TV (Nuvio first, then streaming apps, then HDMI inputs), packaged as a
// real .ipk (ar archive of debian-binary + control.tar.gz + data.tar.gz, same layout as ares-package).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

const HOME_ID = "com.tvsetup.home";
const HOME_VERSION = "1.0.0";

// Known webOS app ids, in the order they should appear after Nuvio.
const KNOWN_APPS = [
  { id: "space.nuvio.native.legacy", name: "Nuvio", sub: "Movies & shows", color: "#3e7bfa", hero: true },
  { id: "cdp-30", name: "Plex", sub: "Your library", color: "#c88a12" },
  { id: "youtube.leanback.v4", name: "YouTube", color: "#cc2b2b" },
  { id: "netflix", name: "Netflix", color: "#b20710" },
  { id: "amazon", name: "Prime Video", color: "#1a8fbf" },
  { id: "com.disney.disneyplus-prod", name: "Disney+", color: "#1b3a8f" },
  { id: "hulu", name: "Hulu", color: "#14a35a" },
  { id: "com.hbo.hbomax", name: "Max", color: "#4b2bd1" },
  { id: "spotify-beehive", name: "Spotify", color: "#1aa34a" },
  { id: "com.apple.appletv", name: "Apple TV", color: "#3a3f48" },
  { id: "tubi", name: "Tubi", color: "#e25a1c" },
  { id: "com.webos.app.livetv", name: "Live TV", sub: "Antenna / cable", color: "#4a5160", group: "inputs" },
  { id: "com.webos.app.hdmi1", name: "HDMI 1", sub: "Input", color: "#4a5160", group: "inputs" },
  { id: "com.webos.app.hdmi2", name: "HDMI 2", sub: "Input", color: "#4a5160", group: "inputs" },
  { id: "com.webos.app.hdmi3", name: "HDMI 3", sub: "Input", color: "#4a5160", group: "inputs" },
  { id: "com.webos.app.hdmi4", name: "HDMI 4", sub: "Input", color: "#4a5160", group: "inputs" },
  { id: "com.palm.app.settings", name: "Settings", sub: "TV settings", color: "#4a5160", group: "inputs" }
];

// Asks the TV which apps exist. Tries the full launch-point list first, then app-by-app lookups.
async function detectApps(exec, client) {
  const present = new Set();
  const list = await exec(client, "luna-send-pub -n 1 -f luna://com.webos.applicationManager/listLaunchPoints '{}' 2>/dev/null", { timeoutMs: 15000 }).catch(() => "");
  for (const match of list.matchAll(/"id"\s*:\s*"([^"]+)"/g)) present.add(match[1]);
  if (present.size < 3) {
    for (const app of KNOWN_APPS) {
      if (app.group === "inputs") continue;
      const info = await exec(client, `luna-send-pub -n 1 -f luna://com.webos.applicationManager/getAppInfo '{"id":"${app.id}"}' 2>/dev/null`, { timeoutMs: 8000 }).catch(() => "");
      if (/"returnValue"\s*:\s*true/.test(info) && /"appInfo"/.test(info)) present.add(app.id);
    }
  }
  return present;
}

function chooseTiles(present, { listWorked } = {}) {
  const tiles = [];
  for (const app of KNOWN_APPS) {
    // Inputs and Settings always exist; streaming apps only if the TV has them.
    if (app.group === "inputs") {
      if (/hdmi[34]$/.test(app.id) && listWorked && !present.has(app.id)) continue;
      tiles.push(app);
      continue;
    }
    if (app.hero || present.has(app.id)) tiles.push(app);
  }
  return tiles;
}

// ---- Tiny writers: PNG, tar, ar ---------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
// Rounded square in the app's blue with a lighter "play" notch: enough to find it in LG's app list.
function iconPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  const radius = size * 0.22;
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const o = y * (size * 4 + 1) + 1 + x * 4;
      const cx = Math.min(x, size - 1 - x), cy = Math.min(y, size - 1 - y);
      const corner = cx < radius && cy < radius && Math.hypot(radius - cx, radius - cy) > radius;
      const u = x / size, v = y / size;
      const inPlay = u > 0.38 && u < 0.7 && Math.abs(v - 0.5) < (0.7 - u) * 0.62;
      const [r, g, b] = inPlay ? [242, 243, 245] : [62, 123, 250];
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = corner ? 0 : 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4);
  header[8] = 8; header[9] = 6; header[10] = 0; header[11] = 0; header[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function tarHeader(name, size, type, mode, mtime) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  header.write(`${mode.toString(8).padStart(7, "0")}\0`, 100, 8, "ascii");
  header.write("0000000\0", 108, 8, "ascii");
  header.write("0000000\0", 116, 8, "ascii");
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
  header.write(`${mtime.toString(8).padStart(11, "0")}\0`, 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii");
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}
// entries: [{ name: "./usr/...", data?: Buffer }] (no data = directory)
function tarGz(entries) {
  const mtime = Math.floor(Date.now() / 1000);
  const parts = [];
  for (const entry of entries) {
    if (entry.data) {
      parts.push(tarHeader(entry.name, entry.data.length, "0", entry.mode || 0o644, mtime), entry.data);
      const pad = (512 - (entry.data.length % 512)) % 512;
      if (pad) parts.push(Buffer.alloc(pad));
    } else {
      parts.push(tarHeader(entry.name.endsWith("/") ? entry.name : `${entry.name}/`, 0, "5", 0o755, mtime));
    }
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}
function ar(files) {
  const parts = [Buffer.from("!<arch>\n", "ascii")];
  const mtime = Math.floor(Date.now() / 1000);
  for (const file of files) {
    const header = Buffer.alloc(60, 0x20);
    header.write(file.name.padEnd(16, " "), 0, 16, "ascii");
    header.write(String(mtime).padEnd(12, " "), 16, 12, "ascii");
    header.write("0".padEnd(6, " "), 28, 6, "ascii");
    header.write("0".padEnd(6, " "), 34, 6, "ascii");
    header.write("100644".padEnd(8, " "), 40, 8, "ascii");
    header.write(String(file.data.length).padEnd(10, " "), 48, 10, "ascii");
    header.write("`\n", 58, 2, "ascii");
    parts.push(header, file.data);
    if (file.data.length % 2) parts.push(Buffer.from("\n", "ascii"));
  }
  return Buffer.concat(parts);
}

// Builds the TV Home .ipk with these tiles baked in.
function buildIpk(tiles, { version = HOME_VERSION } = {}) {
  const template = fs.readFileSync(path.join(__dirname, "lg-home", "index.html"), "utf8");
  const safeTiles = JSON.stringify(tiles.map(({ id, name, sub, color, hero, group }) => ({ id, name, sub: sub || "", color, hero: Boolean(hero), group: group || "" }))).replace(/</g, "\\u003c");
  const html = template.replace(/\/\*TILES\*\/[\s\S]*?\/\*END\*\//, `/*TILES*/${safeTiles}/*END*/`);
  const appDir = `./usr/palm/applications/${HOME_ID}`;
  const appinfo = {
    id: HOME_ID,
    version,
    vendor: "TV Setup",
    type: "web",
    main: "index.html",
    title: "TV Home",
    icon: "icon.png",
    largeIcon: "largeIcon.png",
    bgColor: "#1b1e24",
    resolution: "1920x1080",
    disableBackHistoryAPI: true
  };
  const packageinfo = { app: HOME_ID, id: HOME_ID, loc_name: "TV Home", package_format_version: 2, vendor: "TV Setup", version };
  const files = [
    { name: `${appDir}/index.html`, data: Buffer.from(html) },
    { name: `${appDir}/appinfo.json`, data: Buffer.from(JSON.stringify(appinfo, null, 2)) },
    { name: `${appDir}/icon.png`, data: iconPng(80) },
    { name: `${appDir}/largeIcon.png`, data: iconPng(130) },
    { name: `./usr/palm/packages/${HOME_ID}/packageinfo.json`, data: Buffer.from(JSON.stringify(packageinfo, null, 2)) }
  ];
  const dirs = ["./", "./usr/", "./usr/palm/", "./usr/palm/applications/", `${appDir}/`, "./usr/palm/packages/", `./usr/palm/packages/${HOME_ID}/`];
  const data = tarGz([...dirs.map((name) => ({ name })), ...files]);
  const installedKb = Math.ceil(files.reduce((sum, file) => sum + file.data.length, 0) / 1024);
  const control = [
    `Package: ${HOME_ID}`,
    `Version: ${version}`,
    "Section: misc",
    "Priority: optional",
    "Architecture: all",
    `Installed-Size: ${installedKb}`,
    "Maintainer: TV Setup",
    "Description: TV Home, a clean home screen with Nuvio first",
    "webOS-Package-Format-Version: 2",
    "webOS-Packager-Version: x.y.x",
    ""
  ].join("\n");
  const controlTar = tarGz([{ name: "./" }, { name: "./control", data: Buffer.from(control) }]);
  return ar([
    { name: "debian-binary", data: Buffer.from("2.0\n") },
    { name: "control.tar.gz", data: controlTar },
    { name: "data.tar.gz", data }
  ]);
}

module.exports = { HOME_ID, KNOWN_APPS, detectApps, chooseTiles, buildIpk, iconPng };
