"use strict";
// Stateful fake Fire TV Stick 4K Max (2nd gen, AFTKRT, Fire OS 8.1.8.5, Android 11) shell.
// Like the real one: Amazon's home can't be disabled or replaced, userspace is 32-bit, 2 GB RAM.
const debloat = require("../nodejs-project/src/platforms/debloat");
const fireList = debloat.lists().lists.find((item) => item.id === "amazon-fire-tv-stick-4k-max-2023");
const listPkgs = fireList.groups.flatMap((g) => g.packages.map((p) => p.p));
const AMAZON_HOME = "com.amazon.tv.launcher";
const base = ["android", "com.android.systemui", "com.amazon.tv.settings.v2", AMAZON_HOME, "com.amazon.vizzini",
  "com.amazon.device.controllermanager", "com.amazon.tv.ime", "com.amazon.firetv.youtube", "com.netflix.ninja",
  "com.amazon.amazonvideo.livingroom", "com.amazon.venezia", "com.android.providers.tv"];
// Packages Fire OS refuses to disable (pm answers with an error), whatever is asked.
const REFUSED = new Set([AMAZON_HOME, "com.amazon.vizzini", "com.amazon.tv.settings.v2", "com.amazon.device.controllermanager"]);

const tv = {
  installed: new Set([...base, ...listPkgs]),
  disabled: new Set(),
  attemptedProtected: [],
  settings: { window_animation_scale: "1.0", transition_animation_scale: "1.0", animator_duration_scale: "1.0" },
  secure: { enabled_accessibility_services: "null" },
  setHomeCalls: 0
};
const LAUNCHER = "com.gathin.tvhome";

function homeOwner() { return AMAZON_HOME; } // Fire OS keeps Amazon's home as the system Home.

function shell(command, state) {
  for (const [, pkg] of command.matchAll(/pm disable-user --user 0 ([\w.]+)/g)) {
    if (REFUSED.has(pkg) || debloat.FIRE_PROTECTED.test(pkg)) { tv.attemptedProtected.push(pkg); continue; }
    if (debloat.isCore(pkg)) continue;
    tv.disabled.add(pkg);
  }
  for (const [, pkg] of command.matchAll(/pm enable --user 0 ([\w.]+)/g)) tv.disabled.delete(pkg);
  for (const [, pkg] of command.matchAll(/pm uninstall ([\w.]+)/g)) tv.installed.delete(pkg);
  for (const [, key, value] of command.matchAll(/settings put global (\w+) ([^;\s]+)/g)) tv.settings[key] = value;
  for (const [, key] of command.matchAll(/settings delete global (\w+)/g)) delete tv.settings[key];
  if (/settings delete secure enabled_accessibility_services/.test(command)) tv.secure.enabled_accessibility_services = "null";
  for (const [, value] of command.matchAll(/settings put secure enabled_accessibility_services '([^']*)'/g)) tv.secure.enabled_accessibility_services = value;
  if (/set-home-activity/.test(command)) tv.setHomeCalls += 1;
  if (command.includes("@@ro.product")) {
    const props = { "ro.product.manufacturer": "Amazon", "ro.product.brand": "Amazon", "ro.product.model": "AFTKRT", "ro.product.device": "kara",
      "ro.product.name": "karat", "ro.build.version.sdk": "30", "ro.build.version.release": "11", "ro.product.cpu.abilist": "armeabi-v7a,armeabi",
      "ro.serialno": "G4N1AB0123456789", "ro.adb.secure": "1", "ro.build.version.name": "Fire OS 8.1.8.5 (RS8185/5142)", "ro.build.version.fireos": "8.1.8.5" };
    return command.split(";").map((part) => { const m = part.match(/@@([\w.]+)=/); return m ? `@@${m[1]}=${props[m[1]] || ""}` : ""; }).filter(Boolean).join("\n") + "\n";
  }
  if (command.startsWith("pm list packages -d")) return [...tv.disabled].map((p) => `package:${p}`).join("\n") + "\n";
  if (command.startsWith("pm list packages -e")) return [...tv.installed].filter((p) => !tv.disabled.has(p)).map((p) => `package:${p}`).join("\n") + "\n";
  if (command.startsWith("pm list packages")) return [...tv.installed].map((p) => `package:${p}`).join("\n") + "\n";
  if (command.startsWith("grep MemTotal")) return "MemTotal:        1953124 kB\n";
  if (command.startsWith("df ")) return "/dev/block/dm-4  11000000 5000000 6000000 45% /data\n";
  if (/resolve-activity --brief .*HOME ([a-z]\w*\.[\w.]+)/.test(command)) { const pkg = command.match(/HOME ([a-z]\w*\.[\w.]+)/)[1]; return `priority=0\n${pkg}/.ui.HomeActivity_vNext\n`; }
  if (command.includes("resolve-activity") && command.includes("category.HOME")) return `${AMAZON_HOME}/.ui.HomeActivity_vNext\n`;
  if (command.includes("query-activities") && command.includes("category.HOME")) {
    return [AMAZON_HOME, LAUNCHER].filter((p) => tv.installed.has(p)).map((p) => `  ${p}/.Main`).join("\n") + "\n";
  }
  if (command.includes("vnd.android.cursor.item/channel")) return "";
  if (command.includes("android.settings.SETTINGS")) return "  com.amazon.tv.settings.v2/.tv.SettingsActivity\n";
  if (command.includes("dumpsys package $p")) return "";
  if (command.includes("dumpsys wifi")) return "cname=android.uid.system:1000\n";
  if (/pm install -r -g (\S+)/.test(command)) {
    const remote = command.match(/pm install -r -g (\S+)/)[1];
    const data = state.files[remote];
    const pkg = data ? data.toString("utf8", 0, 40).trim() : "";
    if (pkg.endsWith("-arm64")) return "Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]\n";
    if (pkg) tv.installed.add(pkg);
    return "Performing Streamed Install\nSuccess\n";
  }
  if (command.includes("content write")) return "written\n";
  if (command.startsWith("am start -W")) return "Starting: Intent\nStatus: ok\n";
  if (/settings get global (\w+)/.test(command)) return `${tv.settings[command.match(/settings get global (\w+)/)[1]] || "null"}\n`;
  if (command.startsWith("settings get secure enabled_accessibility_services")) return `${tv.secure.enabled_accessibility_services}\n`;
  if (/pm path ([\w.]+)/.test(command)) { const pkg = command.match(/pm path ([\w.]+)/)[1]; return tv.installed.has(pkg) ? `package:/data/app/${pkg}/base.apk\n` : ""; }
  return "";
}

module.exports = { tv, shell, homeOwner, LAUNCHER, AMAZON_HOME, fireList };
