// AIstory explicit account-link policy helper — synthetic test suite.
// Run: node --experimental-strip-types --test aiUserAccountLinkPolicy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAiUserAccountLinkConfirmation,
  decideAiUserAccountLink,
} from '../lib/auth/aiUserAccountLinkPolicy.ts';

// ---------------------------------------------------------------------------
// Shared synthetic fixtures
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_050;
const AUTH = 1_700_000_000_000; // both proofs issued at this instant
const PK = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // lowercase hex64
const PK2 = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'; // a different lowercase hex64
const BIND_A = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const BIND_A2 = 'bbbbbbbbbbbbbbbebbbbbbbbbbbbbbbebbbbbbbbbbbbbbbebbbbbbbbbbbbbbbe';
const BIND_P = 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const BIND_P2 = 'ccccccccccccccceccccccccccccccceccccccccccccccceccccccccccccccce';
const UUID = '12345678-1234-4123-8234-123456789abc'; // version 4, variant 8
const UUID2 = 'abcdef12-3456-4789-8abc-def012345678'; // version 4, variant 8
const INTENT_ID = 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';

// Parent-owned independent counterexamples; the worker's initial 16-character
// assumption was rejected before integration, not fixed by truncating SHA-256.
test('parent: every SHA-256 binding requires exactly 64 lowercase hex characters', () => {
  granted(decideAiUserAccountLink(baseInput(), NOW), 'link_allowed');
  for (const [section, field] of [['aiuser', 'principalKey'], ['aiuser', 'sessionBinding'], ['phone', 'sessionBinding'],
    ['intent', 'id'], ['intent', 'principalKey'], ['intent', 'aiuserSessionBinding'], ['intent', 'phoneSessionBinding']]) {
    for (const bad of ['a'.repeat(16), 'a'.repeat(63), 'a'.repeat(65), 'A'.repeat(64)]) {
      const input = baseInput(); input[section][field] = bad;
      denied(decideAiUserAccountLink(input, NOW));
    }
  }
});

test('parent: stale proof rejects independently of its lifetime limit', () => {
  for (const section of ['aiuser', 'phone']) {
    const input = baseInput(); input[section].authenticatedAt = NOW - 300001;
    input[section].expiresAt = NOW + 60000;
    denied(decideAiUserAccountLink(input, NOW));
    input[section].authenticatedAt = NOW - 300000;
    granted(decideAiUserAccountLink(input, NOW), 'link_allowed');
  }
});

function baseInput() {
  return {
    schema: 'aistory.aiuser-account-link-proof.v1',
    confirmation: { confirmLink: true },
    aiuser: {
      principalKey: PK,
      sessionBinding: BIND_A,
      authenticatedAt: AUTH,
      expiresAt: AUTH + 900_000, // lifetime exactly 900000ms (allowed)
      membershipGeneration: 7,
    },
    phone: {
      userId: UUID,
      sessionBinding: BIND_P,
      authenticatedAt: AUTH,
      expiresAt: AUTH + 604_800_000, // lifetime exactly 604800000ms (allowed)
      active: true,
    },
    intent: {
      id: INTENT_ID,
      principalKey: PK,
      phoneUserId: UUID,
      aiuserSessionBinding: BIND_A,
      phoneSessionBinding: BIND_P,
      createdAt: AUTH,
      expiresAt: AUTH + 30_000, // TTL 30000ms (<= 60000ms)
      consumed: false,
    },
    existingByAiuser: null,
    existingByPhone: null,
  };
}

