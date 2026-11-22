// Mock adbd for tests: real ADB packet framing, RSA auth (verifies the signature against the
// Android-format public key it was sent, and checks n0inv/rr are correct), flow control
// enforcement, sync SEND/STAT, and a scriptable fake shell.
"use strict";
const crypto = require("node:crypto");
const net = require("node:net");
const { constants: C, packet } = require("../nodejs-project/src/core/adb.js");

function decodeAndroidKey(text) {
  const raw = Buffer.from(text.split(" ")[0], "base64");
  const words = raw.readUInt32LE(0);
  const n0inv = BigInt(raw.readUInt32LE(4));
  let n = 0n;
  for (let i = words - 1; i >= 0; i -= 1) n = (n << 32n) + BigInt(raw.readUInt32LE(8 + i * 4));
  let rr = 0n;
  for (let i = words - 1; i >= 0; i -= 1) rr = (rr << 32n) + BigInt(raw.readUInt32LE(8 + words * 4 + i * 4));
  const e = raw.readUInt32LE(8 + words * 8);
  const word = 1n << 32n;
  const okN0 = ((n * n0inv) % word + 1n) % word === 0n; // n0inv = -1/n mod 2^32
  const okRR = rr === (1n << BigInt(words * 64)) % n;
  const toB64u = (big) => Buffer.from(big.toString(16).padStart(Math.ceil(big.toString(16).length / 2) * 2, "0"), "hex").toString("base64url");
  const key = crypto.createPublicKey({ key: { kty: "RSA", n: toB64u(n), e: toB64u(BigInt(e)) }, format: "jwk" });
  return { key, okN0, okRR, e };
}

function verify(key, token, signature) {
  try {
    const decrypted = crypto.publicDecrypt({ key, padding: crypto.constants.RSA_PKCS1_PADDING }, signature);
    return decrypted.equals(Buffer.concat([Buffer.from("3021300906052b0e03021a05000414", "hex"), token]));
  } catch { return false; }
}

function start({ port, banner = "device::ro.product.name=test;ro.product.model=Test TV;ro.product.device=test;", shell = () => "", maxdata = 4096, acceptDelayMs = 100, autoAccept = true } = {}) {
  const state = { authorized: [], keyChecks: [], violations: 0, files: {}, commands: [], prompts: 0 };
  const server = net.createServer((sock) => {
    sock.on("error", () => {});
    let inbox = Buffer.alloc(0);
    let token = crypto.randomBytes(20);
    let online = false;
    let nextRemote = 500;
    const streams = new Map();
    const send = (cmd, a0, a1, data) => { if (!sock.destroyed) sock.write(packet(cmd, a0, a1, data)); };
    const connected = () => { online = true; send(C.A_CNXN, 0x01000001, maxdata, Buffer.from(`${banner}\0`)); };
    const writeTo = (id, s, data) => {
      // Respect flow control toward the host too: wait for OKAY between packets.
      s.outQueue.push(data);
      if (!s.waiting) flush(id, s);
    };
    const flush = (id, s) => {
      const next = s.outQueue.shift();
      if (!next) { s.waiting = false; if (s.closeAfter) { send(C.A_CLSE, id, s.local); streams.delete(id); } return; }
      s.waiting = true;
      send(C.A_WRTE, id, s.local, next);
    };
    const closeStream = (id, s) => { if (s.waiting || s.outQueue.length) s.closeAfter = true; else { send(C.A_CLSE, id, s.local); streams.delete(id); } };
    const handleSync = (id, s) => {
      while (s.sync.length >= 8) {
        const tag = s.sync.toString("ascii", 0, 4);
        const n = s.sync.readUInt32LE(4);
        if (tag === "QUIT") { s.sync = s.sync.subarray(8); closeStream(id, s); return; }
        if (tag === "DONE") {
          s.sync = s.sync.subarray(8);
          state.files[s.file.path] = Buffer.concat(s.file.chunks);
          writeTo(id, s, Buffer.concat([Buffer.from("OKAY"), Buffer.alloc(4)]));
          continue;
        }
        if (s.sync.length < 8 + n) return;
        const body = s.sync.subarray(8, 8 + n);
        s.sync = s.sync.subarray(8 + n);
        if (tag === "SEND") s.file = { path: body.toString().split(",")[0], chunks: [] };
        else if (tag === "DATA") s.file.chunks.push(Buffer.from(body));
        else if (tag === "STAT") {
          const f = state.files[body.toString()];
          const r = Buffer.alloc(16); r.write("STAT");
          if (f) { r.writeUInt32LE(0o100644, 4); r.writeUInt32LE(f.length, 8); r.writeUInt32LE(1, 12); }
          writeTo(id, s, r);
        }
      }
    };
    sock.on("data", (d) => {
      inbox = Buffer.concat([inbox, d]);
      while (inbox.length >= 24) {
        const len = inbox.readUInt32LE(12);
        if (inbox.length < 24 + len) break;
        const cmd = inbox.readUInt32LE(0), a0 = inbox.readUInt32LE(4), a1 = inbox.readUInt32LE(8);
        const data = Buffer.from(inbox.subarray(24, 24 + len));
        inbox = inbox.subarray(24 + len);
        if (cmd === C.A_CNXN) { token = crypto.randomBytes(20); send(C.A_AUTH, C.AUTH_TOKEN, 0, token); }
        else if (cmd === C.A_AUTH && a0 === C.AUTH_SIGNATURE) {
          if (state.authorized.some((k) => verify(k, token, data))) connected();
          else { token = crypto.randomBytes(20); send(C.A_AUTH, C.AUTH_TOKEN, 0, token); }
        } else if (cmd === C.A_AUTH && a0 === C.AUTH_RSAPUBLICKEY) {
          const decoded = decodeAndroidKey(data.toString("utf8").replace(/\0$/, ""));
          state.keyChecks.push({ okN0: decoded.okN0, okRR: decoded.okRR, e: decoded.e });
          state.prompts += 1;
          if (autoAccept) setTimeout(() => { state.authorized.push(decoded.key); connected(); }, acceptDelayMs);
        } else if (!online) {
          // ignore
        } else if (cmd === C.A_OPEN) {
          const id = nextRemote++;
          const service = data.toString("utf8").replace(/\0$/, "");
          const s = { local: a0, service, sync: Buffer.alloc(0), inflight: false, outQueue: [], waiting: false };
          streams.set(id, s);
          send(C.A_OKAY, id, a0);
          if (service.startsWith("shell:")) {
            const command = service.slice(6);
            state.commands.push(command);
            Promise.resolve(shell(command, state)).then((out) => {
              const buf = Buffer.from(String(out ?? ""));
              for (let o = 0; o < buf.length; o += maxdata) writeTo(id, s, buf.subarray(o, o + maxdata));
              closeStream(id, s);
            });
          }
        } else if (cmd === C.A_WRTE) {
          const s = streams.get(a1);
          if (!s) continue;
          if (s.inflight) state.violations += 1;
          if (data.length > maxdata) state.violations += 1;
          s.inflight = true;
          s.sync = Buffer.concat([s.sync, data]);
          setImmediate(() => { s.inflight = false; send(C.A_OKAY, a1, s.local); handleSync(a1, s); });
        } else if (cmd === C.A_OKAY) {
          const s = streams.get(a1);
          if (s && s.waiting) flush(a1, s);
        } else if (cmd === C.A_CLSE) {
          streams.delete(a1);
        }
      }
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, state })));
}

module.exports = { start, decodeAndroidKey };
