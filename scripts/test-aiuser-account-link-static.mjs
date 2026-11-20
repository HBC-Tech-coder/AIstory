import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { activeAsyncChildCount, activeProtectedDockerChildCount, checked, immutableMutationCases,
  immutableSnapshotSql, observeAsyncChild, observeControlledSessionChild, observeProtectedDockerChild, validateAsyncSqlFailure,
  validateAsyncSuccess, validateExpectedSqlFailure } from "./test-aiuser-account-link-postgres16.mjs";

const read = (path) => readFile(path, "utf8");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const [migration, envelope, callback, product, linkConfig, linkServer, linkLogout, service, repository,
  accountRoute, accountLogout, env, runbook, pg16] = await Promise.all([
  read("supabase/migrations/20260901040000_aiuser_account_link_gate.sql"),
  read("scripts/apply-aiuser-account-link-ledger.psql"),
  read("lib/auth/aiUserOidcCallback.ts"), read("lib/auth/aiUserProductSession.ts"),
  read("lib/auth/aiUserAccountLinkConfig.ts"), read("lib/auth/aiUserAccountLinkServer.ts"),
  read("lib/auth/aiUserAccountLinkLogout.ts"), read("lib/auth/aiUserAccountLinkService.ts"),
  read("lib/auth/aiUserAccountLinkRepository.ts"), read("app/api/account/me/route.ts"),
  read("lib/auth/accountLogoutRoute.ts"),
  read(".env.example"), read("runbooks/aiuser-user-integration-v1.md"),
  read("scripts/test-aiuser-account-link-postgres16.mjs"),
]);

let checks = 0;
const migrationHash = sha256(migration);
assert.match(migrationHash, /^[a-f0-9]{64}$/); checks++;
assert.equal(envelope.split(migrationHash).length, 3, "ledger insert and postflight must pin the exact migration bytes"); checks++;
assert.equal(envelope.split("\\ir ../supabase/migrations/20260901040000_aiuser_account_link_gate.sql").length, 2); checks++;
export function validatePgAreBoundedRepetitions(sqlText) {
  assert.equal(typeof sqlText, "string", "PostgreSQL ARE source must be text");
  const repetitions = [...sqlText.matchAll(/\{(\d+)(?:,(\d*))?\}/g)];
  assert.ok(repetitions.length > 0, "migration must expose its PostgreSQL bounded repetitions to static review");
  for (const match of repetitions) {
    const lower = Number(match[1]);
    const upper = match[2] === undefined ? lower : match[2] === "" ? null : Number(match[2]);
    assert.ok(lower <= 255 && (upper === null || upper <= 255), `PostgreSQL ARE bound exceeds 255: ${match[0]}`);
  }
  return repetitions.map((match) => match[0]);
}
const pgBoundedRepetitions = validatePgAreBoundedRepetitions(migration);
checks += pgBoundedRepetitions.length + 1;
assert.throws(() => validatePgAreBoundedRepetitions("value ~ 'x{1,300}'"), /PostgreSQL ARE bound exceeds 255: \{1,300\}/); checks++;
assert.ok(migration.includes(`object_key collate "C" ~ '^(constraint|default|function):[ -~]+$'`)); checks++;
assert.ok(migration.includes("and char_length(object_key)-strpos(object_key,':') between 1 and 300")); checks++;

