// Android home screen looks and remote buttons for the CleanYourTV launcher (com.gathin.tvhome).
//
// A look is a CleanYourTV theme (config.json plus a wallpaper.jpg or a wallpapers/ collection) bundled by
// scripts/bundle_looks.py. TV Setup merges it with what it owns (dock, Home takeover, remote buttons, the app
// that opens at power-on) and pushes it the way tools/theme.sh does: through the launcher's theme provider,
// falling back to a copy into Android/data, then a theme_revision bump and a Home restart that puts the
// launcher's accessibility helpers back (a force-stop unbinds them).
//
// Remote buttons are learnt with `getevent` on the TV: the first key-down of a button the owner presses is
// its scancode, which the launcher's app_keys read as "scan:<code>:<target>" ("hold:" for a long press).
"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");

const PKG = "com.gathin.tvhome";
const ACTIVITY = `${PKG}/.MainActivity`;
const URI = `content://${PKG}.theme`;
const DIR = `/sdcard/Android/data/${PKG}/files`;
const TMP = "/data/local/tmp/tvsetup-look";
const THEMES_DIR = path.join(__dirname, "..", "..", "bundled", "themes");
const IMAGE = /^[A-Za-z0-9_.-]+\.(jpg|jpeg|png|webp)$/i;

// Keys TV Setup owns: a look never sets these, the device's own choices do.
const OWNED = ["dock_apps", "hidden_apps", "fill_dock", "stock_home_redirect", "power_on_home_always", "app_keys",
  "open_on_start_choice", "open_on_start_app", "open_on_start_on_wake", "open_on_start_network_wait", "reduced_motion"];

// Buttons that would break the remote if they did something else.
const PROTECTED = new Map([
  [103, "Up"], [108, "Down"], [105, "Left"], [106, "Right"], [28, "OK"], [96, "OK"], [352, "OK"], [353, "OK"],
  [158, "Back"], [1, "Back"], [102, "Home"], [172, "Home"], [116, "Power"], [115, "Volume up"], [114, "Volume down"],
  [113, "Mute"]
]);
const KNOWN = new Map([
  [139, "Menu"], [217, "Search"], [582, "Assistant"], [358, "Info"], [365, "Guide"], [402, "Channel up"],
  [403, "Channel down"], [377, "TV"], [394, "Input"], [398, "Red"], [399, "Green"], [400, "Yellow"], [401, "Blue"],
  [164, "Play/Pause"], [207, "Play"], [119, "Pause"], [128, "Stop"], [208, "Fast forward"], [168, "Rewind"],
  [163, "Next"], [165, "Previous"], [393, "Live TV"], [362, "Program guide"], [388, "Text"], [370, "Subtitles"],
  [372, "Zoom"], [226, "Media"], [130, "Properties"], [142, "Sleep"], [431, "Apps"]
]);

const ACTIONS = {
  inputs: "Inputs menu", mute: "Mute", sleep: "Standby", screensaver: "Screensaver", settings: "Settings",
  recents: "Recent apps", library: "App library", ignore: "Do nothing"
};

let themeIndex = null;
async function listLooks() {
  if (!themeIndex) {
    try { themeIndex = JSON.parse(await fsp.readFile(path.join(THEMES_DIR, "index.json"), "utf8")); } catch { themeIndex = []; }
  }
  return themeIndex;
}

