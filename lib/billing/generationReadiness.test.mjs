import test from "node:test";
import assert from "node:assert/strict";

import {
  GENERATION_READINESS_SCOPE,
  generationReadinessMessage,
  isGenerationReadinessReason,
  isPlatformBillingEnabledValue,
  normalizeEstimatedCredits,
  readyGenerationReadiness,
  resolveGenerationReadiness,
  toPublicGenerationReadiness,
  unavailableGenerationReadiness,
} from "./generationReadiness.ts";

function makeDeps(overrides = {}, calls = []) {
  return {
    isBillingEnabled: () => {
      calls.push("billing");
      return true;
    },
    authenticate: async () => {
      calls.push("auth");
      return { kind: "phone", userId: "user-1" };
    },
    assertDatabaseGateReady: () => {
      calls.push("gate");
    },
    loadRuntimeConfig: () => {
      calls.push("config");
      return { text: { model: "runtime-model" } };
    },
    loadUser: async () => {
      calls.push("user");
      return { status: "active" };
    },
    quote: async () => {
      calls.push("quote");
      return { estimatedCredits: 250 };
    },
    ...overrides,
  };
}

function allowlistKeys(value) {
  return Object.keys(value).sort();
}

const UNAVAILABLE_REASONS = [
  "billing_disabled",
  "phone_verification_required",
  "database_gate_unavailable",
  "runtime_config_unavailable",
  "account_inactive",
  "pricing_unavailable",
  "service_unavailable",
];

test("billing switch requires the exact string true", () => {
  assert.equal(isPlatformBillingEnabledValue("true"), true);
  for (const value of [
    "TRUE",
    "True",
    "1",
    " true",
    "true ",
    "",
    undefined,
    null,
    true,
    1,
  ]) {
    assert.equal(isPlatformBillingEnabledValue(value), false, String(value));
  }
});

test("billing disabled short-circuits before auth, config, or DB", async () => {
  const calls = [];
  const result = await resolveGenerationReadiness(
    makeDeps(
      {
        isBillingEnabled: () => {
          calls.push("billing");
          return false;
        },
      },
      calls,
    ),
  );

  assert.equal(result.available, false);
  assert.equal(result.reason, "billing_disabled");
  assert.equal(result.scope, GENERATION_READINESS_SCOPE);
  assert.equal("estimatedCredits" in result, false);
  assert.deepEqual(calls, ["billing"]);
  assert.match(result.message, /暂未开启/);
  assert.match(result.message, /积分仍会保留/);
  assert.match(result.message, /已发布的故事仍可继续游玩/);
});

test("billing switch failure becomes a safe unavailable projection", async () => {
  const result = await resolveGenerationReadiness(
    makeDeps({
      isBillingEnabled: () => {
        throw new Error("secret env value");
      },
    }),
  );

  assert.equal(result.available, false);
  assert.equal(result.reason, "service_unavailable");
  assert.doesNotMatch(result.message, /secret env value/);
});

test("non-phone identity is unavailable with no AIUser fallback", async () => {
  const calls = [];
  const result = await resolveGenerationReadiness(
    makeDeps(
      {
        authenticate: async () => {
          calls.push("auth");
          return null;
        },
      },
      calls,
    ),
  );

  assert.equal(result.reason, "phone_verification_required");
  assert.deepEqual(calls, ["billing", "auth"]);
});

test("an AIUser-shaped identity is still rejected as non-phone", async () => {
  const result = await resolveGenerationReadiness(
    makeDeps({
      authenticate: async () => ({ kind: "aiuser", userId: "ai-user" }),
    }),
  );

  assert.equal(result.reason, "phone_verification_required");
});

test("anonymous identity is rejected as non-phone", async () => {
  const result = await resolveGenerationReadiness(
    makeDeps({
      authenticate: async () => ({ kind: "phone", userId: "anonymous" }),
    }),
  );

  assert.equal(result.reason, "phone_verification_required");
});

test("database gate failure stops before config, account, or quote", async () => {
  const calls = [];
  const result = await resolveGenerationReadiness(
    makeDeps(
      {
        assertDatabaseGateReady: () => {
          calls.push("gate");
          throw new Error("gate secret");
        },
        loadRuntimeConfig: () => {
          calls.push("config");
          return {};
        },
        loadUser: async () => {
          calls.push("user");
          return { status: "active" };
        },
        quote: async () => {
          calls.push("quote");
          return { estimatedCredits: 1 };
        },
      },
      calls,
    ),
  );

  assert.equal(result.reason, "database_gate_unavailable");
  assert.deepEqual(calls, ["billing", "auth", "gate"]);
  assert.doesNotMatch(result.message, /gate secret/);
});

