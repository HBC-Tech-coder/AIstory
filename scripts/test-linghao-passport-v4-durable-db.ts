import assert from "node:assert/strict";
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migration = readFileSync(
  path.join(
    root,
    "supabase",
    "migrations",
    "20261119120000_linghao_passport_v4_auth_state_gate.sql",
  ),
  "utf8",
);
const container = `aistory-passport-v4-pg16-${randomBytes(6).toString("hex")}`;

function docker(
  args: readonly string[],
  input?: string,
  accepted = [0],
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("docker", [...args], {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: 16 * 1024 * 1024,
  });
  const status = result.status ?? -1;
  if (!accepted.includes(status)) {
    throw new Error(
      `docker ${args[0] ?? ""} failed (${status}): ${result.stderr || result.stdout}`,
    );
  }
  return { status, stdout: result.stdout, stderr: result.stderr };
}

function psql(sql: string, accepted = [0]) {
  return docker(
    [
      "exec",
      "-i",
      container,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
      "-U",
      "postgres",
      "-d",
      "postgres",
    ],
    sql,
    accepted,
  );
}

async function waitForDatabaseReady(): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = psql("select 1;", [0, 1, 2]);
    if (probe.status === 0 && probe.stdout.trim() === "1") return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.fail("PostgreSQL 16 did not become SQL-ready");
}

function psqlAsync(sql: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      [
        "exec",
        "-i",
        container,
        "psql",
        "-v",
        "ON_ERROR_STOP=1",
        "-At",
        "-U",
        "postgres",
        "-d",
        "postgres",
      ],
      { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status: status ?? -1, stdout, stderr }));
    child.stdin.end(sql);
  });
}

function hash(label: string): string {
  return createHash("sha256")
    .update(`aistory-passport-v4-db-test\0${label}`)
    .digest("hex");
}

function envelope(label: string): string {
  const body = Buffer.from(label.repeat(4), "utf8").toString("base64url");
  return `v1.${Buffer.alloc(12, label.charCodeAt(0)).toString("base64url")}.${body}.${Buffer.alloc(16, label.charCodeAt(0) + 1).toString("base64url")}`;
}

function operation(name: string, payload: Record<string, unknown>): string {
  return [
    "set request.jwt.claim.role='service_role';",
    `select public.aistory_linghao_passport_v4_${name}('${JSON.stringify(payload).replaceAll("'", "''")}'::jsonb);`,
  ].join("\n");
}

function resultJson(output: string): Record<string, unknown> {
  const line = output
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.trim().startsWith("{"));
  assert.ok(line, `missing JSON result: ${output}`);
  return JSON.parse(line) as Record<string, unknown>;
}

