// Focused regression checks for the /play issue-recovery work.
//
// Run with a TS-capable runner from the repo root, e.g.:
//   npx tsx scripts/test-play-issue-recovery.ts
//
// The first half exercises the pure draft/copy helpers. The second half is a
// source audit for the narrow integration points that cannot be exercised
// without the full Next.js tree (no dependencies are installed in this thin
// workspace): first-load auth pause, authored-lock notices, and the custom
// draft recovery screen.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CUSTOM_PLAY_DRAFT_STORAGE_KEY,
  parseCustomPlayDraft,
  readCustomPlayDraft,
  playIssueRecoveryCopy,
} from "../lib/playIssueRecovery";
import { resolveSafeReturn } from "../lib/playerReviewPolicy";

let passed = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

function validDraft(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    worldSetting: "雨夜的旧城区",
    styleGuide: "电影感水彩",
    ...overrides,
  });
}

check("parse: empty values are missing", () => {
  assert.deepEqual(parseCustomPlayDraft(null), { status: "missing" });
  assert.deepEqual(parseCustomPlayDraft(undefined), { status: "missing" });
  assert.deepEqual(parseCustomPlayDraft(""), { status: "missing" });
  assert.deepEqual(parseCustomPlayDraft("   "), { status: "missing" });
});

check("parse: valid draft returns the normalized payload", () => {
  const result = parseCustomPlayDraft(
    validDraft({
      audioEnabled: true,
      styleReferenceImage: " https://example.test/ref.png ",
      playerName: "林穗",
      ignored: "field",
    }),
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("expected ok");
  assert.deepEqual(result.draft, {
    worldSetting: "雨夜的旧城区",
    styleGuide: "电影感水彩",
    audioEnabled: true,
    styleReferenceImage: " https://example.test/ref.png ",
    playerName: "林穗",
  });
});

check("parse: malformed JSON does not throw", () => {
  assert.deepEqual(parseCustomPlayDraft("{not json"), { status: "malformed" });
});

check("parse: non-object JSON is malformed", () => {
  assert.deepEqual(parseCustomPlayDraft("null"), { status: "malformed" });
  assert.deepEqual(parseCustomPlayDraft("[]"), { status: "malformed" });
  assert.deepEqual(parseCustomPlayDraft('"a string"'), { status: "malformed" });
  assert.deepEqual(parseCustomPlayDraft("42"), { status: "malformed" });
});

check("parse: missing required story fields are malformed", () => {
  assert.deepEqual(
    parseCustomPlayDraft(JSON.stringify({ worldSetting: "x" })),
    { status: "malformed" },
  );
  assert.deepEqual(
    parseCustomPlayDraft(JSON.stringify({ worldSetting: "", styleGuide: "y" })),
    { status: "malformed" },
  );
  assert.deepEqual(
    parseCustomPlayDraft(JSON.stringify({ worldSetting: "x", styleGuide: 7 })),
    { status: "malformed" },
  );
});

check("parse: optional fields are only kept when valid", () => {
  const result = parseCustomPlayDraft(
    validDraft({ audioEnabled: "yes", styleReferenceImage: "", playerName: 1 }),
  );
  assert.equal(result.status, "ok");
  if (result.status !== "ok") throw new Error("expected ok");
  assert.deepEqual(result.draft, {
    worldSetting: "雨夜的旧城区",
    styleGuide: "电影感水彩",
  });
});

check("read: missing storage is missing", () => {
  assert.deepEqual(readCustomPlayDraft(null), { status: "missing" });
});

check("read: storage getItem throw is recoverable", () => {
  const throwingStorage = {
    getItem() {
      throw new Error("SecurityError");
    },
  };
  assert.deepEqual(readCustomPlayDraft(throwingStorage), {
    status: "malformed",
  });
});

check("read: uses the tab-local custom key", () => {
  const seen: string[] = [];
  const result = readCustomPlayDraft({
    getItem(key: string) {
      seen.push(key);
      return validDraft();
    },
  });
  assert.equal(result.status, "ok");
  assert.deepEqual(seen, [CUSTOM_PLAY_DRAFT_STORAGE_KEY]);
});

check("copy: locale fallback and required controls exist", () => {
  for (const locale of ["zh-CN", "en", "ja", "unknown-locale"]) {
    const copy = playIssueRecoveryCopy(locale);
    for (const value of Object.values(copy)) {
      assert.equal(typeof value, "string");
      assert.ok(value.length > 0);
    }
  }
  assert.equal(
    playIssueRecoveryCopy("unknown-locale").authReopenLogin,
    playIssueRecoveryCopy("zh-CN").authReopenLogin,
  );
});

const pageCandidates = [
  resolve(process.cwd(), "app/[locale]/play/page.tsx"),
  fileURLToPath(new URL("../app/[locale]/play/page.tsx", import.meta.url)),
];
const pagePath = pageCandidates.find((candidate) => existsSync(candidate));
assert.ok(pagePath, "could not locate app/[locale]/play/page.tsx");
const page = readFileSync(pagePath!, "utf8");

check("A2: first-load auth does not set 100% error progress", () => {
  const startFetch = page.indexOf("const fetchStart");
  const replayComment = page.indexOf("// ── Deferred replay of the action that hit 401");
  assert.ok(startFetch > -1 && replayComment > startFetch, "start catch not found");
  const startCatch = page.slice(startFetch, replayComment);
  const authCheck = startCatch.indexOf("if (e instanceof AuthRequiredError)");
  const errorProgress = startCatch.indexOf(
    'setFirstFrameProgress(loadingProgress(locale, 100, "error"))',
  );
  assert.ok(authCheck > -1, "first-load auth branch missing");
  assert.ok(
    errorProgress > authCheck,
    "100%/error progress must only run after the auth branch returns",
  );
  assert.ok(
    startCatch.includes("markFirstLoadAuthRequired(e)"),
    "first-load auth should enter the paused recovery state",
  );
});

check("A2: paused auth screen offers reopen login + home controls", () => {
  assert.ok(page.includes("if (firstLoadAuthRequirement)"));
  assert.ok(page.includes("setAuthModalOpen(true)"));
  assert.ok(page.includes("authReopenLogin"));
  assert.ok(page.includes("authHome"));

  // The paused screen must not hardcode a home href: it resolves the link from
  // the search params through the pure, allowlist-only safe-return helper.
  assert.ok(page.includes("resolveSafeReturn({"));
  assert.ok(page.includes('returnTo: params.get("returnTo")'));
  assert.ok(page.includes('homeHref: lp("/")'));
  assert.ok(page.includes('mobileHref: lp("/mobile")'));

  // The paused auth screen itself links through that resolved href.
  const pausedScreenStart = page.indexOf("if (firstLoadAuthRequirement) {");
  const pausedScreenEnd = page.indexOf(
    "if (error && !hasPreservedCanvas) {",
    pausedScreenStart,
  );
  assert.ok(pausedScreenStart > -1, "paused auth screen missing");
  assert.ok(
    pausedScreenEnd > pausedScreenStart,
    "paused auth screen block not delimited",
  );
  const pausedScreen = page.slice(pausedScreenStart, pausedScreenEnd);
  assert.ok(pausedScreen.includes("href={safeReturn.href}"));
  // Scope the negative assertion to the paused screen block: the app's
  // dedicated missing-import screen legitimately links home via lp("/").
  assert.equal(pausedScreen.includes('href={lp("/")}'), false);

  // resolveSafeReturn: only the exact allowlisted `/mobile` may redirect. Every
  // malformed / external / protocol-relative / query / hash / trailing-slash
  // variant and an absent value fall back to the localized home href. Checked
  // against the real locale-prefixed hrefs lp() produces (zh-CN bare, en/ja
  // prefixed).
  const locales = [
    { locale: "zh-CN", homeHref: "/", mobileHref: "/mobile" },
    { locale: "en", homeHref: "/en", mobileHref: "/en/mobile" },
    { locale: "ja", homeHref: "/ja", mobileHref: "/ja/mobile" },
  ] as const;

  for (const { locale, homeHref, mobileHref } of locales) {
    const accepted = resolveSafeReturn({
      returnTo: "/mobile",
      homeHref,
      mobileHref,
    });
    assert.equal(
      accepted.href,
      mobileHref,
      `${locale}: exact /mobile must link to the mobile href`,
    );
    assert.equal(
      accepted.fromReturnTo,
      true,
      `${locale}: exact /mobile must use the returnTo resolution`,
    );

    for (const returnTo of [null, undefined, ""]) {
      const absent = resolveSafeReturn({ returnTo, homeHref, mobileHref });
      assert.equal(
        absent.href,
        homeHref,
        `${locale}: absent returnTo must fall back home`,
      );
      assert.equal(
        absent.fromReturnTo,
        false,
        `${locale}: absent returnTo must not use the returnTo resolution`,
      );
    }

    const rejected = [
      "/mobile/",
      "/MOBILE",
      "mobile",
      "/mobile?next=1",
      "/mobile#top",
      "//evil.test/mobile",
      "https://evil.test/mobile",
      "http://evil.test",
      "javascript:alert(1)",
      " /mobile",
      "/mobile ",
    ];
    for (const returnTo of rejected) {
      const fallback = resolveSafeReturn({ returnTo, homeHref, mobileHref });
      assert.equal(
        fallback.href,
        homeHref,
        `${locale}: returnTo "${returnTo}" must fall back home`,
      );
      assert.equal(
        fallback.fromReturnTo,
        false,
        `${locale}: returnTo "${returnTo}" must not be accepted`,
      );
    }
  }
});

check("A2: first-load login success retries bootstrap once", () => {
  assert.ok(page.includes("firstLoadAuthRequirementRef.current"));
  assert.ok(page.includes("startedRef.current = false"));
  assert.ok(page.includes("setRetryBootstrap((n) => n + 1)"));
});

check("A2: dismissing auth drops the retry/pending action", () => {
  assert.ok(page.includes("const closeAuthModal = useCallback"));
  assert.ok(page.includes("authResolveRef.current = null"));
  assert.ok(page.includes("pendingResumeActionRef.current = null"));
});

check("A2/A3: in-scene retry semantics preserved", () => {
  assert.ok(page.includes("const retry = authResolveRef.current"));
  assert.ok(page.includes("retry?.()"));
});

check("A3: authored-lock fallbacks are nonfatal", () => {
  assert.equal(
    page.includes('setError("作者锁定章节只能使用原稿选项继续")'),
    false,
  );
  assert.equal(
    page.includes('setError("作者锁定章节不启用画面识别或 AI 改写")'),
    false,
  );
  assert.ok(
    page.includes('showPlayNotice("作者锁定章节只能使用原稿选项继续")'),
  );
  assert.ok(
    page.includes('showPlayNotice("作者锁定章节不启用画面识别或 AI 改写")'),
  );
});

check("A3: both PlayCanvas paths hide freeform/vision when author-locked", () => {
  const hiddenFreeform = page.match(
    /onFreeformInput=\{authorLockedScene \? undefined : onFreeformInput\}/g,
  );
  const hiddenVision = page.match(/!authorLockedScene &&/g);
  const disabledFreeform = page.match(/authorLockedScene \|\|/g);
  assert.equal(hiddenFreeform?.length, 2, "expected both PlayCanvas paths");
  assert.equal(hiddenVision?.length, 2, "expected both PlayCanvas paths");
  assert.equal(disabledFreeform?.length, 2, "expected both PlayCanvas paths");
  assert.ok(page.includes("isAuthorLockedScene(session)"));
});

check("A1: paused auth screen never renders the raw requirement message", () => {
  // A1 regression: the paused screen once interpolated the backend message
  // (e.g. a bare "Unauthorized"). It must render fixed localized copy only.
  assert.equal(
    page.includes("firstLoadAuthRequirement.message"),
    false,
    "paused screen must not render firstLoadAuthRequirement.message",
  );
  const screenStart = page.indexOf("if (firstLoadAuthRequirement) {");
  assert.ok(screenStart > -1, "paused auth screen missing");
  const screenEnd = page.indexOf(
    "if (error && !hasPreservedCanvas) {",
    screenStart,
  );
  assert.ok(screenEnd > screenStart, "paused auth screen block not found");
  const screen = page.slice(screenStart, screenEnd);
  assert.equal(
    /\{[^}]*\.message\s*\}/.test(screen),
    false,
    "paused screen must not interpolate any raw requirement message",
  );
  assert.ok(screen.includes("{recoveryCopy.authPausedBody}"));
  assert.ok(screen.includes("{recoveryCopy.authPausedDraftNote}"));
  // The requirement still reaches AuthModal (the other lane sanitizes it).
  assert.ok(screen.includes("requirement={authRequirement}"));
  assert.ok(screen.includes("setAuthRequirement(firstLoadAuthRequirement)"));
  assert.ok(page.includes("firstLoadAuthRequirementRef.current"));
});

