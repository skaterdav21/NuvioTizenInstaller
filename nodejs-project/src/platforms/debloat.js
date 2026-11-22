// Picks the right CleanYourTV tested list for a connected Android TV, turns it into a reviewable
// plan (grouped, with safe defaults), and applies it with the same safety guards as CleanYourTV's
// tools/disable.sh: core packages, Home owner, HDMI/tuner input drivers, the apps that open inputs
// and Settings, and the setup wizard that owns the Wi-Fi network.
"use strict";

const path = require("node:path");
const fs = require("node:fs");

let listsCache = null;
function lists() {
  if (!listsCache) listsCache = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "lists.json"), "utf8"));
  return listsCache;
}

const PKG_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/;
const CORE_RE = /^(android|android\.ext\.(services|shared)|com\.(google\.)?android\.sdksandbox|com\.android\.location\.fused|com\.android\.systemui|com\.android\.shell|com\.android\.phone|com\.android\.settings|com\.android\.tv\.settings|com\.(google\.)?android\.(permissioncontroller|packageinstaller|ext\.services|ext\.shared|modulemetadata)|com\.google\.android\.overlay\.modules.*|com\.android\.providers\..*|com\.cltv\.mal|com\.mediatek\.(tis|tv\.service|tv\.agent))$/;
const CORE_OK = /^com\.android\.providers\.(calendar|contacts|userdictionary|blockednumber)$/;

const SETUPWRAITH = "com.google.android.tungsten.setupwraith";
const STOCK_LAUNCHERS = [
  "com.google.android.tvlauncher",
  "com.google.android.apps.tv.launcherx",
  "com.google.android.leanbacklauncher",
  "com.mitv.tvhome",
  "com.droidlogic.mboxlauncher",
  "com.amazon.tv.launcher"
];

// Things people use day to day. Never disabled by default, even when a tested list turned them off
// (those were the owner's choices). Shown as optional so they can still be picked.
const KEEP_BY_DEFAULT = [
  /^com\.android\.vending$/, /^com\.google\.android\.gms$/, /^com\.google\.android\.gsf$/,
  /^com\.google\.android\.katniss$/, /voicesearch|assistant/i, /^com\.google\.android\.apps\.mediashell$/,
  /^com\.google\.android\.youtube/, /^com\.netflix\./, /amazonvideo|primevideo/i, /disney/i, /hulu/i,
  /^com\.plexapp/, /spotify/i, /hbo|max\b/i, /peacock/i, /paramount/i, /^tv\.pluto/, /^com\.apple\.atve/,
  /\.tv\.remote\.service$/, /inputmethod|keyboard|gboard/i, /bluetooth/i, /\.ota\b|ota$|update|upgrade/i,
  /airplay|homekit/i, /^com\.nvidia\.shield\.remote/, /^com\.nvidia\.shield\.ask/, /tvinput|livetv|tvx$|tvcenter/i,
  /^com\.amazon\.(venezia|avod|tv\.settings|device\.software\.ota|tv\.launcher)/, /^com\.amazon\.alexa/,
  /^com\.google\.android\.tv$/, /webview/i, /\.dreams?\b|screensaver|backdrop|dreamx/i
];