function sq(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function buttonName(code) {
  return PROTECTED.get(code) || KNOWN.get(code) || `Button ${code}`;
}

// The launcher config for a device: the look's keys, then TV Setup's. `owned` comes from the device's
// saved choices (dock, takeover, buttons, power-on app); `device` adjusts for low memory.
function mergeConfig(lookConfig, owned, device = {}) {
  const config = { ...lookConfig };
  for (const key of OWNED) delete config[key];
  const lowMem = device.memMb && device.memMb < 1700;
  if (lowMem) {
    config.reduced_motion = true;
    config.advanced_effects = false;
    config.wallpaper_true_color = false;
  } else if (device.memMb && device.memMb < 2600) {
    config.wallpaper_true_color = false;
  }
  if (owned.dockApps?.length) { config.dock_apps = owned.dockApps; config.fill_dock = true; }
  if (owned.stockHome) { config.stock_home_redirect = owned.stockHome; config.power_on_home_always = !owned.openOnStart; }
  const keys = buttonEntries(owned.buttons || []);
  if (keys.length) config.app_keys = keys;
  if (owned.openOnStart) {
    config.open_on_start_choice = true;
    config.open_on_start_app = owned.openOnStart;
    config.open_on_start_network_wait = 45;
    config.open_on_start_on_wake = Boolean(owned.openOnWake);
  }
  return config;
}

// [{ code, press: "tap"|"hold", target }] -> app_keys entries. Protected buttons are dropped.
function buttonEntries(buttons) {
  const out = [];
  for (const b of buttons) {
    const code = Number(b.code);
    if (!Number.isInteger(code) || code <= 0 || PROTECTED.has(code)) continue;
    const target = String(b.target || "").trim();
    if (!/^([a-zA-Z][\w.]*(\/[\w.$]+)?|inputs)$/.test(target) || /^(back|home)$/.test(target)) continue;
    out.push(`${b.press === "hold" ? "hold:" : ""}scan:${code}:${target}`);
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- pushing files
async function putFile(adb, name, data) {
  const staged = `${TMP}-${name.replace(/\//g, "-")}`;
  await adb.push(Buffer.isBuffer(data) ? data : Buffer.from(data), staged);
  const out = await adb.shell(
    `rm -f ${DIR}/${name} 2>/dev/null; w=; { o=$(content write --uri ${URI}/${name} < ${staged} 2>&1) && case "$o" in *'Unsupported operation'*|*'Error while accessing provider'*) false ;; esac && w=1; } || ` +
    `{ mkdir -p $(dirname ${DIR}/${name}) 2>/dev/null; cp ${staged} ${DIR}/${name} 2>/dev/null && w=1; }; ` +
    `s=$(wc -c < ${staged} 2>/dev/null); rm -f ${staged}; ` +
    `[ -n "$w" ] && { { [ -e ${DIR}/${name} ] && [ "$(wc -c < ${DIR}/${name})" = "$s" ]; } || [ "$(content read --uri ${URI}/${name} 2>/dev/null | wc -c)" = "$s" ]; } && echo written || echo failed`
  );
  if (!out.includes("written")) throw new Error(`The TV wouldn't take ${name}.`);
}

function del(name) {
  return `rm -f ${DIR}/${name} 2>/dev/null; content delete --uri ${URI}/${name} >/dev/null 2>&1`;
}
const CLEAR_WALLPAPERS = `rm -f ${DIR}/wallpapers/*.[jJ][pP][gG] ${DIR}/wallpapers/*.[jJ][pP][eE][gG] ${DIR}/wallpapers/*.[pP][nN][gG] ${DIR}/wallpapers/*.[wW][eE][bB][pP] 2>/dev/null; content delete --uri ${URI}/wallpapers >/dev/null 2>&1`;

async function lookFiles(lookId) {
  const dir = path.join(THEMES_DIR, lookId);
  const config = JSON.parse(await fsp.readFile(path.join(dir, "config.json"), "utf8"));
  let wallpaper = null;
  try { wallpaper = await fsp.readFile(path.join(dir, "wallpaper.jpg")); } catch {}
  const pictures = [];
  let captions = null;
  for (const name of await fsp.readdir(path.join(dir, "wallpapers")).catch(() => [])) {
    if (name === "captions.txt") captions = await fsp.readFile(path.join(dir, "wallpapers", name));
    else if (IMAGE.test(name)) pictures.push(name);
  }
  pictures.sort();
  return { dir, config, wallpaper, pictures, captions };
}

// Restart Home so the launcher reads the new theme, and put its accessibility helpers back afterwards.
async function restartHome(adb) {
  const services = (await adb.shell("settings get secure enabled_accessibility_services")).trim();
  const ours = services && services !== "null" ? services.split(":").filter((s) => s.startsWith(`${PKG}/`)) : [];
  const home = (await adb.shell("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME 2>/dev/null | tail -n 1")).trim();
  const start = home.startsWith(`${PKG}/`) ? "-a android.intent.action.MAIN -c android.intent.category.HOME" : `-n ${ACTIVITY}`;
  await adb.shell(`am force-stop ${PKG}; am start ${start} >/dev/null 2>&1; true`);
  if (!ours.length) return;
  const rest = services.split(":").filter((s) => s && !s.startsWith(`${PKG}/`));
  await new Promise((r) => setTimeout(r, 1000));
  // Android drops force-stopped services; toggling the list off and on rebinds them (Xiaomi and TCL need both).
  await adb.shell(`settings put secure enabled_accessibility_services ${sq(rest.join(":") || "null")}`);
  await new Promise((r) => setTimeout(r, 2000));
  await adb.shell(`settings put secure enabled_accessibility_services ${sq([...rest, ...ours].join(":"))}; settings put secure accessibility_enabled 1`);
}

// Apply a look with TV Setup's own keys. onProgress(fraction, text).
async function applyLook(adb, { lookId, owned = {}, device = {}, onProgress = () => {}, configOnly = false }) {
  const looks = await listLooks();
  if (!looks.some((l) => l.id === lookId)) throw new Error(`Unknown look: ${lookId}`);
  const files = await lookFiles(lookId);
  const config = mergeConfig(files.config, owned, device);
  const total = 3 + files.pictures.length;
  let done = 0;
  const tick = (text) => onProgress(++done / total, text);
  await adb.shell(`mkdir -p ${DIR} 2>/dev/null; true`);
  await putFile(adb, "config.json", JSON.stringify(config, null, 1));
  tick("Settings sent");
  if (configOnly) {
    await putFile(adb, "theme_revision", `tvsetup-${lookId}-${Date.now()}`);
    if (config.app_keys?.length || owned.stockHome) await ensureKeyService(adb);
    await restartHome(adb);
    onProgress(1, "Home restarted");
    return config;
  }
  if (files.wallpaper) await putFile(adb, "wallpaper.jpg", files.wallpaper);
  else await adb.shell(`${del("wallpaper.jpg")}; true`);
  await adb.shell(`${CLEAR_WALLPAPERS}; true`);
  tick("Wallpaper ready");
  for (const name of files.pictures) {
    await putFile(adb, `wallpapers/${name}`, await fsp.readFile(path.join(files.dir, "wallpapers", name)));
    tick(`Pictures ${done - 1} of ${files.pictures.length}`);
  }
  if (files.captions) await putFile(adb, "wallpapers/captions.txt", files.captions);
  else await adb.shell(`${del("wallpapers/captions.txt")}; true`);
  await putFile(adb, "theme_revision", `tvsetup-${lookId}-${Date.now()}`);
  if (config.app_keys?.length || owned.stockHome) await ensureKeyService(adb);
  await restartHome(adb);
  tick("Home restarted");
  return config;
}

async function ensureKeyService(adb) {
  const component = `${PKG}/.HomeKeyService`;
  const before = (await adb.shell("settings get secure enabled_accessibility_services")).trim();
  const list = before && before !== "null" ? before.split(":").filter(Boolean) : [];
  if (!list.includes(component)) {
    list.push(component);
    await adb.shell(`cmd appops set ${PKG} AUTO_START allow 2>/dev/null; settings put secure enabled_accessibility_services ${sq(list.join(":"))}; settings put secure accessibility_enabled 1`);
  }
  return before;
}

// ---------------------------------------------------------------- learning a button
// Waits for one key press on the TV's remote. Resolves { code, name, protected } or throws on timeout.
function parseGetevent(text) {
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/:\s*0001\s+([0-9a-f]{4})\s+00000001\s*$/i);
    if (m) {
      const code = parseInt(m[1], 16);
      return { code, name: buttonName(code), protected: PROTECTED.has(code) };
    }
  }
  return null;
}

async function learnButton(adb, seconds = 12) {
  // grep stops at the first key-down, so a press answers at once instead of after the whole wait.
  const out = await adb.shell(`timeout ${seconds} getevent -q 2>/dev/null | grep -m 1 -E ' 0001 [0-9a-f]{4} 00000001'; true`, (seconds + 8) * 1000);
  const found = parseGetevent(out);
  if (!found) throw new Error("No button press reached the TV. Point the remote at the TV and try again.");
  return found;
}

module.exports = {
  listLooks, mergeConfig, buttonEntries, parseGetevent, learnButton, applyLook, restartHome, ensureKeyService,
  buttonName, ACTIONS, PROTECTED, PKG
};
