// Entry point under nodejs-mobile: loads the upstream installer logic and
// exposes its IPC handlers to the Android WebView over a loopback HTTP server.
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const UI_PORT = Number(process.env.NUVIO_UI_PORT || 4795);
const uiDir = path.join(__dirname, "ui");
// Random per-launch token from the Android side, so other apps on the phone
// cannot drive the installer through the loopback port.
const API_TOKEN = process.env.NUVIO_TOKEN || "";

require("./src/net-patch");
const { app, handlers, bus } = require("./src/electron-shim");
require("./src/main.js");

fs.mkdirSync(app.getPath("userData"), { recursive: true });

const certBackup = require("./src/cert-backup");
handlers.set("certs:status", async () => ({ tvCount: await certBackup.countTvs(app.getPath("userData")) }));
handlers.set("certs:export", async (_event, passphrase) => certBackup.exportBackup(app.getPath("userData"), passphrase));
const samsungCa = require("./src/samsung-ca");
handlers.set("samsungca:status", async () => samsungCa.status());
handlers.set("samsungca:import", async (_event, zipPath) => {
  const uploads = path.join(app.getPath("userData"), "uploads");
  const resolved = path.resolve(String(zipPath || ""));
  if (!resolved.startsWith(uploads + path.sep)) throw new Error("Invalid file.");
  return samsungCa.importFromZip(resolved);
});
handlers.set("certs:import", async (_event, passphrase, text) => certBackup.importBackup(app.getPath("userData"), passphrase, text));

const sseClients = new Set();

function broadcast(channel, payload) {
  const data = `data: ${JSON.stringify({ channel, payload })}\n\n`;
  for (const client of sseClients) {
    client.write(data);
  }
}

bus.on("message", broadcast);

const fakeEvent = {
  sender: {
    send: broadcast
  }
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function readBody(request, limitBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("Request body too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

async function handleInvoke(request, response) {
  const { channel, args } = JSON.parse((await readBody(request, 1024 * 1024)).toString("utf8") || "{}");
  const handler = handlers.get(channel);
  if (!handler) {
    sendJson(response, 404, { error: `Unknown channel: ${channel}` });
    return;
  }
  try {
    const result = await handler(fakeEvent, ...(Array.isArray(args) ? args : []));
    sendJson(response, 200, { result: result === undefined ? null : result });
  } catch (error) {
    sendJson(response, 200, { error: error?.message || String(error) });
  }
}

async function handleUpload(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  const name = path.basename(String(url.searchParams.get("name") || "package.wgt")).replace(/[^a-z0-9._-]+/gi, "_");
  if (!/\.(wgt|tpk|p12|pfx|zip)$/i.test(name)) {
    sendJson(response, 400, { error: "Only .wgt, .p12, .pfx or .zip files can be selected." });
    return;
  }
  const body = await readBody(request, 300 * 1024 * 1024);
  const uploadDir = path.join(app.getPath("userData"), "uploads");
  await fsp.mkdir(uploadDir, { recursive: true });
  const target = path.join(uploadDir, name);
  await fsp.writeFile(target, body);
  sendJson(response, 200, { path: target });
}

async function serveStatic(request, response) {
  const url = new URL(request.url, "http://127.0.0.1");
  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const filePath = path.resolve(uiDir, relative);
  if (!filePath.startsWith(uiDir + path.sep)) {
    response.writeHead(403);
    response.end();
    return;
  }
  try {
    const data = await fsp.readFile(filePath);
    response.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(data);
  } catch {
    response.writeHead(404);
    response.end("Not found");
  }
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.url.startsWith("/api/") && API_TOKEN) {
      const token = new URL(request.url, "http://127.0.0.1").searchParams.get("t");
      if (token !== API_TOKEN) {
        sendJson(response, 403, { error: "Forbidden" });
        return;
      }
    }
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/health") {
      sendJson(response, 200, { ok: true });
    } else if (pathname === "/api/events") {
      response.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive"
      });
      response.write(": connected\n\n");
      sseClients.add(response);
      request.on("close", () => sseClients.delete(response));
    } else if (pathname === "/api/invoke" && request.method === "POST") {
      await handleInvoke(request, response);
    } else if (pathname === "/api/upload" && request.method === "POST") {
      await handleUpload(request, response);
    } else if (request.method === "GET") {
      await serveStatic(request, response);
    } else {
      response.writeHead(405);
      response.end();
    }
  } catch (error) {
    if (!response.headersSent) {
      sendJson(response, 500, { error: error?.message || String(error) });
    } else {
      response.end();
    }
  }
});

// Keep SSE connections alive through idle periods.
setInterval(() => {
  for (const client of sseClients) {
    client.write(": ping\n\n");
  }
}, 15000).unref();

server.listen(UI_PORT, "127.0.0.1", () => {
  console.log(`Nuvio installer UI listening on http://127.0.0.1:${UI_PORT}`);
});
