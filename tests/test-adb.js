"use strict";
const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const adb = require("../nodejs-project/src/core/adb.js");
const mock = require("./mock-adbd.js");

(async () => {
  const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "adbkey-"));
  const { server, state } = await mock.start({
    port: 25555,
    maxdata: 4096,
    shell: (command) => (command.startsWith("getprop ro.product.model") ? "SHIELD Android TV\n" : command.startsWith("echo") ? command.slice(5) + "\n" : "x".repeat(20000))
  });
  let prompted = 0;
  const first = await adb.connect("127.0.0.1", { port: 25555, keyDir, onAuthPrompt: () => { prompted += 1; } });
  assert.strictEqual(prompted, 1, "first connect should prompt");
  assert.deepStrictEqual(state.keyChecks[0], { okN0: true, okRR: true, e: 65537 }, "android key encoding");
  assert.strictEqual(await first.getprop("ro.product.model"), "SHIELD Android TV");
  assert.strictEqual((await first.shell("long-output")).length, 20000, "multi-packet shell output");
  const data = require("node:crypto").randomBytes(3 * 1024 * 1024 + 123);
  let last = 0;
  await first.push(data, "/data/local/tmp/x.bin", { onProgress: (sent) => { last = sent; } });
  assert.ok(state.files["/data/local/tmp/x.bin"].equals(data), "push byte-identical");
  assert.strictEqual(last, data.length, "progress reaches 100%");
  assert.strictEqual((await first.stat("/data/local/tmp/x.bin")).size, data.length, "stat size");
  assert.strictEqual(await first.stat("/nope"), null, "stat missing");
  first.close();

  const second = await adb.connect("127.0.0.1", { port: 25555, keyDir, onAuthPrompt: () => { prompted += 1; } });
  assert.strictEqual(prompted, 1, "second connect reuses the authorized key without a prompt");
  assert.strictEqual(await second.shell("echo hi"), "hi\n");
  second.close();
  assert.strictEqual(state.violations, 0, "no flow-control or payload violations");
  server.close();
  console.log("adb: all checks passed");
})().catch((error) => { console.error("FAIL", error); process.exit(1); });