const ADS_WORDS = /\b(ads?|advert|adservices|acr|samba|track|tracking|telemetry|feedback|stats|statistic|analytic|usage|consent|promo|promotion|sponsor|recommend|registration|bug ?report|diagnos|crash|log collector|logging|privacy sandbox|federated|personaliz|marketing|shop|demo|retail|store mode|survey|nps|ad-click|auto-?install|partner|upsell|offer)\b/i;
const STUB_WORDS = /\b(idle|stub|cts|unused|tidiness|test)\b/i;
const CHOICE_WORDS = /\b(choice|personal|owner'?s|by choice|optional|preference)\b/i;

function isKeepByDefault(pkg) {
  return KEEP_BY_DEFAULT.some((pattern) => pattern.test(pkg));
}

function isCore(pkg) {
  return CORE_RE.test(pkg) && !CORE_OK.test(pkg);
}

// device: { manufacturer, brand, model, device, name, fingerprint, packages:Set, profile }
function matchList(device) {
  const all = lists().lists;
  const props = [device.device, device.name, device.model, device.product].filter(Boolean).map((value) => String(value).toLowerCase());
  const maker = `${device.manufacturer || ""} ${device.brand || ""}`.toLowerCase();
  const scored = [];
  for (const item of all) {
    if (item.variant) continue;
    const packages = item.groups.flatMap((group) => group.packages.map((entry) => entry.p));
    if (!packages.length) continue;
    const present = packages.filter((pkg) => device.packages.has(pkg)).length;
    const coverage = present / packages.length;
    let score = coverage * 50;
    const tokenHit = item.tokens.some((token) => props.some((prop) => prop === token || (token.length >= 4 && prop.includes(token))));
    if (tokenHit) score += 60;
    const brand = (item.brand || "").toLowerCase();
    if (brand && maker && (maker.includes(brand.split(" ")[0]) || brand.includes(maker.trim().split(" ")[0]))) score += 15;
    if (device.sdk && /android(?: tv)? (\d+)|google tv (\d+)/i.test(item.os)) {
      const osVersion = Number((item.os.match(/(\d+)/) || [])[1] || 0);
      const deviceAndroid = sdkToAndroid(device.sdk);
      if (osVersion && deviceAndroid && osVersion === deviceAndroid) score += 8;
    }
    scored.push({ item, score, coverage, tokenHit, present });
  }
  scored.sort((left, right) => right.score - left.score);
  return scored;
}

function sdkToAndroid(sdk) {
  return { 26: 8, 27: 8, 28: 9, 29: 10, 30: 11, 31: 12, 32: 12, 33: 13, 34: 14, 35: 15, 36: 16 }[Number(sdk)] || 0;
}

function categorize(groupTitle, comment, pkg) {
  const text = `${groupTitle} ${comment} ${pkg}`;
  if (STOCK_LAUNCHERS.includes(pkg) || pkg === SETUPWRAITH || /\blauncher\b|hands? home|home over/i.test(groupTitle)) return "home";
  if (isKeepByDefault(pkg)) return "apps";
  if (CHOICE_WORDS.test(groupTitle)) return "apps";
  if (ADS_WORDS.test(text)) return "ads";
  if (STUB_WORDS.test(groupTitle)) return "stubs";
  return "preloads";
}

const CATEGORY_INFO = {
  ads: { label: "Ads, tracking & promos", description: "Viewing trackers (ACR), telemetry, sponsored rows, demo and promo apps." },
  preloads: { label: "Preloaded extras", description: "Factory apps and background services the tested TVs ran fine without." },
  stubs: { label: "Unused system stubs", description: "Idle leftovers. No real speed gain, just tidier." },
  apps: { label: "Apps you might use", description: "Streaming apps, voice, casting and screensavers. Off unless you pick them." }
};

// Builds a reviewable plan from the best match. Only packages installed and enabled on this TV.
function buildPlan(device) {
  const scored = matchList(device);
  const best = scored[0];
  const strong = best && (best.tokenHit || best.coverage >= 0.75);
  const sources = [];
  const entries = new Map();

  const addFrom = (item, weight) => {
    for (const group of item.groups) {
      for (const entry of group.packages) {
        if (!PKG_RE.test(entry.p) || isCore(entry.p)) continue;
        if (!device.packages.has(entry.p) || device.disabled?.has(entry.p)) continue;
        const existing = entries.get(entry.p);
        if (existing) { existing.votes += weight; continue; }
        entries.set(entry.p, { pkg: entry.p, group: group.title, note: entry.c || "", category: categorize(group.title, entry.c || "", entry.p), votes: weight });
      }
    }
  };

  if (strong) {
    addFrom(best.item, 3);
    sources.push({ id: best.item.id, tv: best.item.tv, os: best.item.os, exact: best.tokenHit });
    // Other lists for the same model family add votes (confidence), never new categories of risk.
    for (const other of scored.slice(1, 4)) {
      if (other.tokenHit || other.coverage > 0.85) addFrom(other.item, 1);
    }
  } else {
    // No tested list for this exact TV: use what several close lists agree on.
    const close = scored.slice(0, 6).filter((entry) => entry.coverage >= 0.35);
    for (const entry of close) { addFrom(entry.item, 1); sources.push({ id: entry.item.id, tv: entry.item.tv, os: entry.item.os, exact: false }); }
    for (const [pkg, entry] of entries) {
      if (entry.votes < 2 && entry.category !== "ads") entries.delete(pkg);
    }
  }

  const items = [...entries.values()].filter((entry) => entry.category !== "home").map((entry) => ({
    ...entry,
    selected: entry.category === "ads" || entry.category === "stubs" || (entry.category === "preloads" && strong)
  }));
  const categories = Object.entries(CATEGORY_INFO).map(([id, info]) => ({
    id,
    ...info,
    items: items.filter((item) => item.category === id).sort((left, right) => left.pkg.localeCompare(right.pkg))
  })).filter((category) => category.items.length);

  return {
    matched: strong ? { tv: best.item.tv, os: best.item.os, notes: best.item.notes, exact: best.tokenHit, id: best.item.id } : null,
    sources,
    categories,
    total: items.length,
    selectedCount: items.filter((item) => item.selected).length
  };
}

// ---- Guards (run against the live TV right before disabling) ---------------------------------

function parseActivities(text) {
  return [...new Set(String(text).split("\n").map((line) => (line.trim().match(/^([A-Za-z_][\w.]*)\//) || [])[1]).filter(Boolean))];
}

async function guard(adb, packages, log) {
  let list = packages.filter((pkg) => PKG_RE.test(pkg) && !isCore(pkg));
  const skipped = [];
  const drop = (pkg, reason) => { if (list.includes(pkg)) { list = list.filter((item) => item !== pkg); skipped.push({ pkg, reason }); } };

  // Home owner: never leave the TV without something that answers Home.
  const homeOwner = (await adb.shell("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null | tail -n 1").catch(() => "")).trim().split("/")[0];
  const claimants = parseActivities(await adb.shell("cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null").catch(() => ""))
    .filter((pkg) => ![SETUPWRAITH, "com.android.tv.settings", "com.android.settings", "com.android.provision"].includes(pkg) && !/factory/i.test(pkg));
  for (const pkg of list.slice()) {
    if (pkg === homeOwner || (STOCK_LAUNCHERS.includes(pkg) && claimants.includes(pkg))) {
      const others = claimants.filter((other) => other !== pkg && !list.includes(other));
      if (!others.length || pkg === homeOwner) drop(pkg, "it runs the home screen");
    }
  }

  // Apps that open HDMI inputs/channels and Settings.
  const viewHandlers = parseActivities(await adb.shell("cmd package query-activities --brief -a android.intent.action.VIEW -t vnd.android.cursor.item/channel 2>/dev/null").catch(() => ""));
  const settingsHandlers = parseActivities(await adb.shell("cmd package query-activities --brief -a android.settings.SETTINGS 2>/dev/null").catch(() => ""));
  for (const pkg of viewHandlers) drop(pkg, "it opens the TV's inputs and channels");
  for (const pkg of settingsHandlers) drop(pkg, "it opens Settings");

  // HDMI/tuner input drivers (TV_INPUT_HARDWARE), checked on the TV in one round trip.
  if (list.length) {
    const names = list.join(" ");
    const out = await adb.shell(`for p in ${names}; do d=$(dumpsys package $p 2>/dev/null); case "$d" in *TV_INPUT_HARDWARE*) echo "HW $p";; *'hung system process'*) echo "HUNG $p";; esac; done; true`, 120000).catch(() => null);
    if (out === null) {
      log("Couldn't run the input-driver check; skipping packages it would have checked is safer.");
      return { list: [], skipped: list.map((pkg) => ({ pkg, reason: "couldn't verify it's safe" })).concat(skipped) };
    }
    for (const line of out.split("\n")) {
      const [tag, pkg] = line.trim().split(" ");
      if (tag === "HW") drop(pkg, "it drives the HDMI/tuner inputs");
      if (tag === "HUNG") drop(pkg, "the TV's system is busy; reboot and run again");
    }
  }

  // Setup wizard: disabling it deletes a Wi-Fi network it created (TV drops off Wi-Fi).
  if (list.includes(SETUPWRAITH)) {
    const owner = await setupwraithOwnsWifi(adb);
    if (owner !== false) drop(SETUPWRAITH, owner === true ? "it owns the saved Wi-Fi network" : "couldn't check who owns the Wi-Fi network");
  }
  return { list, skipped };
}

// true = setupwraith owns a saved network, false = it doesn't, null = couldn't tell.
async function setupwraithOwnsWifi(adb) {
  const wifi = await adb.shell("dumpsys wifi 2>/dev/null | grep -o 'cname=[^ ]*'", 30000).catch(() => "");
  const owners = wifi.split("\n").map((line) => line.trim()).filter(Boolean);
  if (!owners.length) return null;
  return owners.some((line) => line.includes("setupwraith"));
}

// Disables in batches, reading back what actually took. Records every change in `record` first.
async function apply(adb, packages, { onProgress, record, log }) {
  const done = [];
  const failed = [];
  const batchSize = 8;
  for (let index = 0; index < packages.length; index += batchSize) {
    const batch = packages.slice(index, index + batchSize);
    await record(batch);
    const script = batch.map((pkg) => `pm disable-user --user 0 ${pkg} >/dev/null 2>&1`).join("; ");
    await adb.shell(`${script}; true`, 60000);
    if (onProgress) onProgress(Math.min(packages.length, index + batch.length), packages.length);
  }
  const enabled = new Set((await adb.shell("pm list packages -e --user 0 2>/dev/null || pm list packages -e", 60000).catch(() => ""))
    .split("\n").map((line) => line.replace(/^package:/, "").trim()).filter(Boolean));
  for (const pkg of packages) {
    if (enabled.size && enabled.has(pkg)) failed.push(pkg); else done.push(pkg);
  }
  if (failed.length && log) log(`The TV kept ${failed.length} enabled: ${failed.join(", ")}`);
  return { done, failed };
}

async function restore(adb, packages, { onProgress } = {}) {
  for (let index = 0; index < packages.length; index += 10) {
    const batch = packages.slice(index, index + 10).filter((pkg) => PKG_RE.test(pkg));
    await adb.shell(`${batch.map((pkg) => `pm enable --user 0 ${pkg} >/dev/null 2>&1 || pm enable ${pkg} >/dev/null 2>&1`).join("; ")}; true`, 60000);
    if (onProgress) onProgress(Math.min(packages.length, index + batch.length), packages.length);
  }
}

module.exports = {
  lists, matchList, buildPlan, guard, apply, restore, setupwraithOwnsWifi,
  STOCK_LAUNCHERS, SETUPWRAITH, CATEGORY_INFO, isCore, PKG_RE
};
