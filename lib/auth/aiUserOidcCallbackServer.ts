import "server-only";

import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  AIUSER_CALLBACK_MODE, aiUserOidcUnavailable, createAiUserOidcCallback,
  validateAiUserCallbackConfiguration, validateAiUserHostReceipt,
  AIUSER_IDENTITY_COOKIE, AIUSER_TRANSACTION_COOKIE, AIUSER_PENDING_COOKIE_PREFIX,
  AIUSER_CALLBACK_REJECTION_STAGES, type AiUserCallbackRejectionStage,
} from "./aiUserOidcCallback";
import { AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION } from "./aiUserOidcProductionBeta";
import { AIUSER_ACCOUNT_PATH } from "./aiUserAccountPublic";
import { clearAiUserLinkIntent } from "./aiUserAccountLinkSession";
import { createAiUserUserRuntime, hasAiUserProductCookie, clearAiUserProductCookie,
  AIUSER_USER_INTEGRATION_ENV, AIUSER_USER_INTEGRATION_MODE, type AiUserBusinessSession } from "./aiUserProductSession";

export const AIUSER_CALLBACK_ENV = Object.freeze({
  mode: "AISTORY_AIUSER_OIDC_CALLBACK_MODE",
  configFile: "AISTORY_AIUSER_OIDC_CALLBACK_CONFIG_FILE",
});

function rejected(): never { throw new Error("aiuser_runtime_unavailable"); }

/** Journal-safe diagnostic: fixed stage only, with no request, token, cookie, claim, URL or exception data. */
export function reportAiUserOidcCallbackRejection(stage: AiUserCallbackRejectionStage): void {
  if (!(AIUSER_CALLBACK_REJECTION_STAGES as readonly string[]).includes(stage)) rejected();
  process.stderr.write(`[aiuser-oidc] callback_rejected stage=${stage}\n`);
}

export type ProtectedFileMetadata = {
  regular: boolean; symbolicLink: boolean; uid: number; gid: number;
  mode: number; nlink: number; size: number;
};

export function assertAiUserProtectedFile(metadata: ProtectedFileMetadata, uid: number, limit: number, gid?: number): void {
  if (!metadata.regular || metadata.symbolicLink || metadata.nlink !== 1
    || metadata.uid !== uid || (gid !== undefined && metadata.gid !== gid)
    || (metadata.mode & 0o777) !== 0o400 && (metadata.mode & 0o777) !== 0o600
    || !Number.isSafeInteger(metadata.size) || metadata.size < 1 || metadata.size > limit) rejected();
}

async function parents(file: string, uid: number): Promise<void> {
  if (path.posix.normalize(file) !== file || !file.startsWith("/")) rejected();
  let current = path.posix.dirname(file);
  while (true) {
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o022) !== 0
      || ![0, uid].includes(info.uid) || await realpath(current) !== current) rejected();
    if (current === "/") break;
    current = path.posix.dirname(current);
  }
}

async function readProtected(file: string, uid: number, maxBytes: number, gid?: number): Promise<Buffer> {
  await parents(file, uid);
  const before = await lstat(file);
  const metadata = (info: typeof before) => ({ regular: info.isFile(), symbolicLink: info.isSymbolicLink(),
    uid: info.uid, gid: info.gid, mode: info.mode, nlink: info.nlink, size: info.size });
  assertAiUserProtectedFile(metadata(before), uid, maxBytes, gid);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    assertAiUserProtectedFile(metadata(opened), uid, maxBytes, gid);
    if (opened.dev !== before.dev || opened.ino !== before.ino) rejected();
    const bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size <= maxBytes) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
      if (size > maxBytes) rejected();
    }
    const after = await handle.stat();
    const leaf = await lstat(file);
    assertAiUserProtectedFile(metadata(after), uid, maxBytes, gid);
    assertAiUserProtectedFile(metadata(leaf), uid, maxBytes, gid);
    if (size !== before.size || after.size !== size || after.mtimeMs !== before.mtimeMs
      || leaf.isSymbolicLink() || leaf.dev !== before.dev || leaf.ino !== before.ino) rejected();
    return bytes.subarray(0, size);
  } finally { await handle.close(); }
}

async function replayDirectory(directory: string, uid: number, gid: number): Promise<void> {
  await parents(`${directory}/entry`, uid);
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || info.gid !== gid
    || (info.mode & 0o777) !== 0o700 || await realpath(directory) !== directory) rejected();
}

// Durable hash-only tombstones; retained across workers/restarts, never cleared by callback failures.
// Maintenance must retain logout tombstones for >=900s token +690s transaction +5s skew.
// Never remove all markers on restart; a surviving cookie must not regain authority.
async function claimOnce(directory: string, uid: number, gid: number, digest: string): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(digest)) rejected();
  await replayDirectory(directory, uid, gid);
  const entries = await opendir(directory);
  let count = 0;
  for await (const entry of entries) {
    if (++count > 10000 || !/^[a-f0-9]{64}\.claim$/.test(entry.name) || !entry.isFile()) rejected();
  }
  let handle;
  try {
    handle = await open(`${directory}/${digest}.claim`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // A previous creator may have failed before file/directory fsync. Existence
      // alone is not a durable logout acknowledgement: revalidate and sync it.
      if (!(await isClaimed(directory, uid, gid, digest, true))) return rejected();
      return false;
    }
    return rejected();
  }
  try { await handle.sync(); } finally { await handle.close(); }
  if (!(await isClaimed(directory, uid, gid, digest, true))) return rejected();
  return true;
}

