/**
 * A8 + B7 regression checks for the thin workspace.
 *
 * These are source invariants plus pure completion-gate behavior, matching the
 * existing `scripts/test-video-story-runtime.ts` style. They intentionally do
 * not import Next.js/React components, so they run without installing app
 * dependencies or booting a browser. The parent owns full dependency and
 * browser/real-device testing.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  createVideoCompletionGate,
  type VideoCompletionReason,
} from "../lib/sceneMedia";

const root = process.cwd();

async function readSource(relativePath: string): Promise<string> {
  return readFile(path.join(root, ...relativePath.split("/")), "utf8");
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) =>
    permutations(items.filter((_, i) => i !== index)).map((rest) => [
      item,
      ...rest,
    ]),
  );
}

// ── A8: completion gate fires once across the ended / seek / skip race ──
const TERMINAL_REASONS: readonly VideoCompletionReason[] = [
  "completed",
  "seeked",
  "skipped",
];

for (const order of permutations(TERMINAL_REASONS)) {
  const calls: VideoCompletionReason[] = [];
  const gate = createVideoCompletionGate((reason) => calls.push(reason));
  assert.equal(gate.state(), "active");
  assert.equal(gate(order[0]!), true, `first ${order[0]} completes`);
  for (const lateReason of order.slice(1)) {
    assert.equal(
      gate(lateReason),
      false,
      `${lateReason} must not complete after ${order[0]}`,
    );
  }
  assert.deepEqual(calls, [order[0]]);
  assert.equal(gate.state(), "completed");
  // A terminal session never re-opens.
  assert.equal(gate("skipped"), false);
  assert.equal(gate.markFailed(), false);
  assert.deepEqual(calls, [order[0]]);
}

// ── A8: failed media never auto-completes; recovery is explicit and once ──
const failedCalls: VideoCompletionReason[] = [];
const failedGate = createVideoCompletionGate((reason) =>
  failedCalls.push(reason),
);
assert.equal(failedGate.markFailed(), true);
assert.equal(failedGate.state(), "failed");
// Native completion and seek-at-end are not a recovery path.
assert.equal(failedGate("completed"), false);
assert.equal(failedGate("seeked"), false);
// Repeated errors do not advance the gate.
assert.equal(failedGate.markFailed(), false);
assert.equal(failedGate.state(), "failed");
assert.deepEqual(failedCalls, []);
// Only the explicit skip-recovery unlocks the gate, exactly once.
assert.equal(failedGate("skipped"), true);
assert.equal(failedGate.state(), "completed");
assert.equal(failedGate("skipped"), false);
assert.equal(failedGate("completed"), false);
assert.equal(failedGate("seeked"), false);
assert.deepEqual(failedCalls, ["skipped"]);

// ── A8: terminal mirroring removes controls/subtitles/VTT in React ──
const player = await readSource("components/VideoStoryPlayer.tsx");

assert.match(player, /const \[terminal, setTerminal\] = useState\(false\);/);
assert.match(player, /const terminalRef = useRef\(false\);/);
assert.match(player, /const didComplete = completionGate\(reason\);/);
assert.match(player, /if \(didComplete\) \{/);
assert.match(player, /terminalRef\.current = true;/);
assert.match(player, /setTerminal\(true\);/);
assert.match(player, /setControlsVisible\(false\);/);

// Terminal completion must drop the transport panel entirely.
assert.match(player, /\{!mediaFailed && !terminal && \(/);
// Subtitle overlay leaves layout/hit-testing/aria-live after terminal.
assert.match(player, /\{!mediaFailed && !terminal && subtitleOverlay && \(/);
// Error-recovery overlay also disappears after successful skip recovery.
assert.match(player, /\{mediaFailed && !terminal && \(/);
// Best-effort autoplay prompt cannot outlive the terminal session.
assert.match(
  player,
  /autoplayBlocked &&\s*!mediaFailed &&\s*completionGate\.state\(\) === "active" &&\s*!terminal/,
);
// Native VTT track is unmounted after terminal/failure (only one <track>).
assert.match(
  player,
  /!terminal &&\s*!mediaFailed &&\s*subtitlePresentation\.source === "vtt"/,
);
assert.equal(player.match(/<track\b/g)?.length, 1);

// Pointer/focus handlers cannot resurrect controls after terminal.
assert.match(
  player,
  /if \(terminalRef\.current \|\| completionGate\.state\(\) !== "active"\) return;/,
);
assert.match(player, /onPointerMove=\{showControls\}/);
assert.match(player, /onPointerDown=\{showControls\}/);
assert.match(player, /onFocusCapture=\{showControls\}/);
assert.doesNotMatch(
  player,
  /onPointer(?:Move|Down)=\{\(\) => setControlsVisible\(true\)\}/,
);

// A fake replay button cannot exist: playback is gated and the outer replay
// owner is retained through onCompleteRef.
assert.doesNotMatch(player, /重播|重新播放|再看一遍|replay\s*\(/i);
assert.match(player, /onCompleteRef\.current\(\{/);
assert.match(player, /createVideoCompletionGate\(\(reason\) =>/);

// Terminal completion exits fullscreen only when this player's root owns it,
// and the parent callback still fires through the gate exactly once.
const fullscreenStart = player.indexOf(
  "const exitPlayerFullscreenOnTerminal = useCallback",
);
const fullscreenEnd = player.indexOf(
  "const complete = useCallback",
  fullscreenStart,
);
assert.ok(fullscreenStart >= 0 && fullscreenEnd > fullscreenStart);
const fullscreenSource = player.slice(fullscreenStart, fullscreenEnd);
assert.match(fullscreenSource, /document\.fullscreenElement !== root/);
assert.match(fullscreenSource, /document\.exitFullscreen\(\)/);
assert.match(fullscreenSource, /result\.catch\(\(\) => \{/);
assert.doesNotMatch(fullscreenSource, /onCompleteRef|completionGate/);

const completeStart = fullscreenEnd;
const completeEnd = player.indexOf(
  "const attemptPlay = useCallback",
  completeStart,
);
assert.ok(completeEnd > completeStart);
const completeSource = player.slice(completeStart, completeEnd);
assert.equal(
  completeSource.match(/completionGate\(reason\)/g)?.length,
  1,
  "terminal completion must not duplicate the parent callback",
);
assert.match(completeSource, /exitPlayerFullscreenOnTerminal\(\);/);
assert.doesNotMatch(completeSource, /onCompleteRef\.current/);

// Each terminal reason goes through the once-only gate.
assert.match(player, /complete\("completed"\)/);
assert.match(player, /complete\("seeked"\)/);
assert.match(player, /complete\("skipped"\)/);

// Failure path does not complete automatically; recovery is explicit.
const recoveryStart = player.indexOf(
  "const recoverFromMediaFailure = useCallback",
);
const recoveryEnd = player.indexOf(
  "const handleMediaError = useCallback",
  recoveryStart,
);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart);
const recoverySource = player.slice(recoveryStart, recoveryEnd);
assert.match(recoverySource, /completionGate\.state\(\) !== "failed"/);
assert.match(recoverySource, /complete\("skipped"\)/);
assert.match(recoverySource, /setRecoveryRequested\(true\)/);
assert.doesNotMatch(recoverySource, /currentTime|duration|allowSkip/);

const errorStart = recoveryEnd;
const errorEnd = player.indexOf("const seekTo = useCallback", errorStart);
assert.ok(errorEnd > errorStart);
const errorSource = player.slice(errorStart, errorEnd);
assert.match(errorSource, /completionGate\.markFailed\(\)/);
assert.match(errorSource, /setMediaState\("failed"\)/);
assert.doesNotMatch(errorSource, /\bcomplete\(|onCompleteRef\.current/);

// ── A8: only the video beat overlay is lifted / genuinely scrollable ──
const canvas = await readSource("components/PlayCanvas.tsx");

assert.match(
  canvas,
  /data-video-beat-overlay=\{isVideoScene \? "true" : undefined\}/,
);
// Video overlay is its own z-layer and scrollport, with a bottom-aligned inner
// so short screens can scroll all choices and dialogue instead of clipping.
assert.match(
  canvas,
  /"absolute inset-0 select-none z-\[35\] flex flex-col overflow-y-auto overscroll-contain pointer-events-auto"/,
);
assert.match(
  canvas,
  /className=\{isVideoScene \? "mt-auto w-full" : "contents"\}/,
);
// Image overlay keeps the exact historical class string and layout.
assert.match(
  canvas,
  /"absolute inset-0 flex flex-col justify-end pointer-events-none select-none"/,
);
assert.doesNotMatch(canvas, /className="[^"]*\bz-\[35\][^"]*"/);
// Video choices use the overlay scrollport (no nested 45dvh scroller); the
// image portrait branch stays byte-for-byte the legacy one.
assert.match(
  canvas,
  /isVideoScene\s*\?\s*portrait\s*\?\s*"flex-col gap-2"\s*:\s*"gap-\[1\.5%\]"\s*:\s*portrait\s*\?\s*"vn-scrollbar flex-col gap-2 max-h-\[45dvh\] overflow-y-auto"\s*:\s*"gap-\[1\.5%\]"/s,
);

// Followup: the create section now carries the scoped class itself.
const mobileApp = await readSource("components/MobileDreamFrameApp.tsx");
assert.match(
  mobileApp,
  /className="mobile-df-scroll-screen mobile-df-create-screen"/,
);

// ── B7: create-screen-only nav clearance and tap targets ──
const css = await readSource("app/globals.css");
const marker = css.indexOf("B7: create-tab only clearance");
assert.ok(marker >= 0, "B7 scoped create-screen block must exist");
const blockEnd = css.indexOf(".mobile-df-toast", marker);
assert.ok(blockEnd > marker, "B7 block must be locatable");
const block = css.slice(marker, blockEnd);

assert.match(block, /\.mobile-df-create-screen\s*\{/);
assert.match(
  block,
  /--mobile-df-create-nav-clearance:\s*calc\(76px \+ env\(safe-area-inset-bottom\)\)/,
);
assert.match(block, /--mobile-df-create-inner-bottom:\s*20px/);
// The create scroll viewport itself ends above the fixed nav (not merely a
// larger inner padding that content could scroll past).
assert.match(block, /bottom:\s*var\(--mobile-df-create-nav-clearance\)/);
assert.match(block, /padding-bottom:\s*var\(--mobile-df-create-inner-bottom\)/);
assert.match(
  block,
  /scroll-padding-bottom:\s*var\(--mobile-df-create-inner-bottom\)/,
);
assert.match(block, /min-width:\s*44px/);
assert.match(block, /min-height:\s*44px/);
// The create header track accommodates the 44px back target without overlap.
assert.match(
  block,
  /\.mobile-df-create-screen \.mobile-df-page-head\s*\{[^}]*grid-template-columns:\s*44px 1fr/s,
);
// Counterexample: the touch-target rule must not shrink authored big cards.
assert.match(
  block,
  /\.mobile-df-create-screen \.mobile-df-create-grid button\s*\{[^}]*min-height:\s*112px/s,
);
assert.match(
  block,
  /\.mobile-df-create-screen \.mobile-df-create-grid button\.wide\s*\{[^}]*min-height:\s*94px/s,
);
assert.match(block, /\.mobile-df-create-screen textarea\s*\{/);
assert.match(block, /scroll-margin-top:\s*72px/);
assert.match(block, /scroll-margin-bottom:\s*24px/);
assert.match(block, /@media \(max-width: 767px\)/);
assert.match(block, /font-size:\s*16px/);
assert.match(block, /\.mobile-df-phone:has\(\.mobile-df-create-screen\)/);
assert.match(block, /min-height:\s*100dvh/);

// Counterexample: no unscoped selector sneaks into the B7 block.
const selectorLines = block
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => {
    if (
      !line ||
      line.startsWith("/*") ||
      line.startsWith("*") ||
      line.startsWith("//")
    ) {
      return false;
    }
    return line.endsWith(",") || line.endsWith("{");
  });
for (const selectorLine of selectorLines) {
  if (selectorLine.startsWith("@media")) continue;
  assert.ok(
    selectorLine.startsWith(".mobile-df-create-screen") ||
      selectorLine.startsWith(
        ".mobile-df-phone:has(.mobile-df-create-screen)",
      ),
    `unscoped B7 selector: ${selectorLine}`,
  );
}

// Shared nav and other scroll screens keep their original geometry.
const navStart = css.indexOf(".mobile-df-bottom-nav {");
const navEnd = css.indexOf(
  ".mobile-df-day .mobile-df-bottom-nav",
  navStart,
);
assert.ok(navStart >= 0 && navEnd > navStart);
const nav = css.slice(navStart, navEnd);
assert.match(nav, /bottom:\s*max\(12px, env\(safe-area-inset-bottom\)\)/);
assert.match(nav, /padding:\s*7px;/);
assert.match(
  css,
  /\.mobile-df-scroll-screen\s*\{[^}]*padding:\s*54px 16px 104px;/s,
);

console.log("issue mobile video/overlay + B7 create CSS tests passed");
