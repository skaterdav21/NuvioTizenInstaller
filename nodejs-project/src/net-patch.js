// Network hardening for nodejs-mobile on Android (added in 1.2.1).
//
// 1. DNS fallback: nodejs-mobile resolves through the system resolver, which on
//    some networks fails for specific hosts (seen: download.tizen.org ENOTFOUND
//    while Chrome, using its own secure DNS, resolves it fine). When the system
//    lookup fails, query public resolvers directly, then DNS-over-HTTPS by IP.
// 2. Default timeouts on node-fetch, so a stalled request surfaces as an error
//    instead of hanging the certificate step forever.
// 3. Clears a half-populated Samsung CA cache so a bad earlier run cannot
//    permanently break certificate creation.
"use strict";

const dns = require("node:dns");
const net = require("node:net");
const https = require("node:https");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FALLBACK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "ENODATA", "ESERVFAIL", "ETIMEOUT"]);
const PUBLIC_DNS = ["8.8.8.8", "1.1.1.1", "9.9.9.9", "8.8.4.4"];
const cache = new Map();

const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(PUBLIC_DNS);

function dohResolve(hostname) {
  // IP-literal endpoints: no DNS needed to reach them, and both certs carry IP SANs.
  const endpoints = [
    { host: "1.1.1.1", path: `/dns-query?name=${encodeURIComponent(hostname)}&type=A` },
    { host: "8.8.8.8", path: `/resolve?name=${encodeURIComponent(hostname)}&type=A` }
  ];
  return endpoints.reduce((prev, ep) => prev.catch(() => new Promise((resolve, reject) => {
    const req = https.get({
      host: ep.host,
      path: ep.path,
      headers: { accept: "application/dns-json" },
      timeout: 6000
    }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        try {
          const json = JSON.parse(body);
          const ips = (json.Answer || []).filter((a) => a.type === 1).map((a) => a.data).filter((ip) => net.isIPv4(ip));
          ips.length ? resolve(ips) : reject(new Error("DoH returned no A records"));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on("timeout", () => req.destroy(new Error("DoH timeout")));
    req.on("error", reject);
  })), Promise.reject(new Error("start")));
}

function fallbackResolve(hostname) {
  const hit = cache.get(hostname);
  if (hit && hit.expires > Date.now()) {
    return Promise.resolve(hit.ips);
  }
  return new Promise((resolve, reject) => {
    resolver.resolve4(hostname, (error, ips) => {
      if (!error && ips && ips.length) {
        resolve(ips);
        return;
      }
      dohResolve(hostname).then(resolve, () => reject(error || new Error("No addresses")));
    });
  }).then((ips) => {
    cache.set(hostname, { ips, expires: Date.now() + 10 * 60 * 1000 });
    console.log(`[net-patch] fallback DNS: ${hostname} -> ${ips.join(", ")}`);
    return ips;
  });
}

const originalLookup = dns.lookup;

dns.lookup = function patchedLookup(hostname, options, callback) {
  if (typeof options === "function") {
    callback = options;
    options = {};
  } else if (typeof options === "number") {
    options = { family: options };
  } else {
    options = options || {};
  }

  originalLookup.call(dns, hostname, options, (error, address, family) => {
    if (!error || !hostname || net.isIP(hostname) || !FALLBACK_CODES.has(error.code) || options.family === 6) {
      callback(error, address, family);
      return;
    }
    fallbackResolve(hostname).then((ips) => {
      if (options.all) {
        callback(null, ips.map((ip) => ({ address: ip, family: 4 })));
      } else {
        callback(null, ips[0], 4);
      }
    }, () => callback(error, address, family));
  });
};

// Default timeout for every node-fetch caller (the tizen library sets none).
try {
  const fetchPath = require.resolve("node-fetch", { paths: [path.join(__dirname, "..", "node_modules", "tizen")] });
  const originalFetch = require(fetchPath);
  const DEFAULT_TIMEOUT_MS = 90 * 1000;
  const wrapped = function fetchWithTimeout(url, options = {}) {
    return originalFetch(url, { timeout: DEFAULT_TIMEOUT_MS, ...options });
  };
  Object.assign(wrapped, originalFetch);
  wrapped.default = wrapped;
  require.cache[fetchPath].exports = wrapped;
} catch (error) {
  console.log(`[net-patch] node-fetch timeout wrapper not installed: ${error.message}`);
}

// Remove an incomplete Samsung CA cache (the library skips downloading if the folder exists).
try {
  const certDir = path.join(os.homedir(), "share", ".samsung-cert");
  const required = ["vd_tizen_dev_author_ca.cer", "vd_tizen_dev_public2.crt", "vd_tizen_dev_partner2.crt"];
  if (fs.existsSync(certDir) && !required.every((name) => fs.existsSync(path.join(certDir, name)))) {
    fs.rmSync(certDir, { recursive: true, force: true });
    console.log("[net-patch] removed incomplete Samsung CA cache");
  }
} catch {}

module.exports = { fallbackResolve };
