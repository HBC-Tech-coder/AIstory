import assert from "node:assert/strict";
import { readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

import type { AdminAuditLog, AdminActor } from "../lib/admin/types.ts";

const previousRegistryRoot = process.env.AISTORY_COMFYUI_REGISTRY_DIR;
const testRoot = await mkdtemp(
  path.join(tmpdir(), "aistory-comfyui-workflow-registry-"),
);
const registryRoot = path.join(testRoot, "registry");
process.env.AISTORY_COMFYUI_REGISTRY_DIR = registryRoot;

const originalFetch = globalThis.fetch;
let networkCallCount = 0;
globalThis.fetch = async () => {
  networkCallCount += 1;
  throw new Error("NETWORK_DISABLED_IN_WORKFLOW_REGISTRY_TEST");
};

const promptMarker = "PRIVATE_PROMPT_MARKER_MUST_NOT_LEAK";
const secretMarker = "SYNTHETIC_SECRET_MUST_NOT_LEAK";
const localPathMarker = "C:\\private\\workflow.json";

function workflowPackage(
  marker: string,
  options: { id?: string; modality?: "image" | "video" } = {},
) {
  const id = options.id ?? "portrait-safe";
  const modality = options.modality ?? "image";
  return {
    schemaVersion: 1,
    template: {
      id,
      name: modality === "video" ? "安全视频" : "安全人像",
      modality,
      workflow: {
        workflow: {
          prompt: {
            class_type: "CLIPTextEncode",
            inputs: {
              text: `${promptMarker}:${marker}`,
              ckpt_name: "approved/checkpoints/base.safetensors",
              lora_name: "approved/loras/continuity.safetensors",
              lora_model_weight: 0.7,
              lora_clip_weight: 0.7,
              control_model: "approved/controlnets/pose.safetensors",
              control_strength: 0.8,
              control_start: 0,
              control_end: 1,
              control_image: "upload/pose.png",
              face_reference: "upload/identity.png",
            },
          },
          output: {
            class_type: modality === "video" ? "SaveVideo" : "SaveImage",
            inputs: { images: ["prompt", 0] },
          },
        },
        outputNodeIds: ["output"],
        bindings: {
          positivePrompt: { nodeId: "prompt", input: "text" },
          checkpoint: { nodeId: "prompt", input: "ckpt_name" },
          loras: [
            {
              name: { nodeId: "prompt", input: "lora_name" },
              modelWeight: {
                nodeId: "prompt",
                input: "lora_model_weight",
              },
              clipWeight: {
                nodeId: "prompt",
                input: "lora_clip_weight",
              },
            },
          ],
          controlNets: [
            {
              model: { nodeId: "prompt", input: "control_model" },
              strength: { nodeId: "prompt", input: "control_strength" },
              startPercent: { nodeId: "prompt", input: "control_start" },
              endPercent: { nodeId: "prompt", input: "control_end" },
              referenceImage: { nodeId: "prompt", input: "control_image" },
            },
          ],
          referenceImages: {
            identity: { nodeId: "prompt", input: "face_reference" },
          },
          faceReference: { nodeId: "prompt", input: "face_reference" },
          ...(modality === "video"
            ? { videoNodes: [{ nodeId: "output", input: "images" }] }
            : {}),
        },
      },
      checkpoint: "approved/checkpoints/base.safetensors",
      loras: [
        {
          name: "approved/loras/continuity.safetensors",
          modelWeight: 0.7,
          clipWeight: 0.7,
        },
      ],
      controlNets: [
        {
          model: "approved/controlnets/pose.safetensors",
          strength: 0.8,
          startPercent: 0,
          endPercent: 1,
          referenceSlot: "pose",
        },
      ],
      faceContinuity: { enabled: true, referenceSlot: "identity" },
    },
  };
}

function clonePackage<T>(value: T): T {
  return structuredClone(value);
}

function assertSafePublicValue(
  value: unknown,
  extraMarkers: readonly string[] = [],
): void {
  const forbiddenKeys = new Set([
    "workflow",
    "bindings",
    "inputs",
    "prompt",
    "checkpoint",
    "loras",
    "controlnets",
    "facecontinuity",
    "localpath",
    "registrypath",
    "providertaskid",
    "apikey",
    "accesskey",
    "secret",
    "token",
    "password",
    "authorization",
    "cookie",
  ]);
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!current || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
      assert.equal(
        forbiddenKeys.has(normalized),
        false,
        `unsafe public key: ${key}`,
      );
      visit(child);
    }
  };
  visit(value);
  const serialized = JSON.stringify(value);
  for (const marker of [
    promptMarker,
    secretMarker,
    localPathMarker,
    "approved/checkpoints",
    "approved/loras",
    "approved/controlnets",
    "sk-proj-SYNTHETIC000000000000",
    "AKIAABCDEFGHIJKLMNOP",
    "LTAISYNTHETIC000000",
    "ghp_SYNTHETIC0000000000000000",
    "eyJzeW50aGV0aWMiOiIxIn0",
    ...extraMarkers,
  ]) {
    assert.equal(serialized.includes(marker), false, `leaked marker: ${marker}`);
  }
}

