import assert from "node:assert/strict";
import test from "node:test";

import { resolvePublishSubmission } from "../lib/shared-stories/publishPolicy";
import {
  SHARED_STORY_DISABLED_MESSAGE,
  isSharingDisabledFailure,
  isSharingDisabledPayload,
  readSharingDisabled,
} from "../lib/shared-stories/shareAvailability";

test("only 503 with the exact disabled code is classified as disabled", () => {
  assert.equal(isSharingDisabledFailure(503, { code: "disabled" }), true);
  assert.equal(isSharingDisabledFailure(503, { code: "maintenance" }), false);
  assert.equal(isSharingDisabledFailure(503, { code: "DISABLED" }), false);
  assert.equal(isSharingDisabledFailure(503, {}), false);
  assert.equal(isSharingDisabledFailure(503, null), false);
  assert.equal(isSharingDisabledFailure(200, { code: "disabled" }), false);
  assert.equal(isSharingDisabledPayload([{ code: "disabled" }]), false);
  assert.equal(isSharingDisabledPayload("disabled"), false);
});

test("parse errors and malformed 503 payloads stay generic", async () => {
  const malformed = new Response("<html>503</html>", { status: 503 });
  assert.equal(await readSharingDisabled(malformed), false);

  const wrongShape = new Response(JSON.stringify({ status: "disabled" }), {
    status: 503,
  });
  assert.equal(await readSharingDisabled(wrongShape), false);

  const disabled = new Response(JSON.stringify({ code: "disabled" }), {
    status: 503,
  });
  assert.equal(await readSharingDisabled(disabled), true);

  const wrongStatus = new Response(JSON.stringify({ code: "disabled" }), {
    status: 500,
  });
  assert.equal(await readSharingDisabled(wrongStatus), false);
});

test("disabled owner lookup still aborts before any POST", () => {
  // The publish panel maps a disabled lookup to "unknown", which the untouched
  // policy must keep aborting.
  assert.deepEqual(
    resolvePublishSubmission({ status: "unknown" }, "public", true),
    { type: "abort", reason: "unknown" },
  );
  assert.equal(SHARED_STORY_DISABLED_MESSAGE, "当前环境尚未开放作品分享");
});