function clone(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

const DENIED = { ok: false, code: 'ACCOUNT_LINK_REJECTED' };

function denied(decision) {
  assert.deepStrictEqual(decision, DENIED);
}

function granted(decision, status) {
  assert.deepStrictEqual(decision, {
    ok: true,
    status,
    principalKey: PK,
    phoneUserId: UUID,
    intentId: INTENT_ID,
    assetsMerged: false,
    creditsGranted: false,
    administratorGranted: false,
  });
}

// ---------------------------------------------------------------------------
// parseAiUserAccountLinkConfirmation
// ---------------------------------------------------------------------------

test('parse accepts a plain confirmation', () => {
  assert.deepStrictEqual(
    parseAiUserAccountLinkConfirmation({ confirmLink: true }),
    { confirmLink: true },
  );
});

test('parse accepts a frozen plain confirmation (still a data object)', () => {
  assert.deepStrictEqual(
    parseAiUserAccountLinkConfirmation(Object.freeze({ confirmLink: true })),
    { confirmLink: true },
  );
});

test('parse rejects non-object values', () => {
  for (const v of [null, undefined, 42, 'x', true, Symbol('s'), 1n]) {
    assert.strictEqual(parseAiUserAccountLinkConfirmation(v), null);
  }
});

test('parse rejects arrays', () => {
  assert.strictEqual(parseAiUserAccountLinkConfirmation([]), null);
  assert.strictEqual(
    parseAiUserAccountLinkConfirmation([{ confirmLink: true }]),
    null,
  );
});

test('parse rejects null and custom prototypes', () => {
  assert.strictEqual(
    parseAiUserAccountLinkConfirmation(
      Object.assign(Object.create(null), { confirmLink: true }),
    ),
    null,
  );
  assert.strictEqual(
    parseAiUserAccountLinkConfirmation(
      Object.assign(Object.create({ x: 1 }), { confirmLink: true }),
    ),
    null,
  );
});

test('parse rejects missing, false or wrong-typed confirmLink', () => {
  assert.strictEqual(parseAiUserAccountLinkConfirmation({}), null);
  assert.strictEqual(parseAiUserAccountLinkConfirmation({ confirmLink: false }), null);
  assert.strictEqual(parseAiUserAccountLinkConfirmation({ confirmLink: 'true' }), null);
  assert.strictEqual(parseAiUserAccountLinkConfirmation({ confirmLink: 1 }), null);
  assert.strictEqual(parseAiUserAccountLinkConfirmation({ ConfirmLink: true }), null);
});

test('parse rejects unknown or missing fields (toJSON included)', () => {
  assert.strictEqual(
    parseAiUserAccountLinkConfirmation({ confirmLink: true, extra: 1 }),
    null,
  );
  assert.strictEqual(
    parseAiUserAccountLinkConfirmation({ toJSON: () => ({ confirmLink: true }) }),
    null,
  );
});

test('parse rejects symbol-keyed fields', () => {
  const o = { confirmLink: true };
  o[Symbol('x')] = 1;
  assert.strictEqual(parseAiUserAccountLinkConfirmation(o), null);
});

test('parse rejects non-enumerable fields', () => {
  const o = {};
  Object.defineProperty(o, 'confirmLink', { value: true, enumerable: false });
  assert.strictEqual(parseAiUserAccountLinkConfirmation(o), null);
  const o2 = { confirmLink: true };
  Object.defineProperty(o2, 'hidden', { value: 1, enumerable: false });
  assert.strictEqual(parseAiUserAccountLinkConfirmation(o2), null);
});

test('parse rejects accessors without executing them', () => {
  let calls = 0;
  const o = {};
  Object.defineProperty(o, 'confirmLink', {
    enumerable: true,
    get() {
      calls++;
      return true;
    },
  });
  assert.strictEqual(parseAiUserAccountLinkConfirmation(o), null);
  assert.strictEqual(calls, 0);
});

test('parse rejects exotic objects', () => {
  assert.strictEqual(parseAiUserAccountLinkConfirmation(new Date()), null);
  assert.strictEqual(parseAiUserAccountLinkConfirmation(/x/), null);
  assert.strictEqual(parseAiUserAccountLinkConfirmation(new Map()), null);
  class C {
    confirmLink = true;
  }
  assert.strictEqual(parseAiUserAccountLinkConfirmation(new C()), null);
});

test('parse returns a fresh object and never mutates its input', () => {
  const input = { confirmLink: true };
  const snapshot = JSON.stringify(input);
  const result = parseAiUserAccountLinkConfirmation(input);
  assert.deepStrictEqual(result, { confirmLink: true });
  assert.notStrictEqual(result, input);
  assert.strictEqual(JSON.stringify(input), snapshot);
});

// ---------------------------------------------------------------------------
// decideAiUserAccountLink — happy paths
// ---------------------------------------------------------------------------

test('allows a fresh link when no existing mapping exists', () => {
  granted(decideAiUserAccountLink(baseInput(), NOW), 'link_allowed');
});

test('already-linked idempotency when both indexes hold the requested pair', () => {
  const input = baseInput();
  input.existingByAiuser = { principalKey: PK, phoneUserId: UUID };
  input.existingByPhone = { principalKey: PK, phoneUserId: UUID };
  granted(decideAiUserAccountLink(input, NOW), 'already_linked');
});

test('boundary-valid proofs and intent are accepted', () => {
  const input = baseInput();
  input.aiuser.authenticatedAt = NOW - 300_000; // exactly max proof age
  input.phone.authenticatedAt = NOW - 300_000;
  input.aiuser.expiresAt = input.aiuser.authenticatedAt + 900_000;
  input.phone.expiresAt = input.phone.authenticatedAt + 604_800_000;
  input.intent.createdAt = NOW - 59_999;
  input.intent.expiresAt = NOW + 1; // TTL exactly 60000ms
  granted(decideAiUserAccountLink(input, NOW), 'link_allowed');
});

// ---------------------------------------------------------------------------
// decideAiUserAccountLink — existing mapping history
// ---------------------------------------------------------------------------

test('one-sided mapping (aiuser index only) is denied', () => {
  const input = baseInput();
  input.existingByAiuser = { principalKey: PK, phoneUserId: UUID };
  denied(decideAiUserAccountLink(input, NOW));
});

test('one-sided mapping (phone index only) is denied', () => {
  const input = baseInput();
  input.existingByPhone = { principalKey: PK, phoneUserId: UUID };
  denied(decideAiUserAccountLink(input, NOW));
});

test('conflicting mapping pair is denied', () => {
  const input = baseInput();
  input.existingByAiuser = { principalKey: PK, phoneUserId: UUID };
  input.existingByPhone = { principalKey: PK2, phoneUserId: UUID };
  denied(decideAiUserAccountLink(input, NOW));
});

test('both indexes holding the same different pair is denied', () => {
  const input = baseInput();
  input.existingByAiuser = { principalKey: PK2, phoneUserId: UUID };
  input.existingByPhone = { principalKey: PK2, phoneUserId: UUID };
  denied(decideAiUserAccountLink(input, NOW));
});

test('extra fields in mapping history are denied (malformed history)', () => {
  const input = baseInput();
  input.existingByAiuser = { principalKey: PK, phoneUserId: UUID, extra: 1 };
  input.existingByPhone = { principalKey: PK, phoneUserId: UUID };
  denied(decideAiUserAccountLink(input, NOW));
});

test('swapped mapping fields are denied', () => {
  const input = baseInput();
  input.existingByAiuser = { principalKey: UUID, phoneUserId: PK };
  input.existingByPhone = { principalKey: UUID, phoneUserId: PK };
  denied(decideAiUserAccountLink(input, NOW));
});

test('partial malformed mapping is denied', () => {
  const input = baseInput();
  input.existingByAiuser = { principalKey: PK };
  input.existingByPhone = { principalKey: PK, phoneUserId: UUID };
  denied(decideAiUserAccountLink(input, NOW));
});

test('mapping entries must be plain data objects', () => {
  const input = baseInput();
  input.existingByAiuser = Object.assign(Object.create(null), {
    principalKey: PK,
    phoneUserId: UUID,
  });
  input.existingByPhone = { principalKey: PK, phoneUserId: UUID };
  denied(decideAiUserAccountLink(input, NOW));
});

// ---------------------------------------------------------------------------
// decideAiUserAccountLink — intent window
// ---------------------------------------------------------------------------

test('expired intent is denied (now >= expiresAt)', () => {
  const input = baseInput();
  input.intent.expiresAt = NOW;
  denied(decideAiUserAccountLink(input, NOW));
});

test('future intent is denied (createdAt > now)', () => {
  const input = baseInput();
  input.intent.createdAt = NOW + 1;
  denied(decideAiUserAccountLink(input, NOW));
});

test('replayed intent (created before proof issuance) is denied', () => {
  const input = baseInput();
  input.intent.createdAt = AUTH - 1;
  denied(decideAiUserAccountLink(input, NOW));
});

test('overlong intent TTL is denied', () => {
  const input = baseInput();
  input.intent.expiresAt = input.intent.createdAt + 60_001;
  denied(decideAiUserAccountLink(input, NOW));
});

test('non-positive intent TTL is denied', () => {
  const input = baseInput();
  input.intent.expiresAt = input.intent.createdAt;
  denied(decideAiUserAccountLink(input, NOW));
});

test('consumed intent is denied', () => {
  const input = baseInput();
  input.intent.consumed = true;
  denied(decideAiUserAccountLink(input, NOW));
});

// ---------------------------------------------------------------------------
// decideAiUserAccountLink — proof windows and lifetimes
// ---------------------------------------------------------------------------

test('stale aiuser proof is denied', () => {
  const input = baseInput();
  input.aiuser.authenticatedAt = NOW - 300_001;
  denied(decideAiUserAccountLink(input, NOW));
});

test('stale phone proof is denied', () => {
  const input = baseInput();
  input.phone.authenticatedAt = NOW - 300_001;
  denied(decideAiUserAccountLink(input, NOW));
});

test('future-dated proof is denied', () => {
  const input = baseInput();
  input.aiuser.authenticatedAt = NOW + 1;
  denied(decideAiUserAccountLink(input, NOW));
});

test('expired proof is denied (now >= expiresAt)', () => {
  const input = baseInput();
  input.aiuser.expiresAt = NOW;
  denied(decideAiUserAccountLink(input, NOW));
});

test('proof whose expiry does not exceed authentication time is denied', () => {
  const input = baseInput();
  input.aiuser.expiresAt = input.aiuser.authenticatedAt;
  denied(decideAiUserAccountLink(input, NOW));
  const input2 = baseInput();
  input2.phone.expiresAt = input2.phone.authenticatedAt - 1;
  denied(decideAiUserAccountLink(input2, NOW));
});

test('aiuser proof lifetime over 900000ms is denied', () => {
  const input = baseInput();
  input.aiuser.expiresAt = input.aiuser.authenticatedAt + 900_001;
  denied(decideAiUserAccountLink(input, NOW));
});

test('phone proof lifetime over 604800000ms is denied', () => {
  const input = baseInput();
  input.phone.expiresAt = input.phone.authenticatedAt + 604_800_001;
  denied(decideAiUserAccountLink(input, NOW));
});

test('inactive phone proof is denied', () => {
  const input = baseInput();
  input.phone.active = false;
  denied(decideAiUserAccountLink(input, NOW));
});

test('non-boolean phone active is denied', () => {
  const input = baseInput();
  input.phone.active = 1;
  denied(decideAiUserAccountLink(input, NOW));
});

// ---------------------------------------------------------------------------
// decideAiUserAccountLink — bindings
// ---------------------------------------------------------------------------

test('mismatched aiuser session binding is denied', () => {
  const input = baseInput();
  input.intent.aiuserSessionBinding = BIND_A2;
  denied(decideAiUserAccountLink(input, NOW));
});

test('mismatched phone session binding is denied', () => {
  const input = baseInput();
  input.intent.phoneSessionBinding = BIND_P2;
  denied(decideAiUserAccountLink(input, NOW));
});

test('cross-account principal key is denied', () => {
  const input = baseInput();
  input.intent.principalKey = PK2;
  denied(decideAiUserAccountLink(input, NOW));
});

test('cross-account phone user id is denied', () => {
  const input = baseInput();
  input.intent.phoneUserId = UUID2;
  denied(decideAiUserAccountLink(input, NOW));
});

// ---------------------------------------------------------------------------
// decideAiUserAccountLink — formats, number limits, generation
// ---------------------------------------------------------------------------

test('uppercase hex64 is denied', () => {
  const input = baseInput();
  input.aiuser.principalKey = 'AAAAAAAAAAAAAAAA';
  denied(decideAiUserAccountLink(input, NOW));
});

test('wrong-length or non-hex keys are denied', () => {
  for (const bad of ['aaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaaaa', 'gggggggggggggggg']) {
    const input = baseInput();
    input.aiuser.principalKey = bad;
    denied(decideAiUserAccountLink(input, NOW));
  }
});

test('invalid UUID version/variant/format is denied', () => {
  const badUuids = [
    '12345678-1234-0123-8234-123456789abc', // version 0
    '12345678-1234-9123-8234-123456789abc', // version 9
    '12345678-1234-4123-7234-123456789abc', // variant 7
    '12345678-1234-4123-c234-123456789abc', // variant c
    '12345678-1234-4123-8234-123456789ab', // too short
    '12345678123441238234123456789abc', // no hyphens
    '12345678-1234-4123-8234-123456789ABC', // uppercase
  ];
  for (const userId of badUuids) {
    const input = baseInput();
    input.phone.userId = userId;
    denied(decideAiUserAccountLink(input, NOW));
  }
});

test('negative timestamps are denied', () => {
  const input = baseInput();
  input.aiuser.authenticatedAt = -1;
  denied(decideAiUserAccountLink(input, NOW));
});

test('fractional timestamps are denied', () => {
  const input = baseInput();
  input.aiuser.authenticatedAt = AUTH + 0.5;
  denied(decideAiUserAccountLink(input, NOW));
});

test('unsafe integer timestamps are denied', () => {
  const input = baseInput();
  input.aiuser.expiresAt = Number.MAX_SAFE_INTEGER + 1;
  denied(decideAiUserAccountLink(input, NOW));
});

test('non-number timestamps are denied', () => {
  const input = baseInput();
  input.aiuser.authenticatedAt = String(AUTH);
  denied(decideAiUserAccountLink(input, NOW));
});

test('NaN and Infinity timestamps are denied', () => {
  for (const bad of [NaN, Infinity, -Infinity]) {
    const input = baseInput();
    input.aiuser.authenticatedAt = bad;
    denied(decideAiUserAccountLink(input, NOW));
  }
});

test('membership generation must be a positive safe integer', () => {
  for (const bad of [0, -1, 1.5, NaN, '7', null]) {
    const input = baseInput();
    input.aiuser.membershipGeneration = bad;
    denied(decideAiUserAccountLink(input, NOW));
  }
});

test('nowMs must be a nonnegative safe integer', () => {
  for (const bad of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '1700000000050']) {
    denied(decideAiUserAccountLink(baseInput(), bad));
  }
});

