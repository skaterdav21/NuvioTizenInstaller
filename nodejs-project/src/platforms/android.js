// Android TV / Google TV / Fire TV setup over ADB: inspect a TV, build a plan, run it, undo it.
"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const adbLib = require("../core/adb");
const assets = require("../core/assets");
const store = require("../core/store");
const debloat = require("./debloat");
const looks = require("./looks");

const LAUNCHER_PKG = "com.gathin.tvhome";
// Horizon Home Kit (MIT): Nuvio-first home with artwork, Continue Watching and a Live TV guide.
const HORIZON = {
  pkg: "com.horizon.home",
  activity: "com.horizon.home/.HomeActivity",
  service: "com.horizon.home/com.horizon.home.HomeButtonService",
  grants: ["android.permission.READ_EXTERNAL_STORAGE", "com.android.providers.tv.permission.READ_EPG_DATA", "android.permission.READ_TV_LISTINGS", "android.permission.DUMP"]
};
const LAUNCHER_ACTIVITY = `${LAUNCHER_PKG}/.MainActivity`;
const FIRE_HOME = "com.amazon.tv.launcher";
const HOME_QUERY = "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME";
const CLAIM_QUERY = "cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.HOME";

let keyDir = path.join(os.tmpdir(), "tvsetup-adb");
function init(userDataDir) {
  keyDir = path.join(userDataDir, "tvsetup", "adb");
}

// ---- Connections (kept open between Inspect and Run) ------------------------------------

const connections = new Map();

async function getConnection(ip, { onAuthPrompt } = {}) {
  const existing = connections.get(ip);
  if (existing && !existing.adb.closed) {
    existing.lastUsed = Date.now();
    return existing.adb;
  }
  const [host, port] = String(ip).split(":");
  const adb = await adbLib.connect(host, { port: Number(port) || 5555, keyDir, onAuthPrompt });
  connections.set(ip, { adb, lastUsed: Date.now() });
  adb.on("closed", () => connections.delete(ip));
  return adb;
}

setInterval(() => {
  for (const [ip, entry] of connections) {
    if (Date.now() - entry.lastUsed > 10 * 60 * 1000) { entry.adb.close(); connections.delete(ip); }
  }
}, 60 * 1000).unref?.();

// ---- Inspect --------------------------------------------------------------------------

async function readDevice(adb) {
  const props = ["ro.product.manufacturer", "ro.product.brand", "ro.product.model", "ro.product.device", "ro.product.name",
    "ro.build.version.sdk", "ro.build.version.release", "ro.product.cpu.abilist", "ro.serialno", "ro.boot.serialno", "ro.adb.secure",
    "ro.build.characteristics", "ro.product.first_api_level", "ro.build.version.name", "ro.build.version.fireos"];
  const out = await adb.shell(props.map((prop) => `echo "@@${prop}=$(getprop ${prop})"`).join("; "));
  const info = {};
  for (const line of out.split("\n")) {
    const match = line.match(/^@@([^=]+)=(.*)$/);
    if (match) info[match[1]] = match[2].trim();
  }
  const [allText, disabledText, memText, homeText, dfText] = await Promise.all([
    adb.shell("pm list packages 2>/dev/null", 60000),
    adb.shell("pm list packages -d 2>/dev/null", 60000),
    adb.shell("grep MemTotal /proc/meminfo"),
    adb.shell(`${HOME_QUERY} 2>/dev/null | tail -n 1`),
    adb.shell("df /data 2>/dev/null | tail -n 1")
  ]);
  const parse = (text) => new Set(text.split("\n").map((line) => line.replace(/^package:/, "").trim()).filter(Boolean));
  const packages = parse(allText);
  const disabled = parse(disabledText);
  const memKb = Number((memText.match(/(\d+)/) || [])[1] || 0);
  const abis = (info["ro.product.cpu.abilist"] || "").split(",").map((item) => item.trim());
  const dfParts = dfText.trim().split(/\s+/);
  const freeKb = Number(dfParts[3] || 0);
  const isFire = /amazon/i.test(info["ro.product.manufacturer"]) || packages.has("com.amazon.tv.launcher");
  const isGoogleTv = packages.has("com.google.android.apps.tv.launcherx");
  return {
    manufacturer: info["ro.product.manufacturer"] || "",
    brand: info["ro.product.brand"] || "",
    model: info["ro.product.model"] || "",
    device: info["ro.product.device"] || "",
    product: info["ro.product.name"] || "",
    sdk: Number(info["ro.build.version.sdk"] || 0),
    android: info["ro.build.version.release"] || "",
    serial: info["ro.serialno"] || info["ro.boot.serialno"] || "",
    adbSecure: info["ro.adb.secure"],
    abi: abis.includes("arm64-v8a") ? "arm64" : "armv7",
    memMb: Math.round(memKb / 1024),
    freeMb: Math.round(freeKb / 1024),
    homeOwner: homeText.trim().split("/")[0],
    packages,
    disabled,
    isFire,
    isGoogleTv,
    fireOs: isFire ? fireOsVersion(info) : 0,
    os: isFire ? fireOsLabel(info) : isGoogleTv ? `Google TV ${info["ro.build.version.release"] || ""}`.trim() : `Android TV ${info["ro.build.version.release"] || ""}`.trim()
  };
}

