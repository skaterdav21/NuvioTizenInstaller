// IPC handlers for the TV Setup UI (scan, inspect, run, undo, prepare, saved TVs, settings).
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const store = require("./core/store");
const assets = require("./core/assets");
const jobs = require("./core/jobs");
const scan = require("./core/scan");
const android = require("./platforms/android");
const lg = require("./platforms/lg");
const samsung = require("./platforms/samsung");
const yearInfo = require("./platforms/samsung-year");
const debloat = require("./platforms/debloat");
const orsay = require("./platforms/orsay");
const looks = require("./platforms/looks");

const APP_VERSION = (() => {
  try { return fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim(); } catch { return "dev"; }
})();

const PROFILES = [
  { id: "samsung", platform: "samsung", label: "Samsung TV", sub: "Tizen, 2018 and newer" },
  { id: "samsung-old", platform: "samsung-old", label: "Older Samsung", sub: "2011 to 2017" },
  { id: "lg", platform: "lg", label: "LG TV", sub: "webOS with Developer Mode" },
  { id: "shield", platform: "android", label: "NVIDIA Shield", sub: "Android TV" },
  { id: "onn", platform: "android", label: "onn box", sub: "Google TV / Android TV" },
  { id: "sony", platform: "android", label: "Sony BRAVIA", sub: "Google TV / Android TV" },
  { id: "androidtv", platform: "android", label: "Other Android / Google TV", sub: "TCL, Hisense, Philips, Chromecast…" },
  { id: "firetv", platform: "android", label: "Fire TV", sub: "Stick, Cube, Fire TV sets" }
];

function platformOf(profile) {
  return PROFILES.find((item) => item.id === profile)?.platform || "android";
}

