// Samsung upload path (main.js pushFileAdb/statFileAdb over adbhost) against three mock Tizen sdbd behaviours:
//   strict: advertises 256 KB but stalls for good on any WRTE over 4 KB (what the real TV appears to do)
//   noack:  processes sync data but never sends OKAY for it
//   normal: acknowledges every WRTE
"use strict";
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const root = path.join(__dirname, "..", "nodejs-project");
process.env.NUVIO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sampush-"));
const src = fs.readFileSync(path.join(root, "src/main.js"), "utf8") + "\nmodule.exports.__t = { pushFileAdb, statFileAdb };";
const tmpMain = path.join(root, "src", "__test_main_push.js");
fs.writeFileSync(tmpMain, src);
require(path.join(root, "src/net-patch"));
require(path.join(root, "src/electron-shim"));
const T = require(tmpMain).__t;
fs.unlinkSync(tmpMain);
const adbhost = require(path.join(root, "node_modules/adbhost"));

const cmd = (s) => Buffer.from(s).readUInt32LE(0);
const C = { CNXN: cmd("CNXN"), OPEN: cmd("OPEN"), OKAY: cmd("OKAY"), WRTE: cmd("WRTE"), CLSE: cmd("CLSE") };
function pkt(c, a1, a2, data = Buffer.alloc(0)) {
  const h = Buffer.alloc(24); h.writeUInt32LE(c, 0); h.writeUInt32LE(a1, 4); h.writeUInt32LE(a2, 8); h.writeUInt32LE(data.length, 12);
  let sum = 0; for (const b of data) sum = (sum + b) >>> 0; h.writeUInt32LE(sum, 16); h.writeUInt32LE((c ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([h, data]);
}
function sdbd(port, mode) {
  const files = {}; const stats = { maxWrte: 0, stalled: false };
  const server = net.createServer((sock) => {
    sock.on("error", () => {});
    let buf = Buffer.alloc(0); let nextId = 700; const streams = {};
    sock.on("data", (d) => {
      if (stats.stalled) return;
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 24) {
        const len = buf.readUInt32LE(12); if (buf.length < 24 + len) break;
        const c = buf.readUInt32LE(0), a1 = buf.readUInt32LE(4), a2 = buf.readUInt32LE(8), data = buf.subarray(24, 24 + len);
        buf = buf.subarray(24 + len);
        if (c === C.CNXN) sock.write(pkt(C.CNXN, 0x01000000, 262144, Buffer.from("device::\0")));
        else if (c === C.OPEN) { const id = nextId++; streams[id] = { local: a1, sync: Buffer.alloc(0) }; sock.write(pkt(C.OKAY, id, a1)); }
        else if (c === C.WRTE) {
          stats.maxWrte = Math.max(stats.maxWrte, len);
          if (mode === "strict" && len > 4096) { stats.stalled = true; return; }
          const st = streams[a2]; st.sync = Buffer.concat([st.sync, data]);
          if (mode !== "noack") sock.write(pkt(C.OKAY, a2, st.local));
          while (st.sync.length >= 8) {
            const tag = st.sync.toString("ascii", 0, 4), n = st.sync.readUInt32LE(4);
            if (tag === "QUIT") { st.sync = st.sync.subarray(8); sock.write(pkt(C.CLSE, a2, st.local)); break; }
            if (tag === "DONE") { st.sync = st.sync.subarray(8); files[st.file.path] = Buffer.concat(st.file.chunks); sock.write(pkt(C.WRTE, a2, st.local, Buffer.concat([Buffer.from("OKAY"), Buffer.alloc(4)]))); continue; }
            if (st.sync.length < 8 + n) break;
            const body = st.sync.subarray(8, 8 + n); st.sync = st.sync.subarray(8 + n);
            if (tag === "SEND") st.file = { path: body.toString().split(",")[0], chunks: [] };
            else if (tag === "DATA") st.file.chunks.push(Buffer.from(body));
            else if (tag === "STAT") { const f = files[body.toString()]; const r = Buffer.alloc(16); r.write("STAT"); if (f) { r.writeUInt32LE(0o100644, 4); r.writeUInt32LE(f.length, 8); r.writeUInt32LE(1, 12); } sock.write(pkt(C.WRTE, a2, st.local, r)); }
          }
        }
      }
    });
  });
  return new Promise((r) => server.listen(port, "127.0.0.1", () => r({ server, files, stats })));
}

(async () => {
  const data = crypto.randomBytes(6 * 1024 * 1024 + 321);
  for (const [port, mode] of [[26201, "strict"], [26202, "noack"], [26203, "normal"]]) {
    const { server, files, stats } = await sdbd(port, mode);
    const client = adbhost.createConnection({ host: "127.0.0.1", port });
    client._stream.on("error", () => {});
    await new Promise((r) => client.once("connect", r));
    const t = Date.now(); let last = 0;
    await T.pushFileAdb(client, "/home/owner/share/tmp/sdk_tools/nuvio-package.tpk", data, (pct) => { last = pct; });
    const remote = await T.statFileAdb(client, "/home/owner/share/tmp/sdk_tools/nuvio-package.tpk").catch((e) => ({ error: e.message }));
    const ok = files["/home/owner/share/tmp/sdk_tools/nuvio-package.tpk"]?.equals(data);
    console.log(`${mode}: ${Date.now() - t}ms, largest packet ${stats.maxWrte} B, stalled=${stats.stalled}, identical=${ok}, progress=${last}%, stat=${JSON.stringify(remote)}`);
    assert.ok(ok, `${mode}: byte-identical`);
    assert.ok(stats.maxWrte <= 4096, `${mode}: packets within 4 KB`);
    assert.strictEqual(last, 100);
    if (mode !== "noack") assert.strictEqual(remote.size, data.length);
    client._stream.destroy(); server.close();
  }
  console.log("samsung-push: all checks passed");
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