// Server-only contract export for the synthetic filesystem qualification; the
// production composition below calls this same implementation.
export { claimOnce as claimAiUserReplayOnce };

async function isClaimed(directory: string, uid: number, gid: number, digest: string, confirmDurable = false): Promise<boolean> {
  if (!/^[a-f0-9]{64}$/.test(digest)) rejected();
  await replayDirectory(directory, uid, gid);
  const file = `${directory}/${digest}.claim`;
  let before;
  try { before = await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; return rejected(); }
  const valid = (info: typeof before) => info.isFile() && !info.isSymbolicLink() && info.uid === uid
    && info.gid === gid && info.nlink === 1 && info.size === 0 && (info.mode & 0o777) === 0o600;
  if (!valid(before)) rejected();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!valid(opened) || opened.ino !== before.ino || opened.dev !== before.dev) rejected();
    if (confirmDurable) await handle.sync();
    const after = await lstat(file);
    if (!valid(opened) || !valid(after) || opened.ino !== before.ino || opened.dev !== before.dev
      || after.ino !== before.ino || after.dev !== before.dev) rejected();
  } finally { await handle.close(); }
  if (confirmDurable) {
    await replayDirectory(directory, uid, gid);
    const parentBefore = await lstat(directory);
    const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const parentOpened = await parent.stat();
      if (!parentOpened.isDirectory() || parentOpened.uid !== uid || parentOpened.gid !== gid
        || (parentOpened.mode & 0o777) !== 0o700 || parentOpened.dev !== parentBefore.dev || parentOpened.ino !== parentBefore.ino) rejected();
      await parent.sync();
      const parentAfter = await lstat(directory);
      const leafAfter = await lstat(file);
      if (!parentAfter.isDirectory() || parentAfter.isSymbolicLink() || parentAfter.uid !== uid || parentAfter.gid !== gid
        || (parentAfter.mode & 0o777) !== 0o700 || parentAfter.dev !== parentBefore.dev || parentAfter.ino !== parentBefore.ino
        || !valid(leafAfter) || leafAfter.dev !== before.dev || leafAfter.ino !== before.ino) rejected();
    } finally { await parent.close(); }
  }
  return true;
}

let rateMinute = 0;
let rateCount = 0;
function allowStart(): boolean {
  const minute = Math.floor(Date.now() / 60000);
  if (minute !== rateMinute) { rateMinute = minute; rateCount = 0; }
  rateCount += 1;
  // Additional process-wide safety cap; the verified ingress rate limit is still mandatory.
  return rateCount <= 30;
}

async function loadRuntime() {
  // Read no other configuration/secret and perform no file/network IO while disabled.
  if (process.env[AIUSER_CALLBACK_ENV.mode] !== AIUSER_CALLBACK_MODE) return null;
  if (process.platform !== "linux" || !process.getuid || !process.getgid) return null;
  const uid = process.getuid();
  const gid = process.getgid();
  const filename = process.env[AIUSER_CALLBACK_ENV.configFile];
  if (!filename || !/^\/etc\/aistory\/aiuser-oidc\/[A-Za-z0-9_-]+\.json$/.test(filename)) return null;
  const configBytes = await readProtected(filename, uid, 8192);
  const config = validateAiUserCallbackConfiguration(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(configBytes)));
  if (config.recipientUid !== uid || config.recipientGid !== gid || config.secretFile === filename
    || config.hostReceiptFile === filename) return null;
  const receipt = await readProtected(config.hostReceiptFile, uid, 8192);
  if (createHash("sha256").update(receipt).digest("hex") !== config.hostReceiptSha256) return null;
  validateAiUserHostReceipt(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(receipt)), config);
  await replayDirectory(config.replayDirectory, uid, gid);
  // Value resolution is unreachable until host receipt + actual recipient UID/ACL have passed.
  // The current local slice never calls this branch with real configuration.
  const secret = await readProtected(config.secretFile, uid, 257, gid);
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(secret).replace(/\n$/, "");
    const dependencies = { clientSecret: value, fetch: globalThis.fetch, now: Date.now, allowStart,
      proxyRequestOrigin: config.proxyRequestOrigin,
      onCallbackRejected: reportAiUserOidcCallbackRejection,
      claimOnce: (digest: string) => claimOnce(config.replayDirectory, uid, gid, digest) };
    if (process.env[AIUSER_USER_INTEGRATION_ENV] !== AIUSER_USER_INTEGRATION_MODE) {
      return { ...createAiUserOidcCallback(dependencies), business: undefined };
    }
    return createAiUserUserRuntime({ ...dependencies,
      isClaimed: (digest) => isClaimed(config.replayDirectory, uid, gid, digest) });
  } finally { secret.fill(0); }
}

