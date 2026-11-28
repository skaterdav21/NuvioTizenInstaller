// Rooted LG (Homebrew Channel): root SSH on 22 with the default password, then this phone's key;
// TV Home + LG Input Hook install through `cat` uploads, keybinds, elevation, boot script, learn, undo.
"use strict";
const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Server, utils } = require("../nodejs-project/node_modules/ssh2");

const store = require("../nodejs-project/src/core/store");
const assets = require("../nodejs-project/src/core/assets");
const jobs = require("../nodejs-project/src/core/jobs");
const lgRoot = require("../nodejs-project/src/platforms/lg-root");
const lgHome = require("../nodejs-project/src/platforms/lg-home");

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lgroot-"));
  store.init(tmp); assets.init(tmp, tmp); lgRoot.init(tmp);
  // Input Hook from the cache so no network is needed.
  const hookIpk = Buffer.concat([Buffer.from("!<arch>\n"), crypto.randomBytes(300000)]);
  fs.mkdirSync(path.join(tmp, "packages", "inputhook"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "packages", "inputhook", "org.webosbrew.inputhook_1.5.1_all.ipk"), hookIpk);

  // ---- rootability outlook
  assert.strictEqual(lgRoot.rootOutlook({ webos: "4.9.0", firmware: "05.40.20" }).level, "likely");
  assert.strictEqual(lgRoot.rootOutlook({ webos: "6.3.1", firmware: "03.33.85" }).level, "maybe");
  assert.strictEqual(lgRoot.rootOutlook({ webos: "9.0.1", firmware: "13.30.70" }).level, "unlikely");
  assert.strictEqual(lgRoot.rootOutlook({ webos: "10.0.0", firmware: "33.25.10" }).level, "maybe");
  assert.strictEqual(lgRoot.rootOutlook({ webos: "10.1.0", firmware: "33.40.01" }).level, "unlikely");
  assert.strictEqual(lgRoot.rootOutlook({ webos: "6.3.1", rooted: true }).level, "rooted");

  // ---- mock rooted TV
  const hostKey = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs1", format: "pem" });
  const files = { "/home/root/.config/lginputhook/keybinds.json": '{"428":{"action":"ignore"}}' };
  const apps = new Set(["netflix", "youtube.leanback.v4"]);
  let authorized = "";
  const logins = [];
  const commands = [];
  const sh = (cmd) => {
    commands.push(cmd);
    if (cmd === "id -u") return "0\n";
    if (cmd.includes("os_info")) return '{"webos_release":"6.3.1"}\n{"modelName":"OLED65C1PUB","firmwareVersion":"03.33.85","returnValue":true}';
    if (cmd.includes("authorized_keys")) { authorized = (cmd.match(/echo '([^']+)' >>/) || [])[1] || authorized; return ""; }
    if (cmd.startsWith("cat /home/root/.config/lginputhook/keybinds.json")) return files["/home/root/.config/lginputhook/keybinds.json"] || "";
    if (cmd.includes("base64 -d > /home/root/.config/lginputhook/keybinds.json.new")) { files["/home/root/.config/lginputhook/keybinds.json"] = Buffer.from(cmd.match(/echo (\S+) \| base64/)[1], "base64").toString(); return ""; }
    if (cmd.includes("base64 -d > /var/lib/webosbrew/init.d/80-tvsetup-home")) { files.boot = Buffer.from(cmd.match(/echo (\S+) \| base64/)[1], "base64").toString(); return ""; }
    if (cmd.includes("rm -f /var/lib/webosbrew/init.d/80-tvsetup-home")) { delete files.boot; return ""; }
    if (cmd.includes("[ -x /var/lib/webosbrew/init.d/80-tvsetup-home ]")) return files.boot ? "on\n" : "";
    if (cmd.startsWith("wc -c < ")) return `${(files[cmd.slice(8).trim()] || Buffer.alloc(0)).length}\n`;
    if (cmd.includes("getAppInfo")) { const id = cmd.match(/"id":"([^"]+)"/)[1]; return apps.has(id) ? `{"returnValue":true,"appInfo":{"id":"${id}","version":"1.5.1"}}` : '{"returnValue":false}'; }
    if (cmd.includes("listLaunchPoints")) return '{"launchPoints":[{"id":"netflix"},{"id":"youtube.leanback.v4"},{"id":"amazon"},{"id":"com.webos.app.hdmi1"}]}';
    if (cmd.includes("elevate-service")) { files.elevated = true; return ""; }
    if (cmd.includes("inputhook.service/start")) { files.hookStarted = true; return ""; }
    if (cmd.includes("applicationManager/launch")) { files.launched = cmd; return '{"returnValue":true}'; }
    if (cmd.includes("tail -n 0 -F /tmp/lginput-hook")) return "[INFO] lginput_uinput_send_button called: keyid=1155, state=1 uinput_code=1\n";
    return "";
  };
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.username !== "root") return ctx.reject();
      if (ctx.method === "password") { logins.push("password"); return ctx.password === "alpine" ? ctx.accept() : ctx.reject(); }
      if (ctx.method === "publickey" && authorized) {
        const key = utils.parseKey(authorized);
        if (Buffer.compare(ctx.key.data, key.getPublicSSH()) === 0) {
          if (!ctx.signature) return ctx.accept();
          if (key.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) { logins.push("key"); return ctx.accept(); }
        }
      }
      ctx.reject(["publickey", "password"]);
    }).on("ready", () => {
      client.on("session", (accept) => {
        accept().on("exec", (acceptExec, _r, info) => {
          const stream = acceptExec();
          const cmd = info.command;
          const cat = cmd.match(/^cat > (\S+)$/);
          if (cat) {
            const chunks = [];
            stream.on("data", (c) => chunks.push(c));
            let done = false; const fin = () => { if (done) return; done = true; files[cat[1]] = Buffer.concat(chunks); stream.exit(0); stream.end(); };
            stream.on("end", fin); stream.on("eof", fin);
            return;
          }
          if (cmd.includes("appInstallService/dev/install")) {
            const ipk = files["/tmp/tvsetup-root.ipk"];
            const id = ipk.length === hookIpk.length ? "org.webosbrew.inputhook" : lgHome.HOME_ID;
            apps.add(id);
            stream.write('{"subscribed":true,"returnValue":true}\n');
            setTimeout(() => stream.write('{"details":{"state":"installed"}}\n'), 60);
            return;
          }
          stream.write(sh(cmd));
          stream.exit(0); stream.end();
        });
      });
    });
  }).listen(2222, "127.0.0.1");
  await new Promise((r) => setTimeout(r, 300));
  const ip = "127.0.0.1:2222";

  const summary = await lgRoot.inspect({ ip });
  assert.strictEqual(summary.rootMode, true); assert.strictEqual(summary.firmware, "03.33.85"); assert.strictEqual(summary.name, "LG OLED65C1PUB");
  assert.ok(authorized.startsWith("ssh-rsa "), "phone key left on the TV");
  assert.deepStrictEqual(logins, ["password"]);

  const choices = { nuvio: "skip", takeHome: true, bootHome: true, shortcuts: { netflix: "nuvio", prime: "", disney: "" } };
  const job = jobs.createJob("Take over", lgRoot.stepsFor(choices));
  await lgRoot.run({ ip, choices }, job);
  job.finish({});
  assert.ok(jobs.getJob(job.id).steps.every((s) => s.status === "done"), JSON.stringify(jobs.getJob(job.id).steps));
  assert.ok(logins.includes("key"), "second connection used the phone's key");
  assert.ok(apps.has(lgHome.HOME_ID) && apps.has("org.webosbrew.inputhook"), "TV Home and Input Hook installed");
  assert.ok(files.elevated && files.hookStarted, "Input Hook elevated and started");
  const binds = JSON.parse(files["/home/root/.config/lginputhook/keybinds.json"]);
  assert.deepStrictEqual(binds["773"], { action: "launch", id: lgHome.HOME_ID }, "Home -> TV Home");
  assert.deepStrictEqual(binds["1037"], { action: "launch", id: "space.nuvio.native.legacy" }, "Netflix -> Nuvio");
  assert.deepStrictEqual(binds["428"], { action: "ignore" }, "owner's own binding kept");
  assert.ok(files.boot.includes(lgHome.HOME_ID), "boot script opens TV Home");
  assert.ok(files.launched.includes(lgHome.HOME_ID));

  const learnt = await lgRoot.learnButton({ ip, seconds: 2 });
  assert.deepStrictEqual(learnt, { code: 1155, name: "Button 1155", protected: false });

  // Re-run with Netflix turned back off and a learnt key: Netflix mapping removed, learnt one added.
  const job2 = jobs.createJob("Again", lgRoot.stepsFor({ ...choices, shortcuts: {}, extraKeys: [{ code: 1155, target: "home" }] }));
  await lgRoot.run({ ip, choices: { ...choices, shortcuts: {}, extraKeys: [{ code: 1155, target: "home" }] } }, job2);
  job2.finish({});
  const binds2 = JSON.parse(files["/home/root/.config/lginputhook/keybinds.json"]);
  assert.ok(!binds2["1037"] && binds2["1155"] && binds2["773"] && binds2["428"]);

  await lgRoot.undo({ ip });
  const binds3 = JSON.parse(files["/home/root/.config/lginputhook/keybinds.json"]);
  assert.deepStrictEqual(binds3, { 428: { action: "ignore" } }, "undo leaves only the owner's bindings");
  assert.ok(!files.boot, "boot script removed");
  server.close();
  console.log("lg-root: outlook, password then key login, TV Home + Input Hook, Home/Netflix mapping, boot, learn, re-map, undo passed");
  process.exit(0);
})().catch((e) => { console.error("FAIL", e); process.exit(1); });