// ---------------------------------------------------------------------------
// decideAiUserAccountLink — confirmation
// ---------------------------------------------------------------------------

test('confirmation false is denied', () => {
  const input = baseInput();
  input.confirmation = { confirmLink: false };
  denied(decideAiUserAccountLink(input, NOW));
});

test('missing confirmation is denied', () => {
  const input = baseInput();
  delete input.confirmation;
  denied(decideAiUserAccountLink(input, NOW));
});

test('confirmation with extra field is denied', () => {
  const input = baseInput();
  input.confirmation = { confirmLink: true, extra: 1 };
  denied(decideAiUserAccountLink(input, NOW));
});

test('non-plain confirmation is denied', () => {
  const input = baseInput();
  input.confirmation = Object.assign(Object.create({ x: 1 }), {
    confirmLink: true,
  });
  denied(decideAiUserAccountLink(input, NOW));
});

// ---------------------------------------------------------------------------
// decideAiUserAccountLink — extra fields at each level, schema
// ---------------------------------------------------------------------------

test('extra root field is denied', () => {
  const input = baseInput();
  input.extra = 1;
  denied(decideAiUserAccountLink(input, NOW));
});

test('extra aiuser field is denied', () => {
  const input = baseInput();
  input.aiuser.extra = 1;
  denied(decideAiUserAccountLink(input, NOW));
});

