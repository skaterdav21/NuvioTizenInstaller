// Fire TV Stick 4K Max (Fire OS 8) end to end: lite Nuvio in 32-bit, clean screen over Amazon's
// home through the Home-button service, debloat that never touches Fire's essentials, then Undo.
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const mock = require("./mock-adbd.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "firetest-"));
process.env.NUVIO_DATA_DIR = tmp;
const store = require("../nodejs-project/src/core/store");
const assets = require("../nodejs-project/src/core/assets");
const jobs = require("../nodejs-project/src/core/jobs");
const android = require("../nodejs-project/src/platforms/android");
const { tv, shell, LAUNCHER, AMAZON_HOME } = require("./fake-fire.js");

function fakeApk(dir, name, pkg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.concat([Buffer.from(pkg.padEnd(40, " ")), crypto.randomBytes(1 << 20)]));
}

(async () => {
  store.init(tmp);
  const bundled = path.join(tmp, "bundled");
  assets.init(tmp, bundled);
  android.init(tmp);
  fakeApk(bundled, "tvhome.apk", LAUNCHER);
  fakeApk(path.join(tmp, "packages", "iqui27__nuvio-native-legacy", "v2.0.8"), "Nuvio-2.0.8-android-lite-armv7.apk", "space.nuvio.nativelegacy");
  global.fetch = async () => { throw new Error("offline"); };
  const { server, state } = await mock.start({ port: 25558, maxdata: 4096, shell });
  const ip = "127.0.0.1:25558";

  const summary = await android.inspect({ ip, profile: "firetv" });
  console.log("inspect:", summary.name, "|", summary.os, "|", summary.abi, "|", summary.memMb, "MB | list:", summary.debloat.matched?.id, "| home:", summary.recommendations.homeMode);
  assert.ok(summary.isFire, "detected as Fire TV");
  assert.strictEqual(summary.fireOs, 8);
  assert.strictEqual(summary.os, "Fire OS 8.1.8.5");
  assert.strictEqual(summary.abi, "armv7", "32-bit userspace");
  assert.strictEqual(summary.recommendations.nuvio, "nuvio-legacy-android", "lite Nuvio on a 2 GB stick");
  assert.strictEqual(summary.recommendations.homeMode, "redirect", "clean screen over Amazon's home");
  assert.strictEqual(summary.recommendations.homeStyle, "clean");
  assert.strictEqual(summary.debloat.matched.id, "amazon-fire-tv-stick-4k-max-2023");
  const allItems = summary.debloat.categories.flatMap((c) => c.items);
  assert.ok(!allItems.some((i) => i.pkg === AMAZON_HOME || i.pkg === "com.amazon.vizzini" || i.pkg.startsWith("com.amazon.tv.settings")), "Fire essentials never offered");

  const updates = [];
  jobs.setBroadcaster((channel, payload) => { if (channel === "job:update") updates.push(payload); });
  // Pretend the UI also sent Amazon's essentials (an old saved plan): the guard must still refuse them.
  const selected = allItems.filter((i) => i.selected).map((i) => i.pkg).concat([AMAZON_HOME, "com.amazon.vizzini", "com.amazon.device.controllermanager", "com.amazon.tv.ime"]);
  const choices = { nuvio: "nuvio-legacy-android", homeMode: "redirect", homeStyle: "horizon", debloat: selected, speed: true, smarttube: false };
  const job = jobs.createJob("Fire TV", android.stepsFor(choices));
  const result = await android.run({ ip, profile: "firetv", choices }, job);
  job.finish(result);
  const final = updates[updates.length - 1];
  console.log("steps:", final.steps.map((s) => `${s.id}=${s.status}${s.detail ? ` (${s.detail})` : ""}`).join("\n       "));
  for (const step of final.steps) assert.strictEqual(step.status, "done", `${step.id} done`);
  assert.ok(tv.installed.has("space.nuvio.nativelegacy"), "Nuvio Legacy installed");
  assert.ok(tv.installed.has(LAUNCHER), "clean screen installed (Horizon is never used on Fire)");
  assert.ok(!tv.installed.has("com.horizon.home"));
  assert.ok(tv.secure.enabled_accessibility_services.includes(`${LAUNCHER}/.HomeKeyService`), "Home-button service on");
  assert.strictEqual(tv.setHomeCalls, 0, "never tries to change Fire's Home");
  assert.ok(!tv.disabled.has(AMAZON_HOME) && !tv.disabled.has("com.amazon.vizzini") && !tv.disabled.has("com.amazon.tv.ime"), "essentials kept");
  assert.strictEqual(tv.attemptedProtected.length, 0, "guard dropped protected packages before asking the TV");
  assert.ok(tv.disabled.size > 10, `ads/bloat turned off (${tv.disabled.size})`);
  const debloatStep = final.steps.find((s) => s.id === "debloat");
  assert.ok(/^Turned off \d+, ?|^Turned off \d+$/.test(debloatStep.detail) && !/refused/.test(debloatStep.detail), debloatStep.detail);
  const config = JSON.parse(state.files["/data/local/tmp/tvsetup-look-config.json"].toString());
  assert.strictEqual(config.stock_home_redirect, AMAZON_HOME, "redirect target is Amazon's home");
  assert.strictEqual(config.power_on_home_always, true);
  assert.strictEqual(config.dock_apps[0], "space.nuvio.nativelegacy", "Nuvio first");
  assert.ok(config.dock_apps.includes("com.amazon.firetv.youtube"), "Fire's YouTube app in the dock");

  const undoJob = jobs.createJob("Undo", [{ id: "connect", label: "c" }, { id: "packages", label: "p" }, { id: "home", label: "h" }, { id: "settings", label: "s" }]);
  await android.undo({ ip, deviceKey: result.deviceKey }, undoJob);
  undoJob.finish({});
  assert.strictEqual(tv.disabled.size, 0, "everything back on");
  assert.ok(!tv.installed.has(LAUNCHER), "clean screen removed");
  assert.ok(!tv.secure.enabled_accessibility_services.includes(LAUNCHER), "Home-button service off");
  assert.strictEqual(tv.setHomeCalls, 0);
  assert.strictEqual(state.violations, 0);
  server.close();
  console.log("android-fire: all checks passed");
  process.exit(0);
})().catch((error) => { console.error("FAIL", error); process.exit(1); });
