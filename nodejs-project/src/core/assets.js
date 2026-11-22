// Catalog of everything the app can put on a TV, with GitHub release resolution,
// download cache, progress, and offline fallback to the newest downloaded copy.
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");

let dataDir = "";
let bundledDir = "";

function init(userDataDir, bundledDirectory) {
  dataDir = path.join(userDataDir, "packages");
  bundledDir = bundledDirectory;
}

// abi: "arm64" | "armv7"
const CATALOG = {
  "nuvio-official": {
    label: "Nuvio (official Android TV app)",
    repo: "NuvioMedia/NuvioTV",
    package: "com.nuvio.tv",
    patterns: { arm64: /^app-full-arm64-v8a-release\.apk$/i, armv7: /^app-full-armeabi-v7a-release\.apk$/i }
  },
  "nuvio-legacy-android": {
    label: "Nuvio Legacy (native, lite)",
    repo: "iqui27/nuvio-native-legacy",
    package: "space.nuvio.nativelegacy",
    patterns: { arm64: /-android-lite-arm64\.apk$/i, armv7: /-android-lite-armv7\.apk$/i }
  },
  "nuvio-legacy-lg": {
    label: "Nuvio Legacy for LG webOS",
    repo: "iqui27/nuvio-native-legacy",
    package: "space.nuvio.native.legacy",
    patterns: { default: /^space\.nuvio\.native\.legacy_[\d.]+_arm\.ipk$/i, highcache: /^space\.nuvio\.native\.legacy_[\d.]+_arm-highcache\.ipk$/i }
  },
  smarttube: {
    label: "SmartTube (YouTube without ads)",
    repo: "yuliskov/SmartTube",
    package: "com.teamsmart.videomanager.tv",
    patterns: { arm64: /^SmartTube_stable_[\d.]+_arm64-v8a\.apk$/i, armv7: /^SmartTube_stable_[\d.]+_armeabi-v7a\.apk$/i }
  },
  launcher: {
    label: "Clean home screen (CleanYourTV launcher)",
    bundled: "tvhome.apk",
    package: "com.gathin.tvhome"
  }
};

const releaseCache = new Map();
const inFlight = new Map();

function once(key, job) {
  if (inFlight.has(key)) return inFlight.get(key);
  const promise = Promise.resolve().then(job).finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, headers: { "User-Agent": "TV-Setup-App", ...(options.headers || {}) } });
  } finally {
    clearTimeout(timer);
  }
}

async function readCachedReleases() {
  try { return JSON.parse(await fsp.readFile(path.join(dataDir, "releases.json"), "utf8")); } catch { return {}; }
}

async function writeCachedRelease(repo, release) {
  const all = await readCachedReleases();
  all[repo] = { ...release, fetchedAt: Date.now() };
  await fsp.mkdir(dataDir, { recursive: true });
  await fsp.writeFile(path.join(dataDir, "releases.json"), JSON.stringify(all));
}