test("runtime config failure stops before account or quote", async () => {
  const calls = [];
  const result = await resolveGenerationReadiness(
    makeDeps(
      {
        loadRuntimeConfig: () => {
          calls.push("config");
          throw new Error("missing TEXT_API_KEY=sk-secret");
        },
      },
      calls,
    ),
  );

  assert.equal(result.reason, "runtime_config_unavailable");
  assert.deepEqual(calls, ["billing", "auth", "gate", "config"]);
  assert.doesNotMatch(result.message, /TEXT_API_KEY|sk-secret/);
});

test("missing or inactive accounts are unavailable before quote", async () => {
  for (const user of [null, undefined, { status: "suspended" }]) {
    let quoted = false;
    const result = await resolveGenerationReadiness(
      makeDeps({
        loadUser: async () => user,
        quote: async () => {
          quoted = true;
          return { estimatedCredits: 1 };
        },
      }),
    );

    assert.equal(result.reason, "account_inactive", String(user));
    assert.equal(quoted, false);
  }
});

test("account repository failure is a safe unavailable projection", async () => {
  const result = await resolveGenerationReadiness(
    makeDeps({
      loadUser: async () => {
        throw new Error("db password");
      },
    }),
  );

  assert.equal(result.reason, "service_unavailable");
  assert.doesNotMatch(result.message, /db password/);
});

test("auth failure is a safe unavailable projection", async () => {
  const result = await resolveGenerationReadiness(
    makeDeps({
      authenticate: async () => {
        throw new Error("jwt token");
      },
    }),
  );

  assert.equal(result.reason, "service_unavailable");
  assert.doesNotMatch(result.message, /jwt token/);
});

test("pricing failure maps to pricing_unavailable without raw error text", async () => {
  const result = await resolveGenerationReadiness(
    makeDeps({
      quote: async () => {
        throw new Error("PLATFORM_PRICING_UNAVAILABLE story.scene provider=secret");
      },
    }),
  );

  assert.equal(result.reason, "pricing_unavailable");
  assert.equal(result.available, false);
  assert.doesNotMatch(result.message, /PLATFORM_PRICING|story\.scene|provider=secret/);
});

test("ready projection is allowlisted and labels story.start scope", async () => {
  const result = await resolveGenerationReadiness(makeDeps());

  assert.equal(result.available, true);
  assert.equal(result.reason, "ready");
  assert.equal(result.estimatedCredits, 250);
  assert.equal(result.scope, "story.start");
  assert.deepEqual(allowlistKeys(result), [
    "available",
    "estimatedCredits",
    "message",
    "reason",
    "scope",
  ]);
  assert.match(result.message, /story\.start/);
  assert.match(result.message, /其他操作会分别校验/);
  assert.match(result.message, /实际生成仍会单独校验/);
});

test("availability reflects service readiness, not balance sufficiency", async () => {
  const result = await resolveGenerationReadiness(
    makeDeps({
      quote: async () => ({ estimatedCredits: 0 }),
    }),
  );

  assert.equal(result.available, true);
  assert.equal(result.reason, "ready");
  assert.equal(result.estimatedCredits, 0);
});

test("malformed quotes are unavailable and never leak raw estimates", async () => {
  const badValues = [
    NaN,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    "10",
    null,
    undefined,
  ];

  for (const bad of badValues) {
    const result = await resolveGenerationReadiness(
      makeDeps({
        quote: async () => ({ estimatedCredits: bad }),
      }),
    );

    assert.equal(result.available, false, String(bad));
    assert.equal(result.reason, "service_unavailable", String(bad));
    assert.equal("estimatedCredits" in result, false, String(bad));
  }
});

test("a missing quote is a safe unavailable projection", async () => {
  const result = await resolveGenerationReadiness(
    makeDeps({ quote: async () => null }),
  );

  assert.equal(result.reason, "service_unavailable");
});

test("async runtime config loaders are awaited", async () => {
  const result = await resolveGenerationReadiness(
    makeDeps({
      loadRuntimeConfig: async () => ({ text: { model: "async-model" } }),
    }),
  );

  assert.equal(result.reason, "ready");
});

test("sync account and quote injectables are accepted too", async () => {
  const result = await resolveGenerationReadiness(
    makeDeps({
      loadUser: () => ({ status: "active" }),
      quote: () => ({ estimatedCredits: 12 }),
    }),
  );

  assert.equal(result.reason, "ready");
  assert.equal(result.estimatedCredits, 12);
});

