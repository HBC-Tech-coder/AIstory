import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  PHONE_OTP_COOLDOWN_STORAGE_KEY,
  clearExpiredPhoneOtpCooldown,
  phoneOtpCooldownSecondsRemaining,
  readPhoneOtpCooldownDeadline,
  resolvePhoneOtpRetryAfterSeconds,
  storePhoneOtpCooldownDeadline,
  type PhoneOtpCooldownStorage,
} from "@/lib/auth/phoneOtpCooldown";

class MemoryStorage implements PhoneOtpCooldownStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const now = 1_800_000_000_000;
const storage = new MemoryStorage();

assert.equal(
  resolvePhoneOtpRetryAfterSeconds({ retryAfterSeconds: 60 }, null, now),
  60,
);
const successDeadline = storePhoneOtpCooldownDeadline(storage, 60, now);
assert.equal(successDeadline, now + 60_000);
assert.equal(phoneOtpCooldownSecondsRemaining(successDeadline, now), 60);
assert.equal(
  phoneOtpCooldownSecondsRemaining(successDeadline, now + 1_001),
  59,
);
assert.equal(
  phoneOtpCooldownSecondsRemaining(successDeadline, now + 59_001),
  1,
);
assert.equal(
  phoneOtpCooldownSecondsRemaining(successDeadline, now + 60_000),
  0,
);

// A newly mounted modal (including the admin entry) reads the same timestamp.
assert.equal(
  readPhoneOtpCooldownDeadline(storage, now + 2_000),
  successDeadline,
);
assert.deepEqual([...storage.values.keys()], [PHONE_OTP_COOLDOWN_STORAGE_KEY]);
assert.doesNotMatch([...storage.values.values()].join(""), /138\d{8}|\+86/);

assert.equal(
  resolvePhoneOtpRetryAfterSeconds({ retryAfter: 23 }, null, now),
  23,
);
assert.equal(
  resolvePhoneOtpRetryAfterSeconds({}, "17", now),
  17,
);
assert.equal(
  resolvePhoneOtpRetryAfterSeconds(
    {},
    new Date(now + 31_000).toUTCString(),
    now,
  ),
  31,
);
assert.equal(resolvePhoneOtpRetryAfterSeconds({}, null, now), 60);

// A shorter response cannot accidentally shrink a still-active server cooldown.
assert.equal(
  storePhoneOtpCooldownDeadline(storage, 10, now + 5_000),
  successDeadline,
);
clearExpiredPhoneOtpCooldown(storage, successDeadline, now + 59_999);
assert.equal(storage.getItem(PHONE_OTP_COOLDOWN_STORAGE_KEY), String(successDeadline));
clearExpiredPhoneOtpCooldown(storage, successDeadline, now + 60_000);
assert.equal(storage.getItem(PHONE_OTP_COOLDOWN_STORAGE_KEY), null);
assert.equal(readPhoneOtpCooldownDeadline(storage, now + 60_000), 0);

const authModalSource = await readFile(
  path.join(process.cwd(), "components", "AuthModal.tsx"),
  "utf8",
);
const adminLoginSource = await readFile(
  path.join(process.cwd(), "app", "admin", "login", "AdminLoginForm.tsx"),
  "utf8",
);
const requestRouteSource = await readFile(
  path.join(
    process.cwd(),
    "app",
    "api",
    "auth",
    "phone",
    "request",
    "route.ts",
  ),
  "utf8",
);
assert.match(authModalSource, /sendInFlightRef\.current/);
assert.match(authModalSource, /readPhoneOtpCooldownDeadline/);
assert.match(authModalSource, /clearTimeout\(timer\)/);
assert.doesNotMatch(authModalSource, /setInterval\(/);
assert.doesNotMatch(adminLoginSource, /<AuthModal|\/api\/auth\/phone/);
assert.match(requestRouteSource, /retryAfterSeconds/);

console.log("phone OTP cooldown tests passed");
