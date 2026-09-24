#!/usr/bin/env node
// mtl-assets/vault.mjs — real basic encrypted file store, safe to commit.
//
// Each sealed file becomes one opaque blob at vault/<id>.enc:
//   [12-byte IV][16-byte GCM tag][ciphertext of JSON {name, size, mtime, data(base64)}]
// The filename lives INSIDE the ciphertext too, not just the content — so a
// `git log`/`ls` of vault/ never leaks what's in there, only opaque ids.
// vault/salt.txt is NOT secret (PBKDF2 salts never are) and is committed
// alongside the blobs; the password itself is never written anywhere.
//
//   node vault.mjs seal <path> [--name NAME]
//   node vault.mjs list
//   node vault.mjs open <id-or-name>     → decrypts into work/<name>
//   node vault.mjs rm <id-or-name>
//
// Password: typed at a masked prompt on a real terminal. For non-interactive
// use (scripting/tests only — never for the real vault password) set
// MTL_VAULT_PASSWORD in the environment instead.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VAULT_DIR = path.join(ROOT, "vault");
const WORK_DIR = path.join(ROOT, "work");
const SALT_FILE = path.join(VAULT_DIR, "salt.txt");
const ITERATIONS = 250000;

fs.mkdirSync(VAULT_DIR, { recursive: true });

function readPassword(promptText) {
  if (process.env.MTL_VAULT_PASSWORD) return Promise.resolve(process.env.MTL_VAULT_PASSWORD);
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let buf = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (c) => { buf += c; });
      process.stdin.on("end", () => resolve(buf.split("\n")[0].trim()));
    });
  }
  process.stdout.write(promptText);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    stdin.resume();
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    let pw = "";
    const onData = (char) => {
      if (char === "\n" || char === "\r" || char === "\u0004") {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(pw);
      } else if (char === "\u0003") {
        process.stdout.write("\n");
        process.exit(1);
      } else if (char === "\u007f" || char === "\b") {
        pw = pw.slice(0, -1);
      } else {
        pw += char;
      }
    };
    stdin.on("data", onData);
  });
}

function getSalt() {
  if (fs.existsSync(SALT_FILE)) return Buffer.from(fs.readFileSync(SALT_FILE, "utf8").trim(), "hex");
  const salt = crypto.randomBytes(16);
  fs.writeFileSync(SALT_FILE, salt.toString("hex") + "\n");
  return salt;
}

function deriveKey(password, salt) {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, 32, "sha256");
}

function encryptRecord(key, record) {
  const plain = Buffer.from(JSON.stringify(record), "utf8");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]);
}

function decryptRecord(key, blob) {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const enc = blob.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

function listBlobIds() {
  return fs.readdirSync(VAULT_DIR).filter((f) => f.endsWith(".enc")).map((f) => f.slice(0, -4));
}

function decryptAll(key) {
  const out = [];
  for (const id of listBlobIds()) {
    const blob = fs.readFileSync(path.join(VAULT_DIR, id + ".enc"));
    let record;
    try {
      record = decryptRecord(key, blob);
    } catch (e) {
      throw new Error("Wrong password (or a corrupted vault file).");
    }
    out.push({ id, ...record });
  }
  return out;
}

function humanSize(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " KB";
  return (n / 1024 / 1024).toFixed(1) + " MB";
}

async function main() {
  const [, , cmd, ...rest] = process.argv;

  if (cmd === "seal") {
    const srcPath = rest.find((a) => !a.startsWith("--"));
    if (!srcPath) { console.error("usage: vault.mjs seal <path> [--name NAME]"); process.exit(1); }
    const nameIdx = rest.indexOf("--name");
    const name = nameIdx !== -1 ? rest[nameIdx + 1] : path.basename(srcPath);
    const bytes = fs.readFileSync(srcPath);
    const password = await readPassword("Vault password: ");
    const key = deriveKey(password, getSalt());
    const record = { name, size: bytes.length, mtime: Date.now(), data: bytes.toString("base64") };
    const id = crypto.randomBytes(8).toString("hex");
    fs.writeFileSync(path.join(VAULT_DIR, id + ".enc"), encryptRecord(key, record));
    console.log(`sealed ${srcPath} -> vault/${id}.enc (${name}, ${humanSize(bytes.length)})`);
    return;
  }

  if (cmd === "list") {
    const password = await readPassword("Vault password: ");
    const key = deriveKey(password, getSalt());
    const files = decryptAll(key).sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) { console.log("(vault is empty)"); return; }
    for (const f of files) {
      console.log(`${f.id}  ${f.name}  ${humanSize(f.size)}  ${new Date(f.mtime).toLocaleString()}`);
    }
    return;
  }

  if (cmd === "open") {
    const query = rest[0];
    if (!query) { console.error("usage: vault.mjs open <id-or-name>"); process.exit(1); }
    const password = await readPassword("Vault password: ");
    const key = deriveKey(password, getSalt());
    const files = decryptAll(key);
    const matches = files.filter((f) => f.id === query || f.id.startsWith(query) || f.name.toLowerCase().includes(query.toLowerCase()));
    if (matches.length === 0) { console.error("no match for " + query); process.exit(1); }
    if (matches.length > 1) { console.error("ambiguous, matches: " + matches.map((f) => `${f.id} (${f.name})`).join(", ")); process.exit(1); }
    const f = matches[0];
    fs.mkdirSync(WORK_DIR, { recursive: true });
    const outPath = path.join(WORK_DIR, f.name);
    fs.writeFileSync(outPath, Buffer.from(f.data, "base64"));
    console.log(outPath);
    return;
  }

  if (cmd === "rm") {
    const query = rest[0];
    if (!query) { console.error("usage: vault.mjs rm <id-or-name>"); process.exit(1); }
    const password = await readPassword("Vault password: ");
    const key = deriveKey(password, getSalt());
    const files = decryptAll(key);
    const matches = files.filter((f) => f.id === query || f.id.startsWith(query) || f.name.toLowerCase().includes(query.toLowerCase()));
    if (matches.length === 0) { console.error("no match for " + query); process.exit(1); }
    if (matches.length > 1) { console.error("ambiguous, matches: " + matches.map((f) => `${f.id} (${f.name})`).join(", ")); process.exit(1); }
    fs.unlinkSync(path.join(VAULT_DIR, matches[0].id + ".enc"));
    console.log("removed " + matches[0].name);
    return;
  }

  console.log("usage: vault.mjs <seal|list|open|rm> ...");
  process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
