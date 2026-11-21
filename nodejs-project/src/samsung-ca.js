// Samsung CA files needed to request a TV certificate (added in 1.2.2).
// The tizen library downloads them from download.tizen.org on first use, which
// can stall from the phone. This module checks for them, and can import them
// from the certificate extension zip that the user downloads in Chrome.
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const JSZip = require("jszip");

const REQUIRED = ["vd_tizen_dev_author_ca.cer", "vd_tizen_dev_public2.crt", "vd_tizen_dev_partner2.crt"];
const DOWNLOAD_URL = "https://download.tizen.org/sdk/extensions/tizen-certificate-extension_2.0.75.zip";

function caDirectory() {
  return path.join(os.homedir(), "share", ".samsung-cert");
}

function missingFiles() {
  const dir = caDirectory();
  return REQUIRED.filter((name) => !fs.existsSync(path.join(dir, name)));
}

function status() {
  const missing = missingFiles();
  return { installed: missing.length === 0, missing, downloadUrl: DOWNLOAD_URL };
}

// Walks nested archives (extension zip -> addon zip -> jar) and collects certs.
async function collectCertificates(buffer, depth, found) {
  if (depth > 4) return;
  let zip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return;
  }
  for (const entry of Object.values(zip.files)) {
    if (entry.dir) continue;
    const lower = entry.name.toLowerCase();
    if (lower.endsWith(".crt") || lower.endsWith(".cer")) {
      found.set(path.basename(entry.name), await entry.async("nodebuffer"));
    } else if (lower.endsWith(".zip") || lower.endsWith(".jar")) {
      await collectCertificates(await entry.async("nodebuffer"), depth + 1, found);
    }
  }
}

async function importFromZip(zipPath) {
  const buffer = await fsp.readFile(zipPath);
  const found = new Map();
  await collectCertificates(buffer, 0, found);
  const missing = REQUIRED.filter((name) => !found.has(name));
  if (missing.length) {
    throw new Error(`That zip doesn't contain the Samsung CA files (missing ${missing.join(", ")}). Use the tizen-certificate-extension zip from the copied link.`);
  }
  const dir = caDirectory();
  await fsp.mkdir(dir, { recursive: true });
  for (const [name, data] of found) {
    await fsp.writeFile(path.join(dir, name), data);
  }
  try {
    await fsp.unlink(zipPath);
  } catch {}
  return { imported: found.size, ...status() };
}

module.exports = { status, importFromZip, missingFiles, DOWNLOAD_URL };
