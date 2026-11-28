// Android home screen looks, remote buttons and power-on app against the fake Shield.
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const mock = require("./mock-adbd.js");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "looktest-"));
process.env.NUVIO_DATA_DIR = tmp;
const store = require("../nodejs-project/src/core/store");
const jobs = require("../nodejs-project/src/core/jobs");
const android = require("../nodejs-project/src/platforms/android");
const looks = require("../nodejs-project/src/platforms/looks");
const { tv, shell: fakeShell, LAUNCHER } = require("./fake-shield.js");

(async () => {
  store.init(tmp);
  android.init(tmp);

  // ---- pure parts
  const list = await looks.listLooks();
  assert.ok(list.length >= 10 && list[0].id === "nuvio-cinema", "looks bundled, Nuvio Cinema first");
  assert.ok(fs.existsSync(path.join(__dirname, "..", "nodejs-project", "ui", "looks", "nuvio-cinema.jpg")), "preview bundled");
  const merged = looks.mergeConfig({ dock_apps: ["x"], app_keys: ["1:x"], cinematic_home: true, advanced_effects: true },
    { dockApps: ["com.nuvio.tv"], stockHome: "com.google.android.tvlauncher", openOnStart: "com.nuvio.tv", openOnWake: true,
      buttons: [{ code: 401, press: "tap", target: "com.nuvio.tv" }, { code: 102, press: "hold", target: "com.nuvio.tv" }, { code: 217, press: "hold", target: "mute" }, { code: 398, target: "home" }] },
    { memMb: 1500 });
  assert.deepStrictEqual(merged.dock_apps, ["com.nuvio.tv"], "the look can't change the dock");
  assert.deepStrictEqual(merged.app_keys, ["scan:401:com.nuvio.tv", "hold:scan:217:mute"], "Home and 'home' targets refused");
  assert.strictEqual(merged.open_on_start_app, "com.nuvio.tv"); assert.strictEqual(merged.open_on_start_choice, true);
  assert.strictEqual(merged.open_on_start_on_wake, true);
  assert.strictEqual(merged.power_on_home_always, false, "power-on app wins over Home-at-power-on");
  assert.strictEqual(merged.reduced_motion, true); assert.strictEqual(merged.advanced_effects, false, "low memory trims effects");
  assert.deepStrictEqual(looks.parseGetevent("/dev/input/event3: 0004 0004 000c0089\n/dev/input/event3: 0001 0191 00000001\n"), { code: 401, name: "Blue", protected: false });
  assert.strictEqual(looks.parseGetevent("/dev/input/event3: 0001 0067 00000001").protected, true, "Up is protected");
  assert.strictEqual(looks.parseGetevent("/dev/input/event3: 0001 0191 00000000"), null, "key-up ignored");

  // ---- against the fake TV
  tv.installed.add(LAUNCHER);
  const files = {};
  const shell = (command, state) => {
    if (command.includes("getevent")) return "/dev/input/event2: 0001 00d9 00000001\n";
    if (command.includes("query-activities")) return "com.nuvio.tv/.MainActivity\ncom.netflix.ninja/.Main\ncom.gathin.tvhome/.MainActivity\n";
    const m = command.match(/content write --uri content:\/\/com\.gathin\.tvhome\.theme\/(\S+) < (\S+)/);
    if (m) files[m[1]] = state.files[m[2]];
    return fakeShell(command, state);
  };
  const port = 25571;
  const { state } = await mock.start({ port, maxdata: 4096, shell, banner: "device::ro.product.name=sif;ro.product.model=SHIELD Android TV;ro.product.device=sif;" });
  const ip = `127.0.0.1:${port}`;
  await android.inspect({ ip, profile: "shield" }, { onAuthPrompt: () => {} });

  const learnt = await android.learnButton({ ip, seconds: 3 });
  assert.deepStrictEqual(learnt, { code: 217, name: "Search", protected: false });
  const apps = await android.listApps({ ip });
  assert.strictEqual(apps[0].pkg, "com.nuvio.tv"); assert.ok(!apps.some((a) => a.pkg === LAUNCHER), "launcher left out");

  const deviceKey = "android-test";
  await store.saveDevice({ id: deviceKey, platform: "android", ip, choices: { nuvio: "nuvio-official" } });
  const job = jobs.createJob("Look", [{ id: "connect", label: "c" }, { id: "home", label: "h" }]);
  await android.customizeHome({ ip, deviceKey, look: "aerial", buttons: [{ code: 217, press: "tap", target: "com.nuvio.tv" }], openOnStart: "com.nuvio.tv" }, job);
  job.finish({});
  const cfg = JSON.parse(files["config.json"].toString());
  assert.strictEqual(cfg.dock_apps[0], "com.nuvio.tv", "default dock filled in");
  assert.deepStrictEqual(cfg.app_keys, ["scan:217:com.nuvio.tv"]);
  assert.strictEqual(cfg.open_on_start_app, "com.nuvio.tv");
  assert.strictEqual(cfg.wallpaper_captions, true, "aerial's keys kept");
  const pics = Object.keys(files).filter((f) => f.startsWith("wallpapers/") && f.endsWith(".jpg"));
  assert.strictEqual(pics.length, list.find((l) => l.id === "aerial").pictures, "every picture pushed");
  assert.ok(files["wallpapers/captions.txt"], "captions pushed");
  assert.ok(tv.secure.enabled_accessibility_services.includes(`${LAUNCHER}/.HomeKeyService`), "key service on for the button");
  const saved = (await store.getDevice(deviceKey)).home;
  assert.strictEqual(saved.look, "aerial"); assert.strictEqual(saved.buttons.length, 1);

  // Changing only the buttons resends the config, not the pictures.
  const before = state.commands.filter((c) => c.includes("theme/wallpapers/")).length;
  const job2 = jobs.createJob("Buttons", [{ id: "connect", label: "c" }, { id: "home", label: "h" }]);
  await android.customizeHome({ ip, deviceKey, buttons: [] }, job2);
  job2.finish({});
  assert.strictEqual(state.commands.filter((c) => c.includes("theme/wallpapers/")).length, before, "no pictures resent");
  assert.ok(!JSON.parse(files["config.json"].toString()).app_keys, "buttons cleared");
  assert.strictEqual((await store.getDevice(deviceKey)).home.look, "aerial", "look kept");
  console.log(`looks: ${list.length} looks, ${pics.length} pictures pushed, button learnt (${learnt.name}), power-on app, config-only update passed`);
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