for (const table of ["aiuser_account_links", "aiuser_account_link_intents", "aiuser_account_link_session_revocations",
  "aiuser_account_link_audit", "aiuser_account_link_catalog_manifest"]) {
  assert.match(migration, new RegExp(`create table public\\.${table} \\(`));
  assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  assert.match(migration, new RegExp(`alter table public\\.${table} force row level security`)); checks += 3;
}
for (const fn of ["aistory_aiuser_link_posture", "aistory_aiuser_link_is_linked", "aistory_aiuser_link_prepare",
  "aistory_aiuser_link_confirm", "aistory_aiuser_link_revoke_sessions", "aistory_aiuser_link_validate_payload",
  "aistory_aiuser_link_catalog", "aistory_aiuser_link_immutable"]) {
  assert.match(migration, new RegExp(`function public\\.${fn}\\(`)); checks++;
}
assert.match(migration, /select \* into v_prepared[\s\S]*for update;/); checks++;
assert.match(migration, /insert into public\.aiuser_account_link_audit[\s\S]*return v_outcome;/); checks++;
for (const [name, firstProtectedOperation] of [
  ["aistory_aiuser_link_prepare", "select * into v_prepared"],
  ["aistory_aiuser_link_confirm", "select * into v_prepared"],
  ["aistory_aiuser_link_revoke_sessions", "insert into public.aiuser_account_link_session_revocations"],
]) {
  const start = migration.indexOf(`create function public.${name}`);
  const end = migration.indexOf("create function public.", start + 1);
  const functionBody = migration.slice(start, end < 0 ? migration.length : end);
  const lock = functionBody.indexOf("pg_advisory_xact_lock(20260901,40000)");
  assert.ok(start >= 0 && lock >= 0 && lock < functionBody.indexOf(firstProtectedOperation), `${name} must lock before protected state`); checks++;
}
assert.match(migration, /except select object_key,definition_sha256 from public\.aiuser_account_link_catalog_manifest/); checks++;
assert.match(migration, /except select object_key,definition_sha256 from public\.aistory_aiuser_link_catalog\(\)/); checks++;
assert.match(migration, /v_ai:=nullif\(request_payload->'aiuser','null'::jsonb\)/); checks++;
assert.match(migration, /jsonb_typeof\(v_phone->'sessionBinding'\) is distinct from 'string'/); checks++;
const confirmFunction = migration.indexOf("create function public.aistory_aiuser_link_confirm");
const confirmRevocationCheck = migration.indexOf("if exists(select 1 from public.aiuser_account_link_session_revocations r", confirmFunction);
const consumedReplayRead = migration.indexOf("select * into v_consumed from public.aiuser_account_link_audit", confirmFunction);
assert.ok(confirmFunction >= 0 && confirmRevocationCheck >= 0 && consumedReplayRead >= 0
  && confirmRevocationCheck < consumedReplayRead); checks++;
const prepareFunction = migration.indexOf("create function public.aistory_aiuser_link_prepare");
const prepareRevocationCheck = migration.indexOf("if exists(select 1 from public.aiuser_account_link_session_revocations r", prepareFunction);
const preparedReplayRead = migration.indexOf("select * into v_prepared from public.aiuser_account_link_intents", prepareFunction);
assert.ok(prepareFunction >= 0 && prepareRevocationCheck >= 0 && preparedReplayRead >= 0
  && prepareRevocationCheck < preparedReplayRead); checks++;