type OidcHttpRuntime = Pick<NonNullable<Awaited<ReturnType<typeof loadRuntime>>>, "start" | "callback">;
export function createAiUserOidcHttpBoundary(loader: () => Promise<OidcHttpRuntime | null>) {
  return async (operation: "start" | "callback", request: Request): Promise<Response> => {
    try {
      const runtime = await loader();
      return runtime ? await runtime[operation](request) : aiUserOidcUnavailable();
    } catch { return aiUserOidcUnavailable(); }
  };
}

export const handleAiUserOidcRequest = createAiUserOidcHttpBoundary(loadRuntime);

/** Protected runtime operations only; never exports the resolved credential. */
export async function loadAiUserBusinessRuntime() {
  if (process.env[AIUSER_USER_INTEGRATION_ENV] !== AIUSER_USER_INTEGRATION_MODE) return null;
  return (await loadRuntime())?.business ?? null;
}

export type AiUserUserRead = { state: "absent" } | { state: "invalid" } | { state: "authenticated"; session: AiUserBusinessSession };

export async function readAiUserBusinessSession(request?: Request): Promise<AiUserUserRead> {
  const input = request ?? new Request(AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION.publicOrigin, {
    headers: await (await import("next/headers")).headers(),
  });
  if (!hasAiUserProductCookie(input)) return { state: "absent" };
  // An expired/invalid AIUser cookie never falls through to an unrelated phone/legacy identity.
  if (process.env[AIUSER_USER_INTEGRATION_ENV] !== AIUSER_USER_INTEGRATION_MODE) return { state: "invalid" };
  try {
    const runtime = await loadRuntime();
    const session = await runtime?.business?.read(input);
    return session ? { state: "authenticated", session } : { state: "invalid" };
  } catch { return { state: "invalid" }; }
}

export async function aiUserUserCapabilities(accountLinkReady = false, linkReauthReady = false): Promise<Response> {
  const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
  if (process.env[AIUSER_USER_INTEGRATION_ENV] !== AIUSER_USER_INTEGRATION_MODE) {
    return Response.json({ enabled: false, linkingEnabled: false, linkReauthAvailable: false }, { headers });
  }
  // Account-link readiness is independently derived by its route from the exact
  // selector, current dual proofs and uncached database posture.
  try {
    const enabled = !!(await loadRuntime())?.business;
    return Response.json({ enabled, linkingEnabled: enabled && accountLinkReady,
      linkReauthAvailable: enabled && linkReauthReady }, { headers });
  }
  catch { return Response.json({ enabled: false, linkingEnabled: false, linkReauthAvailable: false }, { headers }); }
}

export async function logoutAiUserBusinessSession(request: Request, response: Response): Promise<boolean> {
  const raw = request.headers.get("cookie") ?? "";
  const hasPending = raw.split(";").some((item) => item.trim().startsWith(AIUSER_PENDING_COOKIE_PREFIX));
  const present = hasPending || hasAiUserProductCookie(request) || [AIUSER_IDENTITY_COOKIE, AIUSER_TRANSACTION_COOKIE]
    .some((name) => raw.split(";").some((item) => item.trim().startsWith(`${name}=`)));
  if (!present) return true;
  try {
    if (!hasPending && !hasAiUserProductCookie(request) && process.env[AIUSER_USER_INTEGRATION_ENV] !== AIUSER_USER_INTEGRATION_MODE) {
      for (const name of [AIUSER_IDENTITY_COOKIE, AIUSER_TRANSACTION_COOKIE]) {
        response.headers.append("Set-Cookie", `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
      }
      return true;
    }
    const runtime = process.env[AIUSER_USER_INTEGRATION_ENV] === AIUSER_USER_INTEGRATION_MODE ? await loadRuntime() : null;
    if (!runtime?.business) return false;
    for (const clear of await runtime.business.logout(request)) response.headers.append("Set-Cookie", clear);
    response.headers.append("Set-Cookie", clearAiUserLinkIntent());
    response.headers.append("Set-Cookie", clearAiUserProductCookie());
    for (const name of [AIUSER_IDENTITY_COOKIE, AIUSER_TRANSACTION_COOKIE]) {
      response.headers.append("Set-Cookie", `${name}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
    }
    return true;
  } catch { return false; }
}

/** Fixed local landing; error descriptions, tokens, state and caller return URLs are never reflected. */
export async function handleAiUserUserCallback(request: Request): Promise<Response> {
  const response = await handleAiUserOidcRequest("callback", request);
  if (process.env[AIUSER_USER_INTEGRATION_ENV] !== AIUSER_USER_INTEGRATION_MODE || response.status !== 400) return response;
  const headers = new Headers(response.headers);
  headers.set("Location", `${AIUSER_ACCOUNT_PATH}?status=failed`);
  return new Response(null, { status: 303, headers });
}
