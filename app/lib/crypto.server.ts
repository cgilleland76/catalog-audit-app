import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// Encrypts third-party credentials at rest. Uses CREDENTIALS_KEY when set
// (any long random string), otherwise a key derived from the app's API secret.
function key() {
  const secret = process.env.CREDENTIALS_KEY || process.env.SHOPIFY_API_SECRET;
  if (!secret) throw new Error("Set CREDENTIALS_KEY to store credentials");
  return createHash("sha256").update(secret).digest();
}

export function encryptJson(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), data].map((b) => b.toString("base64")).join(".");
}

export function decryptJson<T>(payload: string): T {
  const [iv, tag, data] = payload.split(".").map((p) => Buffer.from(p, "base64"));
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  const text = Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  return JSON.parse(text) as T;
}
