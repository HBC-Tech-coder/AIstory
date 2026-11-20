/**
 * Focused, dependency-free checks for the auth-modal presentation helpers.
 *
 * Run with the repo's TS runner, for example:
 *   npx tsx scripts/test-auth-modal-presentation.ts
 *   npx ts-node scripts/test-auth-modal-presentation.ts
 *
 * The second half contains source regression assertions because this thin
 * workspace has no DOM test runtime (no jsdom, no React testing library).
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  SAFE_AUTH_PROMPTS,
  mapPhoneVerifyFailure,
  normalizeAuthErrorCode,
  resolveAuthRequirementMessage,
} from "../lib/auth/authModalPresentation";

let passed = 0;

function test(name: string, run: () => void) {
  try {
    run();
    passed += 1;
    console.log(`ok ${passed} - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

const ALL_SAFE_PROMPTS = new Set<string>(Object.values(SAFE_AUTH_PROMPTS));

test("normalizes dotted, spaced and dashed codes for lookup only", () => {
  assert.equal(normalizeAuthErrorCode(" invalid-code "), "INVALID_CODE");
  assert.equal(normalizeAuthErrorCode("OTP invalid"), "OTP_INVALID");
  assert.equal(normalizeAuthErrorCode(42), "");
  assert.equal(normalizeAuthErrorCode(null), "");
});

test("invalid verification codes map to safe Chinese copy", () => {
  for (const code of [
    "INVALID_CODE",
    "invalid-code",
    "INVALID_OTP",
    "OTP_INVALID",
    "PHONE_CODE_INVALID",
    "PHONE_OTP_INVALID",
    "VERIFICATION_CODE_INVALID",
    "CODE_MISMATCH",
    "WRONG_CODE",
    "OTP_INVALID_OR_EXPIRED",
  ]) {
    assert.equal(
      mapPhoneVerifyFailure({ status: 400, code }),
      SAFE_AUTH_PROMPTS.invalidCode,
      `code ${code}`,
    );
  }
});

test("rate limits map to the separate safe rate-limit copy", () => {
  assert.equal(
    mapPhoneVerifyFailure({ status: 429 }),
    SAFE_AUTH_PROMPTS.rateLimited,
  );
  assert.equal(
    mapPhoneVerifyFailure({ status: 400, code: "SMS_RATE_LIMITED" }),
    SAFE_AUTH_PROMPTS.rateLimited,
  );
  assert.equal(
    mapPhoneVerifyFailure({ status: 400, code: "TOO_MANY_REQUESTS" }),
    SAFE_AUTH_PROMPTS.rateLimited,
  );
  assert.notEqual(
    SAFE_AUTH_PROMPTS.rateLimited,
    SAFE_AUTH_PROMPTS.invalidCode,
  );
});

test("service failures map to the separate safe unavailable copy", () => {
  for (const input of [
    { status: 500 },
    { status: 502, code: "INTERNAL_SERVER_ERROR" },
    { status: 503, code: "SERVICE_UNAVAILABLE" },
    { status: 408 },
    { status: 413 },
    { status: 403 },
    { status: 403, code: "Forbidden" },
    { status: 404 },
    { status: 0 },
    {},
  ]) {
    assert.equal(
      mapPhoneVerifyFailure(input),
      SAFE_AUTH_PROMPTS.serviceUnavailable,
      JSON.stringify(input),
    );
  }
});

test("known invalid OTP codes still win over a service-looking status", () => {
  assert.equal(
    mapPhoneVerifyFailure({
      status: 403,
      code: "OTP_INVALID_OR_EXPIRED",
    }),
    SAFE_AUTH_PROMPTS.invalidCode,
  );
  assert.equal(
    mapPhoneVerifyFailure({ status: 404, code: "INVALID_OTP" }),
    SAFE_AUTH_PROMPTS.invalidCode,
  );
  assert.equal(
    mapPhoneVerifyFailure({ status: 400, code: "OTP_INVALID_OR_EXPIRED" }),
    SAFE_AUTH_PROMPTS.invalidCode,
  );
});

test("raw server text is never returned, including Unauthorized", () => {
  const inputs = [
    { status: 401, code: "Unauthorized" },
    { status: 401, code: "UNAUTHORIZED" },
    { status: 400, code: "error: something internal" },
    { status: 418, code: null },
    { status: 599, code: "[object Object]" },
  ];

  for (const input of inputs) {
    const message = mapPhoneVerifyFailure(input);
    assert.ok(ALL_SAFE_PROMPTS.has(message), `unsafe message for ${JSON.stringify(input)}`);
    assert.doesNotMatch(message, /unauthorized|error|internal|otp_[a-z]+|code/i);
  }
});

test("unknown codes and statuses still resolve to allow-listed safe copy", () => {
  for (const input of [
    { status: 400, code: "SOMETHING_NEW" },
    { status: 422, code: "VALIDATION_FAILED" },
    { status: 401 },
    { status: 404 },
    { status: 9999 },
  ]) {
    assert.ok(ALL_SAFE_PROMPTS.has(mapPhoneVerifyFailure(input)));
  }
});

test("requirement without a quote ignores arbitrary message and uses login copy", () => {
  assert.equal(
    resolveAuthRequirementMessage({
      message: "Unauthorized: token missing (code AUTH_401)",
    }),
    SAFE_AUTH_PROMPTS.loginRequired,
  );
  assert.equal(
    resolveAuthRequirementMessage({ message: "请充值" }),
    SAFE_AUTH_PROMPTS.loginRequired,
  );
  assert.equal(resolveAuthRequirementMessage(undefined), null);
  assert.equal(resolveAuthRequirementMessage(null), null);
});

test("requirement with a quote is rendered from trusted i18n, not message", () => {
  assert.equal(
    resolveAuthRequirementMessage({
      message: "raw server text",
      quote: {
        estimatedCredits: 12,
        pricePolicyVersion: "v1",
        modalities: ["text"],
      },
    }),
    null,
  );
  assert.equal(
    resolveAuthRequirementMessage({ message: "raw", quote: null }),
    SAFE_AUTH_PROMPTS.loginRequired,
  );
});

function findSource(relativePath: string): string {
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.resolve(directory, relativePath);
    if (existsSync(candidate)) return readFileSync(candidate, "utf8");
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  assert.fail(`unable to locate ${relativePath} from ${process.cwd()}`);
}

const modalSource = findSource("components/AuthModal.tsx");
const verificationSource = findSource("lib/auth/phoneOtpModalVerification.ts");

function has(source: string, needle: string, label: string) {
  assert.ok(source.includes(needle), `${label}: expected source to include ${JSON.stringify(needle)}`);
}

function lacks(source: string, needle: string, label: string) {
  assert.ok(!source.includes(needle), `${label}: expected source NOT to include ${JSON.stringify(needle)}`);
}

test("A1: requirement and error are hidden on claim-result success", () => {
  const hideGuards = modalSource.match(/step !== "claim-result"/g) ?? [];
  assert.ok(hideGuards.length >= 2, "expected requirement and error to be gated on claim-result");
  has(modalSource, "requirement && step !== \"claim-result\"", "requirement visibility");
  has(modalSource, "error && step !== \"claim-result\"", "error visibility");
});

test("A1: arbitrary requirement.message and raw verify error are not rendered", () => {
  lacks(modalSource, "requirement.message", "requirement message");
  lacks(modalSource, "result.error", "verify result.error");
  has(modalSource, "resolveAuthRequirementMessage(requirement)", "safe requirement helper");
  has(modalSource, "mapPhoneVerifyFailure({", "safe verify helper");
  has(modalSource, "SAFE_AUTH_PROMPTS.serviceUnavailable", "safe service fallback");
});

test("A1: claim warnings remain visible", () => {
  has(modalSource, "claimSkipReasonText", "claim skip warnings");
  has(modalSource, "claimApplyFailed", "claim apply warning");
  has(modalSource, "auth.claimRetryHint", "claim retry copy");
  has(modalSource, "auth.claimSkipReasonSummary", "claim skip copy");
});

test("A1: duplicate verify and post-unmount updates are guarded", () => {
  has(modalSource, "verifyInFlightRef", "verify in-flight ref");
  has(modalSource, "if (verifyInFlightRef.current) return;", "duplicate verify guard");
  has(modalSource, "mountedRef.current", "mounted ref");
  has(modalSource, "flowEpochRef", "flow epoch ref");
  const liveFlowGuards = modalSource.match(
    /!mountedRef\.current \|\| flowEpoch !== flowEpochRef\.current/g,
  ) ?? [];
  assert.ok(
    liveFlowGuards.length >= 2,
    "expected post-unmount/stale-flow guards around OTP request paths",
  );
  assert.match(
    modalSource,
    /isActive: \(\) =>\s*mountedRef\.current && flowEpoch === flowEpochRef\.current/,
    "verify path passes live mount and flow identity",
  );
  has(verificationSource, "if (!input.isActive()) return { kind: \"inactive\" };", "verify response mount guard");
  has(verificationSource, "PHONE_OTP_CLAIM_APPLY_WAIT_MS", "bounded local claim apply");
  has(verificationSource, "input.onAuthenticated?.();", "successful session reconciliation");
});

test("A1: cooldown and phone-only/external-login separation are preserved", () => {
  has(modalSource, "startPhoneOtpCooldown", "cooldown starter");
  has(modalSource, "resolvePhoneOtpRetryAfterSeconds", "retry-after handling");
  has(modalSource, "phoneOtpCooldownSecondsRemaining", "cooldown countdown");
  has(modalSource, "PHONE_OTP_COOLDOWN_EVENT", "cooldown event");
  has(
    modalSource,
    "!requirement && !phoneProofOnly && step === \"phone-input\" && (",
    "billing/external-login separation",
  );
  has(modalSource, "<LinghaoPassportV4LoginBoundary>", "Passport capability boundary");
  has(modalSource, "<AiUserLoginButton />", "legacy AIUser rollback entry");
});

test("A7: portal is created only after mount", () => {
  has(modalSource, "import { createPortal } from \"react-dom\";", "portal import");
  has(modalSource, "return createPortal(", "portal render");
  has(modalSource, "document.body,", "portal target");
  has(
    modalSource,
    "if (!hasMounted || typeof document === \"undefined\") return null;",
    "SSR-safe portal guard",
  );
  has(modalSource, "setHasMounted(true)", "mount flag");
});

test("A7: overlay is fixed, safe-area aware and dynamically bounded", () => {
  has(modalSource, "position: \"fixed\"", "fixed overlay");
  has(modalSource, "env(safe-area-inset-top", "safe-area top");
  has(modalSource, "env(safe-area-inset-bottom", "safe-area bottom");
  has(modalSource, "100dvh", "dynamic viewport height");
  has(modalSource, "overflowY: \"auto\"", "scrollable overlay/body");
});

test("A7: close button meets the 44px target", () => {
  has(modalSource, "minHeight: 44", "close button min height");
  has(modalSource, "minWidth: 44", "close button min width");
});

test("A7: escape, focus trap and focus restoration are implemented", () => {
  has(modalSource, "event.key === \"Escape\"", "escape close");
  has(modalSource, "event.key !== \"Tab\"", "tab trap");
  has(modalSource, "getFocusableElements(dialog)", "focusable discovery");
  has(modalSource, "previous.focus({ preventScroll: true })", "focus restoration");
  has(modalSource, "document.activeElement instanceof HTMLElement", "trigger capture");
  has(
    modalSource,
    "}, [handleClose, hasMounted]);",
    "trap effect depends only on stable close handling and mount state",
  );
});

test("A7: body scroll lock is restored", () => {
  has(modalSource, "body.style.overflow = \"hidden\";", "scroll lock");
  has(modalSource, "body.style.overflow = previousOverflow;", "scroll lock restore");
  has(modalSource, "body.style.overscrollBehavior = previousOverscrollBehavior;", "overscroll restore");
});

test("A7: autoFocus is removed in favour of step-scoped focus", () => {
  lacks(modalSource, "autoFocus", "uncontrolled autofocus");
  has(modalSource, "}, [hasMounted, step]);", "step-scoped focus effect");
  has(modalSource, "otpInputRef.current", "OTP focus");
  has(modalSource, "continueButtonRef.current", "success focus");
});

test("A7: backdrop close and modal event isolation remain", () => {
  has(modalSource, "event.stopPropagation();", "portal event isolation");
  has(modalSource, "handleClose();", "backdrop close and state reset");
  has(modalSource, "onClick={(event) => event.stopPropagation()}", "dialog click isolation");
  has(modalSource, "onKeyDown={(event) => event.stopPropagation()}", "portal keydown isolation");

  const backdropHandlerStart = modalSource.indexOf("onClick={(event) => {");
  assert.ok(backdropHandlerStart >= 0, "backdrop handler should use an event body");
  const stopIndex = modalSource.indexOf(
    "event.stopPropagation();",
    backdropHandlerStart,
  );
  const closeIndex = modalSource.indexOf("handleClose();", backdropHandlerStart);
  assert.ok(stopIndex >= 0, "backdrop must stop propagation");
  assert.ok(closeIndex >= 0, "backdrop must still close");
  assert.ok(
    stopIndex < closeIndex,
    "backdrop must stop React propagation before close/reset",
  );
});

console.log(`\n${passed} tests passed.`);