test('aiuser active flag is not part of the exact schema', () => {
  const input = baseInput();
  input.aiuser.active = true;
  denied(decideAiUserAccountLink(input, NOW));
});

test('extra phone field is denied', () => {
  const input = baseInput();
  input.phone.extra = 1;
  denied(decideAiUserAccountLink(input, NOW));
});

test('extra intent field is denied', () => {
  const input = baseInput();
  input.intent.extra = 1;
  denied(decideAiUserAccountLink(input, NOW));
});

test('wrong or missing schema is denied', () => {
  const input = baseInput();
  input.schema = 'aistory.aiuser-account-link-proof.v2';
  denied(decideAiUserAccountLink(input, NOW));
  const input2 = baseInput();
  delete input2.schema;
  denied(decideAiUserAccountLink(input2, NOW));
});

test('missing root fields are denied', () => {
  const input = baseInput();
  delete input.intent;
  denied(decideAiUserAccountLink(input, NOW));
});

test('non-object root values are denied', () => {
  denied(decideAiUserAccountLink(null, NOW));
  denied(decideAiUserAccountLink(undefined, NOW));
  denied(decideAiUserAccountLink(42, NOW));
  denied(decideAiUserAccountLink('string', NOW));
  denied(decideAiUserAccountLink(true, NOW));
  denied(decideAiUserAccountLink([], NOW));
  denied(decideAiUserAccountLink([baseInput()], NOW));
});