// Fire OS 6 = Android 7.1 (API 25), Fire OS 7 = Android 9 (28), Fire OS 8 = Android 11 (30).
function fireOsVersion(info) {
  const named = String(info["ro.build.version.fireos"] || info["ro.build.version.name"] || "").match(/(\d+)\.\d/);
  if (named) return Number(named[1]);
  const sdk = Number(info["ro.build.version.sdk"] || 0);
  return sdk >= 30 ? 8 : sdk >= 28 ? 7 : sdk >= 25 ? 6 : 5;
}
function fireOsLabel(info) {
  const exact = String(info["ro.build.version.fireos"] || "").trim() || (String(info["ro.build.version.name"] || "").match(/Fire OS ([\d.]+)/) || [])[1];
  return exact ? `Fire OS ${exact}` : `Fire OS ${fireOsVersion(info)}`;
}

function recommendNuvio(device) {
  // The official app is the full experience; the native lite build is far lighter on RAM.
  if (device.memMb && device.memMb < 1700) return "nuvio-legacy-android";
  if (device.isFire && device.memMb < 2200) return "nuvio-legacy-android";
  return "nuvio-official";
}

function recommendHomeStyle(device) {
  // Horizon is the richer screen (~160 MB); the CleanYourTV launcher suits tight-memory boxes.
  if (device.isFire || (device.sdk && device.sdk < 26)) return "clean";
  return device.memMb && device.memMb < 1400 ? "clean" : "horizon";
}

function defaultHomeMode(device) {
  if (device.sdk && device.sdk < 26) return "none";
  // Fire OS won't hand Home to another app, but the clean screen can answer the Home button and
  // cover Amazon's home whenever it comes up (Amazon's stays installed underneath).
  if (device.isFire) return "redirect";
  // Google TV: taking Home fully means disabling the setup wizard, which breaks casting from phones.
  if (device.isGoogleTv) return "redirect";
  return "replace";
}

async function inspect({ ip, profile }, { onAuthPrompt } = {}) {
  const adb = await getConnection(ip, { onAuthPrompt });
  const device = await readDevice(adb);
  const plan = debloat.buildPlan(device);
  const nuvioInstalled = ["com.nuvio.tv", "space.nuvio.nativelegacy"].filter((pkg) => device.packages.has(pkg));
  const deviceKey = `android-${device.serial || ip}`;
  const undo = await store.getUndo(deviceKey);
  const summary = {
    platform: "android",
    profile,
    ip,
    deviceKey,
    name: `${device.manufacturer} ${device.model}`.trim(),
    manufacturer: device.manufacturer,
    model: device.model,
    codename: device.device,
    os: device.os,
    sdk: device.sdk,
    abi: device.abi,
    memMb: device.memMb,
    freeMb: device.freeMb,
    isFire: device.isFire,
    fireOs: device.fireOs,
    isGoogleTv: device.isGoogleTv,
    homeOwner: device.homeOwner,
    adbOpenWithoutPrompt: device.adbSecure === "0",
    installed: {
      nuvio: nuvioInstalled,
      launcher: device.packages.has(LAUNCHER_PKG),
      horizon: device.packages.has(HORIZON.pkg),
      smarttube: device.packages.has("com.teamsmart.videomanager.tv"),
      plex: device.packages.has("com.plexapp.android"),
      youtube: device.packages.has("com.google.android.youtube.tv")
    },
    recommendations: {
      nuvio: recommendNuvio(device),
      homeMode: defaultHomeMode(device),
      homeStyle: recommendHomeStyle(device)
    },
    debloat: plan,
    undoAvailable: Boolean(undo.disabled.length || undo.stockLauncher || undo.homeMode)
  };
  await store.saveDevice({
    id: deviceKey, platform: "android", profile, ip, name: summary.name, model: device.model, serial: device.serial, os: summary.os, abi: device.abi
  });
  return summary;
}

// ---- Run ------------------------------------------------------------------------------

function stepsFor(choices) {
  const steps = [{ id: "connect", label: "Connect to the TV" }];
  if (choices.nuvio && choices.nuvio !== "skip") steps.push({ id: "nuvio", label: "Install Nuvio" });
  if (choices.smarttube) steps.push({ id: "smarttube", label: "Install SmartTube" });
  if (choices.homeMode && choices.homeMode !== "none") steps.push({ id: "home", label: choices.homeStyle === "horizon" ? "Set up Horizon Home" : "Set up the clean home screen" });
  if (choices.debloat?.length) steps.push({ id: "debloat", label: "Remove ads, tracking & bloat" });
  if (choices.dnsBlock && choices.horizon?.nextdnsId) steps.push({ id: "dns", label: "Block ads network-wide (NextDNS)" });
  if (choices.speed) steps.push({ id: "speed", label: "Speed tweaks" });
  steps.push({ id: "finish", label: "Finish up" });
  return steps;
}