// Returns { tag, assets: [{ name, url, size }] } for the latest release of repo.
async function latestRelease(repo, { maxAgeMs = 3 * 3600 * 1000 } = {}) {
  const memo = releaseCache.get(repo);
  if (memo && Date.now() - memo.fetchedAt < maxAgeMs) return memo;
  return once(`release:${repo}`, async () => {
    let release = null;
    try {
      const response = await fetchWithTimeout(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } });
      if (response.ok) {
        const json = await response.json();
        release = {
          tag: json.tag_name,
          assets: (json.assets || []).map((asset) => ({ name: asset.name, url: asset.browser_download_url, size: asset.size }))
        };
      }
    } catch {}
    if (!release) {
      try {
        const latest = await fetchWithTimeout(`https://github.com/${repo}/releases/latest`, { redirect: "manual" });
        const location = latest.headers.get("location") || latest.url || "";
        const tag = decodeURIComponent((location.match(/\/releases\/tag\/([^/?#]+)/) || [])[1] || "");
        if (tag) {
          const page = await fetchWithTimeout(`https://github.com/${repo}/releases/expanded_assets/${encodeURIComponent(tag)}`);
          const html = page.ok ? await page.text() : "";
          const names = new Set();
          const pattern = new RegExp(`/${repo.replace("/", "\\/")}/releases/download/[^/"]+/([^"?#]+)`, "gi");
          for (const match of html.matchAll(pattern)) names.add(decodeURIComponent(match[1]));
          release = { tag, assets: [...names].map((name) => ({ name, url: `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`, size: 0 })) };
        }
      } catch {}
    }
    if (release && release.assets.length) {
      release.fetchedAt = Date.now();
      releaseCache.set(repo, release);
      await writeCachedRelease(repo, release).catch(() => {});
      return release;
    }
    const cached = (await readCachedReleases())[repo];
    if (cached) {
      releaseCache.set(repo, { ...cached, fetchedAt: Date.now() - maxAgeMs + 10 * 60 * 1000 });
      return cached;
    }
    throw new Error(`Couldn't reach GitHub to find the latest ${repo} release.`);
  });
}

async function download(url, target, onProgress) {
  return once(`download:${target}`, async () => {
    const response = await fetchWithTimeout(url, {}, 30 * 60 * 1000);
    if (!response.ok) throw new Error(`Download failed (${response.status}) for ${path.basename(target)}.`);
    const total = Number(response.headers.get("content-length") || 0);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const partial = `${target}.part`;
    const out = fs.createWriteStream(partial);
    let received = 0;
    await new Promise((resolve, reject) => {
      const body = Readable.fromWeb(response.body);
      body.on("data", (chunk) => { received += chunk.length; if (onProgress) onProgress(received, total); });
      body.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      body.pipe(out);
    });
    if (total && received !== total) {
      await fsp.rm(partial, { force: true });
      throw new Error(`Download of ${path.basename(target)} was cut off. Try again.`);
    }
    await fsp.rename(partial, target);
    return target;
  });
}

async function newestCached(repo, pattern) {
  const dir = path.join(dataDir, repo.replace("/", "__"));
  const found = [];
  for (const tag of await fsp.readdir(dir).catch(() => [])) {
    for (const name of await fsp.readdir(path.join(dir, tag)).catch(() => [])) {
      if (!pattern.test(name)) continue;
      const full = path.join(dir, tag, name);
      const stat = await fsp.stat(full).catch(() => null);
      if (stat?.size) found.push({ full, mtimeMs: stat.mtimeMs, tag, name });
    }
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return found[0] || null;
}

// Resolves and downloads (if needed) one artifact variant. Returns { path, name, tag, fromCache }.
async function get(id, variant = "default", { onProgress, offlineOk = true } = {}) {
  const entry = CATALOG[id];
  if (!entry) throw new Error(`Unknown package ${id}`);
  if (entry.bundled) {
    const full = path.join(bundledDir, entry.bundled);
    await fsp.access(full);
    return { path: full, name: entry.bundled, tag: "bundled", fromCache: true, package: entry.package };
  }
  const pattern = entry.patterns[variant] || entry.patterns.default;
  if (!pattern) throw new Error(`${entry.label} has no ${variant} build.`);
  let release;
  try {
    release = await latestRelease(entry.repo);
  } catch (error) {
    const cached = offlineOk ? await newestCached(entry.repo, pattern) : null;
    if (cached) return { path: cached.full, name: cached.name, tag: cached.tag, fromCache: true, offline: true, package: entry.package };
    throw error;
  }
  const asset = release.assets.find((item) => pattern.test(item.name));
  if (!asset) {
    const cached = offlineOk ? await newestCached(entry.repo, pattern) : null;
    if (cached) return { path: cached.full, name: cached.name, tag: cached.tag, fromCache: true, package: entry.package };
    throw new Error(`${entry.label} ${release.tag} has no ${variant} download.`);
  }
  const target = path.join(dataDir, entry.repo.replace("/", "__"), release.tag.replace(/[^a-z0-9._-]+/gi, "_"), asset.name);
  const stat = await fsp.stat(target).catch(() => null);
  if (stat?.size && (!asset.size || stat.size === asset.size)) {
    return { path: target, name: asset.name, tag: release.tag, fromCache: true, package: entry.package };
  }
  try {
    await download(asset.url, target, onProgress);
  } catch (error) {
    const cached = offlineOk ? await newestCached(entry.repo, pattern) : null;
    if (cached) return { path: cached.full, name: cached.name, tag: cached.tag, fromCache: true, offline: true, package: entry.package };
    throw error;
  }
  return { path: target, name: asset.name, tag: release.tag, fromCache: false, package: entry.package };
}

async function sha256(file) {
  const hash = crypto.createHash("sha256");
  await new Promise((resolve, reject) => fs.createReadStream(file).on("data", (c) => hash.update(c)).on("end", resolve).on("error", reject));
  return hash.digest("hex");
}

// Removes old versions, keeping the newest `keep` tags per repo.
async function prune(keep = 2) {
  for (const repoDir of await fsp.readdir(dataDir).catch(() => [])) {
    const full = path.join(dataDir, repoDir);
    const stat = await fsp.stat(full).catch(() => null);
    if (!stat?.isDirectory() || !repoDir.includes("__")) continue;
    const tags = [];
    for (const tag of await fsp.readdir(full)) {
      const tagStat = await fsp.stat(path.join(full, tag)).catch(() => null);
      if (tagStat?.isDirectory()) tags.push({ tag, mtimeMs: tagStat.mtimeMs });
    }
    tags.sort((left, right) => right.mtimeMs - left.mtimeMs);
    for (const old of tags.slice(keep)) await fsp.rm(path.join(full, old.tag), { recursive: true, force: true });
  }
}

async function storageUsed() {
  let total = 0;
  const walk = async (dir) => {
    for (const name of await fsp.readdir(dir).catch(() => [])) {
      const full = path.join(dir, name);
      const stat = await fsp.stat(full).catch(() => null);
      if (!stat) continue;
      if (stat.isDirectory()) await walk(full); else total += stat.size;
    }
  };
  await walk(dataDir);
  return total;
}

module.exports = { init, CATALOG, latestRelease, get, prune, storageUsed, sha256 };