check("A6: recovery copy makes no storage/URL/server/expiry claims", () => {
  const locales = ["zh-CN", "en", "ja"];
  const forbidden = [
    "sessionStorage",
    "localStorage",
    "URL",
    "server",
    "expire",
    "expired",
    "expiry",
    "retention",
    "paid",
    "billing",
    "服务器",
    "过期",
    "期限",
    "课金",
    "課金",
    "サーバー",
    "期限切れ",
  ];
  for (const locale of locales) {
    const copy = playIssueRecoveryCopy(locale);
    for (const field of [
      "customDraftBody",
      "authPausedBody",
      "authPausedDraftNote",
    ] as const) {
      const value = copy[field];
      for (const token of forbidden) {
        assert.equal(
          value.includes(token),
          false,
          `${locale}.${field} must not claim "${token}"`,
        );
      }
    }
    // The paused note must stay generic: not "every entry is a custom draft".
    assert.equal(
      playIssueRecoveryCopy(locale).authPausedDraftNote.includes("custom"),
      false,
      `${locale}.authPausedDraftNote must not claim a custom draft is retained`,
    );
  }
  const en = playIssueRecoveryCopy("en");
  assert.equal(
    en.customDraftBody,
    "This tab could not find a usable custom story draft. Return to the original tab or return home and enter your story again.",
  );
  assert.equal(
    en.authPausedDraftNote,
    "Your inputs have not been cleared. After signing in, this page will retry the opening scene once.",
  );
  assert.equal(
    en.authPausedBody,
    "Opening scene generation is paused. Sign in to continue or return home.",
  );
});

