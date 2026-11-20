import "server-only";

import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin/security";
import { getAdminRepositoryForActor } from "@/lib/admin/service";
import type { AdminRepository } from "@/lib/admin/repositories";
import type { AdminActor, AdminRole } from "@/lib/admin/types";
import { hasActiveComfyUIWorkflowSelection } from "@/lib/generation-jobs/store";
import {
  configureComfyUIWorkflowTemplateWithOutcome,
  importComfyUIWorkflowTemplateWithOutcome,
  listComfyUIWorkflowTemplateManagementSummaries,
  summarizeComfyUIWorkflowTemplate,
} from "./registry";
import {
  containsObviousSecretValue,
  containsUnsafeWorkflowPath,
  parseComfyUIWorkflowPackage,
} from "./workflowPackage";
import {
  COMFYUI_WORKFLOW_PACKAGE_MAX_BYTES,
} from "./workflowRegistryPublic";
import {
  assertTrustedLoopbackMutation,
  isLoopbackReadRequest,
} from "@/lib/security/localMutation";

const MAX_REQUEST_BYTES = COMFYUI_WORKFLOW_PACKAGE_MAX_BYTES + 128 * 1024;
const ADMIN_ROLES: AdminRole[] = ["super_admin", "ops"];

type WorkflowRegistryRouteDependencies = {
  authorize: (
    roles: AdminRole[],
  ) => Promise<AdminActor | NextResponse>;
  repositoryForActor: (
    actor: AdminActor,
  ) => Promise<Pick<AdminRepository, "appendAudit">>;
  list: typeof listComfyUIWorkflowTemplateManagementSummaries;
  importTemplate: typeof importComfyUIWorkflowTemplateWithOutcome;
  configureTemplate: typeof configureComfyUIWorkflowTemplateWithOutcome;
  isWorkflowSelectionInUse: (templateId: string) => Promise<boolean>;
};

type RouteProblemCode =
  | "forbidden"
  | "unsupported_media_type"
  | "request_too_large"
  | "invalid_json"
  | "invalid_action"
  | "confirmation_required"
  | "package_changed"
  | "workflow_in_use"
  | "workflow_action_rejected"
  | "control_plane_unavailable";

class WorkflowRegistryRouteProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: RouteProblemCode,
  ) {
    super(code);
  }
}

function responseJson(value: unknown, status = 200): NextResponse {
  return NextResponse.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorResponse(problem: WorkflowRegistryRouteProblem): NextResponse {
  return responseJson({ error: problem.code }, problem.status);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return null;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return null;
      }
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function ownValue(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  try {
    const actual = Reflect.ownKeys(record).sort();
    const expected = [...keys].sort();
    return (
      actual.length === expected.length &&
      actual.every((key, index) => key === expected[index])
    );
  } catch {
    return false;
  }
}

function optionalKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[],
): boolean {
  try {
    const allowedSet = new Set(allowed);
    return (
      Reflect.ownKeys(record).every(
        (key) => typeof key === "string" && allowedSet.has(key),
      ) && required.every((key) => Object.hasOwn(record, key))
    );
  } catch {
    return false;
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new WorkflowRegistryRouteProblem(415, "unsupported_media_type");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new WorkflowRegistryRouteProblem(400, "invalid_json");
    }
    const declaredBytes = Number(declared);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_REQUEST_BYTES) {
      throw new WorkflowRegistryRouteProblem(413, "request_too_large");
    }
  }
  if (!request.body) {
    throw new WorkflowRegistryRouteProblem(400, "invalid_json");
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_REQUEST_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new WorkflowRegistryRouteProblem(413, "request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total <= 0) {
    throw new WorkflowRegistryRouteProblem(400, "invalid_json");
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new WorkflowRegistryRouteProblem(400, "invalid_json");
  }
}

function safeReason(value: unknown): string {
  if (typeof value !== "string") {
    throw new WorkflowRegistryRouteProblem(400, "invalid_action");
  }
  const reason = value.trim();
  if (
    !reason ||
    reason.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(reason) ||
    containsObviousSecretValue(reason) ||
    containsUnsafeWorkflowPath(reason)
  ) {
    throw new WorkflowRegistryRouteProblem(400, "invalid_action");
  }
  return reason;
}

