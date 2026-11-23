// LG engine against a mock webOS TV: key server on 9991 (encrypted PEM key, passphrase),
// SSH on 9922 as prisoner with SFTP, and luna-send-pub install/launch/session responses.
"use strict";
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { Server, utils } = require("../nodejs-project/node_modules/ssh2");

const { app } = require("../nodejs-project/src/electron-shim");
const store = require("../nodejs-project/src/core/store");
const assets = require("../nodejs-project/src/core/assets");
const jobs = require("../nodejs-project/src/core/jobs");
const lg = require("../nodejs-project/src/platforms/lg");

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lgtest-"));
  store.init(tmp);
  assets.init(tmp, tmp);
  const passphrase = "ABC123";
  const { privateKey: clientKey, publicKey: clientPub } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const encryptedPem = clientKey.export({ type: "pkcs1", format: "pem", cipher: "aes-128-cbc", passphrase });
  const authorized = utils.parseKey(clientKey.export({ type: "pkcs1", format: "pem" }));
  const hostKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });

  const keyServer = http.createServer((req, res) => { res.end(req.url === "/webos_rsa" ? encryptedPem : "no"); }).listen(9991, "127.0.0.1");
  const received = {};
  const installs = [];
  const rootCommands = [];
  const commands = [];
  const sshServer = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "publickey" && ctx.username === "prisoner" && ctx.key.algo.includes("rsa") && Buffer.compare(ctx.key.data, authorized.getPublicSSH()) === 0) {
        if (!ctx.signature || authorized.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.accept();
      }
      ctx.reject(["publickey"]);
    }).on("ready", () => {
      client.on("session", (accept) => {
        const session = accept();
        session.on("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          commands.push(info.command);
          if (info.command.includes("devmode_enabled")) stream.write("TOKEN123abc\n");
          else if (info.command.includes("listLaunchPoints")) stream.write('{"launchPoints":[{"id":"space.nuvio.native.legacy"},{"id":"cdp-30"},{"id":"youtube.leanback.v4"},{"id":"netflix"},{"id":"com.webos.app.hdmi1"},{"id":"com.webos.app.hdmi2"}],"returnValue":true}\n');
          else if (info.command.includes("hbchannel.service/exec")) {
            const cmd = (info.command.match(/"command":"(.*?)"\}'/) || [])[1] || "";
            rootCommands.push(cmd);
            stream.write(cmd.startsWith("id -u") ? '{"returnValue":true,"stdoutString":"0\\n"}\n' : '{"returnValue":true,"stdoutString":""}\n');
          }
          else if (info.command.includes("os_info")) stream.write('{"webos_release":"6.3.1"}\n{"modelName":"OLED55C1PUB","returnValue":true}');
          else if (info.command.includes("appInstallService/dev/install")) {
            installs.push(Buffer.from(received["/media/developer/temp/tvsetup.ipk"]));
            stream.write('{"subscribed":true,"returnValue":true}\n');
            setTimeout(() => { stream.write('{"details":{"state":"installing"}}\n'); }, 50);
            setTimeout(() => { stream.write('{"details":{"state":"installed"}}\n'); }, 120);
            return; // stays open like a real subscription; the client closes it
          } else if (info.command.includes("applicationManager/launch")) stream.write('{"returnValue":true}\n');
          stream.exit(0);
          stream.end();
        });
        session.on("sftp", (acceptSftp) => {
          const sftp = acceptSftp();
          const handles = new Map();
          let next = 0;
          sftp.on("OPEN", (reqid, filename) => { const h = Buffer.from([next++]); handles.set(h.toString("hex"), { filename, chunks: [] }); sftp.handle(reqid, h); });
          sftp.on("WRITE", (reqid, handle, offset, data) => { handles.get(handle.toString("hex")).chunks.push({ offset, data: Buffer.from(data) }); sftp.status(reqid, 0); });
          sftp.on("FSTAT", (reqid) => sftp.attrs(reqid, { mode: 0o100644, size: 0, uid: 0, gid: 0, atime: 0, mtime: 0 }));
          sftp.on("CLOSE", (reqid, handle) => {
            const file = handles.get(handle.toString("hex"));
            if (file) { const size = Math.max(0, ...file.chunks.map((c) => c.offset + c.data.length)); const buf = Buffer.alloc(size); for (const c of file.chunks) c.data.copy(buf, c.offset); received[file.filename] = buf; }
            sftp.status(reqid, 0);
          });
        });
      });
    });
  }).listen(9922, "127.0.0.1");

  // Fake IPK served from the cache so no network is needed.
  const ipk = crypto.randomBytes(5 * 1024 * 1024 + 17);
  const dir = path.join(tmp, "packages", "iqui27__nuvio-native-legacy", "v9.9.9");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "space.nuvio.native.legacy_9.9.9_arm.ipk"), ipk);
  fs.writeFileSync(path.join(tmp, "packages", "releases.json"), "{}");
  global.fetch = async () => { throw new Error("offline"); };

  // Wrong passphrase gives a friendly error.
  await assert.rejects(lg.inspect({ ip: "127.0.0.1", passphrase: "WRONG1" }), /passphrase/i);
  const summary = await lg.inspect({ ip: "127.0.0.1", passphrase });
  assert.strictEqual(summary.model, "OLED55C1PUB");
  assert.strictEqual(summary.sessionTokenSaved, true);

  assert.strictEqual(summary.rooted, true, "root detected through Homebrew Channel");
  const updates = [];
  jobs.setBroadcaster((channel, payload) => { if (channel === "job:update") updates.push(payload); });
  const choices = { nuvio: "default", home: true, bootHome: true };
  const job = jobs.createJob("LG", lg.stepsFor(choices));
  await lg.run({ ip: "127.0.0.1", choices, passphrase }, job);
  job.finish({});
  const final = updates[updates.length - 1];
  assert.strictEqual(installs.length, 2, "Nuvio and TV Home installed");
  assert.ok(installs[0].equals(ipk), "Nuvio IPK uploaded byte-identical");
  // The second install is TV Home: unpack it and check the tiles that were baked in.
  const homeIpk = installs[1];
  assert.strictEqual(homeIpk.toString("ascii", 0, 8), "!<arch>\n", "TV Home is an ar archive");
  const zlib = require("node:zlib");
  let off = 8; const members = {};
  while (off < homeIpk.length) {
    const name = homeIpk.toString("ascii", off, off + 16).trim(); const size = Number(homeIpk.toString("ascii", off + 48, off + 58).trim());
    members[name] = homeIpk.subarray(off + 60, off + 60 + size); off += 60 + size + (size % 2);
  }
  assert.deepStrictEqual(Object.keys(members), ["debian-binary", "control.tar.gz", "data.tar.gz"]);
  const tar = zlib.gunzipSync(members["data.tar.gz"]).toString("latin1");
  assert.ok(tar.includes('"id": "com.tvsetup.home"'), "appinfo id");
  const tiles = JSON.parse(tar.match(/\/\*TILES\*\/(.*?)\/\*END\*\//)[1]);
  console.log("TV Home tiles:", tiles.map((t) => t.name).join(", "));
  assert.strictEqual(tiles[0].name, "Nuvio");
  assert.ok(tiles.some((t) => t.name === "Plex") && !tiles.some((t) => t.name === "Hulu"), "only installed apps");
  assert.ok(rootCommands.some((c) => c.includes("/var/lib/webosbrew/init.d/80-tvsetup-home")), "boot script written on a rooted TV");
  assert.ok(commands.some((c) => c.includes('"ipkUrl":"/media/developer/temp/tvsetup.ipk"')), "install called");
  assert.ok(commands.some((c) => c.includes("applicationManager/launch") && c.includes("com.tvsetup.home")), "TV Home opened at the end");
  assert.strictEqual(final.steps.find((s) => s.id === "nuvio").status, "done");
  console.log("steps:", final.steps.map((s) => `${s.id}=${s.status}`).join(" "));
  keyServer.close(); sshServer.close();
  console.log("lg: all checks passed");
  process.exit(0);
})().catch((error) => { console.error("FAIL", error); process.exit(1); });