function progressText(sent, total, started) {
  const mb = (value) => `${(value / 1048576).toFixed(1)} MB`;
  const seconds = Math.max(0.5, (Date.now() - started) / 1000);
  return `${mb(sent)} of ${mb(total)} at ${mb(sent / seconds)}/s`;
}

async function installApk(adb, job, step, artifact, { replaceIncompatible = false, label }) {
  step.detail(`Downloading ${label}…`);
  const started = Date.now();
  const file = await assets.get(artifact.id, artifact.variant, {
    onProgress: (received, total) => total && step.progress(received / total * 0.4, `Downloading, ${progressText(received, total, started)}`)
  });
  if (file.offline) job.log(`Offline: using the downloaded ${file.name}.`);
  const uploadStarted = Date.now();
  let output = await adb.install(file.path, {
    flags: "-r -g",
    onProgress: (sent, total) => step.progress(0.4 + sent / total * 0.5, `Uploading to the TV, ${progressText(sent, total, uploadStarted)}`)
  });
  step.progress(0.95, "Installing on the TV…");
  if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(output)) {
    if (!replaceIncompatible) {
      return { status: "kept", detail: `A differently signed ${label} is already installed, so it was kept. Choose "Replace" to swap it (its settings will be reset).`, file };
    }
    job.log(`Replacing the existing ${label} (different signature).`);
    await adb.shell(`pm uninstall ${file.package}`);
    output = await adb.install(file.path, { flags: "-r -g" });
  }
  if (/INSTALL_FAILED_NO_MATCHING_ABIS/i.test(output) && artifact.variant === "arm64") {
    job.log("This TV runs 32-bit apps; switching to the 32-bit build.");
    return installApk(adb, job, step, { ...artifact, variant: "armv7" }, { replaceIncompatible, label });
  }
  if (/INSTALL_FAILED_INSUFFICIENT_STORAGE/i.test(output)) throw new Error("The TV is out of storage. Free some space and try again.");
  if (!/Success/.test(output)) throw new Error(`The TV refused the install: ${output.split("\n").pop() || output}`);
  return { status: "installed", detail: `${label} ${file.tag} installed`, file };
}

async function pushLauncherConfig(adb, config) {
  const local = Buffer.from(JSON.stringify(config, null, 2));
  const staged = "/data/local/tmp/tvsetup-config.json";
  await adb.push(local, staged);
  const dir = `/sdcard/Android/data/${LAUNCHER_PKG}/files`;
  const out = await adb.shell(
    `w=; o=$(content write --uri content://${LAUNCHER_PKG}.theme/config.json < ${staged} 2>&1) && case "$o" in *Unsupported*|*Error*) ;; *) w=1;; esac; ` +
    `[ -n "$w" ] || { mkdir -p ${dir} 2>/dev/null; cp ${staged} ${dir}/config.json 2>/dev/null && w=1; }; rm -f ${staged}; [ -n "$w" ] && echo written || echo failed`
  );
  return out.includes("written");
}

async function enableAccessibilityService(adb, service) {
  const component = service.includes("/") ? service : `${LAUNCHER_PKG}/.${service}`;
  const before = (await adb.shell("settings get secure enabled_accessibility_services")).trim();
  const list = before && before !== "null" ? before.split(":").filter(Boolean) : [];
  if (!list.includes(component)) list.push(component);
  const pkg = component.split("/")[0];
  await adb.shell(`cmd appops set ${pkg} AUTO_START allow 2>/dev/null; settings put secure enabled_accessibility_services '${list.join(":")}'; settings put secure accessibility_enabled 1`);
  return before;
}