let started = false;
try {
  docker([
    "run",
    "--rm",
    "-d",
    "--name",
    container,
    "-e",
    "POSTGRES_HOST_AUTH_METHOD=trust",
    "postgres:16",
  ]);
  started = true;
  await waitForDatabaseReady();
  psql(
    "create role anon nologin; create role authenticated nologin; create role service_role nologin;",
  );
  psql(migration);

  assert.equal(
    psql(
      "set request.jwt.claim.role='service_role'; select public.aistory_linghao_passport_v4_auth_posture();",
    ).stdout.trim(),
    "SET\n20261119120000",
  );
  const denied = psql(
    "set role service_role; select count(*) from public.linghao_passport_v4_sessions;",
    [0, 1, 2, 3],
  );
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /permission denied|row-level security/i);

  const family = hash("family");
  const transaction = hash("transaction");
  const state = hash("state");
  const session = hash("session");
  const refresh = hash("refresh");
  const principal = hash("principal");
  const reserve = resultJson(
    psql(
      operation("reserve_start", {
        familyHash: family,
        transactionHash: transaction,
        stateHash: state,
        nonceHash: hash("nonce"),
        rateBucketHash: hash("bucket"),
        verifierEnvelope: envelope("a"),
      }),
    ).stdout,
  );
  assert.equal(reserve.status, "reserved");
  assert.equal(
    resultJson(
      psql(
        operation("consume_callback", {
          transactionHash: transaction,
          stateHash: state,
        }),
      ).stdout,
    ).status,
    "accepted",
  );
  const providerExpiresAtMs = Date.now() + 30 * 60 * 1000;
  const commitPayload = {
    transactionHash: transaction,
    familyHash: family,
    principalKey: principal,
    sessionHash: session,
    completionHash: hash("callback-completion"),
    sessionResultEnvelope: envelope("b"),
    accessTokenFingerprint: hash("access-token"),
    accessTokenEnvelope: envelope("o"),
    idTokenHintEnvelope: envelope("c"),
    refreshFingerprint: refresh,
    refreshEnvelope: envelope("d"),
    providerExpiresAtMs,
  };
  assert.equal(
    resultJson(psql(operation("commit_callback", commitPayload)).stdout).status,
    "committed",
  );
  assert.equal(
    resultJson(psql(operation("commit_callback", commitPayload)).stdout).status,
    "replayed",
  );
  assert.equal(
    resultJson(
      psql(
        operation("consume_callback", {
          transactionHash: transaction,
          stateHash: state,
        }),
      ).stdout,
    ).status,
    "completed",
  );
  const initialAccessWork = resultJson(
    psql(
      operation("claim_revocation", {
        outboxClaimHash: hash("initial-access-worker"),
      }),
    ).stdout,
  );
  assert.equal(initialAccessWork.tokenKind, "access_token");
  assert.equal(
    psql(
      operation("complete_revocation", {
        outboxHash: initialAccessWork.outboxHash,
        confirmed: true,
      }),
    ).stdout.trim(),
    "SET\nt",
  );

  docker(["restart", container]);
  await waitForDatabaseReady();
  assert.equal(
    resultJson(psql(operation("read_session", { sessionHash: session })).stdout)
      .status,
    "authenticated",
  );

  const refreshClaims = await Promise.all([
    psqlAsync(
      operation("begin_refresh", {
        sessionHash: session,
        attemptHash: hash("refresh-attempt-1"),
      }),
    ),
    psqlAsync(
      operation("begin_refresh", {
        sessionHash: session,
        attemptHash: hash("refresh-attempt-2"),
      }),
    ),
  ]);
  assert.deepEqual(
    refreshClaims
      .map((claim) => resultJson(claim.stdout).status)
      .sort(),
    ["claimed", "rejected"],
  );
  const winner = refreshClaims[0]!.stdout.includes('"claimed"')
    ? hash("refresh-attempt-1")
    : hash("refresh-attempt-2");

  const receipt = hash("logout-receipt");
  const logoutState = hash("logout-state");
  const [refreshCommit, logout] = await Promise.all([
    psqlAsync(
      operation("commit_refresh", {
        attemptHash: winner,
        completionHash: hash("refresh-completion"),
        replacementFingerprint: hash("replacement-refresh"),
        replacementEnvelope: envelope("e"),
        accessTokenFingerprint: hash("refresh-access-token"),
        accessTokenEnvelope: envelope("q"),
        idTokenHintEnvelope: envelope("f"),
        providerExpiresAtMs: Date.now() + 30 * 60 * 1000,
      }),
    ),
    psqlAsync(
      operation("begin_logout", {
        familyHash: family,
        sessionHash: session,
        receiptHash: receipt,
        stateHash: logoutState,
        upstreamReturnExpected: true,
      }),
    ),
  ]);
  assert.ok(
    ["committed", "cleanup_required"].includes(
      String(resultJson(refreshCommit.stdout).status),
    ),
  );
  assert.equal(resultJson(logout.stdout).status, "revoked");
  assert.equal(
    psql(
      `select status || ':' || (current_session_hash is null)::text from public.linghao_passport_v4_browser_families where family_hash='${family}';`,
    ).stdout.trim(),
    "revoked:true",
  );
  assert.equal(
    psql(
      `select count(*) from public.linghao_passport_v4_sessions where family_hash='${family}' and status in ('active','refreshing');`,
    ).stdout.trim(),
    "0",
  );

  let revocationClaims = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const claim = resultJson(
      psql(
        operation("claim_revocation", {
          outboxClaimHash: hash(`worker-${attempt}`),
        }),
      ).stdout,
    );
    if (claim.status === "empty") break;
    revocationClaims += 1;
    assert.equal(claim.status, "claimed");
    assert.equal(
      psql(
        operation("complete_revocation", {
          outboxHash: claim.outboxHash,
          confirmed: true,
        }),
      ).stdout.trim(),
      "SET\nt",
    );
  }
  assert.ok(revocationClaims >= 1);
  const logoutResult = resultJson(
    psql(
      operation("consume_logout_result", {
        receiptHash: receipt,
        stateHash: logoutState,
        upstreamReturnConfirmed: true,
      }),
    ).stdout,
  );
  assert.deepEqual(logoutResult, {
    status: "consumed",
    localLoggedOut: true,
    revocationConfirmed: true,
    upstreamReturnConfirmed: true,
  });
  assert.equal(
    resultJson(
      psql(
        operation("consume_logout_result", {
          receiptHash: receipt,
          stateHash: logoutState,
          upstreamReturnConfirmed: true,
        }),
      ).stdout,
    ).status,
    "invalid",
  );

  const wrongFamily = hash("wrong-state-family");
  const wrongTransaction = hash("wrong-state-transaction");
  const correctState = hash("correct-state");
  resultJson(
    psql(
      operation("reserve_start", {
        familyHash: wrongFamily,
        transactionHash: wrongTransaction,
        stateHash: correctState,
        nonceHash: hash("wrong-state-nonce"),
        rateBucketHash: hash("wrong-state-bucket"),
        verifierEnvelope: envelope("g"),
      }),
    ).stdout,
  );
  assert.equal(
    resultJson(
      psql(
        operation("consume_callback", {
          transactionHash: wrongTransaction,
          stateHash: hash("incorrect-state"),
        }),
      ).stdout,
    ).reason,
    "state_mismatch",
  );
  assert.equal(
    resultJson(
      psql(
        operation("consume_callback", {
          transactionHash: wrongTransaction,
          stateHash: correctState,
        }),
      ).stdout,
    ).reason,
    "terminal",
  );

  const logoutFirstFamily = hash("logout-first-family");
  const logoutFirstTransaction = hash("logout-first-transaction");
  const logoutFirstState = hash("logout-first-state");
  const logoutFirstSession = hash("logout-first-session");
  const logoutFirstRefresh = hash("logout-first-refresh");
  const logoutFirstAttempt = hash("logout-first-attempt");
  assert.equal(
    resultJson(
      psql(
        operation("reserve_start", {
          familyHash: logoutFirstFamily,
          transactionHash: logoutFirstTransaction,
          stateHash: logoutFirstState,
          nonceHash: hash("logout-first-nonce"),
          rateBucketHash: hash("logout-first-bucket"),
          verifierEnvelope: envelope("i"),
        }),
      ).stdout,
    ).status,
    "reserved",
  );
  assert.equal(
    resultJson(
      psql(
        operation("consume_callback", {
          transactionHash: logoutFirstTransaction,
          stateHash: logoutFirstState,
        }),
      ).stdout,
    ).status,
    "accepted",
  );
  assert.equal(
    resultJson(
      psql(
        operation("commit_callback", {
          transactionHash: logoutFirstTransaction,
          familyHash: logoutFirstFamily,
          principalKey: hash("logout-first-principal"),
          sessionHash: logoutFirstSession,
          completionHash: hash("logout-first-callback-completion"),
          sessionResultEnvelope: envelope("j"),
          accessTokenFingerprint: hash("logout-first-access"),
          accessTokenEnvelope: envelope("p"),
          idTokenHintEnvelope: envelope("k"),
          refreshFingerprint: logoutFirstRefresh,
          refreshEnvelope: envelope("l"),
          providerExpiresAtMs: Date.now() + 30 * 60 * 1000,
        }),
      ).stdout,
    ).status,
    "committed",
  );
  const logoutFirstAccessWork = resultJson(
    psql(
      operation("claim_revocation", {
        outboxClaimHash: hash("logout-first-access-worker"),
      }),
    ).stdout,
  );
  assert.equal(logoutFirstAccessWork.tokenKind, "access_token");
  assert.equal(
    psql(
      operation("complete_revocation", {
        outboxHash: logoutFirstAccessWork.outboxHash,
        confirmed: true,
      }),
    ).stdout.trim(),
    "SET\nt",
  );
  assert.equal(
    resultJson(
      psql(
        operation("begin_refresh", {
          sessionHash: logoutFirstSession,
          attemptHash: logoutFirstAttempt,
        }),
      ).stdout,
    ).status,
    "claimed",
  );
  const logoutFirstReceipt = hash("logout-first-receipt");
  const logoutFirstLogoutState = hash("logout-first-logout-state");
  assert.equal(
    resultJson(
      psql(
        operation("begin_logout", {
          familyHash: logoutFirstFamily,
          sessionHash: logoutFirstSession,
          receiptHash: logoutFirstReceipt,
          stateHash: logoutFirstLogoutState,
          upstreamReturnExpected: true,
        }),
      ).stdout,
    ).status,
    "revoked",
  );
  assert.equal(
    resultJson(
      psql(
        operation("commit_refresh", {
          attemptHash: logoutFirstAttempt,
          completionHash: hash("logout-first-refresh-completion"),
          replacementFingerprint: hash("logout-first-replacement"),
          replacementEnvelope: envelope("m"),
          accessTokenFingerprint: hash("logout-first-refresh-access"),
          accessTokenEnvelope: envelope("r"),
          idTokenHintEnvelope: envelope("n"),
          providerExpiresAtMs: Date.now() + 30 * 60 * 1000,
        }),
      ).stdout,
    ).status,
    "cleanup_required",
  );
  let logoutFirstClaims = 0;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const claim = resultJson(
      psql(
        operation("claim_revocation", {
          outboxClaimHash: hash(`logout-first-worker-${attempt}`),
        }),
      ).stdout,
    );
    if (claim.status === "empty") break;
    logoutFirstClaims += 1;
    assert.equal(
      psql(
        operation("complete_revocation", {
          outboxHash: claim.outboxHash,
          confirmed: true,
        }),
      ).stdout.trim(),
      "SET\nt",
    );
  }
  assert.equal(logoutFirstClaims, 3);
  assert.deepEqual(
    resultJson(
      psql(
        operation("consume_logout_result", {
          receiptHash: logoutFirstReceipt,
          stateHash: logoutFirstLogoutState,
          upstreamReturnConfirmed: true,
        }),
      ).stdout,
    ),
    {
      status: "consumed",
      localLoggedOut: true,
      revocationConfirmed: true,
      upstreamReturnConfirmed: true,
    },
  );

  const rateStatuses: unknown[] = [];
  for (let index = 0; index < 11; index += 1) {
    rateStatuses.push(
      resultJson(
        psql(
          operation("reserve_start", {
            familyHash: hash(`rate-family-${index}`),
            transactionHash: hash(`rate-transaction-${index}`),
            stateHash: hash(`rate-state-${index}`),
            nonceHash: hash(`rate-nonce-${index}`),
            rateBucketHash: hash("shared-rate-bucket"),
            verifierEnvelope: envelope("h"),
          }),
        ).stdout,
      ).status,
    );
  }
  assert.equal(rateStatuses.filter((status) => status === "reserved").length, 10);
  assert.equal(
    rateStatuses.filter((status) => status === "rate_limited").length,
    1,
  );
  assert.ok(
    Number(
      psql("select count(*) from public.linghao_passport_v4_auth_audit;")
        .stdout,
    ) >= 10,
  );

  console.log("PASS_LINGHAO_PASSPORT_V4_DURABLE_DB_PG16");
  console.log(
    JSON.stringify({
      postgres: "16",
      restartPersistence: true,
      concurrentRefreshClaims: 2,
      refreshClaimsAccepted: 1,
      refreshLogoutRace: "linearized",
      logoutFirstRefreshCleanup: true,
      revocationClaims,
      logoutFirstClaims,
      logoutReplayRejected: true,
      directTableAccessDenied: true,
      rateAllowed: 10,
      rateDenied: 1,
      productionEnabled: false,
    }),
  );
} finally {
  if (started) {
    docker(["stop", container], undefined, [0, 1]);
  }
}
