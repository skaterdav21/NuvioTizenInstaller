// Older Samsung (Orsay): widget build, User App Sync server, and the TV relay, against a local upstream.
"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const JSZip = require("../nodejs-project/node_modules/jszip");
const store = require("../nodejs-project/src/core/store");
const orsay = require("../nodejs-project/src/platforms/orsay");

const MEDIA = Buffer.alloc(300000, 7);
for (let i = 0; i < MEDIA.length; i++) MEDIA[i] = i % 251;

function upstream() {
  return new Promise((resolve) => {
    const s = http.createServer((req, res) => {
      if (req.url === "/manifest/catalog/movie/top.json") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ metas: [{ id: "tt1", name: "A" }] })); }
      if (req.url === "/picky/stream/movie/tt1.json") {
        if (!/okhttp/.test(req.headers["user-agent"])) { res.writeHead(403); return res.end("blocked"); }
        res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ streams: [{ url: "http://x/1" }, { infoHash: "abc" }] }));
      }
      if (req.url === "/go") { res.writeHead(302, { Location: "/media.mp4" }); return res.end(); }
      if (req.url === "/media.mp4") {
        const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || "");
        if (m) {
          const a = Number(m[1]); const b = m[2] ? Number(m[2]) : MEDIA.length - 1;
          res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": `bytes ${a}-${b}/${MEDIA.length}`, "Content-Length": b - a + 1, "Accept-Ranges": "bytes" });
          return res.end(MEDIA.subarray(a, b + 1));
        }
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": MEDIA.length });
        return res.end(MEDIA);
      }
      res.writeHead(404); res.end();
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "orsay-"));
  store.init(dir);
  const events = [];
  orsay.init({ store, broadcast: (ch, p) => events.push(p.kind) });
  const up = await upstream();
  const U = `http://127.0.0.1:${up.address().port}`;

  // A Plex-style zip wrapped in a folder gets flattened.
  const pz = new JSZip(); pz.file("Plex/config.xml", "<widget/>"); pz.file("Plex/index.html", "<html></html>");
  const plexPath = path.join(dir, "plex.zip"); fs.writeFileSync(plexPath, await pz.generateAsync({ type: "nodebuffer" }));
  const flat = await JSZip.loadAsync(await orsay.checkWidgetZip(plexPath));
  assert.ok(flat.files["config.xml"], "plex zip flattened");
  const bad = new JSZip(); bad.file("x.txt", "x"); fs.writeFileSync(path.join(dir, "bad.zip"), await bad.generateAsync({ type: "nodebuffer" }));
  await assert.rejects(orsay.checkWidgetZip(path.join(dir, "bad.zip")), /no config\.xml/);

  const cfg = await orsay.setConfig({ streamAddons: ["https://addon.example/abc/manifest.json", "not a url"], plexZip: plexPath });
  assert.deepStrictEqual(cfg.streamAddons, ["https://addon.example/abc/manifest.json"]);
  assert.ok(cfg.key.length >= 10, "relay key generated");
  assert.strictEqual(orsay.relayBase({ relayMode: "worker", relayUrl: "https://r.example.workers.dev" }, "1.2.3.4", 80), "http://r.example.workers.dev", "worker relay forced to http");

  const st = await orsay.start({ ip: "127.0.0.1", ports: [0] });
  const B = `http://127.0.0.1:${(await new Promise((r) => r(st.port)))}`;
  assert.ok(st.running && st.port > 0 && !st.port80 && st.syncIp === "");
  assert.deepStrictEqual(st.widgets.map((w) => w.id), ["NuvioLite", "Plex"]);

  const xml = await (await fetch(`${B}/widgetlist.xml`)).text();
  assert.match(xml, /<widget id="NuvioLite">/); assert.match(xml, /<widget id="Plex">/);
  assert.match(xml, new RegExp(`<download>${B}/Widget/NuvioLite.zip</download>`));
  const zipBuf = Buffer.from(await (await fetch(`${B}/Widget/NuvioLite.zip`)).arrayBuffer());
  assert.strictEqual(Number(xml.match(/Nuvio Lite<\/title>\s*<compression size="(\d+)"/)[1]), zipBuf.length, "size in list matches zip");
  const tv = await JSZip.loadAsync(zipBuf);
  for (const f of ["config.xml", "index.html", "app.js", "style.css", "config.js"]) assert.ok(tv.files[f], `widget has ${f}`);
  const tvCfg = JSON.parse((await tv.files["config.js"].async("string")).replace(/^var CFG = /, "").replace(/;\s*$/, ""));
  assert.strictEqual(tvCfg.relay, B); assert.strictEqual(tvCfg.phoneRelay, B, "phone relay always baked in"); assert.strictEqual(tvCfg.key, cfg.key); assert.strictEqual(tvCfg.streamMode, "proxy");
  await fetch(`${B}/Widget/Plex.zip`).then((r) => r.arrayBuffer());
  assert.ok(events.includes("widgetlist") && events.includes("download"));
  assert.strictEqual(Object.keys(orsay.status().stats.downloads).length, 2);

  const k = `&k=${encodeURIComponent(cfg.key)}`;
  assert.strictEqual((await fetch(`${B}/proxy?u=${encodeURIComponent(U + "/manifest/catalog/movie/top.json")}`)).status, 403, "key required");
  assert.strictEqual((await fetch(`${B}/proxy?u=${encodeURIComponent("file:///etc/passwd")}${k}`)).status, 400, "only http(s)");
  const j = await (await fetch(`${B}/proxy?u=${encodeURIComponent(U + "/manifest/catalog/movie/top.json")}${k}`)).json();
  assert.strictEqual(j.metas[0].id, "tt1");

  const picky = await fetch(`${B}/proxy?u=${encodeURIComponent(U + "/picky/stream/movie/tt1.json")}${k}`);
  assert.strictEqual(picky.status, 200, "retried with app client header");
  assert.deepStrictEqual({ ...orsay.status().stats.lastLookup, at: 0 }, { host: "127.0.0.1", status: 200, count: 1, at: 0 });
  const part = await fetch(`${B}/stream?u=${encodeURIComponent(U + "/go")}${k}&mode=proxy`, { headers: { Range: "bytes=100-1099" } });
  assert.strictEqual(part.status, 206);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(MEDIA.subarray(100, 1100)), "range through redirect");
  const redir = await fetch(`${B}/stream?u=${encodeURIComponent(U + "/go")}${k}&mode=http`, { redirect: "manual" });
  assert.strictEqual(redir.status, 302);
  assert.strictEqual(redir.headers.get("location"), `${U}/media.mp4`);

  // Worker mode: menus go to the Worker, stream lookups keep the phone as first choice.
  await orsay.setConfig({ relayMode: "worker", relayUrl: "https://r.example.workers.dev", streamMode: "http" });
  const st2 = await orsay.start({ ip: "127.0.0.1", ports: [0] });
  const B2 = `http://127.0.0.1:${st2.port}`;
  const tv2 = await JSZip.loadAsync(Buffer.from(await (await fetch(`${B2}/Widget/NuvioLite.zip`)).arrayBuffer()));
  const cfg2 = JSON.parse((await tv2.files["config.js"].async("string")).replace(/^var CFG = /, "").replace(/;\s*$/, ""));
  assert.strictEqual(cfg2.relay, "http://r.example.workers.dev"); assert.strictEqual(cfg2.phoneRelay, B2); assert.strictEqual(cfg2.streamMode, "http");
  await orsay.stop();
  assert.strictEqual(orsay.status().running, false);
  up.close();
  console.log("orsay: widget build, sync list, plex zip, relay key, proxy, range stream, redirect resolve passed");
})().catch((e) => { console.error(e); process.exit(1); });