test("quote extras never reach the projection", async () => {
  const result = await resolveGenerationReadiness(
    makeDeps({
      quote: async () => ({
        estimatedCredits: 7,
        pricePolicyVersion: "secret-policy",
        provider: "secret-provider",
        model: "secret-model",
      }),
    }),
  );

  assert.deepEqual(allowlistKeys(result), [
    "available",
    "estimatedCredits",
    "message",
    "reason",
    "scope",
  ]);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("serializer enforces the fixed allowlist and scope", () => {
  const result = toPublicGenerationReadiness({
    scope: "story.scene",
    available: true,
    reason: "ready",
    estimatedCredits: 42,
    message: "raw details",
    operation: "story.scene",
    pricePolicyVersion: "secret-policy",
    userId: "user-secret",
  });

  assert.deepEqual(allowlistKeys(result), [
    "available",
    "estimatedCredits",
    "message",
    "reason",
    "scope",
  ]);
  assert.equal(result.scope, "story.start");
  assert.equal(result.available, true);
  assert.equal(result.reason, "ready");
  assert.equal(result.estimatedCredits, 42);
  assert.equal(result.message, generationReadinessMessage("ready"));
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("serializer rejects inconsistent or malformed projections", () => {
  const inconsistent = toPublicGenerationReadiness({
    scope: "story.start",
    available: false,
    reason: "ready",
    estimatedCredits: 42,
    message: "x",
  });
  assert.equal(inconsistent.available, false);
  assert.equal(inconsistent.reason, "service_unavailable");
  assert.equal("estimatedCredits" in inconsistent, false);

  const malformed = toPublicGenerationReadiness({
    scope: "story.start",
    available: false,
    reason: "leak",
    message: "x",
    userId: "user-secret",
  });
  assert.equal(malformed.reason, "service_unavailable");
  assert.deepEqual(allowlistKeys(malformed), [
    "available",
    "message",
    "reason",
    "scope",
  ]);

  const nonObject = toPublicGenerationReadiness(null);
  assert.equal(nonObject.reason, "service_unavailable");
  assert.equal(nonObject.scope, "story.start");

  const notReady = toPublicGenerationReadiness({
    scope: "story.start",
    available: true,
    reason: "billing_disabled",
    message: "x",
  });
  assert.equal(notReady.available, false);
  assert.equal(notReady.reason, "billing_disabled");

  const missingCost = toPublicGenerationReadiness({
    scope: "story.start",
    available: true,
    reason: "ready",
    message: "x",
  });
  assert.equal(missingCost.available, false);
  assert.equal(missingCost.reason, "service_unavailable");
  assert.equal("estimatedCredits" in missingCost, false);
});

test("unavailable projections omit estimatedCredits and use the allowlist", () => {
  for (const reason of UNAVAILABLE_REASONS) {
    const projection = unavailableGenerationReadiness(reason);

    assert.equal(projection.available, false);
    assert.equal(projection.reason, reason);
    assert.equal("estimatedCredits" in projection, false);
    assert.deepEqual(allowlistKeys(projection), [
      "available",
      "message",
      "reason",
      "scope",
    ]);
  }
});

test("every reason has a fixed, non-empty, safe message", () => {
  const reasons = [...UNAVAILABLE_REASONS, "ready"];

  for (const reason of reasons) {
    assert.equal(isGenerationReadinessReason(reason), true);
    const message = generationReadinessMessage(reason);
    assert.ok(message.length > 0, reason);
    assert.doesNotMatch(
      message,
      /(?:sk-|tp-|api[_-]?key\s*[:=]|token\s*[:=]|process\.env|pricePolicyVersion|providerCostMinor)/i,
      reason,
    );
  }

  assert.equal(isGenerationReadinessReason("story.scene"), false);
  assert.equal(isGenerationReadinessReason(undefined), false);
  assert.equal(
    generationReadinessMessage("not-a-reason"),
    generationReadinessMessage("service_unavailable"),
  );
});

test("estimated credits accept only safe non-negative integers", () => {
  assert.equal(normalizeEstimatedCredits(0), 0);
  assert.equal(normalizeEstimatedCredits(250), 250);

  for (const bad of [-1, 1.5, NaN, Infinity, "10", null, undefined]) {
    assert.equal(normalizeEstimatedCredits(bad), undefined);
  }
});

test("ready helper refuses an unsafe estimate", () => {
  assert.equal(readyGenerationReadiness(-1).reason, "service_unavailable");
});
