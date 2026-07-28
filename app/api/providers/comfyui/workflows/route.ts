import { NextResponse } from "next/server";

import { isLoopbackReadRequest } from "@/lib/security/localMutation";
import { listComfyUIWorkflowTemplates } from "@/lib/providers/comfyui/registry";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  if (!isLoopbackReadRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    templates: (await listComfyUIWorkflowTemplates()).filter(
      (template) => template.enabled,
    ),
  });
}
