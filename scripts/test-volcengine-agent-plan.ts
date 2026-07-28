import assert from "node:assert/strict";

const {
  VolcengineAgentPlanVideoClient,
  buildVolcengineVideoSubmitBody,
  classifyVolcengineVideoFailure,
  normalizeVolcengineVideoTask,
} = await import("../lib/providers/volcengine-agent-plan/contract");
const {
  discoverVolcengineAgentPlanStatus,
  getVolcengineAgentPlanConfig,
  getVolcengineAgentPlanVideoEndpoints,
  validateVolcengineAgentPlanConfig,
} = await import("../lib/providers/volcengine-agent-plan/server");
const { getProviderDescriptor } = await import("../lib/providers/registry");
const { VOLCENGINE_VIDEO_PENDING_MESSAGE } = await import(
  "../lib/providers/volcengine-agent-plan/types"
);
type VolcengineVideoRawTask = import(
  "../lib/providers/volcengine-agent-plan/types"
).VolcengineVideoRawTask;
type VolcengineVideoSubmitBody = import(
  "../lib/providers/volcengine-agent-plan/types"
).VolcengineVideoSubmitBody;
type VolcengineVideoTransport = import(
  "../lib/providers/volcengine-agent-plan/types"
).VolcengineVideoTransport;

const disabled = discoverVolcengineAgentPlanStatus({});
assert.equal(disabled.state, "disabled");
assert.equal(disabled.available, false);
assert.equal(disabled.networkEnabled, false);

const missingCredential = discoverVolcengineAgentPlanStatus({
  VOLCENGINE_AGENT_PLAN_ENABLED: "true",
  VOLCENGINE_AGENT_PLAN_VIDEO_MODEL: "doubao-seedance-test",
});
assert.equal(missingCredential.state, "not_configured");

const invalid = discoverVolcengineAgentPlanStatus({
  VOLCENGINE_AGENT_PLAN_ENABLED: "true",
  VOLCENGINE_AGENT_PLAN_BASE_URL: "https://evil.example/api/plan/v3",
  VOLCENGINE_AGENT_PLAN_API_KEY: "fixture-key-never-logged",
  VOLCENGINE_AGENT_PLAN_VIDEO_MODEL: "doubao-seedance-test",
});
assert.equal(invalid.state, "invalid_config");

const configuredEnv = {
  VOLCENGINE_AGENT_PLAN_ENABLED: "true",
  VOLCENGINE_AGENT_PLAN_BASE_URL:
    "https://ark.cn-beijing.volces.com/api/plan/v3",
  VOLCENGINE_AGENT_PLAN_API_KEY: "fixture-key-never-logged",
  VOLCENGINE_AGENT_PLAN_VIDEO_MODEL: "doubao-seedance-test",
  AISTORY_TEXT_PRODUCT_PROVIDER: "volcengine-agent-plan",
  AISTORY_IMAGE_PRODUCT_PROVIDER: "bailian",
  AISTORY_TTS_PRODUCT_PROVIDER: "bailian",
};
const configured = discoverVolcengineAgentPlanStatus(configuredEnv);
assert.equal(configured.state, "contract_ready");
assert.equal(configured.configured, true);
assert.equal(configured.available, false);
assert.equal(configured.routing.text, "volcengine-agent-plan");
assert.equal(configured.routing.automaticFallback, false);
assert.equal(JSON.stringify(configured).includes("fixture-key-never-logged"), false);

const config = getVolcengineAgentPlanConfig(configuredEnv);
assert.deepEqual(validateVolcengineAgentPlanConfig(config), []);
assert.deepEqual(getVolcengineAgentPlanVideoEndpoints(config), {
  collection:
    "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks",
});
assert.equal(
  getVolcengineAgentPlanVideoEndpoints(config, "cgt-20260000-task01").task,
  "https://ark.cn-beijing.volces.com/api/plan/v3/contents/generations/tasks/cgt-20260000-task01",
);

const descriptor = getProviderDescriptor("volcengine-agent-plan");
assert.equal(descriptor.capabilities.video, "async_contract");
assert.equal(descriptor.capabilities.text, "selection_only");
assert.equal(VOLCENGINE_VIDEO_PENDING_MESSAGE, "视频生成中，故事继续");

