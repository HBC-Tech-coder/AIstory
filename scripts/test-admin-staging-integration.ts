import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import { PRODUCTION_IDENTITY_DB_GATE_VERSION } from "@/lib/production/databaseGate";

const enabled = process.env.AISTORY_STAGING_INTEGRATION_ENABLED === "true";
if (!enabled) {
  console.log("admin staging integration skipped (zero-network default)");
  process.exit(0);
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required staging setting: ${name}`);
  return value;
}

function uuid(value: string, name: string): string {
  assert.match(
    value,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    `${name} must be a UUID`,
  );
  return value;
}

const stagingUrl = new URL(required("AISTORY_STAGING_SUPABASE_URL"));
assert.ok(
  stagingUrl.protocol === "http:" || stagingUrl.protocol === "https:",
  "staging URL must use HTTP(S)",
);
assert.ok(
  ["127.0.0.1", "localhost", "[::1]", "::1"].includes(stagingUrl.hostname),
  "staging integration requires an SSH tunnel or loopback endpoint",
);
assert.equal(stagingUrl.username, "");
assert.equal(stagingUrl.password, "");
assert.equal(stagingUrl.search, "");
assert.equal(stagingUrl.hash, "");

const serviceRoleKey = required("AISTORY_STAGING_SUPABASE_SERVICE_ROLE_KEY");
const actorId = uuid(
  required("AISTORY_STAGING_ADMIN_ACTOR_ID"),
  "AISTORY_STAGING_ADMIN_ACTOR_ID",
);
const tenantId = process.env.AISTORY_STAGING_TENANT_ID?.trim() || "platform";
assert.match(tenantId, /^[A-Za-z0-9._:-]{1,80}$/);

const guardedFetch: typeof fetch = async (input, init) => fetch(input, {
  ...init,
  redirect: "error",
  signal: AbortSignal.timeout(15_000),
});
const client = createClient(stagingUrl.toString(), serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
  global: { fetch: guardedFetch },
});

async function rpc(name: string, args?: Record<string, unknown>) {
  const result = await client.rpc(name, args);
  if (result.error) throw new Error(`${name} failed`);
  return result.data;
}

function hostedFingerprint(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function syntheticEnvelope(seed: number, kekVersion: string) {
  return {
    envelope_version: 1,
    masked_label: "synthetic staging credential",
    ciphertext: Buffer.alloc(48, seed).toString("base64"),
    nonce: Buffer.alloc(12, seed + 1).toString("base64"),
    tag: Buffer.alloc(16, seed + 2).toString("base64"),
    wrapped_dek: Buffer.alloc(48, seed + 3).toString("base64"),
    wrap_nonce: Buffer.alloc(12, seed + 4).toString("base64"),
    wrap_tag: Buffer.alloc(16, seed + 5).toString("base64"),
    kek_version: kekVersion,
  };
}

assert.equal(
  await rpc("aistory_database_gate_status"),
  PRODUCTION_IDENTITY_DB_GATE_VERSION,
);
assert.equal(await rpc("aistory_database_security_posture"), true);
assert.equal(await rpc("aistory_admin_rpc_security_posture"), true);
assert.equal(await rpc("aistory_phone_admin_security_posture"), true);
assert.equal(await rpc("aistory_hosted_byok_security_posture"), true);
assert.equal(await rpc("aistory_video_asset_security_posture"), true);

const actor = await rpc("aistory_admin_resolve_actor", {
  actor_user_id: actorId,
  actor_tenant: tenantId,
});
assert.ok(actor && typeof actor === "object", "staging admin actor unavailable");
const actorProjection = actor as Record<string, unknown>;
assert.equal(actorProjection.user_id, actorId);
assert.equal(actorProjection.tenant_id, tenantId);
assert.ok(Array.isArray(actorProjection.roles) && actorProjection.roles.length > 0);

const snapshot = await rpc("aistory_admin_read_snapshot", {
  actor_user_id: actorId,
  actor_tenant: tenantId,
});
assert.ok(snapshot && typeof snapshot === "object");
const projection = snapshot as Record<string, unknown>;
for (
  const dataset of [
    "users",
    "roles",
    "accounts",
    "ledger",
    "events",
    "settings",
    "payment_configs",
    "provider_configs",
    "domains",
    "channel_apps",
    "audit",
    "billing_policies",
  ]
) {
  assert.ok(Array.isArray(projection[dataset]), `${dataset} is not an array`);
}

let mutationReplayVerified = false;
if (process.env.AISTORY_STAGING_MUTATION_TEST_ENABLED === "true") {
  const targetUserId = uuid(
    required("AISTORY_STAGING_TEST_USER_ID"),
    "AISTORY_STAGING_TEST_USER_ID",
  );
  const runId = required("AISTORY_STAGING_TEST_RUN_ID");
  assert.match(runId, /^[A-Za-z0-9._-]{8,80}$/);
  const adjustment = {
    actor_id: actorId,
    tenant_id: tenantId,
    user_id: targetUserId,
    amount: 1,
    reason: "staging admin RPC idempotency test",
    idempotency_key: `staging_admin_grant:${runId}`,
    request_id: `staging_admin_grant:${runId}`,
  };
  const first = await rpc("aistory_admin_adjust_credits", { adjustment });
  const replay = await rpc("aistory_admin_adjust_credits", { adjustment });
  assert.deepEqual(replay, first, "credit adjustment replay changed result");
  assert.equal((replay as Record<string, unknown>).replayed, true);
  mutationReplayVerified = true;
}

let hostedByokRpcVerified = false;
if (process.env.AISTORY_STAGING_HOSTED_BYOK_TEST_ENABLED === "true") {
  const hostedActorId = uuid(
    required("AISTORY_STAGING_HOSTED_BYOK_ACTOR_ID"),
    "AISTORY_STAGING_HOSTED_BYOK_ACTOR_ID",
  );
  const credentialId = uuid(
    required("AISTORY_STAGING_HOSTED_BYOK_CREDENTIAL_ID"),
    "AISTORY_STAGING_HOSTED_BYOK_CREDENTIAL_ID",
  );
  const runId = required("AISTORY_STAGING_HOSTED_BYOK_TEST_RUN_ID");
  assert.match(runId, /^[A-Za-z0-9._-]{8,80}$/);

  function hostedMutation(
    action: "create" | "replace" | "rotate" | "delete",
    semantic: Record<string, unknown>,
  ) {
    return {
      actor_user_id: hostedActorId,
      tenant_id: tenantId,
      credential_id: credentialId,
      action,
      reason: `synthetic staging hosted ${action} contract test`,
      idempotency_key: `staging_hosted_${action}:${runId}`,
      mutation_fingerprint: hostedFingerprint({ action, ...semantic }),
      ...semantic,
    };
  }

  const createMutation = hostedMutation("create", {
    provider: "openai_compatible",
    capabilities: ["text"],
    default_for: ["text"],
    ...syntheticEnvelope(11, "synthetic-v1"),
  });
  const created = await rpc("aistory_hosted_byok_apply_mutation", {
    mutation: createMutation,
  }) as Record<string, unknown>;
  const createReplay = await rpc("aistory_hosted_byok_apply_mutation", {
    mutation: createMutation,
  }) as Record<string, unknown>;
  assert.equal(typeof created.replayed, "boolean");
  assert.equal(createReplay.replayed, true);
  assert.deepEqual(createReplay.credential, created.credential);

  const conflict = await client.rpc("aistory_hosted_byok_apply_mutation", {
    mutation: {
      ...createMutation,
      mutation_fingerprint: hostedFingerprint({
        action: "create",
        semanticConflict: true,
      }),
    },
  });
  assert.ok(conflict.error, "hosted mutation semantic conflict was accepted");

  const replaceMutation = hostedMutation("replace", {
    provider: "openai_compatible",
    capabilities: ["text", "vision"],
    default_for: ["text"],
    ...syntheticEnvelope(21, "synthetic-v1"),
  });
  await rpc("aistory_hosted_byok_apply_mutation", {
    mutation: replaceMutation,
  });
  const replaceReplay = await rpc("aistory_hosted_byok_apply_mutation", {
    mutation: replaceMutation,
  }) as Record<string, unknown>;
  assert.equal(replaceReplay.replayed, true);

  const rotateMutation = hostedMutation("rotate", {
    provider: "openai_compatible",
    capabilities: ["text", "vision"],
    default_for: ["text"],
    ...syntheticEnvelope(31, "synthetic-v2"),
  });
  await rpc("aistory_hosted_byok_apply_mutation", {
    mutation: rotateMutation,
  });
  const rotateReplay = await rpc("aistory_hosted_byok_apply_mutation", {
    mutation: rotateMutation,
  }) as Record<string, unknown>;
  assert.equal(rotateReplay.replayed, true);

  const listed = await rpc("aistory_hosted_byok_list", {
    owner_user_id: hostedActorId,
    owner_tenant: tenantId,
  });
  assert.ok(Array.isArray(listed) && listed.length === 1);
  const encrypted = await rpc("aistory_hosted_byok_read_encrypted", {
    owner_user_id: hostedActorId,
    owner_tenant: tenantId,
    credential_id: credentialId,
    requested_capability: "text",
  });
  assert.ok(encrypted && typeof encrypted === "object");
  assert.equal(await rpc("aistory_hosted_byok_mark_used", {
    owner_user_id: hostedActorId,
    owner_tenant: tenantId,
    credential_id: credentialId,
    requested_capability: "text",
  }), true);

  const crossTenant = await client.rpc("aistory_hosted_byok_list", {
    owner_user_id: hostedActorId,
    owner_tenant: "staging-cross-tenant",
  });
  assert.ok(crossTenant.error, "cross-tenant hosted list was accepted");

  const deleteMutation = hostedMutation("delete", {});
  await rpc("aistory_hosted_byok_apply_mutation", {
    mutation: deleteMutation,
  });
  const deleteReplay = await rpc("aistory_hosted_byok_apply_mutation", {
    mutation: deleteMutation,
  }) as Record<string, unknown>;
  assert.equal(deleteReplay.replayed, true);
  assert.equal(await rpc("aistory_hosted_byok_read_encrypted", {
    owner_user_id: hostedActorId,
    owner_tenant: tenantId,
    credential_id: credentialId,
    requested_capability: "text",
  }), null);
  hostedByokRpcVerified = true;
}

console.log(JSON.stringify({
  gateReady: true,
  securityPosture: true,
  adminActorResolved: true,
  snapshotDatasets: Object.keys(projection).length,
  mutationReplayVerified,
  hostedByokRpcVerified,
}));
