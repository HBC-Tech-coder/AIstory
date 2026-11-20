// Deliberately no runtime imports from Next/server-only at the CLI boundary.
import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const CHILD = "--protected-bootstrap-child-v1";
function fail(): never { throw new Error("Protected administrator bootstrap unavailable."); }

export function parseTemporaryBootstrapInput(raw: string): { username: string; password: string } {
  if (Buffer.byteLength(raw) > 2048 || raw.startsWith("\uFEFF")) fail();
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).sort().join(",") !== "password,schemaVersion,username"
    || !("schemaVersion" in value) || value.schemaVersion !== 1
    || !("username" in value) || typeof value.username !== "string"
    || !("password" in value) || typeof value.password !== "string") fail();
  return { username: value.username, password: value.password };
}

export async function loadTemporaryBootstrapDependencies() {
  const [principal, repository, first, database, server] = await Promise.all([
    import("@/lib/admin/independentPrincipal"), import("@/lib/admin/independentPrincipalRepository"),
    import("@/lib/admin/independentFirstPasswordChange"), import("@/lib/production/databaseGate"),
    import("@/lib/admin/independentPrincipalServer"),
  ]);
  return { principal, repository, first, database, server };
}

export async function runTemporaryBootstrap(args: readonly string[]) {
  if (args.length !== 6 || args[0] !== "--input-file" || args[2] !== "--output-file" || args[4] !== "--recipient-uid"
    || !/^\d{1,6}$/.test(args[5] ?? "") || process.platform !== "linux" || process.getuid?.() !== 0) fail();
  const recipient = Number(args[5]);
  if (recipient < 1) fail();
  const dependencies = await loadTemporaryBootstrapDependencies();
  const { principal, repository, first, database, server } = dependencies;
  const env: Record<string, string | undefined> = process.env;
  if (!server.inspectIndependentAdminPrincipalProductionGate(env).ready) fail();
  const input = principal.validateIndependentAdminPrincipalFileReference(args[1] ?? "", process.cwd(), "linux");
  const output = principal.validateIndependentAdminPrincipalFileReference(args[3] ?? "", process.cwd(), "linux");
  if (input === output || env.AISTORY_ADMIN_PRINCIPAL_CREDENTIAL_FILE !== output) fail();
  await principal.assertIndependentAdminPrincipalProtectedDirectoryChain(path.dirname(input), { effectiveUid: 0, ownerOnlyLeaf: true });
  await principal.assertIndependentAdminPrincipalProtectedDirectoryChain(path.dirname(output), { effectiveUid: recipient, ownerOnlyLeaf: true });
  const inputStat = await lstat(input);
  const parent = await lstat(path.dirname(output));
  if (inputStat.uid !== 0 || inputStat.gid !== 0 || (inputStat.mode & 0o777) !== 0o600 || !inputStat.isFile()
    || inputStat.isSymbolicLink() || inputStat.nlink !== 1 || inputStat.size > 2048
    || await realpath(input) !== input || parent.uid !== recipient || parent.gid !== recipient || (parent.mode & 0o777) !== 0o700) fail();
  try { await lstat(output); fail(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(); }
  const client = database.createProductionSupabaseServiceClient(env);
  await database.assertProductionDatabaseGateReady("identity", client, env);
  await first.assertFirstPasswordChangeGate(client);
  const handle = await open(input, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: Buffer;
  try {
    const stat = await handle.stat();
    if (stat.ino !== inputStat.ino || stat.dev !== inputStat.dev || stat.size !== inputStat.size || stat.mtimeMs !== inputStat.mtimeMs
      || !stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) fail();
    raw = Buffer.alloc(2049);
    const read = await handle.read(raw, 0, raw.length, 0);
    if (read.bytesRead !== stat.size) fail();
    raw = raw.subarray(0, read.bytesRead);
    const after = await handle.stat();
    if (after.ctimeMs !== stat.ctimeMs || after.mtimeMs !== stat.mtimeMs || after.size !== stat.size
      || after.nlink !== 1 || after.uid !== 0 || after.gid !== 0 || (after.mode & 0o777) !== 0o600) fail();
  } finally { await handle.close(); }
  let credential;
  try { credential = await principal.createFirstChangeIndependentAdminCredential(parseTemporaryBootstrapInput(new TextDecoder("utf-8", { fatal: true }).decode(raw))); }
  finally { raw.fill(0); }
  const binding = principal.projectIndependentAdminPrincipalCredentialBinding(credential);
  const repo = repository.createSupabaseIndependentAdminPrincipalRepository(client, binding);
  await repo.assertGateReady();
  // Immutable seed is durable BEFORE DB commit. On ambiguous DB failure keep it;
  // never overwrite, rotate, auto-resume, or synthesize another administrator.
  const outputHandle = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let outputIdentity;
  try {
    await outputHandle.writeFile(principal.serializeIndependentAdminPrincipalCredential(credential));
    await outputHandle.chown(recipient, recipient); await outputHandle.sync();
    outputIdentity = await outputHandle.stat();
  } finally { await outputHandle.close(); }
  const parentHandle = await open(path.dirname(output), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await parentHandle.sync(); } finally { await parentHandle.close(); }
  const outputStat = await lstat(output);
  const parentAfter = await lstat(path.dirname(output));
  if (outputStat.isSymbolicLink() || !outputStat.isFile() || outputStat.ino !== outputIdentity.ino
    || outputStat.dev !== outputIdentity.dev || outputStat.size !== outputIdentity.size || outputStat.nlink !== 1
    || outputStat.uid !== recipient || outputStat.gid !== recipient || (outputStat.mode & 0o777) !== 0o600
    || outputStat.mtimeMs !== outputIdentity.mtimeMs || await realpath(output) !== output
    || parentAfter.ino !== parent.ino || parentAfter.dev !== parent.dev || parentAfter.uid !== recipient
    || parentAfter.gid !== recipient || (parentAfter.mode & 0o777) !== 0o700) fail();
  const result = await client.rpc("aistory_iap_first_change_bootstrap", { request_payload: {
    registration: { ...first.firstChangeBinding(credential), request_id: `ipr_${randomBytes(32).toString("base64url")}` },
    password_state: first.firstChangePasswordState(credential),
  } });
  if (result.error || result.data !== true) fail();
  const finalInput = await lstat(input);
  if (finalInput.dev !== inputStat.dev || finalInput.ino !== inputStat.ino || finalInput.mtimeMs !== inputStat.mtimeMs) fail();
  await unlink(input);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] !== CHILD) {
    // No sentinel import, environment value read, credential prompt or RPC in
    // the parent. Conditions are set on the actual module-graph child process.
    const result = spawnSync(process.execPath, ["--conditions=react-server", "--import=tsx", fileURLToPath(import.meta.url), CHILD, ...args],
      { stdio: "inherit", windowsHide: true });
    process.exitCode = result.status === 0 ? 0 : 1;
  } else {
    try {
      if (args.length === 2 && args[1] === "--check-module-boundary") await loadTemporaryBootstrapDependencies();
      else await runTemporaryBootstrap(args.slice(1));
      process.stdout.write("PROTECTED_BOOTSTRAP_CHECK_PASS\n");
    } catch { process.stderr.write("PROTECTED_BOOTSTRAP_UNAVAILABLE\n"); process.exitCode = 1; }
  }
}