const body = buildVolcengineVideoSubmitBody({
  model: "doubao-seedance-test",
  prompt: "镜头缓慢拉远",
  imageUrl: "https://assets.example/reference.png",
  returnLastFrame: true,
  idempotencyKey: "video-request-0001",
});
assert.deepEqual(body, {
  model: "doubao-seedance-test",
  content: [
    { type: "text", text: "镜头缓慢拉远" },
    {
      type: "image_url",
      image_url: { url: "https://assets.example/reference.png" },
    },
  ],
  return_last_frame: true,
});
assert.equal(JSON.stringify(body).includes("idempotency"), false);
await assert.rejects(
  async () =>
    buildVolcengineVideoSubmitBody({
      model: "doubao-seedance-test",
      prompt: "test",
      imageUrl: "http://127.0.0.1/private.png",
      idempotencyKey: "video-request-0002",
    }),
  /must use HTTPS/,
);

let submitCount = 0;
let cancelCount = 0;
let submittedBody: VolcengineVideoSubmitBody | undefined;
const states: VolcengineVideoRawTask[] = [
  { id: "cgt-20260000-task02", status: "queued" },
  { id: "cgt-20260000-task02", status: "running" },
  {
    id: "cgt-20260000-task02",
    status: "succeeded",
    updated_at: 1_750_000_000,
    content: { video_url: "https://result.example/video.mp4" },
    usage: { total_tokens: 1234 },
  },
];
const transport: VolcengineVideoTransport = {
  async submit(nextBody) {
    submitCount += 1;
    submittedBody = nextBody;
    return { id: "cgt-20260000-task02" };
  },
  async get() {
    const next = states.shift();
    if (!next) throw new Error("fixture exhausted");
    return next;
  },
  async cancel() {
    cancelCount += 1;
  },
};
const client = new VolcengineAgentPlanVideoClient(transport);
const input = {
  model: "doubao-seedance-test",
  prompt: "雨夜中的追逐镜头",
  idempotencyKey: "video-request-0003",
};
const [submittedA, submittedB] = await Promise.all([
  client.submit(input),
  client.submit(input),
]);
assert.equal(submitCount, 1);
assert.equal(submittedA.providerTaskId, submittedB.providerTaskId);
assert.equal(submittedA.requestFingerprint.length, 64);
assert.equal(submittedBody?.model, "doubao-seedance-test");

assert.equal((await client.poll(submittedA.providerTaskId)).status, "queued");
assert.equal((await client.poll(submittedA.providerTaskId)).status, "pending");
const succeeded = await client.poll(submittedA.providerTaskId);
assert.equal(succeeded.status, "succeeded");
assert.equal(succeeded.resultUrl, "https://result.example/video.mp4");
assert.equal(succeeded.usageTokens, 1234);

const queuedTask = { ...submittedA, status: "queued" as const };
const cancelled = await client.cancel(queuedTask);
assert.equal(cancelled.status, "cancelled");
assert.equal(cancelCount, 1);
await assert.rejects(
  () => client.cancel({ ...queuedTask, status: "pending" }),
  /only supports cancellation while.*queued/,
);
assert.equal(cancelCount, 1);

assert.deepEqual(classifyVolcengineVideoFailure(429), {
  retryable: true,
  ambiguousSubmit: false,
});
assert.deepEqual(classifyVolcengineVideoFailure(503), {
  retryable: true,
  ambiguousSubmit: true,
});
assert.deepEqual(classifyVolcengineVideoFailure(400), {
  retryable: false,
  ambiguousSubmit: false,
});
const failed = normalizeVolcengineVideoTask(
  {
    id: "cgt-20260000-task03",
    status: "failed",
    error: { code: "OutputVideoSensitiveContentDetected" },
  },
  "fingerprint",
);
assert.equal(failed.status, "failed");
assert.equal(failed.errorCode, "OutputVideoSensitiveContentDetected");

console.log("Volcengine Agent Plan contract tests passed.");
