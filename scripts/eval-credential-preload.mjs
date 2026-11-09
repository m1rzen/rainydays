// Headless evaluation runs have no Electron safeStorage. Protect credentials with a key that exists only in this process.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { configureCredentialProtector } from "../dist/credential-store.js";

const key = randomBytes(32);
configureCredentialProtector({
  protect(value) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
    const body = Buffer.concat([cipher.update(value), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  },
  unprotect(value) {
    const data = Buffer.from(value), decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]);
  },
});
