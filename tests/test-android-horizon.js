// Horizon Home + NextDNS on the mock Shield, then Undo.
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const mock = require("./mock-adbd.js");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hztest-"));
process.env.NUVIO_DATA_DIR = tmp;
const store = require("../nodejs-project/src/core/store");
const assets = require("../nodejs-project/src/core/assets");
const jobs = require("../nodejs-project/src/core/jobs");
const android = require("../nodejs-project/src/platforms/android");
const { tv, shell, homeOwner } = require("./fake-shield.js");

function fakeApk(dir, name, pkg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), Buffer.concat([Buffer.from(pkg.padEnd(40, " ")), crypto.randomBytes(1 << 20)]));
}

(async () => {
  store.init(tmp);
  assets.init(tmp, path.join(tmp, "bundled"));
  android.init(tmp);
  fakeApk(path.join(tmp, "bundled"), "horizon.apk", "com.horizon.home");
  fakeApk(path.join(tmp, "bundled"), "tvhome.apk", "com.gathin.tvhome");
  global.fetch = async () => { throw new Error("offline"); };
  tv.settings.private_dns_mode = "off";
  const { server, state } = await mock.start({ port: 25557, maxdata: 4096, shell });
  const ip = "127.0.0.1:25557";

  const summary = await android.inspect({ ip, profile: "shield" });
  assert.strictEqual(summary.recommendations.homeStyle, "horizon", "Horizon recommended on a 2.9 GB Shield");

  const updates = [];
  jobs.setBroadcaster((channel, payload) => { if (channel === "job:update") updates.push(payload); });
  const choices = {
    nuvio: "skip", homeStyle: "horizon", homeMode: "redirect", debloat: [], speed: false, dnsBlock: true,
    horizon: { name: "Dave", tmdb: "tmdbKEY123", livetv: "https://my-livetv.example.workers.dev/abc/manifest.json", nextdnsId: "ab12cd", nextdnsKey: "" }
  };
  const job = jobs.createJob("Horizon", android.stepsFor(choices));
  const result = await android.run({ ip, profile: "shield", choices }, job);
  job.finish(result);
  const final = updates[updates.length - 1];
  console.log("steps:", final.steps.map((s) => `${s.id}=${s.status}${s.detail ? ` (${s.detail})` : ""}`).join("\n       "));
  for (const step of final.steps) assert.strictEqual(step.status, "done", `${step.id} done`);
  assert.strictEqual(homeOwner(), "com.horizon.home", "Home resolves to Horizon");
  assert.ok(tv.secure.enabled_accessibility_services.includes("com.horizon.home/com.horizon.home.HomeButtonService"), "Home button service on");
  assert.ok(!tv.disabled.has("com.google.android.tvlauncher"), "redirect mode keeps the stock home");
  const start = state.commands.find((c) => c.includes("am start -n com.horizon.home/.HomeActivity"));
  assert.ok(start.includes("--es tmdb 'tmdbKEY123'") && start.includes("--es name 'Dave'"), "settings passed as extras");
  assert.ok(start.includes("--es livetv 'https://my-livetv.example.workers.dev/abc'"), "Live TV link without /manifest.json");
  assert.ok(state.commands.some((c) => c.includes("pm grant com.horizon.home com.android.providers.tv.permission.READ_EPG_DATA")), "guide permission granted");
  assert.strictEqual(tv.settings.private_dns_specifier, "ab12cd.dns.nextdns.io");
  assert.strictEqual(tv.settings.private_dns_mode, "hostname");

  const undoJob = jobs.createJob("Undo", [{ id: "connect", label: "c" }, { id: "packages", label: "p" }, { id: "home", label: "h" }, { id: "settings", label: "s" }]);
  await android.undo({ ip, deviceKey: result.deviceKey }, undoJob);
  undoJob.finish({});
  assert.ok(!tv.installed.has("com.horizon.home"), "Horizon removed");
  assert.strictEqual(homeOwner(), "com.google.android.tvlauncher", "stock home back");
  assert.ok(!tv.secure.enabled_accessibility_services.includes("horizon"), "Home button service off");
  assert.strictEqual(tv.settings.private_dns_mode, "off", "private DNS restored");
  assert.strictEqual(state.violations, 0);
  server.close();
  console.log("android-horizon: all checks passed");
  process.exit(0);
})().catch((error) => { console.error("FAIL", error); process.exit(1); });
