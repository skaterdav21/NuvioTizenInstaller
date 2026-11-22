// Minimal ADB host client for Android TV / Google TV / Fire TV over TCP (port 5555).
//
// Why not adbhost: it has no AUTH support (every modern Android TV asks for RSA auth),
// no flow control (one WRTE in flight, wait for OKAY), and no way to read a shell's
// output to completion. This implements just what the setup flow needs:
//   connect + RSA auth (signature, then public key so the TV shows "Allow USB debugging?")
//   shell(command) -> output text
//   push(buffer, remotePath) with flow control and progress
//   stat(remotePath)
//   install(apkPath) via push + pm install
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const A_SYNC = 0x434e5953;
const A_CNXN = 0x4e584e43;
const A_OPEN = 0x4e45504f;
const A_OKAY = 0x59414b4f;
const A_CLSE = 0x45534c43;
const A_WRTE = 0x45545257;
const A_AUTH = 0x48545541;
const A_STLS = 0x534c5453;
const A_VERSION = 0x01000001;
const MAX_PAYLOAD_SENT = 256 * 1024;

const AUTH_TOKEN = 1;
const AUTH_SIGNATURE = 2;
const AUTH_RSAPUBLICKEY = 3;

// DER prefix of a SHA-1 DigestInfo: adbd verifies with RSA_verify(NID_sha1, token, ...).
const SHA1_DIGEST_INFO = Buffer.from("3021300906052b0e03021a05000414", "hex");

function checksum(data) {
  let sum = 0;
  for (let index = 0; index < data.length; index += 1) sum = (sum + data[index]) >>> 0;
  return sum;
}

function packet(command, arg0, arg1, data = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const header = Buffer.alloc(24);
  header.writeUInt32LE(command, 0);
  header.writeUInt32LE(arg0 >>> 0, 4);
  header.writeUInt32LE(arg1 >>> 0, 8);
  header.writeUInt32LE(body.length, 12);
  header.writeUInt32LE(checksum(body), 16);
  header.writeUInt32LE((command ^ 0xffffffff) >>> 0, 20);
  return Buffer.concat([header, body]);
}

// ---- RSA key in Android's adb format -------------------------------------------------

function bigIntFromBuffer(buffer) {
  return BigInt(`0x${buffer.toString("hex") || "0"}`);
}

function modInverse(value, modulus) {
  let [oldR, r] = [value % modulus, modulus];
  let [oldS, s] = [1n, 0n];
  while (r !== 0n) {
    const quotient = oldR / r;
    [oldR, r] = [r, oldR - quotient * r];
    [oldS, s] = [s, oldS - quotient * s];
  }
  return ((oldS % modulus) + modulus) % modulus;
}

// struct RSAPublicKey { u32 len; u32 n0inv; u32 n[len]; u32 rr[len]; u32 exponent; } little-endian words.
function androidPublicKey(publicKeyPem, label) {
  const jwk = crypto.createPublicKey(publicKeyPem).export({ format: "jwk" });
  const n = bigIntFromBuffer(Buffer.from(jwk.n, "base64url"));
  const e = Number(bigIntFromBuffer(Buffer.from(jwk.e, "base64url")));
  const words = 64; // 2048-bit key
  const word = 1n << 32n;
  const n0inv = (word - modInverse(n % word, word)) % word;
  const rr = (1n << BigInt(words * 32 * 2)) % n;
  const out = Buffer.alloc(4 + 4 + words * 4 * 2 + 4);
  let offset = 0;
  out.writeUInt32LE(words, offset); offset += 4;
  out.writeUInt32LE(Number(n0inv), offset); offset += 4;
  let value = n;
  for (let index = 0; index < words; index += 1) { out.writeUInt32LE(Number(value % word), offset); offset += 4; value /= word; }
  value = rr;
  for (let index = 0; index < words; index += 1) { out.writeUInt32LE(Number(value % word), offset); offset += 4; value /= word; }
  out.writeUInt32LE(e, offset);
  return `${out.toString("base64")} ${label}\0`;
}

async function loadOrCreateKey(keyDir) {
  const keyPath = path.join(keyDir, "adbkey");
  try {
    const privateKeyPem = await fsp.readFile(keyPath, "utf8");
    const publicKeyPem = crypto.createPublicKey(privateKeyPem).export({ type: "spki", format: "pem" });
    return { privateKeyPem, publicKeyPem };
  } catch {}
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" });
  await fsp.mkdir(keyDir, { recursive: true });
  await fsp.writeFile(keyPath, privateKeyPem, { mode: 0o600 });
  return { privateKeyPem, publicKeyPem };
}