async function setupHome(adb, job, step, device, choices, deviceKey, dockApps) {
  if (device.sdk && device.sdk < 26) return device.isFire ? "Skipped: Fire OS 6 is too old for the clean screen (it needs Fire OS 7 or newer)." : "Skipped: this TV is older than Android 8, which the home screen needs.";
  step.detail("Installing the home screen…");
  const result = await installApk(adb, job, step, { id: "launcher" }, { label: "home screen", replaceIncompatible: true });
  if (result.status !== "installed" && !device.packages.has(LAUNCHER_PKG)) throw new Error(result.detail);

  const stock = device.isFire ? FIRE_HOME : await findStockLauncher(adb, device);
  const saved = (await store.getDevice(deviceKey))?.home || {};
  const owned = {
    dockApps,
    stockHome: (choices.homeMode === "redirect" || device.isFire) && stock ? stock : "",
    buttons: choices.buttons ?? saved.buttons ?? [],
    openOnStart: choices.openOnStart ?? saved.openOnStart ?? "",
    openOnWake: choices.openOnWake ?? saved.openOnWake ?? false
  };
  const lookId = choices.look || saved.look || ((await looks.listLooks()).length ? "nuvio-cinema" : "");
  const writeHome = async (configOnly) => {
    if (lookId) {
      await looks.applyLook(adb, { lookId, owned, device, configOnly, onProgress: (f, text) => step.progress(f, text) });
      return true;
    }
    const config = looks.mergeConfig({ show_greeting: false }, owned, device);
    return pushLauncherConfig(adb, config);
  };
  // The look can turn on the launcher's key service (redirect, remote buttons): remember the list from before it.
  const a11yBefore = (await adb.shell("settings get secure enabled_accessibility_services")).trim();
  await store.updateUndo(deviceKey, (undo) => ({ ...undo, accessibility: undo.accessibility ?? a11yBefore }));
  step.detail(lookId ? "Dressing up the home screen…" : "Setting up your dock…");
  await adb.shell(`am start -W -n ${LAUNCHER_ACTIVITY} >/dev/null 2>&1; true`);
  let written = false;
  try { written = await writeHome(false); } catch (error) { job.log(`Couldn't apply the look (${error.message}); using the plain screen.`); written = await pushLauncherConfig(adb, looks.mergeConfig({}, owned, device)); }
  if (!written) job.log("Couldn't write the dock layout; the home screen uses its defaults.");
  await store.saveDevice({ id: deviceKey, home: { look: lookId, dockApps, stockHome: owned.stockHome, buttons: owned.buttons, openOnStart: owned.openOnStart, openOnWake: owned.openOnWake, memMb: device.memMb || 0 } });

  await store.updateUndo(deviceKey, (undo) => ({ ...undo, stockLauncher: stock || undo.stockLauncher, homeMode: choices.homeMode }));

  if (choices.homeMode === "replace" && stock) {
    step.detail("Handing Home to the new screen…");
    const start = await adb.shell(`am start -W -a android.intent.action.MAIN -c android.intent.category.HOME -n ${LAUNCHER_ACTIVITY}`);
    if (!/Status: ok/.test(start) && /Error/i.test(start)) throw new Error("The new home screen didn't start, so nothing was changed.");
    await adb.shell(`cmd package compile -m speed -f ${LAUNCHER_PKG} >/dev/null 2>&1; pm disable-user --user 0 ${stock} >/dev/null 2>&1; cmd package set-home-activity --user 0 ${LAUNCHER_ACTIVITY} >/dev/null 2>&1; true`);
    const now = (await adb.shell(`${HOME_QUERY} 2>/dev/null | tail -n 1`)).trim();
    if (!now.startsWith(`${LAUNCHER_PKG}/`)) {
      const claim = await adb.shell(`${CLAIM_QUERY} 2>/dev/null`);
      if (now === "android" && claim.includes(`${LAUNCHER_PKG}/`)) {
        job.log("Home shows Android's chooser with the new screen in it; keeping it.");
      } else {
        job.log(`Home went to ${now || "nothing"}; undoing and switching to the Home-button redirect instead.`);
        await adb.shell(`pm enable --user 0 ${stock} >/dev/null 2>&1; true`);
        owned.stockHome = stock;
        await writeHome(true);
        await store.saveDevice({ id: deviceKey, home: { ...(await store.getDevice(deviceKey))?.home, stockHome: stock } });
        const previous = await enableAccessibilityService(adb, "HomeKeyService");
        await store.updateUndo(deviceKey, (undo) => ({ ...undo, homeMode: "redirect", accessibility: undo.accessibility ?? previous }));
        await adb.shell(`am start -W -n ${LAUNCHER_ACTIVITY} >/dev/null 2>&1; true`);
        return "Home button now opens the clean screen (the stock home stays as a fallback).";
      }
    }
    return "The clean screen is now Home. The old one is turned off; Undo brings it back.";
  }

  if (device.isFire) {
    // Amazon's home can't be turned off or replaced; it stays the system Home and the clean screen
    // comes up over it every time it shows (Home button, power-on, leaving an app).
    step.detail("Making the Home button open the clean screen…");
    const previous = await enableAccessibilityService(adb, "HomeKeyService");
    await store.updateUndo(deviceKey, (undo) => ({ ...undo, homeMode: "redirect", accessibility: undo.accessibility ?? previous }));
    await adb.shell(`cmd package compile -m speed -f ${LAUNCHER_PKG} >/dev/null 2>&1; am start -W -n ${LAUNCHER_ACTIVITY} >/dev/null 2>&1; true`);
    const enabled = (await adb.shell("settings get secure enabled_accessibility_services")).trim();
    if (!enabled.includes(`${LAUNCHER_PKG}/`)) {
      throw new Error("Fire TV didn't turn on the clean screen's Home-button service. Open Settings > Accessibility on the Fire TV and check for it, then run setup again.");
    }
    return device.fireOs >= 8
      ? "The Home button now opens the clean screen. Amazon's home stays underneath and may flash for a moment."
      : "The Home button now opens the clean screen. On Fire OS 7 Amazon's home can show for a second or two first.";
  }

  if (choices.homeMode === "redirect") {
    step.detail("Making the Home button open the clean screen…");
    const previous = await enableAccessibilityService(adb, "HomeKeyService");
    await store.updateUndo(deviceKey, (undo) => ({ ...undo, accessibility: undo.accessibility ?? previous }));
    await adb.shell(`cmd package compile -m speed -f ${LAUNCHER_PKG} >/dev/null 2>&1; cmd package set-home-activity --user 0 ${LAUNCHER_ACTIVITY} >/dev/null 2>&1; am start -W -n ${LAUNCHER_ACTIVITY} >/dev/null 2>&1; true`);
    return "Home button now opens the clean screen. Casting and the stock home keep working.";
  }
  return "Installed.";
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

async function setupHorizon(adb, job, step, device, choices, deviceKey, extras) {
  if (device.sdk && device.sdk < 26) return "Skipped: Horizon needs Android 8 or newer.";
  step.detail("Installing Horizon Home…");
  const result = await installApk(adb, job, step, { id: "horizon" }, { label: "Horizon Home", replaceIncompatible: true });
  if (result.status !== "installed" && !device.packages.has(HORIZON.pkg)) throw new Error(result.detail);
  step.progress(0.95, "Giving Horizon what it needs (TV guide, memory panel)…");
  await adb.shell(`${HORIZON.grants.map((perm) => `pm grant ${HORIZON.pkg} ${perm} >/dev/null 2>&1`).join("; ")}; appops set ${HORIZON.pkg} GET_USAGE_STATS allow >/dev/null 2>&1; true`);

  const stock = await findStockLauncher(adb, device);
  const previousA11y = (await adb.shell("settings get secure enabled_accessibility_services")).trim();
  await store.updateUndo(deviceKey, (undo) => ({
    ...undo,
    stockLauncher: stock || undo.stockLauncher,
    homeMode: choices.homeMode,
    homeApp: HORIZON.pkg,
    accessibility: undo.accessibility ?? previousA11y
  }));

  step.detail("Making Home open Horizon…");
  await adb.shell(`cmd package set-home-activity --user 0 ${HORIZON.activity} >/dev/null 2>&1; true`);
  await enableAccessibilityService(adb, HORIZON.service);
  let note = "The Home button opens Horizon; the stock home stays as a fallback, so casting keeps working.";
  if (choices.homeMode === "replace" && stock && !device.isGoogleTv) {
    await adb.shell(`pm disable-user --user 0 ${stock} >/dev/null 2>&1; cmd package set-home-activity --user 0 ${HORIZON.activity} >/dev/null 2>&1; true`);
    const now = (await adb.shell(`${HOME_QUERY} 2>/dev/null | tail -n 1`)).trim();
    if (now.startsWith(`${HORIZON.pkg}/`)) note = "Horizon is now Home. The old home is turned off; Undo brings it back.";
    else {
      await adb.shell(`pm enable --user 0 ${stock} >/dev/null 2>&1; true`);
      job.log(`Home went to ${now || "nothing"} with ${stock} off, so it was turned back on. Horizon still opens from the Home button.`);
    }
  }
  const args = Object.entries(extras).filter(([, value]) => value).map(([key, value]) => `--es ${key} ${shellQuote(value)}`).join(" ");
  await adb.shell(`cmd package compile -m speed -f ${HORIZON.pkg} >/dev/null 2>&1; am start -n ${HORIZON.activity} ${args} >/dev/null 2>&1; true`, 300000);
  const missing = [!extras.tmdb && "TMDB key (artwork)", !extras.livetv && "Live TV link (guide)"].filter(Boolean);
  if (missing.length) job.log(`Horizon works now; add your ${missing.join(" and ")} in TV Setup's Settings and run setup again to fill in the rest.`);
  return note;
}

async function setPrivateDns(adb, deviceKey, hostname) {
  const keys = ["private_dns_mode", "private_dns_specifier"];
  const before = {};
  for (const key of keys) before[key] = (await adb.shell(`settings get global ${key}`)).trim();
  await store.updateUndo(deviceKey, (undo) => ({ ...undo, settings: { ...before, ...undo.settings } }));
  await adb.shell(`settings put global private_dns_specifier ${hostname}; settings put global private_dns_mode hostname`);
  const mode = (await adb.shell("settings get global private_dns_mode")).trim();
  if (mode !== "hostname") throw new Error("The TV didn't accept the private DNS setting.");
}

async function findStockLauncher(adb, device) {
  const owner = (await adb.shell(`${HOME_QUERY} 2>/dev/null | tail -n 1`)).trim().split("/")[0];
  if (debloat.STOCK_LAUNCHERS.includes(owner)) return owner;
  const claimants = (await adb.shell(`${CLAIM_QUERY} 2>/dev/null`)).split("\n").map((line) => (line.trim().match(/^([\w.]+)\//) || [])[1]).filter(Boolean);
  const known = debloat.STOCK_LAUNCHERS.filter((pkg) => claimants.includes(pkg) && pkg !== "com.amazon.tv.launcher");
  if (known.length === 1) return known[0];
  return debloat.STOCK_LAUNCHERS.find((pkg) => device.packages.has(pkg) && !device.disabled.has(pkg)) || "";
}

async function run({ ip, profile, choices }, job) {
  let adb;
  let device;
  let deviceKey;
  const installedPackages = [];

  await job.run("connect", async (step) => {
    adb = await getConnection(ip, {
      onAuthPrompt: () => step.waiting("On the TV, choose Allow on \"Allow USB debugging?\" and tick Always allow.")
    });
    device = await readDevice(adb);
    deviceKey = `android-${device.serial || ip}`;
    return `${device.manufacturer} ${device.model}, ${device.os}`;
  });

  if (choices.nuvio && choices.nuvio !== "skip") {
    await job.run("nuvio", async (step) => {
      if (choices.nuvio === "custom") {
        if (!choices.customApk) throw new Error("Pick an APK file first.");
        const output = await adb.install(choices.customApk, { flags: "-r -g", onProgress: (sent, total) => step.progress(sent / total, "Uploading…") });
        if (!/Success/.test(output)) throw new Error(output.split("\n").pop());
        return "Your Nuvio build is installed";
      }
      const result = await installApk(adb, job, step, { id: choices.nuvio, variant: device.abi }, { label: "Nuvio", replaceIncompatible: choices.replaceIncompatible });
      installedPackages.push(result.file.package);
      if (result.status === "kept") step.skip(result.detail);
      return result.detail;
    }, { optional: true });
  }

  if (choices.smarttube) {
    await job.run("smarttube", async (step) => {
      const result = await installApk(adb, job, step, { id: "smarttube", variant: device.abi }, { label: "SmartTube", replaceIncompatible: false });
      installedPackages.push("com.teamsmart.videomanager.tv");
      if (result.status === "kept") step.skip(result.detail);
      return result.detail;
    }, { optional: true });
  }

  if (choices.homeMode && choices.homeMode !== "none") {
    const dockApps = defaultDock(choices, device);
    await job.run("home", (step) => choices.homeStyle === "horizon" && !device.isFire
      ? setupHorizon(adb, job, step, device, choices, deviceKey, {
        name: choices.horizon?.name || "",
        tmdb: choices.horizon?.tmdb || "",
        livetv: (choices.horizon?.livetv || "").replace(/\/manifest\.json$/, ""),
        nextdns_id: choices.horizon?.nextdnsId || "",
        nextdns_key: choices.horizon?.nextdnsKey || ""
      })
      : setupHome(adb, job, step, device, choices, deviceKey, dockApps), { optional: true });
  }

  if (choices.debloat?.length) {
    await job.run("debloat", async (step) => {
      step.detail("Running safety checks on the TV…");
      const refreshed = await readDevice(adb);
      const wanted = choices.debloat.filter((pkg) => refreshed.packages.has(pkg) && !refreshed.disabled.has(pkg));
      const { list, skipped } = await debloat.guard(adb, wanted, (text) => job.log(text));
      for (const item of skipped) job.log(`Kept ${item.pkg}: ${item.reason}.`);
      if (!list.length) return skipped.length ? `Nothing safe to turn off (${skipped.length} kept for safety)` : "Nothing left to turn off";
      const { done, failed } = await debloat.apply(adb, list, {
        record: (batch) => store.updateUndo(deviceKey, (undo) => ({ ...undo, disabled: [...new Set([...undo.disabled, ...batch])] })),
        onProgress: (count, total) => step.progress(count / total, `Turned off ${count} of ${total}`),
        log: (text) => job.log(text)
      });
      return `Turned off ${done.length}${failed.length ? `, ${failed.length} refused by the TV` : ""}${skipped.length ? `, ${skipped.length} kept for safety` : ""}`;
    }, { optional: true });
  }

  if (choices.dnsBlock && choices.horizon?.nextdnsId) {
    await job.run("dns", async () => {
      const id = String(choices.horizon.nextdnsId).trim().replace(/[^a-z0-9]/gi, "");
      await setPrivateDns(adb, deviceKey, `${id}.dns.nextdns.io`);
      return `Ads and trackers blocked for every app through NextDNS (${id})`;
    }, { optional: true });
  }

  if (choices.speed) {
    await job.run("speed", async (step) => {
      const keys = ["window_animation_scale", "transition_animation_scale", "animator_duration_scale"];
      const before = {};
      for (const key of keys) before[key] = (await adb.shell(`settings get global ${key}`)).trim();
      await store.updateUndo(deviceKey, (undo) => ({ ...undo, settings: { ...before, ...undo.settings } }));
      await adb.shell(keys.map((key) => `settings put global ${key} 0.5`).join("; "));
      const compileTargets = [...new Set([...installedPackages, LAUNCHER_PKG, HORIZON.pkg, "com.nuvio.tv", "space.nuvio.nativelegacy"])];
      let index = 0;
      for (const pkg of compileTargets) {
        index += 1;
        const present = (await adb.shell(`pm path ${pkg} 2>/dev/null`)).trim();
        if (!present) continue;
        step.progress(index / compileTargets.length, `Optimizing ${pkg}…`);
        await adb.shell(`cmd package compile -m speed -f ${pkg} >/dev/null 2>&1; true`, 300000);
      }
      return "Faster animations, apps pre-compiled for speed";
    }, { optional: true });
  }

  await job.run("finish", async () => {
    await adb.shell(`am start -a android.intent.action.MAIN -c android.intent.category.HOME >/dev/null 2>&1; true`);
    await store.saveDevice({ id: deviceKey, platform: "android", profile, ip, name: `${device.manufacturer} ${device.model}`.trim(), model: device.model, serial: device.serial, lastSetup: Date.now(), choices: { ...choices, debloat: undefined } });
    return "The TV is back on its home screen";
  });
  return { deviceKey };
}

function defaultDock(choices, device) {
  const nuvioPkg = choices.nuvio === "nuvio-legacy-android" ? "space.nuvio.nativelegacy" : "com.nuvio.tv";
  const youtube = choices.smarttube ? "com.teamsmart.videomanager.tv" : device.isFire ? "com.amazon.firetv.youtube" : "com.google.android.youtube.tv";
  const dock = [nuvioPkg, "com.nuvio.tv", "space.nuvio.nativelegacy", youtube, "com.plexapp.android", "com.netflix.ninja", ...(device.isFire ? ["com.amazon.amazonvideo.livingroom"] : [])];
  return [...new Set(dock)].slice(0, 5);
}

// ---- Home screen look, remote buttons, power-on app (after setup) ------------------------

async function customizeHome({ ip, deviceKey, look, buttons, openOnStart, openOnWake }, job) {
  let adb;
  let device;
  await job.run("connect", async (step) => {
    adb = await getConnection(ip, { onAuthPrompt: () => step.waiting("On the TV, choose Allow on \"Allow USB debugging?\" and tick Always allow.") });
    device = await readDevice(adb);
    return `${device.manufacturer} ${device.model}`;
  });
  await job.run("home", async (step) => {
    if (!device.packages.has(LAUNCHER_PKG)) throw new Error("The clean home screen isn't on this TV yet. Run setup and pick the Minimal (CleanYourTV) home screen first.");
    const record = (await store.getDevice(deviceKey)) || {};
    const saved = record.home || {};
    const owned = {
      dockApps: saved.dockApps?.length ? saved.dockApps : defaultDock(record.choices || {}, device),
      stockHome: saved.stockHome || "",
      buttons: buttons ?? saved.buttons ?? [],
      openOnStart: openOnStart ?? saved.openOnStart ?? "",
      openOnWake: openOnWake ?? saved.openOnWake ?? false
    };
    const lookId = look || saved.look || "nuvio-cinema";
    const configOnly = lookId === saved.look && !look;
    const before = (await adb.shell("settings get secure enabled_accessibility_services")).trim();
    await looks.applyLook(adb, { lookId, owned, device, configOnly, onProgress: (f, text) => step.progress(f, text) });
    await store.updateUndo(deviceKey, (undo) => ({ ...undo, accessibility: undo.accessibility ?? before }));
    await store.saveDevice({ id: deviceKey, home: { ...saved, look: lookId, ...owned, memMb: device.memMb || 0 } });
    const parts = [];
    if (!configOnly) parts.push(`${(await looks.listLooks()).find((l) => l.id === lookId)?.name || lookId} look applied`);
    if (owned.buttons.length) parts.push(`${owned.buttons.length} remote button${owned.buttons.length > 1 ? "s" : ""} mapped`);
    if (owned.openOnStart) parts.push(`${appLabel(owned.openOnStart)} opens when the TV turns on`);
    return parts.join(", ") || "Home screen updated";
  });
  return { deviceKey };
}

const APP_LABELS = {
  "com.nuvio.tv": "Nuvio", "space.nuvio.nativelegacy": "Nuvio Legacy", "com.teamsmart.videomanager.tv": "SmartTube",
  "com.google.android.youtube.tv": "YouTube", "com.plexapp.android": "Plex", "com.netflix.ninja": "Netflix",
  "com.amazon.amazonvideo.livingroom": "Prime Video", "com.disney.disneyplus": "Disney+", "com.wbd.stream": "Max",
  "com.hulu.livingroomplus": "Hulu", "com.google.android.tv": "Live TV", "com.android.tv.settings": "Settings",
  "com.spotify.tv.android": "Spotify", "com.apple.atve.androidtv.appletv": "Apple TV", "org.xbmc.kodi": "Kodi",
  "com.google.android.youtube.tvmusic": "YouTube Music", "com.cbs.ott": "Paramount+", "com.peacocktv.peacockandroid": "Peacock",
  "com.horizon.home": "Horizon Home", [LAUNCHER_PKG]: "Clean home screen"
};
function appLabel(pkg) {
  if (APP_LABELS[pkg]) return APP_LABELS[pkg];
  const last = String(pkg).split(".").filter((w) => !/^(com|org|tv|android|app|net|ott|livingroom)$/i.test(w)).pop() || pkg;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

async function listApps({ ip }) {
  const adb = await getConnection(ip);
  const out = await adb.shell("cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LEANBACK_LAUNCHER 2>/dev/null; cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER 2>/dev/null");
  const pkgs = [...new Set(out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^[\w.]+\/[\w.$]+$/.test(l)).map((l) => l.split("/")[0]))]
    .filter((p) => p !== LAUNCHER_PKG && !/^com\.android\.(documentsui|providers)/.test(p));
  const order = ["com.nuvio.tv", "space.nuvio.nativelegacy", "com.teamsmart.videomanager.tv", "com.plexapp.android"];
  pkgs.sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99) || appLabel(a).localeCompare(appLabel(b)));
  return pkgs.map((pkg) => ({ pkg, label: appLabel(pkg) }));
}

async function learnButton({ ip, seconds = 12 }) {
  const adb = await getConnection(ip);
  return looks.learnButton(adb, seconds);
}

// ---- Undo -----------------------------------------------------------------------------

async function undo({ ip, deviceKey, removeLauncher = true }, job) {
  let adb;
  const record = await store.getUndo(deviceKey);
  await job.run("connect", async (step) => {
    adb = await getConnection(ip, { onAuthPrompt: () => step.waiting("On the TV, choose Allow on \"Allow USB debugging?\".") });
    return "Connected";
  });
  await job.run("packages", async (step) => {
    if (!record.disabled.length) return "Nothing was turned off";
    await debloat.restore(adb, record.disabled, { onProgress: (count, total) => step.progress(count / total, `Turned back on ${count} of ${total}`) });
    return `Turned back on ${record.disabled.length}`;
  }, { optional: true });
  await job.run("home", async () => {
    if (record.stockLauncher === FIRE_HOME) {
      // Never changed on Fire TV: it only needs the Home-button service turned off (below).
    } else if (record.stockLauncher) {
      await adb.shell(`pm enable --user 0 ${record.stockLauncher} >/dev/null 2>&1; true`);
      const activity = (await adb.shell(`cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME ${record.stockLauncher} 2>/dev/null | tail -n 1`)).trim();
      if (activity.includes("/")) await adb.shell(`cmd package set-home-activity --user 0 ${activity} >/dev/null 2>&1; true`);
    }
    if (record.accessibility !== null && record.accessibility !== undefined) {
      const value = record.accessibility && record.accessibility !== "null" ? record.accessibility : "";
      await adb.shell(value ? `settings put secure enabled_accessibility_services '${value}'` : "settings delete secure enabled_accessibility_services");
    }
    if (removeLauncher) await adb.shell(`pm uninstall ${LAUNCHER_PKG} >/dev/null 2>&1; pm uninstall ${HORIZON.pkg} >/dev/null 2>&1; true`);
    return record.stockLauncher ? `${record.stockLauncher} is Home again` : "Home unchanged";
  }, { optional: true });
  await job.run("settings", async () => {
    const entries = Object.entries(record.settings || {});
    for (const [key, value] of entries) {
      await adb.shell(value && value !== "null" ? `settings put global ${key} ${value}` : `settings delete global ${key}`);
    }
    return entries.length ? "Animation speed restored" : "Nothing to restore";
  }, { optional: true });
  await store.clearUndo(deviceKey);
  await adb.shell("am start -a android.intent.action.MAIN -c android.intent.category.HOME >/dev/null 2>&1; true").catch(() => {});
  return { restored: true };
}

async function launch({ ip, pkg }) {
  const adb = await getConnection(ip);
  await adb.shell(`monkey -p ${pkg} -c android.intent.category.LEANBACK_LAUNCHER 1 >/dev/null 2>&1 || monkey -p ${pkg} -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; true`);
  return true;
}

module.exports = { init, inspect, run, undo, launch, stepsFor, readDevice, getConnection, customizeHome, listApps, learnButton, appLabel, LAUNCHER_PKG };