function register(handlers, { userDataDir, bundledDir, broadcast }) {
  store.init(userDataDir);
  assets.init(userDataDir, bundledDir);
  android.init(userDataDir);
  samsung.init(handlers);
  jobs.setBroadcaster(broadcast);
  orsay.init({ broadcast, store });

  const startJob = (title, steps, worker) => {
    const job = jobs.createJob(title, steps);
    Promise.resolve()
      .then(() => worker(job))
      .then((result) => job.finish(result))
      .catch((error) => { job.log(error?.message || String(error), "error"); job.fail(error); });
    return { jobId: job.id };
  };

  handlers.set("app:info", async () => ({
    version: APP_VERSION,
    profiles: PROFILES,
    settings: await store.getSettings(),
    devices: (await store.listDevices()).map(({ lg: lgSecrets, ...device }) => ({ ...device, hasLgKey: Boolean(lgSecrets?.key) })),
    storageBytes: await assets.storageUsed(),
    lists: { count: debloat.lists().lists.length, commit: debloat.lists().commit, source: debloat.lists().source }
  }));

  handlers.set("settings:set", async (_event, patch) => store.setSettings(patch || {}));

  handlers.set("scan:run", async (_event, phoneIp) => {
    const found = await scan.scan(phoneIp, {
      onProgress: (fraction) => broadcast("scan:progress", { fraction }),
      onFound: (info) => broadcast("scan:found", info)
    });
    return found;
  });

  handlers.set("device:check", async (_event, { ip, platform }) => scan.check(ip, platform));
  handlers.set("samsung:year", async (_event, { model, year }) => (year ? yearInfo.fromYear(year) : yearInfo.yearFromModel(model || "")));

  handlers.set("device:inspect", async (_event, request) => {
    const platform = platformOf(request.profile);
    if (platform === "samsung") return samsung.inspect(request);
    if (platform === "lg") return lg.inspect(request);
    return android.inspect(request, {
      onAuthPrompt: () => broadcast("device:authPrompt", { ip: request.ip })
    });
  });

  handlers.set("device:run", async (_event, request) => {
    const platform = platformOf(request.profile);
    const choices = request.choices || {};
    // Horizon's keys live in this phone's settings; they're handed to the TV, never shown in the UI.
    if (choices.homeStyle === "horizon" || choices.dnsBlock) choices.horizon = { ...((await store.getSettings()).horizon || {}) };
    if (platform === "samsung") return startJob("Setting up your Samsung TV", samsung.stepsFor(choices), (job) => samsung.run(request, job));
    if (platform === "lg") return startJob("Setting up your LG TV", lg.stepsFor(choices), (job) => lg.run(request, job));
    return startJob("Setting up your TV", android.stepsFor(choices), (job) => android.run(request, job));
  });

  handlers.set("device:undo", async (_event, request) => startJob("Undoing changes", [
    { id: "connect", label: "Connect to the TV" },
    { id: "packages", label: "Turn removed apps back on" },
    { id: "home", label: "Restore the original home screen" },
    { id: "settings", label: "Restore settings" }
  ], (job) => android.undo(request, job)));

  handlers.set("device:launch", async (_event, request) => android.launch(request));

  // Backup of saved TVs and settings (the Samsung certificate has its own encrypted backup).
  handlers.set("backup:export", async () => {
    const settings = await store.getSettings();
    const devices = await store.listDevices();
    const stamp = new Date().toISOString().slice(0, 10);
    return { fileName: `tvsetup-backup-${stamp}.json`, text: JSON.stringify({ app: "TV Setup", version: APP_VERSION, exportedAt: Date.now(), settings, devices }, null, 1) };
  });
  handlers.set("backup:import", async (_event, text) => {
    let data;
    try { data = JSON.parse(String(text || "")); } catch { throw new Error("That file isn't a TV Setup backup."); }
    if (data?.app !== "TV Setup" || !Array.isArray(data.devices)) throw new Error("That file isn't a TV Setup backup.");
    if (data.settings && typeof data.settings === "object") await store.setSettings(data.settings);
    for (const device of data.devices) if (device && device.id && device.platform) await store.saveDevice(device);
    return { devices: data.devices.length };
  });

  // Android home screen: looks, remote buttons, the app that opens at power-on.
  handlers.set("home:looks", async () => looks.listLooks());
  handlers.set("home:apps", async (_event, request) => android.listApps(request));
  handlers.set("home:learn", async (_event, request) => android.learnButton(request));
  handlers.set("home:actions", async () => looks.ACTIONS);
  handlers.set("home:apply", async (_event, request) => startJob("Updating the home screen", [
    { id: "connect", label: "Connect to the TV" },
    { id: "home", label: request.look ? "Apply the new look" : "Update remote buttons and power-on app" }
  ], (job) => android.customizeHome(request, job)));
  handlers.set("device:remove", async (_event, id) => { await store.removeDevice(id); return true; });
  handlers.set("device:list", async () => store.listDevices());
  handlers.set("job:get", async (_event, id) => jobs.getJob(id));
  handlers.set("job:cancel", async (_event, id) => { jobs.cancelJob(id); return true; });

  handlers.set("lg:extendAll", async () => lg.extendAll());

  // Older Samsung (Orsay, 2011-2014): Nuvio Lite + Plex through User App Sync, and the TV's HTTPS relay.
  handlers.set("orsay:config", async () => orsay.getConfig());
  handlers.set("orsay:setConfig", async (_event, patch) => orsay.setConfig(patch || {}));
  handlers.set("orsay:setPlexZip", async (_event, zipPath) => {
    if (!zipPath) return orsay.setConfig({ plexZip: "" });
    const uploads = path.join(userDataDir, "uploads");
    const resolved = path.resolve(String(zipPath));
    if (!resolved.startsWith(uploads + path.sep)) throw new Error("Invalid file.");
    await orsay.checkWidgetZip(resolved);
    const keep = path.join(userDataDir, "tvsetup", "orsay-plex.zip");
    await fs.promises.mkdir(path.dirname(keep), { recursive: true });
    await fs.promises.copyFile(resolved, keep);
    return orsay.setConfig({ plexZip: keep });
  });
  handlers.set("orsay:start", async (_event, request = {}) => orsay.start(request));
  handlers.set("orsay:stop", async () => { await orsay.stop(); return orsay.status(); });
  handlers.set("orsay:status", async () => orsay.status());

  // Prepare ahead: download everything the saved TVs (or all platforms) need, so setup at the
  // TV only uploads and installs. Samsung also gets its package pre-signed (installer:prefetch).
  handlers.set("prepare:run", async (_event, request = {}) => {
    const devices = await store.listDevices();
    const settings = await store.getSettings();
    const wantAll = Boolean(request.all || settings.prepareAllPlatforms);
    const wanted = [];
    const add = (id, variant, label) => { if (!wanted.some((item) => item.id === id && item.variant === variant)) wanted.push({ id, variant, label }); };
    for (const device of devices) {
      if (device.platform === "android") {
        const choice = device.choices?.nuvio && device.choices.nuvio !== "skip" && device.choices.nuvio !== "custom" ? device.choices.nuvio : "nuvio-official";
        const abi = device.abi || "arm64";
        add(choice, abi, `Nuvio for ${device.name}`);
        if (device.choices?.smarttube) add("smarttube", abi, `SmartTube for ${device.name}`);
      }
      if (device.platform === "lg") add("nuvio-legacy-lg", device.choices?.nuvio === "highcache" ? "highcache" : "default", "Nuvio for LG");
    }
    if (wantAll) {
      add("nuvio-official", "arm64", "Nuvio (64-bit)");
      add("nuvio-official", "armv7", "Nuvio (32-bit)");
      add("nuvio-legacy-android", "arm64", "Nuvio Legacy (64-bit)");
      add("nuvio-legacy-android", "armv7", "Nuvio Legacy (32-bit)");
      add("nuvio-legacy-lg", "default", "Nuvio for LG");
      add("smarttube", "arm64", "SmartTube (64-bit)");
      add("smarttube", "armv7", "SmartTube (32-bit)");
    }
    const hasSamsung = devices.some((device) => device.platform === "samsung") || wantAll;
    const steps = wanted.map((item, index) => ({ id: `a${index}`, label: item.label }));
    if (hasSamsung) steps.push({ id: "samsung", label: "Samsung: download & pre-sign Nuvio Legacy" });
    if (!steps.length) return { jobId: null, nothing: true };
    return startJob("Preparing downloads", steps, async (job) => {
      for (const [index, item] of wanted.entries()) {
        await job.run(`a${index}`, async (step) => {
          const result = await assets.get(item.id, item.variant, {
            onProgress: (received, total) => total && step.progress(received / total, `${(received / 1048576).toFixed(0)} of ${(total / 1048576).toFixed(0)} MB`)
          });
          return result.fromCache ? `Ready (${result.tag})` : `Downloaded ${result.tag}`;
        }, { optional: true });
      }
      if (hasSamsung && handlers.get("installer:prefetch")) {
        await job.run("samsung", async () => {
          const samsungDevice = devices.find((device) => device.platform === "samsung");
          const summary = await handlers.get("installer:prefetch")({ sender: { send: (_c, p) => job.log(String(p?.text || "")) } }, {
            apps: ["legacy"], ip: samsungDevice?.ip || "", legacyVariant: samsungDevice?.choices?.legacyVariant || "auto"
          });
          if (summary?.errors?.length) throw new Error(summary.errors[0]);
          return summary?.signed ? "Downloaded and pre-signed" : "Downloaded";
        }, { optional: true });
      }
      await assets.prune(2).catch(() => {});
      await store.setSettings({ lastPrepared: Date.now() });
      return { prepared: wanted.length + (hasSamsung ? 1 : 0) };
    });
  });

  handlers.set("storage:clear", async () => {
    await fs.promises.rm(path.join(userDataDir, "packages"), { recursive: true, force: true });
    return assets.storageUsed();
  });
}

module.exports = { register, PROFILES };