function signToken(privateKeyPem, token) {
  return crypto.privateEncrypt(
    { key: privateKeyPem, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.concat([SHA1_DIGEST_INFO, token])
  );
}

// ---- Connection --------------------------------------------------------------------

class AdbStream extends EventEmitter {
  constructor(connection, localId) {
    super();
    this.connection = connection;
    this.localId = localId;
    this.remoteId = 0;
    this.closed = false;
    this.buffer = Buffer.alloc(0);
    this.readers = [];
    this.ackWaiter = null;
  }

  _data(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.emit("data", chunk);
    this._pump();
  }

  _pump() {
    while (this.readers.length) {
      const reader = this.readers[0];
      if (reader.bytes === Infinity) {
        if (!this.closed) return;
        this.readers.shift().resolve(this.buffer);
        this.buffer = Buffer.alloc(0);
        continue;
      }
      if (this.buffer.length >= reader.bytes) {
        this.readers.shift().resolve(this.buffer.subarray(0, reader.bytes));
        this.buffer = this.buffer.subarray(reader.bytes);
        continue;
      }
      if (this.closed) {
        this.readers.shift().reject(new Error("The TV closed the connection."));
        continue;
      }
      return;
    }
  }

  _close() {
    if (this.closed) return;
    this.closed = true;
    if (this.ackWaiter) { this.ackWaiter.reject(new Error("The TV closed the connection.")); this.ackWaiter = null; }
    this._pump();
    this.emit("close");
  }

  // One WRTE in flight; resolves when the TV sends OKAY for it.
  write(data, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error("The TV closed the connection."));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.ackWaiter = null;
        reject(new Error(`The TV stopped responding (no reply in ${Math.round(timeoutMs / 1000)}s).`));
      }, timeoutMs);
      this.ackWaiter = {
        resolve: () => { clearTimeout(timer); resolve(); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      };
      this.connection._send(A_WRTE, this.localId, this.remoteId, data);
    });
  }

  // Splits a large buffer into packets the TV accepts and writes them one by one.
  async writeAll(data, onProgress, timeoutMs) {
    const size = this.connection.maxPayload;
    for (let offset = 0; offset < data.length; offset += size) {
      await this.write(data.subarray(offset, offset + size), timeoutMs);
      if (onProgress) onProgress(Math.min(data.length, offset + size), data.length);
    }
  }

  read(bytes, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.readers.indexOf(reader);
        if (index >= 0) this.readers.splice(index, 1);
        reject(new Error(`The TV didn't answer in ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      const reader = {
        bytes,
        resolve: (value) => { clearTimeout(timer); resolve(Buffer.from(value)); },
        reject: (error) => { clearTimeout(timer); reject(error); }
      };
      this.readers.push(reader);
      this._pump();
    });
  }

  readAll(timeoutMs) {
    return this.read(Infinity, timeoutMs);
  }

  close() {
    if (this.closed) return;
    this.connection._send(A_CLSE, this.localId, this.remoteId);
    this._close();
  }
}

class AdbConnection extends EventEmitter {
  constructor(socket, key) {
    super();
    this.socket = socket;
    this.key = key;
    this.inbox = Buffer.alloc(0);
    this.streams = new Map();
    this.nextLocalId = 1;
    this.maxPayload = 4096;
    this.banner = "";
    this.props = {};
    this.closed = false;
    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._onClose(new Error("The connection to the TV was closed.")));
    socket.on("error", (error) => this._onClose(error));
  }

  _send(command, arg0, arg1, data) {
    if (this.closed) return;
    this.socket.write(packet(command, arg0, arg1, data));
  }

  _onClose(error) {
    if (this.closed) return;
    this.closed = true;
    for (const stream of this.streams.values()) stream._close();
    this.streams.clear();
    this.emit("closed", error);
  }

  _onData(chunk) {
    this.inbox = Buffer.concat([this.inbox, chunk]);
    while (this.inbox.length >= 24) {
      const length = this.inbox.readUInt32LE(12);
      if (this.inbox.length < 24 + length) return;
      const command = this.inbox.readUInt32LE(0);
      const arg0 = this.inbox.readUInt32LE(4);
      const arg1 = this.inbox.readUInt32LE(8);
      const data = Buffer.from(this.inbox.subarray(24, 24 + length));
      this.inbox = this.inbox.subarray(24 + length);
      this._onPacket(command, arg0, arg1, data);
    }
  }

  _onPacket(command, arg0, arg1, data) {
    switch (command) {
      case A_CNXN: {
        this.maxPayload = Math.max(4096, Math.min(arg1 || 4096, MAX_PAYLOAD_SENT));
        this.banner = data.toString("utf8").replace(/\0+$/, "");
        const props = {};
        const propPart = this.banner.split("::")[1] || "";
        for (const pair of propPart.split(";")) {
          const [name, value] = pair.split("=");
          if (name) props[name] = value || "";
        }
        this.props = props;
        this.emit("connected");
        break;
      }
      case A_AUTH:
        this.emit("auth", arg0, data);
        break;
      case A_STLS:
        this.emit("stls");
        break;
      case A_OKAY: {
        const stream = this.streams.get(arg1);
        if (!stream) break;
        if (!stream.remoteId) {
          stream.remoteId = arg0;
          stream.emit("open");
        } else if (stream.ackWaiter) {
          const waiter = stream.ackWaiter;
          stream.ackWaiter = null;
          waiter.resolve();
        }
        break;
      }
      case A_WRTE: {
        const stream = this.streams.get(arg1);
        if (!stream) { this._send(A_CLSE, arg1, arg0); break; }
        this._send(A_OKAY, stream.localId, stream.remoteId);
        stream._data(data);
        break;
      }
      case A_CLSE: {
        const stream = this.streams.get(arg1);
        if (stream) {
          this.streams.delete(arg1);
          if (!stream.remoteId) stream.emit("refused");
          stream._close();
        }
        break;
      }
      default:
        break;
    }
  }

  open(service, timeoutMs = 15000) {
    if (this.closed) return Promise.reject(new Error("Not connected to the TV."));
    const localId = this.nextLocalId++;
    const stream = new AdbStream(this, localId);
    this.streams.set(localId, stream);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.streams.delete(localId);
        reject(new Error(`The TV didn't open "${service.split(":")[0]}" in ${Math.round(timeoutMs / 1000)}s.`));
      }, timeoutMs);
      stream.once("open", () => { clearTimeout(timer); resolve(stream); });
      stream.once("refused", () => { clearTimeout(timer); reject(new Error(`The TV refused "${service.split(":")[0]}".`)); });
      this._send(A_OPEN, localId, 0, Buffer.from(`${service}\0`));
    });
  }

  // Runs a shell command and returns everything it printed.
  async shell(command, timeoutMs = 60000) {
    const stream = await this.open(`shell:${command}`);
    const output = await stream.readAll(timeoutMs);
    return output.toString("utf8").replace(/\r\n/g, "\n");
  }

  async getprop(name) {
    return (await this.shell(`getprop ${name}`)).trim();
  }

  async _sync() {
    const stream = await this.open("sync:");
    const request = async (id, payload) => {
      const body = Buffer.from(payload);
      const header = Buffer.alloc(8);
      header.write(id, 0, "ascii");
      header.writeUInt32LE(body.length, 4);
      await stream.writeAll(Buffer.concat([header, body]));
    };
    const quit = async () => {
      try { await request("QUIT", ""); } catch {}
      stream.close();
    };
    return { stream, request, quit };
  }

  async stat(remotePath) {
    const sync = await this._sync();
    try {
      await sync.request("STAT", remotePath);
      const reply = await sync.stream.read(16, 15000);
      if (reply.toString("ascii", 0, 4) !== "STAT") throw new Error("Unexpected reply from the TV.");
      const mode = reply.readUInt32LE(4);
      const size = reply.readUInt32LE(8);
      const mtime = reply.readUInt32LE(12);
      return mode === 0 && size === 0 && mtime === 0 ? null : { mode, size, mtime };
    } finally {
      await sync.quit();
    }
  }

  // Pushes a buffer with flow control, then waits for the TV to confirm the write.
  async push(data, remotePath, { mode = 0o644, onProgress } = {}) {
    const sync = await this._sync();
    try {
      const parts = [];
      const send = Buffer.from(`${remotePath},${mode | 0o100000}`);
      const sendHeader = Buffer.alloc(8);
      sendHeader.write("SEND", 0, "ascii");
      sendHeader.writeUInt32LE(send.length, 4);
      parts.push(sendHeader, send);
      for (let offset = 0; offset < data.length; offset += 65536) {
        const chunk = data.subarray(offset, offset + 65536);
        const header = Buffer.alloc(8);
        header.write("DATA", 0, "ascii");
        header.writeUInt32LE(chunk.length, 4);
        parts.push(header, chunk);
      }
      const done = Buffer.alloc(8);
      done.write("DONE", 0, "ascii");
      done.writeUInt32LE(Math.floor(Date.now() / 1000), 4);
      parts.push(done);
      const payload = Buffer.concat(parts);
      await sync.stream.writeAll(payload, onProgress ? (sent, total) => onProgress(Math.min(data.length, Math.round(sent * data.length / total)), data.length) : null);
      const status = await sync.stream.read(8, 120000);
      const id = status.toString("ascii", 0, 4);
      if (id === "FAIL") {
        const length = status.readUInt32LE(4);
        const message = length ? (await sync.stream.read(length, 10000)).toString("utf8") : "unknown error";
        throw new Error(`The TV refused the upload: ${message}`);
      }
      if (id !== "OKAY") throw new Error(`Unexpected upload reply from the TV: ${id}`);
    } finally {
      await sync.quit();
    }
  }

  // Installs an APK: push, verify size, pm install, clean up. Returns pm's output.
  async install(apkPath, { onProgress, flags = "-r" } = {}) {
    const data = await fsp.readFile(apkPath);
    const remote = `/data/local/tmp/tvsetup-${Date.now()}.apk`;
    await this.push(data, remote, { onProgress });
    const remoteStat = await this.stat(remote).catch(() => null);
    if (remoteStat && remoteStat.size !== data.length) {
      await this.shell(`rm -f ${remote}`).catch(() => {});
      throw new Error(`Upload was incomplete (${remoteStat.size} of ${data.length} bytes).`);
    }
    const output = await this.shell(`pm install ${flags} ${remote} 2>&1; rm -f ${remote}`, 600000);
    return output.trim();
  }

  close() {
    if (this.closed) return;
    try { this.socket.destroy(); } catch {}
    this._onClose(new Error("Closed."));
  }
}

