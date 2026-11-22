// Samsung Tizen setup. The proven install code lives in main.js (certificate creation, signing,
// flow-controlled upload, vd_appinstall); this wraps it in the step UI by reading its log lines.
"use strict";

const store = require("../core/store");
const scan = require("../core/scan");

let handlers = null;
function init(handlerMap) {
  handlers = handlerMap;
}

const VARIANTS = {
  auto: "Detect automatically",
  "40": "2018-2020 TV (Tizen 4 / 5 / 5.5)",
  "60": "2021 TV (Tizen 6)",
  "65": "2022-2023 TV (Tizen 6.5 / 7)",
  "80": "2024+ TV (Tizen 8 / 9)"
};

function variantFromYear(year) {
  if (!year) return "";
  if (year <= 2020) return "40";
  if (year === 2021) return "60";
  if (year <= 2023) return "65";
  return "80";
}

// Samsung model codes carry a year letter: QN55Q60BAFXZA -> B (2022), UN50TU7000 -> T (2020),
// QN65QN90B -> B, QN55LS03B -> B. The TV's REST API also reports e.g. "22_PONTUSM_UHD".
function variantFromModel(model, apiModel = "") {
  const apiYear = Number((String(apiModel).match(/^(\d\d)_/) || [])[1] || 0);
  if (apiYear >= 15 && apiYear <= 40) return variantFromYear(2000 + apiYear);
  const rest = String(model || "").toUpperCase().replace(/^[A-Z]{2}\d{2}/, "");
  const letter = (rest.match(/^([NRTABCDEF])U\d/) || rest.match(/^[A-Z]{1,2}\d{2,3}([A-Z])/) || [])[1];
  const years = { N: 2018, R: 2019, T: 2020, A: 2021, B: 2022, C: 2023, D: 2024, E: 2025, F: 2026 };
  return variantFromYear(years[letter]);
}

async function inspect({ ip }) {
  const ports = await scan.check(ip, "samsung");
  const info = await scan.identify(ip, ["samsung", ports[26101] ? "tizen-dev" : ""].filter(Boolean));
  const deviceKey = `samsung-${ip}`;
  const saved = await store.getDevice(deviceKey);
  const certStatus = await handlers.get("certs:status")?.(null).catch(() => ({ tvCount: 0 }));
  const guessed = variantFromModel(info.model, info.apiModel) || saved?.choices?.legacyVariant || "auto";
  await store.saveDevice({ id: deviceKey, platform: "samsung", profile: "samsung", ip, name: info.name || "Samsung TV", model: info.model, os: info.os || "Tizen" });
  return {
    platform: "samsung", profile: "samsung", ip, deviceKey,
    name: info.name || "Samsung TV", model: info.model, os: info.os || "Tizen",
    devMode: Boolean(ports[26101]),
    reachable: Boolean(ports[8001] || ports[26101]),
    certificateSaved: (certStatus?.tvCount || 0) > 0,
    variants: VARIANTS,
    recommendations: { nuvio: "legacy", legacyVariant: guessed }
  };
}

function stepsFor() {
  return [
    { id: "connect", label: "Connect to the TV" },
    { id: "cert", label: "Samsung certificate for this TV" },
    { id: "upload", label: "Upload Nuvio Legacy" },
    { id: "install", label: "Install on the TV" },
    { id: "finish", label: "Open Nuvio" }
  ];
}

async function run({ ip, choices }, job) {
  const steps = Object.fromEntries(stepsFor().map((def) => [def.id, job.step(def.id)]));
  let current = "connect";
  const begin = (id, detail = "") => {
    const order = stepsFor().map((def) => def.id);
    for (const earlier of order.slice(0, order.indexOf(id))) {
      if (steps[earlier].status === "running" || steps[earlier].status === "waiting" || steps[earlier].status === "pending") steps[earlier].done();
    }
    if (steps[id].status === "pending") steps[id].start(detail);
    current = id;
  };
  begin("connect", `Connecting to ${ip}…`);

  const event = {
    sender: {
      send: (_channel, payload) => {
        const text = String(payload?.text || "");
        job.log(text, payload?.type || "info");
        if (/Direct Samsung connection is active/.test(text)) steps.connect.done("Connected");
        else if (/Samsung sign-in needed|Opening Samsung login/.test(text)) { begin("cert"); steps.cert.waiting("Sign in to Samsung in Chrome, then come back here."); }
        else if (/Creating the Samsung certificate/.test(text)) { begin("cert"); steps.cert.resume("Creating the certificate (30-60s)…"); }
        else if (/certificate created|already saved for this TV|pre-signed package|Signed in \d+s/.test(text)) { begin("cert"); steps.cert.done(/created/.test(text) ? "Created and saved" : "Using the saved one"); }
        else if (/Using the .* build of Nuvio Legacy|TV reports Tizen/.test(text)) { if (current === "connect") steps.connect.detail(text); }
        else if (/Downloading .*: (\d+)%/.test(text)) { steps[current].detail(text); }
        else if (/Uploading to TV: (\d+)%/.test(text)) { begin("upload"); const pct = Number(text.match(/(\d+)%/)[1]); steps.upload.progress(pct / 100, text.replace("Uploading to TV: ", "")); }
        else if (/Verified on TV|Upload finished/.test(text)) { begin("upload"); if (/Verified/.test(text)) steps.upload.done(text.replace("Verified on TV: ", "")); }
        else if (/vd_appinstall|pkgcmd/.test(text) && payload?.type === "command") { begin("install", "Installing (native apps can take a few minutes)…"); }
        else if (/Installing on the TV/.test(text)) { begin("install", text); }
        else if (/was_execute|Launching/.test(text)) { begin("finish"); }
      }
    }
  };

  const result = await handlers.get("installer:run")(event, {
    platform: "samsung",
    action: "install",
    options: { app: "legacy", ip, mode: "simple", legacyVariant: choices.legacyVariant || "auto", samsungCert: { auto: true } }
  });
  if (!result?.ok) {
    const failing = Object.values(steps).find((step) => step.status === "running" || step.status === "waiting") || steps[current];
    failing.fail(result?.error || "Install failed");
    throw new Error(result?.error || "Install failed");
  }
  for (const id of ["connect", "cert", "upload", "install"]) if (steps[id].status !== "done") steps[id].done();
  // Launch: the install flow already opens the app when it can; make sure it's marked.
  if (steps.finish.status !== "done") {
    begin("finish", "Opening Nuvio…");
    const launched = await handlers.get("installer:run")({ sender: { send: (_c, p) => job.log(String(p?.text || "")) } }, {
      platform: "samsung", action: "launch", options: { app: "legacy", ip, mode: "simple", samsungCert: { auto: true } }
    }).catch(() => null);
    steps.finish.done(launched?.ok ? "Nuvio is opening on the TV" : "Installed. Open Nuvio from the TV's apps.");
  }
  await store.saveDevice({ id: `samsung-${ip}`, platform: "samsung", profile: "samsung", ip, lastSetup: Date.now(), choices: { legacyVariant: choices.legacyVariant } });
  return { deviceKey: `samsung-${ip}` };
}

module.exports = { init, inspect, run, stepsFor, variantFromModel, VARIANTS };