// ---------------------------------------------------------------------------
// decideAiUserAccountLink — hostile objects (getter count must stay 0)
// ---------------------------------------------------------------------------

test('root getters are never executed', () => {
  let calls = 0;
  const original = baseInput();
  const hostile = {};
  for (const key of Object.keys(original)) {
    Object.defineProperty(hostile, key, {
      enumerable: true,
      get() {
        calls++;
        return clone(original[key]);
      },
    });
  }
  denied(decideAiUserAccountLink(hostile, NOW));
  assert.strictEqual(calls, 0);
});

test('nested accessor fields are rejected without invoking them', () => {
  let calls = 0;
  const input = baseInput();
  input.aiuser = {};
  for (const key of [
    'principalKey',
    'sessionBinding',
    'authenticatedAt',
    'expiresAt',
    'membershipGeneration',
  ]) {
    Object.defineProperty(input.aiuser, key, {
      enumerable: true,
      get() {
        calls++;
        return baseInput().aiuser[key];
      },
    });
  }
  denied(decideAiUserAccountLink(input, NOW));
  assert.strictEqual(calls, 0);
});

test('confirmation getter is never executed', () => {
  let calls = 0;
  const input = baseInput();
  input.confirmation = {};
  Object.defineProperty(input.confirmation, 'confirmLink', {
    enumerable: true,
    get() {
      calls++;
      return true;
    },
  });
  denied(decideAiUserAccountLink(input, NOW));
  assert.strictEqual(calls, 0);
});