function request(
  method: "GET" | "POST" | "PATCH",
  body?: string,
  overrides: Record<string, string> = {},
): Request {
  const headers = new Headers({
    Host: "127.0.0.1:4200",
    Origin: "http://127.0.0.1:4200",
    ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    ...overrides,
  });
  return new Request("http://127.0.0.1:4200/api/admin/comfyui/workflows", {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

async function registrySnapshot(): Promise<string | null> {
  try {
    return await readFile(path.join(registryRoot, "registry.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

try {
  const {
    configureComfyUIWorkflowTemplate,
    importComfyUIWorkflowTemplate,
    listComfyUIWorkflowTemplateManagementSummaries,
  } = await import("../lib/providers/comfyui/registry.ts");
  const { parseComfyUIWorkflowPackage } = await import(
    "../lib/providers/comfyui/workflowPackage.ts"
  );
  const { createComfyUIWorkflowRegistryRouteHandlers } = await import(
    "../lib/providers/comfyui/workflowRegistryRoute.ts"
  );

  const validImage = workflowPackage("v1");
  const validVideo = workflowPackage("v1-video", {
    id: "video-safe",
    modality: "video",
  });
  const parsedImage = parseComfyUIWorkflowPackage(validImage);
  assert.equal(parsedImage.ok, true);
  assert.equal(parsedImage.ok && parsedImage.value.dryResult.nodeCount, 2);
  assert.match(
    parsedImage.ok ? parsedImage.value.dryResult.fingerprint ?? "" : "",
    /^[a-f0-9]{64}$/,
  );
  assert.equal(parseComfyUIWorkflowPackage(validVideo).ok, true);
  if (!parsedImage.ok) throw new Error("valid image package did not parse");
  assert.equal(await registrySnapshot(), null);
  await assert.rejects(
    () =>
      importComfyUIWorkflowTemplate({
        ...parsedImage.value.input,
        name: "unsafe\nworkflow name",
      }),
    /safe/i,
  );
  assert.equal(await registrySnapshot(), null);

  const invalidPackages: unknown[] = [
    null,
    [],
    {},
    { ...validImage, schemaVersion: 2 },
    { ...validImage, unexpected: true },
    Object.assign(Object.create({ inherited: true }), validImage),
  ];
  for (const dangerousKey of ["__proto__", "prototype", "constructor"]) {
    const dangerousPackage = clonePackage(validImage);
    Object.defineProperty(dangerousPackage.template, dangerousKey, {
      value: { marker: secretMarker },
      enumerable: true,
    });
    invalidPackages.push(dangerousPackage);
  }
  const nonEnumerable = clonePackage(validImage);
  Object.defineProperty(nonEnumerable.template, "token", {
    value: secretMarker,
    enumerable: false,
  });
  invalidPackages.push(nonEnumerable);
  const symbolField = clonePackage(validImage);
  Object.defineProperty(symbolField.template, Symbol("token"), {
    value: secretMarker,
    enumerable: true,
  });
  invalidPackages.push(symbolField);
  const accessorField = clonePackage(validImage);
  Object.defineProperty(accessorField.template, "name", {
    get: () => "unsafe",
    enumerable: true,
  });
  invalidPackages.push(accessorField);
  const revoked = Proxy.revocable(clonePackage(validImage), {});
  revoked.revoke();
  invalidPackages.push(revoked.proxy);
  for (const item of invalidPackages) {
    const result = parseComfyUIWorkflowPackage(item);
    assert.equal(result.ok, false);
    if (!result.ok) assertSafePublicValue(result.dryResult, [secretMarker]);
  }

  const invalidBinding = clonePackage(validImage);
  invalidBinding.template.workflow.bindings.positivePrompt.input = "missing_input";
  const invalidBindingResult = parseComfyUIWorkflowPackage(invalidBinding);
  assert.equal(invalidBindingResult.ok, false);
  if (!invalidBindingResult.ok) {
    assert.deepEqual(
      invalidBindingResult.dryResult.issues.map((item) => item.path),
      ["template.workflow.bindings"],
    );
    assertSafePublicValue(invalidBindingResult.dryResult);
  }

  for (const unsafePath of [
    "/etc/passwd",
    "C:\\private\\model.safetensors",
    "C:private\\model.safetensors",
    "\\\\server\\share\\model.safetensors",
    "file:///private/model.safetensors",
    "file:C:\\private\\model.safetensors",
    "file:/private/model.safetensors",
    "approved/../private/model.safetensors",
    "approved/%2e%2e%2fprivate/model.safetensors",
  ]) {
    const unsafe = clonePackage(validImage);
    unsafe.template.checkpoint = unsafePath;
    const result = parseComfyUIWorkflowPackage(unsafe);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.dryResult.issues[0]?.code, "forbidden_path");
    if (!result.ok) assertSafePublicValue(result.dryResult, [unsafePath]);
  }
  for (const unsafeKey of [
    "../escape-node",
    "/absolute-input",
    "C:\\private\\metadata",
  ]) {
    const unsafe = clonePackage(validImage);
    if (unsafeKey.includes("node")) {
      Object.defineProperty(unsafe.template.workflow.workflow, unsafeKey, {
        value: { class_type: "Noop", inputs: {} },
        enumerable: true,
      });
    } else if (unsafeKey.includes("input")) {
      Object.defineProperty(
        unsafe.template.workflow.workflow.prompt.inputs,
        unsafeKey,
        { value: "x", enumerable: true },
      );
    } else {
      unsafe.template.workflow.workflow.prompt._meta = {};
      Object.defineProperty(
        unsafe.template.workflow.workflow.prompt._meta,
        unsafeKey,
        { value: "x", enumerable: true },
      );
    }
    const result = parseComfyUIWorkflowPackage(unsafe);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.dryResult.issues[0]?.code, "forbidden_path");
    if (!result.ok) assertSafePublicValue(result.dryResult, [unsafeKey]);
  }
  const secretPackages = [
    ...[
      "apiKey",
      "accessKeyId",
      "secretValue",
      "tokenValue",
      "accessTokenValue",
      "sessionTokenValue",
      "passwordValue",
      "authorizationHeader",
      "cookieHeader",
      "x-api-key",
      "privateKey",
      "credentials",
    ].map((secretKey) => {
      const value = clonePackage(validImage);
      Object.defineProperty(
        value.template.workflow.workflow.prompt.inputs,
        secretKey,
        { value: secretMarker, enumerable: true },
      );
      return value;
    }),
    ...[
      `Bearer ${secretMarker}`,
      `Basic ${Buffer.from(secretMarker).toString("base64")}`,
      "sk-proj-SYNTHETIC000000000000",
      "AKIAABCDEFGHIJKLMNOP",
      "LTAISYNTHETIC000000",
      "ghp_SYNTHETIC0000000000000000",
      "eyJzeW50aGV0aWMiOiIxIn0.eyJzZWNyZXQiOiIyIn0.c2lnbmF0dXJl",
    ].map((secretValue) => {
      const value = clonePackage(validImage);
      value.template.workflow.workflow.prompt.inputs.text = secretValue;
      return value;
    }),
  ];
  for (const secretPackage of secretPackages) {
    const result = parseComfyUIWorkflowPackage(secretPackage);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.dryResult.issues[0]?.code, "secret_material");
    if (!result.ok) assertSafePublicValue(result.dryResult, [secretMarker]);
  }
  const invalidFaceContinuity = clonePackage(validImage);
  (
    invalidFaceContinuity.template as unknown as { faceContinuity: unknown }
  ).faceContinuity = { enabled: "yes", referenceSlot: { unsafe: true } };
  assert.equal(parseComfyUIWorkflowPackage(invalidFaceContinuity).ok, false);
  const invalidControlSlot = clonePackage(validImage);
  (
    invalidControlSlot.template.controlNets[0] as unknown as {
      referenceSlot: unknown;
    }
  ).referenceSlot = { unsafe: true };
  assert.equal(parseComfyUIWorkflowPackage(invalidControlSlot).ok, false);
  const oversizePackage = clonePackage(validImage);
  oversizePackage.template.workflow.workflow.prompt.inputs.text = "x".repeat(
    2 * 1024 * 1024,
  );
  const oversizeResult = parseComfyUIWorkflowPackage(oversizePackage);
  assert.equal(oversizeResult.ok, false);
  assert.equal(
    !oversizeResult.ok && oversizeResult.dryResult.issues[0]?.code,
    "package_too_large",
  );

  const actor: AdminActor = {
    userId: "local-workflow-admin",
    roles: ["super_admin"],
    mode: "local",
  };
  const audits: AdminAuditLog[] = [];
  let authorizeCount = 0;
  let occupiedWorkflowId: string | undefined;
  let occupiedWorkflowStatus:
    | "queued"
    | "running"
    | "pending"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "interrupted"
    | undefined;
  let occupancyCallCount = 0;
  let occupancyMustFail = false;
  const handlers = createComfyUIWorkflowRegistryRouteHandlers({
    authorize: async (roles) => {
      authorizeCount += 1;
      assert.deepEqual(roles, ["super_admin", "ops"]);
      return actor;
    },
    repositoryForActor: async (authorizedActor) => {
      assert.equal(authorizedActor, actor);
      return {
        appendAudit: async (log: AdminAuditLog) => {
          audits.push(structuredClone(log));
        },
      };
    },
    isWorkflowSelectionInUse: async (templateId) => {
      occupancyCallCount += 1;
      if (occupancyMustFail) throw new Error("synthetic job store failure");
      return (
        templateId === occupiedWorkflowId &&
        occupiedWorkflowStatus !== undefined &&
        ["queued", "running", "pending"].includes(occupiedWorkflowStatus)
      );
    },
  });

  const emptySnapshot = await registrySnapshot();
  assert.equal(emptySnapshot, null);
  const wrongHost = await handlers.POST(
    request(
      "POST",
      JSON.stringify({ action: "dry_validate", package: validImage }),
      { Host: "192.168.1.20:4200", Origin: "http://192.168.1.20:4200" },
    ),
  );
  assert.equal(wrongHost.status, 403);
  assert.equal(authorizeCount, 0);
  const wrongOrigin = await handlers.POST(
    request(
      "POST",
      JSON.stringify({ action: "dry_validate", package: validImage }),
      { Origin: "http://localhost:4200" },
    ),
  );
  assert.equal(wrongOrigin.status, 403);
  assert.equal(authorizeCount, 0);
  const missingOrigin = await handlers.POST(
    new Request("http://127.0.0.1:4200/api/admin/comfyui/workflows", {
      method: "POST",
      headers: {
        Host: "127.0.0.1:4200",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action: "dry_validate", package: validImage }),
    }),
  );
  assert.equal(missingOrigin.status, 403);
  for (const invalidOrigin of [
    "https://127.0.0.1:4200",
    "http://user@127.0.0.1:4200",
    "http://127.0.0.1:4200/path",
  ]) {
    const response = await handlers.POST(
      request(
        "POST",
        JSON.stringify({ action: "dry_validate", package: validImage }),
        { Origin: invalidOrigin },
      ),
    );
    assert.equal(response.status, 403);
  }
  assert.equal(authorizeCount, 0);
  const wrongType = await handlers.POST(
    request("POST", "{}", { "Content-Type": "text/plain" }),
  );
  assert.equal(wrongType.status, 415);
  const declaredOversize = await handlers.POST(
    request("POST", "{}", { "Content-Length": String(3 * 1024 * 1024) }),
  );
  assert.equal(declaredOversize.status, 413);
  const actualOversize = await handlers.POST(
    request("POST", "x".repeat(2 * 1024 * 1024 + 256 * 1024)),
  );
  assert.equal(actualOversize.status, 413);
  const invalidJson = await handlers.POST(request("POST", "{"));
  assert.equal(invalidJson.status, 400);
  const remoteGet = await handlers.GET(
    request("GET", undefined, { Host: "example.com", Origin: "https://example.com" }),
  );
  assert.equal(remoteGet.status, 403);
  assert.equal(await registrySnapshot(), null);
  assert.equal(audits.length, 0);

  const dryResponse = await handlers.POST(
    request(
      "POST",
      JSON.stringify({ action: "dry_validate", package: validImage }),
    ),
  );
  assert.equal(dryResponse.status, 200);
  const dryPayload = await responseJson(dryResponse);
  assertSafePublicValue(dryPayload);
  assert.equal(await registrySnapshot(), null);
  const validation = dryPayload.validation as {
    ok?: boolean;
    fingerprint?: string;
  };
  assert.equal(validation.ok, true);
  assert.match(validation.fingerprint ?? "", /^[a-f0-9]{64}$/);

  const hostileDryResponse = await handlers.POST(
    request(
      "POST",
      JSON.stringify({ action: "dry_validate", package: secretPackages[0] }),
    ),
  );
  assert.equal(hostileDryResponse.status, 400);
  assertSafePublicValue(await responseJson(hostileDryResponse), [secretMarker]);

  const noMutationSnapshot = await registrySnapshot();
  const confirmRequired = await handlers.POST(
    request(
      "POST",
      JSON.stringify({
        action: "import",
        package: validImage,
        expectedFingerprint: validation.fingerprint,
        reason: "synthetic local registry acceptance",
        confirm: false,
      }),
    ),
  );
  assert.equal(confirmRequired.status, 409);
  const fingerprintMismatch = await handlers.POST(
    request(
      "POST",
      JSON.stringify({
        action: "import",
        package: validImage,
        expectedFingerprint: "0".repeat(64),
        reason: "synthetic local registry acceptance",
        confirm: true,
      }),
    ),
  );
  assert.equal(fingerprintMismatch.status, 409);
  const missingReason = await handlers.POST(
    request(
      "POST",
      JSON.stringify({
        action: "import",
        package: validImage,
        expectedFingerprint: validation.fingerprint,
        confirm: true,
      }),
    ),
  );
  assert.equal(missingReason.status, 400);
  const unknownAction = await handlers.POST(
    request(
      "POST",
      JSON.stringify({
        action: "execute",
        package: validImage,
        expectedFingerprint: validation.fingerprint,
        reason: "must remain local-only",
        confirm: true,
      }),
    ),
  );
  assert.equal(unknownAction.status, 400);
  assert.equal(await registrySnapshot(), noMutationSnapshot);
  assert.equal(audits.length, 0);

  const importBody = (packageValue: unknown, expectedFingerprint: string) =>
    JSON.stringify({
      action: "import",
      package: packageValue,
      expectedFingerprint,
      reason: "synthetic local registry acceptance",
      confirm: true,
    });
  const importedResponse = await handlers.POST(
    request("POST", importBody(validImage, validation.fingerprint ?? "")),
  );
  assert.equal(importedResponse.status, 200);
  const importedPayload = await responseJson(importedResponse);
  assert.equal(importedPayload.changed, true);
  assertSafePublicValue(importedPayload);
  assert.equal(audits.length, 1);

  const firstRegistrySnapshot = await registrySnapshot();
  assert.ok(firstRegistrySnapshot);
  const retryResponse = await handlers.POST(
    request("POST", importBody(validImage, validation.fingerprint ?? "")),
  );
  assert.equal(retryResponse.status, 200);
  const retryPayload = await responseJson(retryResponse);
  assert.equal(retryPayload.changed, false);
  assert.equal(audits.length, 1);
  assert.equal(await registrySnapshot(), firstRegistrySnapshot);

  const validImageV2 = workflowPackage("v2");
  const parsedV2 = parseComfyUIWorkflowPackage(validImageV2);
  assert.equal(parsedV2.ok, true);
  const importedV2 = await handlers.POST(
    request(
      "POST",
      importBody(
        validImageV2,
        parsedV2.ok ? parsedV2.value.dryResult.fingerprint ?? "" : "",
      ),
    ),
  );
  assert.equal(importedV2.status, 200);
  assert.equal(audits.length, 2);

  const beforePatchGateSnapshot = await registrySnapshot();
  const patchGateCases: Array<[Request, number]> = [
    [
      request(
        "PATCH",
        JSON.stringify({
          templateId: "portrait-safe",
          enabled: true,
          reason: "must not mutate",
          confirm: true,
        }),
        { Origin: "http://localhost:4200" },
      ),
      403,
    ],
    [
      request("PATCH", "{}", { "Content-Type": "text/plain" }),
      415,
    ],
    [
      request(
        "PATCH",
        JSON.stringify({
          templateId: "portrait-safe",
          enabled: true,
          reason: "confirmation missing",
          confirm: false,
        }),
      ),
      409,
    ],
    [
      request(
        "PATCH",
        JSON.stringify({
          templateId: "portrait-safe",
          activeVersion: 999,
          reason: "unknown version",
          confirm: true,
        }),
      ),
      400,
    ],
    [
      request(
        "PATCH",
        JSON.stringify({
          templateId: "portrait-safe",
          enabled: true,
          reason: localPathMarker,
          confirm: true,
        }),
      ),
      400,
    ],
    [
      request(
        "PATCH",
        JSON.stringify({
          templateId: "portrait-safe",
          enabled: true,
          reason: "sk-proj-SYNTHETIC000000000000",
          confirm: true,
        }),
      ),
      400,
    ],
    [
      request(
        "PATCH",
        JSON.stringify({
          templateId: "portrait-safe",
          enabled: true,
          reason: `credential=${secretMarker}`,
          confirm: true,
        }),
      ),
      400,
    ],
    [
      request(
        "PATCH",
        JSON.stringify({
          templateId: "portrait-safe",
          enabled: true,
          reason: `privateKey=${secretMarker}`,
          confirm: true,
        }),
      ),
      400,
    ],
  ];
  for (const [gateRequest, expectedStatus] of patchGateCases) {
    const response = await handlers.PATCH(gateRequest);
    assert.equal(response.status, expectedStatus);
    assertSafePublicValue(await responseJson(response), [localPathMarker]);
  }
  assert.equal(await registrySnapshot(), beforePatchGateSnapshot);
  assert.equal(audits.length, 2);

  const enableResponse = await handlers.PATCH(
    request(
      "PATCH",
      JSON.stringify({
        templateId: "portrait-safe",
        enabled: true,
        reason: "enable approved local workflow",
        confirm: true,
      }),
    ),
  );
  assert.equal(enableResponse.status, 200);
  assert.equal(audits.length, 3);
  const enableRetry = await handlers.PATCH(
    request(
      "PATCH",
      JSON.stringify({
        templateId: "portrait-safe",
        enabled: true,
        reason: "idempotent enable retry",
        confirm: true,
      }),
    ),
  );
  assert.equal(enableRetry.status, 200);
  assert.equal((await responseJson(enableRetry)).changed, false);
  assert.equal(audits.length, 3);

  occupiedWorkflowId = "portrait-safe";
  const guardSnapshot = await registrySnapshot();
  const guardAuditCount = audits.length;
  const noOpGuardCalls = occupancyCallCount;
  assert.equal(noOpGuardCalls, 0);
  const busyNoOp = await handlers.PATCH(
    request(
      "PATCH",
      JSON.stringify({
        templateId: "portrait-safe",
        enabled: true,
        reason: "busy no-op remains allowed",
        confirm: true,
      }),
    ),
  );
  assert.equal(busyNoOp.status, 200);
  assert.equal((await responseJson(busyNoOp)).changed, false);
  assert.equal(occupancyCallCount, noOpGuardCalls);
  for (const status of ["queued", "running", "pending"] as const) {
    occupiedWorkflowStatus = status;
    for (const patchBody of [
      {
        templateId: "portrait-safe",
        activeVersion: 1,
        reason: `blocked ${status} rollback`,
        confirm: true,
      },
      {
        templateId: "portrait-safe",
        enabled: false,
        reason: `blocked ${status} disable`,
        confirm: true,
      },
    ]) {
      const blocked = await handlers.PATCH(
        request("PATCH", JSON.stringify(patchBody)),
      );
      assert.equal(blocked.status, 409);
      assert.deepEqual(await responseJson(blocked), { error: "workflow_in_use" });
      assert.equal(await registrySnapshot(), guardSnapshot);
      assert.equal(audits.length, guardAuditCount);
    }
  }
  const concurrentlyBlocked = await Promise.all(
    Array.from({ length: 4 }, () =>
      handlers.PATCH(
        request(
          "PATCH",
          JSON.stringify({
            templateId: "portrait-safe",
            activeVersion: 1,
            reason: "concurrent occupied rollback",
            confirm: true,
          }),
        ),
      ),
    ),
  );
  for (const blocked of concurrentlyBlocked) {
    assert.equal(blocked.status, 409);
    assert.deepEqual(await responseJson(blocked), { error: "workflow_in_use" });
  }
  assert.equal(await registrySnapshot(), guardSnapshot);
  assert.equal(audits.length, guardAuditCount);

  occupiedWorkflowStatus = "queued";
  occupancyMustFail = true;
  const unavailableGuard = await handlers.PATCH(
    request(
      "PATCH",
      JSON.stringify({
        templateId: "portrait-safe",
        activeVersion: 1,
        reason: "job store unavailable",
        confirm: true,
      }),
    ),
  );
  occupancyMustFail = false;
  assert.equal(unavailableGuard.status, 503);
  assert.deepEqual(await responseJson(unavailableGuard), {
    error: "control_plane_unavailable",
  });
  assert.equal(await registrySnapshot(), guardSnapshot);
  assert.equal(audits.length, guardAuditCount);

  await importComfyUIWorkflowTemplate({
    id: "busy-import-safe",
    name: "Busy import remains safe",
    modality: "image",
    enabled: true,
    workflow: workflowPackage("busy-v1").template.workflow,
  });
  occupiedWorkflowId = "busy-import-safe";
  const busyImportPackage = workflowPackage("busy-v2", {
    id: "busy-import-safe",
  });
  const busyImportParsed = parseComfyUIWorkflowPackage(busyImportPackage);
  assert.equal(busyImportParsed.ok, true);
  if (!busyImportParsed.ok) throw new Error("busy import package did not parse");
  const busyImportAudits: AdminAuditLog[] = [];
  let busyImportGuardCalls = 0;
  const busyImportHandlers = createComfyUIWorkflowRegistryRouteHandlers({
    authorize: async () => actor,
    repositoryForActor: async () => ({
      appendAudit: async (log: AdminAuditLog) => {
        busyImportAudits.push(structuredClone(log));
      },
    }),
    isWorkflowSelectionInUse: async () => {
      busyImportGuardCalls += 1;
      return true;
    },
  });
  const busyDry = await busyImportHandlers.POST(
    request(
      "POST",
      JSON.stringify({ action: "dry_validate", package: busyImportPackage }),
    ),
  );
  assert.equal(busyDry.status, 200);
  const busyImport = await busyImportHandlers.POST(
    request(
      "POST",
      importBody(
        busyImportPackage,
        busyImportParsed.value.dryResult.fingerprint ?? "",
      ),
    ),
  );
  assert.equal(busyImport.status, 200);
  assert.equal(busyImportAudits.length, 1);
  assert.equal(busyImportGuardCalls, 0);

  await importComfyUIWorkflowTemplate({
    id: "busy-enable-safe",
    name: "Busy enable remains safe",
    modality: "image",
    workflow: workflowPackage("enable-v1").template.workflow,
  });
  const busyEnable = await busyImportHandlers.PATCH(
    request(
      "PATCH",
      JSON.stringify({
        templateId: "busy-enable-safe",
        enabled: true,
        reason: "enable does not change a pinned execution selection",
        confirm: true,
      }),
    ),
  );
  assert.equal(busyEnable.status, 200);
  assert.equal((await responseJson(busyEnable)).changed, true);
  assert.equal(busyImportAudits.length, 2);
  assert.equal(busyImportGuardCalls, 0);

  occupiedWorkflowId = undefined;
  occupiedWorkflowStatus = undefined;
  const disableResponse = await handlers.PATCH(
    request(
      "PATCH",
      JSON.stringify({
        templateId: "portrait-safe",
        enabled: false,
        reason: "disable approved local workflow",
        confirm: true,
      }),
    ),
  );
  assert.equal(disableResponse.status, 200);
  const rollbackResponse = await handlers.PATCH(
    request(
      "PATCH",
      JSON.stringify({
        templateId: "portrait-safe",
        activeVersion: 1,
        reason: "rollback to reviewed workflow version",
        confirm: true,
      }),
    ),
  );
  assert.equal(rollbackResponse.status, 200);
  assert.equal(audits.length, 5);

  const summaries = await listComfyUIWorkflowTemplateManagementSummaries();
  assert.equal(summaries[0]?.versionCount, 2);
  assert.equal(summaries[0]?.activeVersion, 1);
  assert.equal(summaries[0]?.enabled, false);
  assertSafePublicValue({ templates: summaries });

  const routeConcurrentPackage = workflowPackage("route-concurrent", {
    id: "route-concurrent-safe",
  });
  const parsedRouteConcurrent = parseComfyUIWorkflowPackage(
    routeConcurrentPackage,
  );
  assert.equal(parsedRouteConcurrent.ok, true);
  if (!parsedRouteConcurrent.ok) {
    throw new Error("valid concurrent route package did not parse");
  }
  const concurrentImportResponses = await Promise.all(
    Array.from({ length: 8 }, () =>
      handlers.POST(
        request(
          "POST",
          importBody(
            routeConcurrentPackage,
            parsedRouteConcurrent.value.dryResult.fingerprint ?? "",
          ),
        ),
      ),
    ),
  );
  const concurrentImportPayloads = await Promise.all(
    concurrentImportResponses.map(async (response) => {
      assert.equal(response.status, 200);
      return responseJson(response);
    }),
  );
  assert.equal(
    concurrentImportPayloads.filter((payload) => payload.changed === true).length,
    1,
  );
  assert.equal(audits.length, 6);
  const concurrentEnableResponses = await Promise.all(
    Array.from({ length: 8 }, () =>
      handlers.PATCH(
        request(
          "PATCH",
          JSON.stringify({
            templateId: "route-concurrent-safe",
            enabled: true,
            reason: "concurrent idempotent enable",
            confirm: true,
          }),
        ),
      ),
    ),
  );
  const concurrentEnablePayloads = await Promise.all(
    concurrentEnableResponses.map(async (response) => {
      assert.equal(response.status, 200);
      return responseJson(response);
    }),
  );
  assert.equal(
    concurrentEnablePayloads.filter((payload) => payload.changed === true).length,
    1,
  );
  assert.equal(audits.length, 7);

  const auditChainPackages = ["v1", "v2", "v3"].map((marker) =>
    workflowPackage(marker, { id: "audit-chain-safe" }),
  );
  const auditChainFingerprints = auditChainPackages.map((item) => {
    const parsed = parseComfyUIWorkflowPackage(item);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) throw new Error("valid audit-chain package did not parse");
    return parsed.value.dryResult.fingerprint ?? "";
  });
  const auditChainFirst = await handlers.POST(
    request(
      "POST",
      importBody(auditChainPackages[0], auditChainFingerprints[0]),
    ),
  );
  assert.equal(auditChainFirst.status, 200);
  const auditChainConcurrent = await Promise.all(
    auditChainPackages.slice(1).map((item, index) =>
      handlers.POST(
        request(
          "POST",
          importBody(item, auditChainFingerprints[index + 1]),
        ),
      ),
    ),
  );
  for (const response of auditChainConcurrent) {
    assert.equal(response.status, 200);
    assert.equal((await responseJson(response)).changed, true);
  }
  const auditChainTransitions = audits
    .filter(
      (audit) =>
        audit.action === "comfyui.workflow.import" &&
        audit.targetId === "audit-chain-safe",
    )
    .map((audit) => ({
      before: (audit.beforeSummary as { versionCount?: number }).versionCount,
      after: (audit.afterSummary as { versionCount?: number }).versionCount,
    }))
    .filter(
      (transition): transition is { before: number; after: number } =>
        transition.before !== undefined && transition.after !== undefined,
    )
    .sort((left, right) => left.before - right.before);
  assert.deepEqual(auditChainTransitions, [
    { before: 1, after: 2 },
    { before: 2, after: 3 },
  ]);

  const packageV3 = workflowPackage("v3", { id: "concurrent-safe" });
  const parsedV3 = parseComfyUIWorkflowPackage(packageV3);
  assert.equal(parsedV3.ok, true);
  if (!parsedV3.ok) throw new Error("valid package did not parse");
  await Promise.all(
    Array.from({ length: 8 }, () =>
      importComfyUIWorkflowTemplate(parsedV3.value.input),
    ),
  );
  const packageV4 = workflowPackage("v4", { id: "concurrent-safe" });
  const packageV5 = workflowPackage("v5", { id: "concurrent-safe" });
  const parsedV4 = parseComfyUIWorkflowPackage(packageV4);
  const parsedV5 = parseComfyUIWorkflowPackage(packageV5);
  assert.equal(parsedV4.ok, true);
  assert.equal(parsedV5.ok, true);
  if (!parsedV4.ok || !parsedV5.ok) throw new Error("valid packages did not parse");
  await Promise.all([
    importComfyUIWorkflowTemplate(parsedV4.value.input),
    importComfyUIWorkflowTemplate(parsedV5.value.input),
  ]);
  const concurrentSummary = (
    await listComfyUIWorkflowTemplateManagementSummaries()
  ).find((item) => item.id === "concurrent-safe");
  assert.deepEqual(
    concurrentSummary?.versions.map((item) => item.version),
    [1, 2, 3],
  );
  assert.equal(concurrentSummary?.versionCount, 3);

  await assert.rejects(
    () =>
      importComfyUIWorkflowTemplate(
        parsedV3.value.input.modality === "image"
          ? { ...parsedV3.value.input, modality: "video" }
          : { ...parsedV3.value.input, modality: "image" },
      ),
    /modality/i,
  );
  await assert.rejects(
    () => configureComfyUIWorkflowTemplate("concurrent-safe", {}),
    /empty/i,
  );

  const primaryPath = path.join(registryRoot, "registry.json");
  const backupPath = path.join(registryRoot, "registry.previous.json");
  const primary = JSON.parse(await readFile(primaryPath, "utf8")) as {
    schemaVersion?: number;
  };
  const backup = JSON.parse(await readFile(backupPath, "utf8")) as {
    schemaVersion?: number;
  };
  assert.equal(primary.schemaVersion, 1);
  assert.equal(backup.schemaVersion, 1);
  assert.equal(
    (await readdir(registryRoot)).some((name) => name.endsWith(".tmp")),
    false,
  );

  const validBackupBeforeRecovery = await readFile(backupPath, "utf8");
  await writeFile(primaryPath, "{corrupt-primary", "utf8");
  const fallbackSummaries =
    await listComfyUIWorkflowTemplateManagementSummaries();
  const fallbackPortrait = fallbackSummaries.find(
    (item) => item.id === "portrait-safe",
  );
  assert.ok(fallbackPortrait);
  await configureComfyUIWorkflowTemplate("portrait-safe", {
    enabled: !fallbackPortrait.enabled,
  });
  assert.equal(
    (JSON.parse(await readFile(primaryPath, "utf8")) as { schemaVersion?: number })
      .schemaVersion,
    1,
  );
  assert.equal(await readFile(backupPath, "utf8"), validBackupBeforeRecovery);
  const stablePrimary = await readFile(primaryPath, "utf8");
  const stableBackup = await readFile(backupPath, "utf8");
  const stableBackupDocument = JSON.parse(stableBackup) as {
    templates: Array<{ id: string }>;
  };
  const expectedBackupIds = stableBackupDocument.templates.map(
    (template) => template.id,
  );
  const invalidStoredFieldSetters: Array<
    (version: Record<string, unknown>) => void
  > = [
    (version) => {
      version.checkpoint = 42;
    },
    (version) => {
      version.loras = null;
    },
    (version) => {
      version.faceContinuity = false;
    },
  ];
  for (const setInvalidField of invalidStoredFieldSetters) {
    const invalidDocument = JSON.parse(stablePrimary) as {
      templates: Array<{ versions: Array<Record<string, unknown>> }>;
    };
    const targetVersion = invalidDocument.templates[0]?.versions[0];
    assert.ok(targetVersion);
    setInvalidField(targetVersion);
    await writeFile(primaryPath, JSON.stringify(invalidDocument), "utf8");
    assert.deepEqual(
      (await listComfyUIWorkflowTemplateManagementSummaries()).map(
        (template) => template.id,
      ),
      expectedBackupIds,
    );
  }
  await writeFile(
    primaryPath,
    JSON.stringify({
      schemaVersion: 1,
      templates: [{ id: "parseable-but-incomplete" }],
    }),
    "utf8",
  );
  const parseableFallback =
    await listComfyUIWorkflowTemplateManagementSummaries();
  assert.deepEqual(
    parseableFallback.map((template) => template.id),
    expectedBackupIds,
  );
  assert.equal(
    parseableFallback.some((template) => template.id === "parseable-but-incomplete"),
    false,
  );
  await writeFile(primaryPath, stablePrimary, { encoding: "utf8", mode: 0o600 });
  await unlink(primaryPath);
  await writeFile(backupPath, "{corrupt-backup", "utf8");
  await assert.rejects(
    () => listComfyUIWorkflowTemplateManagementSummaries(),
    /JSON|position|property|expected/i,
  );
  await writeFile(primaryPath, stablePrimary, { encoding: "utf8", mode: 0o600 });
  await writeFile(backupPath, stableBackup, { encoding: "utf8", mode: 0o600 });

  const getResponse = await handlers.GET(request("GET"));
  assert.equal(getResponse.status, 200);
  assertSafePublicValue(await responseJson(getResponse));

  await configureComfyUIWorkflowTemplate("portrait-safe", { enabled: true });
  const consumerRoute = await import(
    "../app/api/providers/comfyui/workflows/route.ts"
  );
  const consumerResponse = await consumerRoute.GET(
    new Request("http://127.0.0.1:4200/api/providers/comfyui/workflows", {
      headers: { Host: "127.0.0.1:4200" },
    }),
  );
  assert.equal(consumerResponse.status, 200);
  const consumerPayload = (await consumerResponse.json()) as {
    templates?: Array<Record<string, unknown>>;
  };
  assert.deepEqual(
    Object.keys(consumerPayload.templates?.[0] ?? {}).sort(),
    [
      "activeVersion",
      "enabled",
      "fingerprint",
      "id",
      "modality",
      "name",
      "nodeCount",
      "updatedAt",
      "versionCount",
    ],
  );
  assert.equal(
    consumerPayload.templates?.some((item) => item.id === "concurrent-safe"),
    false,
  );
  assertSafePublicValue(consumerPayload);

  const productionHandlers = createComfyUIWorkflowRegistryRouteHandlers({
    authorize: async () => ({ ...actor, mode: "production" }),
  });
  const beforeProductionAttempt = await registrySnapshot();
  const productionResponse = await productionHandlers.POST(
    request(
      "POST",
      JSON.stringify({ action: "dry_validate", package: validImage }),
    ),
  );
  assert.equal(productionResponse.status, 503);
  assert.equal(await registrySnapshot(), beforeProductionAttempt);

  for (const audit of audits) assertSafePublicValue(audit);
  assert.equal(networkCallCount, 0);

  const routeSource = await readFile(
    path.join(process.cwd(), "lib/providers/comfyui/workflowRegistryRoute.ts"),
    "utf8",
  );
  for (const forbiddenImport of [
    "./transport",
    "./server",
    "generation-jobs/server",
    "8188",
  ]) {
    assert.equal(routeSource.includes(forbiddenImport), false);
  }

  console.log(
    "ComfyUI workflow registry tests passed: package-v1 validation, safe summaries, loopback gates, idempotent versioning, rollback, backup, and zero network.",
  );
} finally {
  globalThis.fetch = originalFetch;
  if (previousRegistryRoot === undefined) {
    delete process.env.AISTORY_COMFYUI_REGISTRY_DIR;
  } else {
    process.env.AISTORY_COMFYUI_REGISTRY_DIR = previousRegistryRoot;
  }
  await rm(testRoot, { recursive: true, force: true });
}
