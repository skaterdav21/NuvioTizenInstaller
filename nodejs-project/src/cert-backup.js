// Passphrase-encrypted backup/restore of the saved Samsung signing certificates
// (the JSON files main.js keeps in userData/samsung-certificates).
const crypto = require("node:crypto");
const fsp = require("node:fs/promises");
const path = require("node:path");

const FORMAT = "nuvio-tv-cert-backup";
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const FILE_NAME_PATTERN = /^[A-Za-z0-9_.-]+\.json$/;

function certificateDirectory(userDataPath) {
  return path.join(userDataPath, "samsung-certificates");
}

function deriveKey(passphrase, salt) {
  return crypto.scryptSync(String(passphrase), salt, 32, SCRYPT);
}

function requirePassphrase(passphrase) {
  if (String(passphrase || "").length < 6) {
    throw new Error("Use a passphrase of at least 6 characters.");
  }
}

async function readCertificateFiles(userDataPath) {
  const directory = certificateDirectory(userDataPath);
  const entries = await fsp.readdir(directory).catch(() => []);
  const files = {};
  for (const name of entries) {
    if (!FILE_NAME_PATTERN.test(name)) {
      continue;
    }
    const text = await fsp.readFile(path.join(directory, name), "utf8");
    try {
      const parsed = JSON.parse(text);
      if (parsed?.authorCert && parsed?.distributorCert) {
        files[name] = text;
      }
    } catch {}
  }
  return files;
}

async function countTvs(userDataPath) {
  const files = await readCertificateFiles(userDataPath);
  return Object.keys(files).filter((name) => name.startsWith("duid-")).length;
}

async function exportBackup(userDataPath, passphrase) {
  requirePassphrase(passphrase);
  const files = await readCertificateFiles(userDataPath);
  const tvCount = Object.keys(files).filter((name) => name.startsWith("duid-")).length;
  if (Object.keys(files).length === 0) {
    throw new Error("No certificates saved yet. Install to a TV first.");
  }

  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const plaintext = Buffer.from(JSON.stringify({ files }), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  const envelope = {
    format: FORMAT,
    version: 1,
    createdAt: new Date().toISOString(),
    tvCount,
    kdf: "scrypt",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: ciphertext.toString("base64")
  };
  const stamp = new Date().toISOString().slice(0, 10);
  return { fileName: `nuvio-tv-certificates-${stamp}.json`, text: JSON.stringify(envelope, null, 2), tvCount };
}

async function importBackup(userDataPath, passphrase, text) {
  let envelope;
  try {
    envelope = JSON.parse(String(text || ""));
  } catch {
    throw new Error("That file isn't a certificate backup.");
  }
  if (envelope?.format !== FORMAT || envelope.version !== 1) {
    throw new Error("That file isn't a certificate backup from this app.");
  }

  let payload;
  try {
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      deriveKey(passphrase, Buffer.from(envelope.salt, "base64")),
      Buffer.from(envelope.iv, "base64")
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, "base64")), decipher.final()]);
    payload = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("Wrong passphrase, or the backup file is damaged.");
  }

  const directory = certificateDirectory(userDataPath);
  await fsp.mkdir(directory, { recursive: true });
  let restored = 0;
  for (const [name, content] of Object.entries(payload?.files || {})) {
    if (!FILE_NAME_PATTERN.test(name)) {
      continue;
    }
    const target = path.join(directory, name);
    await fsp.writeFile(target, String(content), { mode: 0o600 });
    restored += 1;
  }
  return { restored, tvCount: await countTvs(userDataPath) };
}

module.exports = { exportBackup, importBackup, countTvs };