test('custom prototype at root is denied', () => {
  const input = baseInput();
  const hostile = Object.create({ polluted: 1 });
  for (const key of Object.keys(input)) hostile[key] = input[key];
  denied(decideAiUserAccountLink(hostile, NOW));
});

test('null-prototype objects are denied (root and nested)', () => {
  const input = baseInput();
  const hostile = Object.assign(Object.create(null), input);
  denied(decideAiUserAccountLink(hostile, NOW));
  const nested = baseInput();
  nested.aiuser = Object.assign(Object.create(null), nested.aiuser);
  denied(decideAiUserAccountLink(nested, NOW));
});

test('symbol-keyed extra field is denied', () => {
  const input = baseInput();
  input[Symbol('x')] = 1;
  denied(decideAiUserAccountLink(input, NOW));
});

test('own toJSON field is denied', () => {
  const input = baseInput();
  input.toJSON = () => ({});
  denied(decideAiUserAccountLink(input, NOW));
});

test('non-enumerable extra field is denied', () => {
  const input = baseInput();
  Object.defineProperty(input, 'hidden', { value: 1, enumerable: false });
  denied(decideAiUserAccountLink(input, NOW));
});

test('revoked proxy is denied without throwing', () => {
  const { proxy, revoke } = Proxy.revocable({}, {});
  revoke();
  denied(decideAiUserAccountLink(proxy, NOW));
  assert.strictEqual(parseAiUserAccountLinkConfirmation(proxy), null);
});