check("A6: legacy resume probe is guarded so storage denial cannot abort bootstrap", () => {
  const probe = page.indexOf("sessionStorage.getItem(PLAY_RESUME_KEY)");
  assert.ok(probe > -1, "legacy resume probe not found");
  const guardedOpen = page.lastIndexOf("try {", probe);
  assert.ok(guardedOpen > -1 && guardedOpen < probe, "probe is not inside a try");
  const beforeProbe = page.slice(guardedOpen, probe);
  assert.equal(
    beforeProbe.includes("}"),
    false,
    "the resume probe must be the first statement in its own try block",
  );
  assert.ok(
    beforeProbe.includes("hasLegacyResumeSnapshot"),
    "guarded probe must record its result in a flag",
  );
  const catchAt = page.indexOf("} catch", probe);
  assert.ok(catchAt > probe, "guarded probe needs a catch");
  const afterCatch = page.slice(catchAt, catchAt + 400);
  assert.ok(
    afterCatch.includes("hasLegacyResumeSnapshot"),
    "a denied probe must fall through to the normal bootstrap",
  );
  // Resume consume logic must be untouched.
  assert.ok(page.includes("consumeResumeSnapshot<PlayResumeSnapshot>("));
  assert.ok(page.includes("await restorePlayResume(snap)"));
});

check("A6: custom draft uses the safe reader and a recoverable screen", () => {
  assert.ok(page.includes("readCustomPlayDraft(window.sessionStorage)"));
  assert.ok(page.includes("if (customDraftFailure)"));
  assert.ok(page.includes("setCustomDraftIssue(customDraftFailure)"));
  assert.ok(page.includes("if (customDraftIssue)"));
  assert.ok(page.includes("customDraftHome"));
  // The custom-draft return must happen before the generic home redirect.
  const customReturn = page.indexOf("if (customDraftFailure)");
  const homeRedirect = page.indexOf('router.replace(lp("/"))');
  assert.ok(customReturn > -1 && homeRedirect > customReturn);
  // No story text/secrets are appended to the recovery links.
  assert.ok(!/href=\{[^}]*sessionStorage/.test(page));
});

console.log(`\n${passed} checks passed.`);
