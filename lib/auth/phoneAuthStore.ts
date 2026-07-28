import "server-only";

import { timingSafeEqual } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export type PhoneChallenge = {
  id: string;
  phoneHash: string;
  maskedPhone: string;
  otpHash: string;
  requestIpHash: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
  status?: "pending" | "sent" | "invalidated";
  consumedAt?: number;
};

type PhoneAuthStore = {
  schemaVersion: 1;
  challenges: PhoneChallenge[];
};

let mutationQueue = Promise.resolve();

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function storeFile(): string {
  return process.env.AISTORY_PHONE_AUTH_STORE_PATH
    || path.join(process.cwd(), ".aistory-accounts", "phone-auth.json");
}

function backupFile(): string {
  return `${storeFile()}.previous`;
}

function emptyStore(): PhoneAuthStore {
  return { schemaVersion: 1, challenges: [] };
}

async function parseFile(file: string): Promise<PhoneAuthStore> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as PhoneAuthStore;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.challenges)) {
    throw new Error("Unsupported phone auth store schema.");
  }
  return parsed;
}

async function readStore(): Promise<PhoneAuthStore> {
  let firstError: unknown;
  for (const file of [storeFile(), backupFile()]) {
    try {
      return await parseFile(file);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (
    firstError
    && typeof firstError === "object"
    && "code" in firstError
    && firstError.code === "ENOENT"
  ) return emptyStore();
  throw firstError;
}

async function writeStore(store: PhoneAuthStore): Promise<void> {
  const target = storeFile();
  const directory = path.dirname(target);
  const backup = backupFile();
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(directory, { recursive: true });
  let movedPrimary = false;
  try {
    await writeFile(temporary, JSON.stringify(store, null, 2), {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await unlink(backup).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(target, backup)
      .then(() => {
        movedPrimary = true;
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    if (movedPrimary) await rename(backup, target).catch(() => undefined);
    throw error;
  }
}

async function mutate<T>(
  operation: (store: PhoneAuthStore) => T | Promise<T>,
): Promise<T> {
  let release: (() => void) | undefined;
  const previous = mutationQueue;
  mutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const store = await readStore();
    const result = await operation(store);
    await writeStore(store);
    return result;
  } finally {
    release?.();
  }
}

export async function createPhoneChallenge(
  challenge: PhoneChallenge,
): Promise<void> {
  await mutate((store) => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    store.challenges = store.challenges.filter(
      (item) => item.createdAt >= cutoff,
    );
    store.challenges.push(challenge);
  });
}

export async function markPhoneChallengeSent(
  challengeId: string,
): Promise<boolean> {
  return mutate((store) => {
    const challenge = store.challenges.find(
      (item) => item.id === challengeId && item.status === "pending",
    );
    if (!challenge) return false;
    challenge.status = "sent";
    return true;
  });
}

export async function invalidatePhoneChallenge(
  challengeId: string,
): Promise<void> {
  await mutate((store) => {
    const challenge = store.challenges.find(
      (item) => item.id === challengeId,
    );
    if (challenge && !challenge.consumedAt) {
      challenge.status = "invalidated";
    }
  });
}

export async function listRecentPhoneChallenges(
  phoneHash: string,
  requestIpHash: string,
  since: number,
): Promise<PhoneChallenge[]> {
  const store = await readStore();
  return store.challenges.filter(
    (item) =>
      item.createdAt >= since
      && (item.phoneHash === phoneHash || item.requestIpHash === requestIpHash),
  );
}

export async function verifyAndConsumePhoneChallenge(input: {
  challengeId: string;
  phoneHash: string;
  otpHash: string;
  now: number;
  maxAttempts: number;
}): Promise<"verified" | "expired" | "invalid"> {
  return mutate((store) => {
    const challenge = store.challenges.find(
      (item) =>
        item.id === input.challengeId
        && item.phoneHash === input.phoneHash,
    );
    if (
      !challenge
      || challenge.consumedAt
      || challenge.attempts >= input.maxAttempts
      || (
        challenge.status !== undefined
        && challenge.status !== "sent"
      )
    ) return "invalid";
    if (challenge.expiresAt <= input.now) return "expired";
    challenge.attempts += 1;
    if (!hashesEqual(challenge.otpHash, input.otpHash)) return "invalid";
    challenge.consumedAt = input.now;
    return "verified";
  });
}
