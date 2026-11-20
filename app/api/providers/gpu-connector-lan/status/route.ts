import { NextResponse } from "next/server";

import { projectLanGpuCoordinatorStudioStatus } from "@/lib/gpu-coordinator/generationJobAdapter";
import {
  configuredLanGpuAdminStatus,
  inspectLanGpuCoordinatorEnvironment,
} from "@/lib/gpu-coordinator/server";

export const runtime = "nodejs";

export async function GET(): Promise<Response> {
  const capability = inspectLanGpuCoordinatorEnvironment();
  try {
    return NextResponse.json(
      projectLanGpuCoordinatorStudioStatus({
        ready: capability.ready,
        status: await configuredLanGpuAdminStatus(),
      }),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      {
        state: capability.enabled ? "offline" : "disabled",
        ready: false,
        releaseClassification: "non_publishable",
        speculativePrefetch: false,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
}
