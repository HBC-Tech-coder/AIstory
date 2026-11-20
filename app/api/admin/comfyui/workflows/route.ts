import { createComfyUIWorkflowRegistryRouteHandlers } from "@/lib/providers/comfyui/workflowRegistryRoute";

export const runtime = "nodejs";

const handlers = createComfyUIWorkflowRegistryRouteHandlers();

export const GET = handlers.GET;
export const POST = handlers.POST;
export const PATCH = handlers.PATCH;
