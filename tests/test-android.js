// Android engine end-to-end against a stateful mock NVIDIA Shield (2019 tube, Android TV 11).
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const mock = require("./mock-adbd.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "andtest-"));
process.env.NUVIO_DATA_DIR = tmp;
const store = require("../nodejs-project/src/core/store");
const assets = require("../nodejs-project/src/core/assets");
const jobs = require("../nodejs-project/src/core/jobs");
const android = require("../nodejs-project/src/platforms/android");
const debloat = require("../nodejs-project/src/platforms/debloat");

const { tv, shell, homeOwner, LAUNCHER } = require("./fake-shield.js");

function fakeApk(dir, name, pkg) {
  fs.mkdirSync(dir, { recursive: true });
  // First 40 bytes carry the package name so the mock "installs" the right package.
  const body = Buffer.concat([Buffer.from(pkg.padEnd(40, " ")), crypto.randomBytes(2 * 1024 * 1024)]);
  fs.writeFileSync(path.join(dir, name), body);
}

(async () => {
  store.init(tmp);
  const bundled = path.join(tmp, "bundled");
  assets.init(tmp, bundled);
  android.init(tmp);
  fakeApk(bundled, "tvhome.apk", LAUNCHER);
  fakeApk(path.join(tmp, "packages", "NuvioMedia__NuvioTV", "1.0.0"), "app-full-arm64-v8a-release.apk", "com.nuvio.tv");
  global.fetch = async () => { throw new Error("offline"); };

  const { server, state } = await mock.start({ port: 25556, maxdata: 4096, shell, banner: "device::ro.product.name=sif;ro.product.model=SHIELD Android TV;ro.product.device=sif;" });
  let prompts = 0;
  const summary = await android.inspect({ ip: "127.0.0.1:25556", profile: "shield" }, { onAuthPrompt: () => { prompts += 1; } });
  android.init(tmp);
  assert.strictEqual(prompts, 1);
  assert.strictEqual(summary.debloat.matched.id, "nvidia-shield-tv-2019", "matched the Shield 2019 list");
  assert.ok(summary.debloat.matched.exact, "exact codename match");
  assert.strictEqual(summary.recommendations.homeMode, "replace");
  assert.strictEqual(summary.recommendations.nuvio, "nuvio-official");
  const cats = Object.fromEntries(summary.debloat.categories.map((c) => [c.id, c.items.length]));
  console.log("plan:", summary.debloat.matched.tv, "| categories:", JSON.stringify(cats), "| selected:", summary.debloat.selectedCount, "of", summary.debloat.total);
  const allItems = summary.debloat.categories.flatMap((c) => c.items);
  assert.ok(!allItems.some((i) => i.pkg === "com.google.android.tvlauncher"), "stock launcher left to the home step");
  assert.ok(allItems.filter((i) => i.selected).every((i) => !/youtube|netflix|vending|katniss/.test(i.pkg)), "everyday apps never preselected");

  const selected = allItems.filter((i) => i.selected).map((i) => i.pkg).concat(["com.nvidia.tvsettings.input", "com.google.android.tv", "com.android.tv.settings"]);
  const updates = [];
  jobs.setBroadcaster((channel, payload) => { if (channel === "job:update") updates.push(payload); });
  const choices = { nuvio: "nuvio-official", homeMode: "replace", debloat: selected, speed: true, smarttube: false };
  const job = jobs.createJob("Shield", android.stepsFor(choices));
  const result = await android.run({ ip: "127.0.0.1:25556", profile: "shield", choices }, job);
  job.finish(result);
  const final = updates[updates.length - 1];
  console.log("steps:", final.steps.map((s) => `${s.id}=${s.status}${s.detail ? ` (${s.detail})` : ""}`).join("\n       "));
  for (const step of final.steps) assert.strictEqual(step.status, "done", `${step.id} done`);
  assert.ok(tv.installed.has("com.nuvio.tv"), "Nuvio installed");
  assert.ok(tv.installed.has(LAUNCHER), "launcher installed");
  assert.strictEqual(homeOwner(), LAUNCHER, "launcher owns Home");
  assert.ok(tv.disabled.has("com.google.android.tvlauncher"), "stock launcher disabled in replace mode");
  assert.ok(!tv.disabled.has("com.nvidia.tvsettings.input"), "input driver kept by the guard");
  assert.ok(!tv.disabled.has("com.google.android.tv"), "channel/input handler kept by the guard");
  assert.ok(!tv.disabled.has("com.android.tv.settings"), "settings kept (core)");
  assert.ok(tv.disabled.has("com.nvidia.stats"), "telemetry disabled");
  assert.strictEqual(tv.settings.window_animation_scale, "0.5");
  assert.ok(state.commands.some((c) => c.includes("content write --uri content://com.gathin.tvhome.theme/config.json")), "dock config pushed");
  const dock = JSON.parse(state.files["/data/local/tmp/tvsetup-config.json"].toString());
  assert.strictEqual(dock.dock_apps[0], "com.nuvio.tv", "Nuvio first in the dock");

  // Undo
  const undoJob = jobs.createJob("Undo", [{ id: "connect", label: "c" }, { id: "packages", label: "p" }, { id: "home", label: "h" }, { id: "settings", label: "s" }]);
  await android.undo({ ip: "127.0.0.1:25556", deviceKey: result.deviceKey }, undoJob);
  undoJob.finish({});
  assert.strictEqual(tv.disabled.size, 0, "everything re-enabled");
  assert.strictEqual(homeOwner(), "com.google.android.tvlauncher", "stock home back");
  assert.ok(!tv.installed.has(LAUNCHER), "launcher removed");
  assert.strictEqual(tv.settings.window_animation_scale, "1.0", "animations restored");
  assert.strictEqual(state.violations, 0);
  server.close();
  console.log("android: all checks passed");
  process.exit(0);
})().catch((error) => { console.error("FAIL", error); process.exit(1); });
