import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  CREATOR_STUDIO_BRIDGE_PROTOCOL_VERSION,
  CREATOR_STUDIO_SELECTED_PROJECT_STORAGE_KEY,
  buildCreatorStudioHostContext,
  buildCreatorStudioOpenModuleMessage,
  buildCreatorStudioProjectSelectedMessage,
  buildCreatorStudioReadyMessage,
  parseCreatorStudioInboundMessage,
  readRememberedCreatorStudioProject,
  rememberCreatorStudioProject,
  resolveCreatorStudioBridgeAction,
  type CreatorStudioInboundMessage,
  type CreatorStudioOpenModuleIntent,
} from "../lib/creator-studio/bridge";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

assert.equal(CREATOR_STUDIO_BRIDGE_PROTOCOL_VERSION, 1);

const projectSelected = buildCreatorStudioProjectSelectedMessage(7);
assert.ok(projectSelected);
assert.deepEqual(projectSelected, {
  protocolVersion: 1,
  type: "aistory:localminidrama:project-selected",
  projectId: 7,
});
assert.deepEqual(parseCreatorStudioInboundMessage(projectSelected), projectSelected);

const intents: CreatorStudioOpenModuleIntent[] = [
  { projectId: 7, module: "tasks" },
  { projectId: 7, module: "tasks", taskId: "job:2026-08-12_01" },
  { projectId: 7, module: "media", mediaKind: "image" },
  { projectId: 7, module: "media", mediaKind: "video" },
  { projectId: 7, module: "media", mediaKind: "audio" },
  { projectId: 7, module: "media", mediaKind: "all" },
  { projectId: 7, module: "local-generation" },
];

const inboundMessages: CreatorStudioInboundMessage[] = [
  projectSelected!,
  buildCreatorStudioReadyMessage(),
];
for (const intent of intents) {
  const message = buildCreatorStudioOpenModuleMessage(intent);
  assert.ok(message, `builder rejected ${intent.module}`);
  assert.deepEqual(parseCreatorStudioInboundMessage(message), message);
  inboundMessages.push(message);

  const hostContext = buildCreatorStudioHostContext({ projectId: 7, intent });
  assert.ok(hostContext, `host context rejected ${intent.module}`);
  assert.equal(hostContext.projectId, 7);
  assert.equal(hostContext.module, intent.module);
}
assert.deepEqual(buildCreatorStudioHostContext({ projectId: null }), {
  protocolVersion: 1,
  type: "aistory:host-context",
  projectId: null,
});
assert.equal(
  buildCreatorStudioHostContext({
    projectId: 8,
    intent: { projectId: 7, module: "tasks" },
  }),
  null,
);

for (const projectId of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(buildCreatorStudioProjectSelectedMessage(projectId), null);
}
assert.equal(
  parseCreatorStudioInboundMessage({
    protocolVersion: 1,
    type: "aistory:localminidrama:project-selected",
    projectId: "7",
  }),
  null,
);

const invalidMessages: unknown[] = [
  null,
  [],
  "message",
  { type: "aistory:localminidrama:ready" },
  { protocolVersion: 2, type: "aistory:localminidrama:ready" },
  { protocolVersion: 1, type: "unknown" },
  {
    protocolVersion: 1,
    type: "aistory:localminidrama:open-module",
    projectId: 7,
    module: "models",
  },
  {
    protocolVersion: 1,
    type: "aistory:localminidrama:open-module",
    projectId: 7,
    module: "media",
  },
  {
    protocolVersion: 1,
    type: "aistory:localminidrama:open-module",
    projectId: 7,
    module: "media",
    mediaKind: "document",
  },
  {
    protocolVersion: 1,
    type: "aistory:localminidrama:open-module",
    projectId: 7,
    module: "tasks",
    taskId: "unsafe/task",
  },
  {
    protocolVersion: 1,
    type: "aistory:localminidrama:open-module",
    projectId: 7,
    module: "tasks",
    taskId: "x".repeat(121),
  },
  {
    protocolVersion: 1,
    type: "aistory:localminidrama:open-module",
    projectId: 7,
    module: "local-generation",
    mediaKind: "all",
  },
];
for (const message of invalidMessages) {
  assert.equal(parseCreatorStudioInboundMessage(message), null);
}
assert.ok(
  buildCreatorStudioOpenModuleMessage({
    projectId: 7,
    module: "tasks",
    taskId: "x".repeat(120),
  }),
);

for (const sensitiveField of [
  "localPath",
  "providerTaskId",
  "prompt",
  "workflow",
  "apiKey",
  "token",
]) {
  assert.equal(
    parseCreatorStudioInboundMessage({
      ...projectSelected,
      [sensitiveField]: `PRIVATE_${sensitiveField}`,
    }),
    null,
    `accepted extra field ${sensitiveField}`,
  );
}

