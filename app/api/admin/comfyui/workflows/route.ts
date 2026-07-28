import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/admin/security";
import { getAdminRepository } from "@/lib/admin/service";
import {
  configureComfyUIWorkflowTemplate,
  dryValidateComfyUIWorkflowImport,
  importComfyUIWorkflowTemplate,
  listComfyUIWorkflowTemplates,
  type ImportComfyUIWorkflowInput,
} from "@/lib/providers/comfyui/registry";
import { assertTrustedLoopbackMutation } from "@/lib/security/localMutation";

export const runtime = "nodejs";

type WorkflowAdminAction =
  | { action: "dry_validate"; input: ImportComfyUIWorkflowInput }
  | { action: "import"; input: ImportComfyUIWorkflowInput; reason: string }
  | {
      action: "configure";
      workflowId: string;
      enabled?: boolean;
      activeVersion?: number;
      reason: string;
    };

export async function GET(): Promise<Response> {
  const actor = await requireAdmin(["super_admin", "ops"]);
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json({ templates: await listComfyUIWorkflowTemplates() });
}

export async function POST(request: Request): Promise<Response> {
  const actor = await requireAdmin(["super_admin", "ops"]);
  if (actor instanceof NextResponse) return actor;
  try {
    assertTrustedLoopbackMutation(request);
    const body = (await request.json()) as WorkflowAdminAction;
    if (body.action === "dry_validate") {
      return NextResponse.json(dryValidateComfyUIWorkflowImport(body.input));
    }
    const reason = body.reason.trim().slice(0, 500);
    if (!reason) {
      return NextResponse.json({ error: "A reason is required." }, { status: 400 });
    }
    const requestId = request.headers.get("x-request-id") || randomUUID();
    const before = await listComfyUIWorkflowTemplates();
    const result = body.action === "import"
      ? await importComfyUIWorkflowTemplate(body.input)
      : body.action === "configure"
        ? await configureComfyUIWorkflowTemplate(body.workflowId, {
            enabled: body.enabled,
            activeVersion: body.activeVersion,
          })
        : undefined;
    if (!result) {
      return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    }
    await getAdminRepository().appendAudit({
      id: randomUUID(),
      tenantId: "platform",
      actorId: actor.userId,
      actorRoles: actor.roles,
      action: `comfyui.workflow.${body.action}`,
      targetType: "comfyui_workflow",
      targetId: result.id,
      beforeSummary: {
        templateCount: before.length,
        activeVersion: before.find((item) => item.id === result.id)?.activeVersion,
      },
      afterSummary: {
        enabled: result.enabled,
        activeVersion: result.activeVersion,
        modality: result.modality,
      },
      reason,
      requestId,
      createdAt: new Date().toISOString(),
    });
    return NextResponse.json({ result, requestId });
  } catch (error) {
    const forbidden = error instanceof Error && error.message.includes("loopback");
    return NextResponse.json(
      { error: forbidden ? "Forbidden" : "Workflow action rejected." },
      { status: forbidden ? 403 : 400 },
    );
  }
}