function safeRequestId(request: Request): string {
  const supplied = request.headers.get("x-request-id")?.trim();
  return supplied && /^[A-Za-z0-9][A-Za-z0-9._:-]{7,119}$/.test(supplied)
    ? supplied
    : randomUUID();
}

function assertLoopbackMutation(request: Request): void {
  try {
    assertTrustedLoopbackMutation(request);
  } catch {
    throw new WorkflowRegistryRouteProblem(403, "forbidden");
  }
}

async function localActor(
  dependencies: WorkflowRegistryRouteDependencies,
): Promise<AdminActor | NextResponse> {
  const actor = await dependencies.authorize(ADMIN_ROLES);
  if (actor instanceof NextResponse) return actor;
  if (actor.mode !== "local") {
    return errorResponse(
      new WorkflowRegistryRouteProblem(503, "control_plane_unavailable"),
    );
  }
  return actor;
}

function defaultDependencies(): WorkflowRegistryRouteDependencies {
  return {
    authorize: requireAdmin,
    repositoryForActor: getAdminRepositoryForActor,
    list: listComfyUIWorkflowTemplateManagementSummaries,
    importTemplate: importComfyUIWorkflowTemplateWithOutcome,
    configureTemplate: configureComfyUIWorkflowTemplateWithOutcome,
    isWorkflowSelectionInUse: hasActiveComfyUIWorkflowSelection,
  };
}