for (const forbidden of ["credit_accounts", "credit_ledger", "stories", "hosted_credentials", "administrators",
  "independent_admin_principals", "membership"]) {
  assert.doesNotMatch(migration, new RegExp(`(?:insert\\s+into|update|delete\\s+from)\\s+public\\.${forbidden}`, "i")); checks++;
}
assert.match(callback, /Object\.hasOwn\(payload, "auth_time"\)/); checks++;
assert.match(callback, /idpAuthenticatedAt = verifiedIdpAuthenticationTime\(idClaims, verifiedNow\)/); checks++;
assert.match(product, /sessionIssuedAt: payload\.iat! \* 1000/); checks++;
assert.match(product, /idpAuthenticatedAt: idpAuthenticatedAt === null \? null : \(idpAuthenticatedAt as number\) \* 1000/); checks++;
assert.match(linkConfig, /process\.env\[AIUSER_LINK_ENV\] === AIUSER_LINK_MODE\s*&& aiUserAccountLinkRevocationSelected\(\)/); checks++;
assert.match(linkConfig, /AISTORY_AIUSER_ACCOUNT_LINK_REVOCATION_MODE/); checks++;
assert.doesNotMatch(linkServer, /authenticatedAt:\s*session\.sessionIssuedAt/); checks++;
assert.match(linkServer, /if \(session\.idpAuthenticatedAt === null\) return null/); checks++;
assert.match(linkLogout, /revocationSelected: aiUserAccountLinkRevocationSelected/); checks++;
assert.doesNotMatch(linkLogout, /aiUserAccountLinkSelected/); checks++;
assert.match(service, /await deps\.repository\.prepare\(proof\)/); checks++;
const mutationProofRead = service.indexOf("const proofs = await deps.readProofs");
const mutationRateLimit = service.indexOf("deps.allowMutation(proofs.aiuser.principalKey)");
assert.ok(mutationProofRead >= 0 && mutationRateLimit >= 0 && mutationProofRead < mutationRateLimit); checks++;
for (const rpc of ["aistory_aiuser_link_prepare", "aistory_aiuser_link_confirm", "aistory_aiuser_link_revoke_sessions"]) {
  assert.match(repository, new RegExp(`client\\.rpc\\("${rpc}"`)); checks++;
}
assert.match(accountRoute, /return handleAccountLogout\(request\)/); checks++;
const revokeBeforeLogout = accountLogout.indexOf("deps.revokeLinkSessions(request)");
const baseBusinessLogout = accountLogout.indexOf("deps.logoutBusinessSession(request, response)");
const unavailableLogoutResponse = accountLogout.indexOf('NextResponse.json({ ok: false, code: "ACCOUNT_LOGOUT_UNAVAILABLE" }');
assert.ok(revokeBeforeLogout >= 0 && baseBusinessLogout >= 0 && revokeBeforeLogout < baseBusinessLogout); checks++;
assert.ok(unavailableLogoutResponse >= 0 && baseBusinessLogout >= 0 && unavailableLogoutResponse > baseBusinessLogout); checks++;
const getBranch = service.indexOf('if (request.method === "GET")');
const initialGetProofRead = service.indexOf("const initial = await deps.readProofs(request)");
const readyCheck = service.indexOf("await deps.repository.assertReady()");
const currentGetProofRead = service.indexOf("const current = await deps.readProofs(request)");
assert.ok(getBranch >= 0 && initialGetProofRead >= 0 && getBranch < initialGetProofRead); checks++;
assert.ok(readyCheck >= 0 && currentGetProofRead >= 0 && currentGetProofRead > readyCheck); checks++;
assert.match(linkServer, /const currentSession = await runtime\.read\(request\)/); checks++;
assert.match(env, /^AISTORY_AIUSER_ACCOUNT_LINK_MODE=$/m); checks++;
assert.match(env, /^AISTORY_AIUSER_ACCOUNT_LINK_REVOCATION_MODE=$/m); checks++;
assert.match(runbook, /helper\/内存测试不能替代 SQL 并发/); checks++;
const immutableAssignments = {
  aiuser_account_links: "principal_hash=principal_hash",
  aiuser_account_link_intents: "intent_hash=intent_hash",
  aiuser_account_link_session_revocations: "session_hash=session_hash",
  aiuser_account_link_audit: "intent_hash=intent_hash",
  aiuser_account_link_catalog_manifest: "object_key=object_key",
};
const expectedImmutableCases = Object.entries(immutableAssignments).flatMap(([table, assignment]) => [
  { table, operation: "update", label: `immutable_${table}_update`,
    sql: `update public.${table} set ${assignment}` },
  { table, operation: "delete", label: `immutable_${table}_delete`, sql: `delete from public.${table}` },
  { table, operation: "truncate", label: `immutable_${table}_truncate`, sql: `truncate public.${table} cascade` },
]);
assert.deepEqual(immutableMutationCases, expectedImmutableCases); checks++;
assert.ok(Object.isFrozen(immutableMutationCases) && immutableMutationCases.every(Object.isFrozen)); checks++;
assert.equal(new Set(immutableMutationCases.map((item) => item.label)).size, 15); checks++;
for (const immutableCase of immutableMutationCases) {
  assert.ok(["update", "delete", "truncate"].includes(immutableCase.operation));
  if (immutableCase.operation === "truncate") {
    assert.match(immutableCase.sql, /^truncate public\.aiuser_account_link(?:s|_intents|_session_revocations|_audit|_catalog_manifest) cascade$/);
  } else {
    assert.doesNotMatch(immutableCase.sql, /\btruncate\b/);
  }
  checks += 2;
}
for (const table of Object.keys(immutableAssignments)) {
  assert.match(immutableSnapshotSql, new RegExp(`from public\\.${table} t`)); checks++;
}
assert.equal((immutableSnapshotSql.match(/count\(\*\)/g) ?? []).length, 5); checks++;
assert.equal((immutableSnapshotSql.match(/jsonb_agg\(/g) ?? []).length, 5); checks++;
assert.equal((immutableSnapshotSql.match(/jsonb_build_object\(/g) ?? []).length, 5); checks++;
assert.doesNotMatch(immutableSnapshotSql, /\bmd5\s*\(/); checks++;
assert.ok(pg16.includes('immutable: { sqlStates: ["42501"], message: /^ACCOUNT_LINK_IMMUTABLE$/ }')); checks++;
assert.doesNotMatch(pg16, /truncate public\.\$\{table\}(?! cascade)/); checks++;
const immutableStateBefore = pg16.indexOf('const immutableStateBefore = sql(immutableSnapshotSql, "IMMUTABLE_STATE_BEFORE")');
const immutableLoop = pg16.indexOf("for (const immutableCase of immutableMutationCases)", immutableStateBefore);
const immutableFailure = pg16.indexOf("mustFail(immutableCase.sql, immutableCase.label, expectedSqlFailure.immutable)", immutableLoop);
const immutableStateAfterEach = pg16.indexOf("IMMUTABLE_STATE_AFTER_${immutableCase.table}_${immutableCase.operation}", immutableFailure);
const immutableStateAfterAll = pg16.indexOf('IMMUTABLE_STATE_AFTER_ALL', immutableStateAfterEach);
assert.ok(immutableStateBefore >= 0 && immutableStateBefore < immutableLoop && immutableLoop < immutableFailure
  && immutableFailure < immutableStateAfterEach && immutableStateAfterEach < immutableStateAfterAll); checks++;
for (const marker of ["--pull=never", '"--network", "none"', "listen_addresses=", "waitForAdvisoryWaiter",
  "logout_holds_lock_confirm_waits_then_fails", "confirm_holds_lock_revoke_waits_then_blocks_replay",
  "PASS_AIUSER_ACCOUNT_LINK_POSTGRES16", "singleTransaction: false", "CONCURRENT_LEDGER_STATE",
  "CATALOG_KEY_VALID_BOUNDARIES", "catalog_key_301_suffix", "catalog_key_tab_suffix",
  "catalog_key_newline_suffix", "catalog_key_del_suffix", "catalog_key_nonascii_suffix",
  "CLEANUP_LABEL_RESIDUE", "CLEANUP_NAME_RESIDUE", "CLEANUP_IMAGE_RESIDUE", "CLEANUP_VOLUME_RESIDUE",
  "CLEANUP_ASYNC_CHILD_RESIDUE", "CLEANUP_TRUSTED_CONTAINER_ID", "CLEANUP_EXACT_NAME_FALLBACK",
  "CLEANUP_UNTRUSTED_CREATE_RECONCILE", "CLEANUP_PROTECTED_DOCKER_REQUESTS_SETTLED",
  "CLEANUP_PROTECTED_DOCKER_CHILD_RESIDUE", "CLEANUP_SIGNAL_EVENT_LOOP_BARRIER", "LOCKED_LEDGER_RACE",
  "verboseErrors: true", "AggregateError", 'child.stdout.once("error"', 'child.stderr.once("error"',
  'process.on("SIGINT"', 'process.on("SIGTERM"', '"create", "--pull=never"', '"start", containerId',
  "detached: true", "CLEANUP_UNTRUSTED_CREATE_EXTERNAL_RECONCILIATION_REQUIRED",
  "cleanupVerified", "\\set VERBOSITY verbose", "validateExpectedSqlFailure"]) {
  assert.ok(pg16.includes(marker)); checks++;
}
assert.equal(pg16.split('status: "PASS_AIUSER_ACCOUNT_LINK_POSTGRES16"').length, 2); checks++;
assert.equal((pg16.match(/\bconsole\.log\s*\(/g) ?? []).length, 1); checks++;
for (const forbiddenOutput of [/\bconsole\.(?:debug|error|info|warn)\s*\(/, /process\.stdout\.write\s*\(/,
  /process\.stderr\.write\s*\(/]) {
  assert.doesNotMatch(pg16, forbiddenOutput); checks++;
}
assert.doesNotMatch(pg16, /\["run",\s*"--pull=never"/); checks++;
assert.doesNotMatch(pg16, /stderr:\s*typeof result\?\.stderr/); checks++;
assert.doesNotMatch(pg16, /error\?\.message\?\.slice/); checks++;
const expectedClassifierFailure = { sqlStates: ["P0001"], message: /^expected qualification rejection$/ };
assert.deepEqual(validateExpectedSqlFailure({ status: 3, signal: null,
  stderr: "ERROR:  P0001: expected qualification rejection\n" }, "expected_sql_rejection", expectedClassifierFailure),
{ sqlState: "P0001", message: "expected qualification rejection" }); checks++;
for (const falsePositive of [
  { status: null, signal: null, error: new Error("spawn failure"), stderr: "" },
  { status: null, signal: null, stderr: "ERROR:  P0001: timeout masquerade\n" },
  { status: 3, signal: "SIGTERM", stderr: "ERROR:  P0001: signaled masquerade\n" },
  { status: 3, signal: null, stderr: "transport failure" },
  { status: 0, signal: null, stderr: "ERROR:  P0001: successful-process masquerade\n" },
  { status: 1, signal: null, stderr: "ERROR:  P0001: expected qualification rejection\n" },
  { status: 2, signal: null, stderr: "ERROR:  P0001: expected qualification rejection\n" },
  { status: 125, signal: null, stderr: "ERROR:  P0001: expected qualification rejection\n" },
  { status: 3, signal: null, stderr: "ERROR:  42601: syntax error masquerade\n" },
  { status: 3, signal: null, stderr: "ERROR:  P0001: wrong rejection marker\n" },
  { status: 3, signal: null, stderr: "ERROR:  P0001: NOT_expected qualification rejection\n" },
  { status: 3, signal: null, stderr: "ERROR:  P0001: expected qualification rejection_OTHER\n" },
]) {
  assert.throws(() => validateExpectedSqlFailure(falsePositive, "reject_transport_false_positive",
    expectedClassifierFailure)); checks++;
}
assert.throws(() => validateExpectedSqlFailure({ status: 3, signal: null,
  stderr: "ERROR:  P0001: expected qualification rejection\n" }, "reject_unanchored_sync_marker",
{ sqlStates: ["P0001"], message: /expected qualification rejection/ })); checks++;
const validAsyncSuccess = { status: 0, signal: null, timedOut: false, transportCode: null,
  sqlState: null, error: null, output: "linked" };
validateAsyncSuccess(validAsyncSuccess, "valid_async_success", "linked"); checks++;
for (const falsePositive of [
  { ...validAsyncSuccess, status: null }, { ...validAsyncSuccess, status: 1 },
  { ...validAsyncSuccess, signal: "SIGTERM" }, { ...validAsyncSuccess, timedOut: true },
  { ...validAsyncSuccess, transportCode: "ETIMEDOUT" }, { ...validAsyncSuccess, sqlState: "22023" },
  { ...validAsyncSuccess, error: "ACCOUNT_LINK_REJECTED" }, { ...validAsyncSuccess, output: "wrong" },
]) {
  assert.throws(() => validateAsyncSuccess(falsePositive, "reject_async_success_false_positive", "linked")); checks++;
}
const validAsyncFailure = { status: 3, signal: null, timedOut: false, transportCode: null,
  sqlState: "22023", error: "ACCOUNT_LINK_REJECTED", output: "" };
validateAsyncSqlFailure(validAsyncFailure, "valid_async_sql_failure",
  { sqlStates: ["22023"], message: /^ACCOUNT_LINK_REJECTED$/ }); checks++;
for (const falsePositive of [
  { ...validAsyncFailure, status: null }, { ...validAsyncFailure, status: 0 },
  { ...validAsyncFailure, status: 1 },
  { ...validAsyncFailure, status: 2 }, { ...validAsyncFailure, status: 125 },
  { ...validAsyncFailure, signal: "SIGINT" }, { ...validAsyncFailure, timedOut: true },
  { ...validAsyncFailure, transportCode: "SPAWN_ERROR" }, { ...validAsyncFailure, sqlState: "42601" },
  { ...validAsyncFailure, error: "wrong marker" }, { ...validAsyncFailure, error: "NOT_ACCOUNT_LINK_REJECTED" },
  { ...validAsyncFailure, error: "ACCOUNT_LINK_REJECTED_OTHER" },
]) {
  assert.throws(() => validateAsyncSqlFailure(falsePositive, "reject_async_failure_false_positive",
    { sqlStates: ["22023"], message: /^ACCOUNT_LINK_REJECTED$/ })); checks++;
}
assert.throws(() => validateAsyncSqlFailure(validAsyncFailure, "reject_unanchored_async_marker",
  { sqlStates: ["22023"], message: /ACCOUNT_LINK_REJECTED/ })); checks++;
function fakeAsyncChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => true;
  return child;
}
for (const streamName of ["stdout", "stderr"]) {
  assert.equal(activeAsyncChildCount(), 0);
  const child = fakeAsyncChild();
  const observed = observeAsyncChild(child, { text: "select 1;", timeoutMs: 1000 });
  const streamError = Object.assign(new Error(`${streamName} fixture failure`), { code: "EPIPE" });
  child[streamName].emit("error", streamError); child.emit("close", 1, null);
  const result = await observed;
  assert.equal(result.transportCode, `${streamName.toUpperCase()}_EPIPE`);
  assert.throws(() => validateAsyncSuccess(result, `${streamName}_error_cannot_pass`));
  assert.equal(activeAsyncChildCount(), 0);
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); checks += 4;
}
for (const streamName of ["stdout", "stderr"]) {
  assert.equal(activeAsyncChildCount(), 0);
  const child = fakeAsyncChild();
  const session = observeControlledSessionChild(child, 1000);
  const observed = session.finish("");
  const streamError = Object.assign(new Error(`controlled ${streamName} fixture failure`), { code: "EPIPE" });
  child[streamName].emit("error", streamError); child.emit("close", 1, null);
  const result = await observed;
  assert.equal(result.transportCode, `${streamName.toUpperCase()}_EPIPE`);
  assert.throws(() => validateAsyncSuccess(result, `controlled_${streamName}_error_cannot_pass`));
  assert.equal(activeAsyncChildCount(), 0);
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); checks += 4;
}
for (const streamName of ["stdout", "stderr"]) {
  assert.equal(activeProtectedDockerChildCount(), 0);
  const child = fakeAsyncChild();
  const observed = observeProtectedDockerChild(child);
  const streamError = Object.assign(new Error(`protected ${streamName} fixture failure`), { code: "EPIPE" });
  child[streamName].emit("error", streamError);
  assert.equal(activeProtectedDockerChildCount(), 1);
  child.emit("close", 0, null);
  const result = await observed;
  assert.equal(result.error?.code, `${streamName.toUpperCase()}_EPIPE`);
  assert.throws(() => checked(result, `protected_${streamName}_error_cannot_pass`));
  assert.equal(activeProtectedDockerChildCount(), 0);
  child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); checks += 5;
}
const protectedObserverStart = pg16.indexOf("export function observeProtectedDockerChild");
const protectedRunnerStart = pg16.indexOf("function runProtectedDocker", protectedObserverStart);
const protectedObserverBody = pg16.slice(protectedObserverStart, protectedRunnerStart);
assert.ok(protectedObserverStart >= 0 && protectedRunnerStart > protectedObserverStart); checks++;
assert.equal((protectedObserverBody.match(/resolve\s*\(/g) ?? []).length, 1); checks++;
assert.ok(protectedObserverBody.indexOf('child.once("close"') < protectedObserverBody.indexOf("resolve({")); checks++;
assert.doesNotMatch(protectedObserverBody, /setTimeout|\.kill\s*\(/); checks++;
const protectedRunnerEnd = pg16.indexOf("export function validateExpectedSqlFailure", protectedRunnerStart);
const protectedRunnerBody = pg16.slice(protectedRunnerStart, protectedRunnerEnd);
assert.match(protectedRunnerBody, /detached: true/); checks++;
assert.doesNotMatch(protectedRunnerBody, /setTimeout|\.kill\s*\(/); checks++;
const terminationStart = pg16.indexOf("const requestTermination = (signal)");
const terminationEnd = pg16.indexOf("const onSigint", terminationStart);
const terminationBody = pg16.slice(terminationStart, terminationEnd);
assert.match(terminationBody, /activeAsyncChildren/); checks++;
assert.doesNotMatch(terminationBody, /activeProtectedDockerChildren/); checks++;
const signalHandler = pg16.indexOf('process.on("SIGINT", onSigint)');
const createAttempt = pg16.indexOf("createAttempted = true", signalHandler);
const protectedCreate = pg16.indexOf('await runProtectedDocker(["create"', createAttempt);
const createClosed = pg16.indexOf("createRequestClosed = true", protectedCreate);
const trustedCreateId = pg16.indexOf('containerId = checked(createResult, "CREATE")', createClosed);
const inspectCreated = pg16.indexOf("running: false", trustedCreateId);
const startAttempt = pg16.indexOf("containerStartAttempted = true", inspectCreated);
const protectedStart = pg16.indexOf('await runProtectedDocker(["start", containerId])', startAttempt);
const startClosed = pg16.indexOf("startRequestClosed = true", protectedStart);
const trustedStart = pg16.indexOf('checked(startResult, "START")', startClosed);
const inspectStarted = pg16.indexOf("running: true", trustedStart);
const successSettle = pg16.indexOf("await settleAsyncChildren();");
const passPayload = pg16.indexOf("passPayload = {", successSettle);
const finallyBlock = pg16.indexOf("} finally {", passPayload);
const protectedRequestsSettled = pg16.indexOf('captureCleanup("CLEANUP_PROTECTED_DOCKER_REQUESTS_SETTLED"', finallyBlock);
const trustedIdCleanup = pg16.indexOf('captureCleanup("CLEANUP_TRUSTED_CONTAINER_ID"', finallyBlock);
const nameFallbackCleanup = pg16.indexOf('captureCleanup("CLEANUP_EXACT_NAME_FALLBACK"', trustedIdCleanup);
const untrustedCreateReconcile = pg16.indexOf('captureCleanup("CLEANUP_UNTRUSTED_CREATE_RECONCILE"', nameFallbackCleanup);
const residueCleanup = pg16.indexOf('captureCleanup("CLEANUP_CONTAINER_RESIDUE"', untrustedCreateReconcile);
const protectedChildResidue = pg16.indexOf('captureCleanup("CLEANUP_PROTECTED_DOCKER_CHILD_RESIDUE"', residueCleanup);
const signalBarrier = pg16.indexOf('captureCleanup("CLEANUP_SIGNAL_EVENT_LOOP_BARRIER"', residueCleanup);
const signalRecheck = pg16.indexOf("if (requestedSignal && !qualificationError)", signalBarrier);
const signalHandlersRemoved = pg16.indexOf('process.off("SIGINT", onSigint)', signalRecheck);
const cleanupVerifiedAssignment = pg16.indexOf("cleanupVerified = cleanupErrors.length === 0", signalHandlersRemoved);
const combinedFailureGate = pg16.indexOf("if (qualificationError && cleanupErrors.length > 0)", cleanupVerifiedAssignment);
const qualificationFailureGate = pg16.indexOf("if (qualificationError) throw qualificationError", combinedFailureGate);
const cleanupFailureGate = pg16.indexOf("if (cleanupErrors.length > 0) throw new AggregateError", qualificationFailureGate);
const finallyCloseAndPassGuard = pg16.indexOf("\n  }\n  assert.ok(passPayload, \"PG16_PASS_PAYLOAD_MISSING\")", cleanupFailureGate);
const finalPass = pg16.indexOf("console.log(JSON.stringify({ ...passPayload", finallyCloseAndPassGuard);
const orderedExecutionMarkers = [signalHandler, createAttempt, protectedCreate, createClosed, trustedCreateId,
  inspectCreated, startAttempt, protectedStart, startClosed, trustedStart, inspectStarted, successSettle, passPayload,
  finallyBlock, protectedRequestsSettled, trustedIdCleanup, nameFallbackCleanup, untrustedCreateReconcile,
  residueCleanup, protectedChildResidue, signalBarrier, signalRecheck, signalHandlersRemoved,
  cleanupVerifiedAssignment, combinedFailureGate, qualificationFailureGate, cleanupFailureGate,
  finallyCloseAndPassGuard, finalPass];
for (const marker of orderedExecutionMarkers) { assert.ok(marker >= 0); checks++; }
assert.ok(signalHandler < createAttempt && createAttempt < protectedCreate && protectedCreate < createClosed
  && createClosed < trustedCreateId && trustedCreateId < inspectCreated && inspectCreated < startAttempt
  && startAttempt < protectedStart && protectedStart < startClosed && startClosed < trustedStart
  && trustedStart < inspectStarted && inspectStarted < successSettle && successSettle < passPayload
  && passPayload < finallyBlock && finallyBlock < protectedRequestsSettled
  && protectedRequestsSettled < trustedIdCleanup && trustedIdCleanup < nameFallbackCleanup
  && nameFallbackCleanup < untrustedCreateReconcile && untrustedCreateReconcile < residueCleanup
  && residueCleanup < protectedChildResidue && protectedChildResidue < signalBarrier && signalBarrier < signalRecheck
  && signalRecheck < signalHandlersRemoved && signalHandlersRemoved < cleanupVerifiedAssignment
  && cleanupVerifiedAssignment < combinedFailureGate && combinedFailureGate < qualificationFailureGate
  && qualificationFailureGate < cleanupFailureGate && cleanupFailureGate < finallyCloseAndPassGuard
  && finallyCloseAndPassGuard < finalPass); checks++;
const untrustedCreateReconcileEnd = pg16.indexOf('captureCleanup("CLEANUP_ASYNC_CHILD_SETTLE_AFTER_CONTAINER"',
  untrustedCreateReconcile);
const untrustedCreateReconcileBody = pg16.slice(untrustedCreateReconcile, untrustedCreateReconcileEnd);
assert.match(untrustedCreateReconcileBody, /CLEANUP_UNTRUSTED_CREATE_EXTERNAL_RECONCILIATION_REQUIRED/); checks++;
assert.doesNotMatch(untrustedCreateReconcileBody, /emptyObservations[^\n]*return/); checks++;
assert.doesNotMatch(pg16, /stableWindowMs|CLEANUP_AMBIGUOUS_START/); checks++;

console.log(JSON.stringify({ status: "PASS_AIUSER_ACCOUNT_LINK_STATIC_CONTRACT", checks, migrationSha256: migrationHash,
  externalNetwork: 0, credentialsRead: false, databaseExecuted: false, deployment: false }));
