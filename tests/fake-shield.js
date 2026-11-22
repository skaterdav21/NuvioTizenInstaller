"use strict";
// Stateful fake NVIDIA Shield (2019 tube, Android TV 11) shell, shared by tests and UI screenshots.
const debloat = require("../nodejs-project/src/platforms/debloat");
const shieldList = debloat.lists().lists.find((item) => item.id === "nvidia-shield-tv-2019");
const listPkgs = shieldList.groups.flatMap((g) => g.packages.map((p) => p.p));
const base = ["android", "com.android.systemui", "com.android.vending", "com.google.android.gms", "com.android.tv.settings",
  "com.google.android.tvlauncher", "com.google.android.youtube.tv", "com.netflix.ninja", "com.google.android.katniss",
  "com.nvidia.tvsettings.input", "com.google.android.tv", "com.android.providers.tv"];

const tv = {
  installed: new Set([...base, ...listPkgs]),
  disabled: new Set(),
  settings: { window_animation_scale: "1.0", transition_animation_scale: "1.0", animator_duration_scale: "1.0" },
  secure: { enabled_accessibility_services: "null" },
  home: "com.google.android.tvlauncher"
};
const LAUNCHER = "com.gathin.tvhome";

function homeOwner() {
  if (tv.home && tv.installed.has(tv.home) && !tv.disabled.has(tv.home)) return tv.home;
  if (tv.installed.has(LAUNCHER) && !tv.disabled.has(LAUNCHER)) return LAUNCHER;
  if (!tv.disabled.has("com.google.android.tvlauncher")) return "com.google.android.tvlauncher";
  return "";
}

function shell(command, state) {
  let out = "";
  for (const [, pkg] of command.matchAll(/pm disable-user --user 0 ([\w.]+)/g)) {
    if (debloat.isCore(pkg)) continue;
    tv.disabled.add(pkg);
    if (tv.home === pkg) tv.home = "";
  }
  for (const [, pkg] of command.matchAll(/pm enable --user 0 ([\w.]+)/g)) tv.disabled.delete(pkg);
  for (const [, pkg] of command.matchAll(/pm uninstall ([\w.]+)/g)) tv.installed.delete(pkg);
  for (const [, key, value] of command.matchAll(/settings put global (\w+) ([\d.]+)/g)) tv.settings[key] = value;
  for (const [, value] of command.matchAll(/settings put secure enabled_accessibility_services '([^']*)'/g)) tv.secure.enabled_accessibility_services = value;
  for (const [, comp] of command.matchAll(/set-home-activity --user 0 ([\w.]+)\//g)) tv.home = comp;
  if (command.includes("@@ro.product")) {
    const props = { "ro.product.manufacturer": "NVIDIA", "ro.product.brand": "NVIDIA", "ro.product.model": "SHIELD Android TV", "ro.product.device": "sif",
      "ro.product.name": "sif", "ro.build.version.sdk": "30", "ro.build.version.release": "11", "ro.product.cpu.abilist": "arm64-v8a,armeabi-v7a,armeabi",
      "ro.serialno": "1323819033322", "ro.adb.secure": "1" };
    return command.split(";").map((part) => { const m = part.match(/@@([\w.]+)=/); return m ? `@@${m[1]}=${props[m[1]] || ""}` : ""; }).filter(Boolean).join("\n") + "\n";
  }
  if (command.startsWith("pm list packages -d")) return [...tv.disabled].map((p) => `package:${p}`).join("\n") + "\n";
  if (command.startsWith("pm list packages -e")) return [...tv.installed].filter((p) => !tv.disabled.has(p)).map((p) => `package:${p}`).join("\n") + "\n";
  if (command.startsWith("pm list packages")) return [...tv.installed].map((p) => `package:${p}`).join("\n") + "\n";
  if (command.startsWith("grep MemTotal")) return "MemTotal:        2945120 kB\n";
  if (command.startsWith("df ")) return "/dev/block/dm-2  10000000 4000000 6000000 40% /data\n";
  if (/resolve-activity --brief .*HOME ([a-z]\w*\.[\w.]+)/.test(command)) { const pkg = command.match(/HOME ([a-z]\w*\.[\w.]+)/)[1]; return `priority=0\n${pkg}/.Main\n`; }
  if (command.includes("resolve-activity") && command.includes("category.HOME")) { const owner = homeOwner(); return owner ? `${owner}/.Main\n` : "android\n"; }
  if (command.includes("query-activities") && command.includes("category.HOME")) {
    return [LAUNCHER, "com.google.android.tvlauncher"].filter((p) => tv.installed.has(p) && !tv.disabled.has(p)).map((p) => `  ${p}/.Main`).join("\n") + "\n";
  }
  if (command.includes("vnd.android.cursor.item/channel")) return "  com.google.android.tv/.Main\n";
  if (command.includes("android.settings.SETTINGS")) return "  com.android.tv.settings/.MainSettings\n";
  if (command.includes("dumpsys package $p")) {
    // The input service package declares TV_INPUT_HARDWARE.
    return command.includes("com.nvidia.tvsettings.input") ? "HW com.nvidia.tvsettings.input\n" : "";
  }
  if (command.includes("dumpsys wifi")) return "cname=android.uid.system:1000\n";
  if (/pm install -r -g (\S+)/.test(command)) {
    const remote = command.match(/pm install -r -g (\S+)/)[1];
    const data = state.files[remote];
    const pkg = data ? data.toString("utf8", 0, 40).trim() : "";
    if (pkg) tv.installed.add(pkg);
    return "Performing Streamed Install\nSuccess\n";
  }
  if (command.includes("content write")) return "written\n";
  if (command.startsWith("am start -W")) return "Starting: Intent\nStatus: ok\n";
  if (/settings get global (\w+)/.test(command)) return `${tv.settings[command.match(/settings get global (\w+)/)[1]] || "null"}\n`;
  if (command.startsWith("settings get secure enabled_accessibility_services")) return `${tv.secure.enabled_accessibility_services}\n`;
  if (/pm path ([\w.]+)/.test(command)) { const pkg = command.match(/pm path ([\w.]+)/)[1]; return tv.installed.has(pkg) ? `package:/data/app/${pkg}/base.apk\n` : ""; }
  return out;
}


module.exports = { tv, shell, homeOwner, LAUNCHER };