export function createComfyUIWorkflowRegistryRouteHandlers(
  overrides: Partial<WorkflowRegistryRouteDependencies> = {},
) {
  const dependencies = { ...defaultDependencies(), ...overrides };

  return {
    async GET(request: Request): Promise<Response> {
      if (!isLoopbackReadRequest(request)) {
        return errorResponse(new WorkflowRegistryRouteProblem(403, "forbidden"));
      }
      try {
        const actor = await localActor(dependencies);
        if (actor instanceof NextResponse) return actor;
        await dependencies.repositoryForActor(actor);
        return responseJson({ templates: await dependencies.list() });
      } catch {
        return errorResponse(
          new WorkflowRegistryRouteProblem(503, "control_plane_unavailable"),
        );
      }
    },

    async POST(request: Request): Promise<Response> {
      try {
        assertLoopbackMutation(request);
        const body = plainRecord(await readBoundedJson(request));
        if (!body) {
          throw new WorkflowRegistryRouteProblem(400, "invalid_action");
        }
        const action = ownValue(body, "action");
        const keys = action === "dry_validate"
          ? ["action", "package"]
          : ["action", "package", "expectedFingerprint", "reason", "confirm"];
        if (!exactKeys(body, keys)) {
          throw new WorkflowRegistryRouteProblem(400, "invalid_action");
        }
        if (action !== "dry_validate" && action !== "import") {
          throw new WorkflowRegistryRouteProblem(400, "invalid_action");
        }
        let expectedFingerprint: string | undefined;
        let reason: string | undefined;
        if (action === "import") {
          if (ownValue(body, "confirm") !== true) {
            throw new WorkflowRegistryRouteProblem(409, "confirmation_required");
          }
          const fingerprintValue = ownValue(body, "expectedFingerprint");
          if (
            typeof fingerprintValue !== "string" ||
            !/^[a-f0-9]{64}$/.test(fingerprintValue)
          ) {
            throw new WorkflowRegistryRouteProblem(409, "package_changed");
          }
          expectedFingerprint = fingerprintValue;
          reason = safeReason(ownValue(body, "reason"));
        }
        const actor = await localActor(dependencies);
        if (actor instanceof NextResponse) return actor;
        const parsed = parseComfyUIWorkflowPackage(ownValue(body, "package"));
        if (!parsed.ok) {
          return responseJson({ validation: parsed.dryResult }, 400);
        }
        if (action === "dry_validate") {
          return responseJson({ validation: parsed.value.dryResult });
        }
        if (
          reason === undefined ||
          expectedFingerprint !== parsed.value.dryResult.fingerprint
        ) {
          throw new WorkflowRegistryRouteProblem(409, "package_changed");
        }
        const repository = await dependencies.repositoryForActor(actor);
        const imported = await dependencies.importTemplate(parsed.value.input);
        const result = summarizeComfyUIWorkflowTemplate(imported.template);
        const previous = imported.previous
          ? summarizeComfyUIWorkflowTemplate(imported.previous)
          : undefined;
        const changed = imported.changed;
        const requestId = safeRequestId(request);
        if (changed) {
          await repository.appendAudit({
            id: randomUUID(),
            tenantId: "platform",
            actorId: actor.userId,
            actorRoles: actor.roles,
            action: "comfyui.workflow.import",
            targetType: "comfyui_workflow",
            targetId: result.id,
            beforeSummary: previous
              ? {
                  enabled: previous.enabled,
                  activeVersion: previous.activeVersion,
                  versionCount: previous.versionCount,
                }
              : { exists: false },
            afterSummary: {
              enabled: result.enabled,
              activeVersion: result.activeVersion,
              versionCount: result.versionCount,
              modality: result.modality,
            },
            reason,
            requestId,
            createdAt: new Date().toISOString(),
          });
        }
        return responseJson({ result, changed, requestId });
      } catch (error) {
        if (error instanceof WorkflowRegistryRouteProblem) {
          return errorResponse(error);
        }
        return errorResponse(
          new WorkflowRegistryRouteProblem(400, "workflow_action_rejected"),
        );
      }
    },

    async PATCH(request: Request): Promise<Response> {
      try {
        assertLoopbackMutation(request);
        const body = plainRecord(await readBoundedJson(request));
        if (
          !body ||
          !optionalKeys(
            body,
            ["templateId", "reason", "confirm"],
            ["templateId", "enabled", "activeVersion", "reason", "confirm"],
          ) ||
          (ownValue(body, "enabled") === undefined &&
            ownValue(body, "activeVersion") === undefined)
        ) {
          throw new WorkflowRegistryRouteProblem(400, "invalid_action");
        }
        if (ownValue(body, "confirm") !== true) {
          throw new WorkflowRegistryRouteProblem(409, "confirmation_required");
        }
        const templateId = ownValue(body, "templateId");
        const enabled = ownValue(body, "enabled");
        const activeVersion = ownValue(body, "activeVersion");
        if (
          typeof templateId !== "string" ||
          (enabled !== undefined && typeof enabled !== "boolean") ||
          (activeVersion !== undefined &&
            (!Number.isSafeInteger(activeVersion) || Number(activeVersion) <= 0))
        ) {
          throw new WorkflowRegistryRouteProblem(400, "invalid_action");
        }
        const reason = safeReason(ownValue(body, "reason"));
        const actor = await localActor(dependencies);
        if (actor instanceof NextResponse) return actor;
        const repository = await dependencies.repositoryForActor(actor);
        const configured = await dependencies.configureTemplate(templateId, {
          ...(enabled === undefined ? {} : { enabled }),
          ...(activeVersion === undefined
            ? {}
            : { activeVersion: Number(activeVersion) }),
        }, {
          assertSelectionChangeAllowed: async ({ templateId: selectedId }) => {
            let inUse: boolean;
            try {
              inUse = await dependencies.isWorkflowSelectionInUse(selectedId);
            } catch {
              throw new WorkflowRegistryRouteProblem(
                503,
                "control_plane_unavailable",
              );
            }
            if (inUse) {
              throw new WorkflowRegistryRouteProblem(409, "workflow_in_use");
            }
          },
        });
        const result = summarizeComfyUIWorkflowTemplate(configured.template);
        const previous = configured.previous
          ? summarizeComfyUIWorkflowTemplate(configured.previous)
          : undefined;
        const changed = configured.changed;
        const requestId = safeRequestId(request);
        if (changed) {
          await repository.appendAudit({
            id: randomUUID(),
            tenantId: "platform",
            actorId: actor.userId,
            actorRoles: actor.roles,
            action: "comfyui.workflow.configure",
            targetType: "comfyui_workflow",
            targetId: result.id,
            beforeSummary: previous
              ? {
                  enabled: previous.enabled,
                  activeVersion: previous.activeVersion,
                  versionCount: previous.versionCount,
                }
              : { exists: false },
            afterSummary: {
              enabled: result.enabled,
              activeVersion: result.activeVersion,
              versionCount: result.versionCount,
              modality: result.modality,
            },
            reason,
            requestId,
            createdAt: new Date().toISOString(),
          });
        }
        return responseJson({ result, changed, requestId });
      } catch (error) {
        if (error instanceof WorkflowRegistryRouteProblem) {
          return errorResponse(error);
        }
        return errorResponse(
          new WorkflowRegistryRouteProblem(400, "workflow_action_rejected"),
        );
      }
    },
  };
}