// ---------------------------------------------------------------------------
// decideAiUserAccountLink — robustness guarantees
// ---------------------------------------------------------------------------

test('input is never mutated (plain and deep-frozen inputs)', () => {
  const input = baseInput();
  const snapshot = JSON.stringify(input);
  granted(decideAiUserAccountLink(input, NOW), 'link_allowed');
  assert.strictEqual(JSON.stringify(input), snapshot);

  const frozen = deepFreeze(baseInput());
  granted(decideAiUserAccountLink(frozen, NOW), 'link_allowed');

  const frozenLinked = deepFreeze(
    (() => {
      const i = baseInput();
      i.existingByAiuser = { principalKey: PK, phoneUserId: UUID };
      i.existingByPhone = { principalKey: PK, phoneUserId: UUID };
      return i;
    })(),
  );
  granted(decideAiUserAccountLink(frozenLinked, NOW), 'already_linked');
});

test('decision is deterministic', () => {
  assert.deepStrictEqual(
    decideAiUserAccountLink(baseInput(), NOW),
    decideAiUserAccountLink(clone(baseInput()), NOW),
  );
  const linked = baseInput();
  linked.existingByAiuser = { principalKey: PK, phoneUserId: UUID };
  linked.existingByPhone = { principalKey: PK, phoneUserId: UUID };
  assert.deepStrictEqual(
    decideAiUserAccountLink(linked, NOW),
    decideAiUserAccountLink(clone(linked), NOW),
  );
});

test('failure output is a fixed redacted object with no user strings', () => {
  const leak = 'LEAKME-SECRET-INPUT';
  const input = baseInput();
  input.aiuser.principalKey = leak; // malformed -> denied
  const decision = decideAiUserAccountLink(input, NOW);
  denied(decision);
  const json = JSON.stringify(decision);
  assert.ok(!json.includes(leak));
  assert.ok(!json.includes(UUID));
  assert.ok(!json.includes(INTENT_ID));
});

test('decide never throws on garbage and always returns a decision', () => {
  const garbage = [
    null,
    undefined,
    0,
    '',
    [],
    {},
    { schema: 1 },
    new Proxy({}, {}),
    Object.create(null),
    new Date(),
    Symbol('s'),
    1n,
  ];
  for (const g of garbage) {
    const d = decideAiUserAccountLink(g, 0);
    assert.ok(d.ok === true || d.ok === false);
    if (!d.ok) denied(d);
  }
});