const inherited = Object.create({
  protocolVersion: 1,
  type: "aistory:localminidrama:project-selected",
  projectId: 7,
});
assert.equal(parseCreatorStudioInboundMessage(inherited), null);

const nonEnumerable = { ...projectSelected };
Object.defineProperty(nonEnumerable, "token", {
  value: "PRIVATE_TOKEN",
  enumerable: false,
});
assert.equal(parseCreatorStudioInboundMessage(nonEnumerable), null);

const symbolPayload = { ...projectSelected };
Object.defineProperty(symbolPayload, Symbol("token"), {
  value: "PRIVATE_TOKEN",
  enumerable: true,
});
assert.equal(parseCreatorStudioInboundMessage(symbolPayload), null);

const revoked = Proxy.revocable({ ...projectSelected }, {});
revoked.revoke();
assert.doesNotThrow(() => parseCreatorStudioInboundMessage(revoked.proxy));
assert.equal(parseCreatorStudioInboundMessage(revoked.proxy), null);

const trustedSource = {};
const trustedOrigin = "http://127.0.0.1:4107";
const actionContext = {
  trustedOrigin,
  trustedSource,
  knownProjectIds: [7, 8],
  currentProjectId: 7,
};
assert.deepEqual(
  resolveCreatorStudioBridgeAction(
    { origin: trustedOrigin, source: trustedSource, data: projectSelected },
    actionContext,
  ),
  { kind: "project-selected", projectId: 7 },
);
assert.deepEqual(
  resolveCreatorStudioBridgeAction(
    {
      origin: trustedOrigin,
      source: trustedSource,
      data: buildCreatorStudioOpenModuleMessage({
        projectId: 7,
        module: "media",
        mediaKind: "image",
      }),
    },
    actionContext,
  ),
  {
    kind: "open-module",
    intent: { projectId: 7, module: "media", mediaKind: "image" },
  },
);
assert.deepEqual(
  resolveCreatorStudioBridgeAction(
    {
      origin: trustedOrigin,
      source: trustedSource,
      data: buildCreatorStudioReadyMessage(),
    },
    actionContext,
  ),
  { kind: "ready" },
);

for (const rejected of [
  {
    origin: "http://localhost:4107",
    source: trustedSource,
    data: projectSelected,
  },
  { origin: trustedOrigin, source: {}, data: projectSelected },
  {
    origin: trustedOrigin,
    source: trustedSource,
    data: buildCreatorStudioProjectSelectedMessage(99),
  },
  {
    origin: trustedOrigin,
    source: trustedSource,
    data: buildCreatorStudioOpenModuleMessage({
      projectId: 8,
      module: "tasks",
    }),
  },
]) {
  assert.equal(resolveCreatorStudioBridgeAction(rejected, actionContext), null);
}

const storage = new MemoryStorage();
assert.equal(rememberCreatorStudioProject(storage, 8), true);
assert.equal(
  storage.getItem(CREATOR_STUDIO_SELECTED_PROJECT_STORAGE_KEY),
  "8",
);
assert.equal(readRememberedCreatorStudioProject(storage, [7, 8]), 8);
assert.equal(readRememberedCreatorStudioProject(storage, [7]), null);
assert.equal(rememberCreatorStudioProject(storage, 0), false);

const publicDtos = JSON.stringify([
  ...inboundMessages,
  ...intents.map((intent) => buildCreatorStudioHostContext({
    projectId: intent.projectId,
    intent,
  })),
]).toLowerCase();
for (const forbidden of [
  "localpath",
  "local_path",
  "providertaskid",
  "provider_task_id",
  "prompt",
  "workflow",
  "apikey",
  "api_key",
  "token",
  "secret",
]) {
  assert.equal(publicDtos.includes(forbidden), false, `DTO leaked ${forbidden}`);
}

const shellSource = await readFile(
  new URL("../components/CreatorStudioShell.tsx", import.meta.url),
  "utf8",
);
assert.match(shellSource, /resolveCreatorStudioBridgeAction\(event,/);
assert.match(shellSource, /knownProjectIds: projects\.map/);
assert.match(shellSource, /setProjectContextRevision/);
assert.match(shellSource, /data-creator-bridge-state=\{bridgeState\}/);
assert.match(shellSource, /awaiting_donor_sender/);
assert.doesNotMatch(shellSource, /Number\(event\.data\.projectId\)/);

const panelSource = await readFile(
  new URL("../components/CreatorProjectContextPanel.tsx", import.meta.url),
  "utf8",
);
assert.match(panelSource, /data-studio-context-target="tasks"/);
assert.match(panelSource, /data-studio-media-kind="image"/);
assert.match(panelSource, /data-studio-media-kind="video"/);
assert.match(panelSource, /data-studio-context-target="local-generation"/);
assert.match(panelSource, /data-studio-active-task=\{task\.id\}/);

console.log("Creator Studio typed bridge tests passed (zero network).");