// Connects and authenticates. onAuthPrompt() is called when the TV needs the user to
// accept "Allow USB debugging?" on screen; the promise then waits up to authTimeoutMs.
async function connect(host, {
  port = 5555,
  keyDir = path.join(os.tmpdir(), "tvsetup-adb"),
  label = "TV Setup@phone",
  connectTimeoutMs = 6000,
  authTimeoutMs = 90000,
  onAuthPrompt = () => {}
} = {}) {
  const key = await loadOrCreateKey(keyDir);
  const socket = await new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`Couldn't reach ${host}:${port}. Is network/USB debugging on?`)); }, connectTimeoutMs);
    sock.once("connect", () => { clearTimeout(timer); sock.setNoDelay(true); sock.setKeepAlive(true, 10000); resolve(sock); });
    sock.once("error", (error) => {
      clearTimeout(timer);
      const code = error?.code || "";
      if (code === "ECONNREFUSED") reject(new Error(`${host} refused port ${port}. Turn on network debugging (or USB debugging on Google TV) and try again.`));
      else reject(new Error(`Couldn't reach ${host}:${port} (${code || error.message}).`));
    });
  });
  const connection = new AdbConnection(socket, key);

  await new Promise((resolve, reject) => {
    let signatureSent = false;
    let publicKeySent = false;
    let timer = setTimeout(() => fail(new Error("The TV didn't answer the ADB handshake.")), 10000);
    const fail = (error) => { clearTimeout(timer); cleanup(); connection.close(); reject(error); };
    const done = () => { clearTimeout(timer); cleanup(); resolve(); };
    const onAuth = (type, data) => {
      if (type !== AUTH_TOKEN) return;
      if (!signatureSent) {
        signatureSent = true;
        connection._send(A_AUTH, AUTH_SIGNATURE, 0, signToken(key.privateKeyPem, data));
        return;
      }
      if (!publicKeySent) {
        publicKeySent = true;
        connection._send(A_AUTH, AUTH_RSAPUBLICKEY, 0, Buffer.from(androidPublicKey(key.publicKeyPem, label)));
        clearTimeout(timer);
        timer = setTimeout(() => fail(new Error("Nobody accepted \"Allow USB debugging?\" on the TV in time. Run it again and accept the prompt (tick \"Always allow\").")), authTimeoutMs);
        try { onAuthPrompt(); } catch {}
        return;
      }
      fail(new Error("The TV rejected this phone's debugging key. On the TV, revoke USB debugging authorizations, then try again."));
    };
    const onStls = () => fail(new Error("This TV only accepts encrypted wireless debugging (Android 11+ pairing). Enable classic network/USB debugging on port 5555, or use the Wireless debugging pairing option."));
    const onClosed = (error) => fail(new Error(`The TV closed the connection during the handshake${error?.message ? ` (${error.message})` : ""}. If a prompt appeared on the TV, accept it and try again.`));
    const cleanup = () => {
      connection.off("connected", done);
      connection.off("auth", onAuth);
      connection.off("stls", onStls);
      connection.off("closed", onClosed);
    };
    connection.on("connected", done);
    connection.on("auth", onAuth);
    connection.on("stls", onStls);
    connection.on("closed", onClosed);
    connection._send(A_CNXN, A_VERSION, MAX_PAYLOAD_SENT, Buffer.from("host::features=shell_v2,cmd,stat_v2\0"));
  });

  return connection;
}

module.exports = {
  connect,
  androidPublicKey,
  loadOrCreateKey,
  signToken,
  constants: { A_SYNC, A_CNXN, A_OPEN, A_OKAY, A_CLSE, A_WRTE, A_AUTH, A_STLS, AUTH_TOKEN, AUTH_SIGNATURE, AUTH_RSAPUBLICKEY },
  packet
};
