import { NextResponse } from "next/server";

import { getGenerationJobScheduler } from "@/lib/generation-jobs/server";
import { canSubmitComfyUIGeneration } from "@/lib/generation-jobs/preflight";
import type {
  ComfyUIGenerationJobInput,
  LocalMiniDramaImageJobInput,
} from "@/lib/generation-jobs/types";
import { getLocalMiniDramaStatus } from "@/lib/localminidrama/server";
import { discoverComfyUIProviderStatus } from "@/lib/providers/comfyui/server";
import {
  assertTrustedLoopbackMutation,
  isLoopbackReadRequest,
} from "@/lib/security/localMutation";

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  if (!isLoopbackReadRequest(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({
    jobs: await getGenerationJobScheduler().list(),
    scheduler: {
      gpuConcurrency: 1,
      coverage: "aistory_generation_jobs_only",
      legacyIframeBypass: true,
    },
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    assertTrustedLoopbackMutation(request);
    const body = (await request.json()) as {
      provider?: unknown;
      input?: ComfyUIGenerationJobInput | LocalMiniDramaImageJobInput;
    };
    if (!body.input || !["comfyui", "localminidrama"].includes(String(body.provider))) {
      return NextResponse.json(
        { error: "Unsupported generation provider." },
        { status: 400 },
      );
    }
    if (body.provider === "comfyui") {
      const input = body.input as ComfyUIGenerationJobInput;
      if (input.modality !== "image" && input.modality !== "video") {
        return NextResponse.json(
          { error: "Generation modality is invalid." },
          { status: 400 },
        );
      }
      const status = await discoverComfyUIProviderStatus();
      if (!canSubmitComfyUIGeneration(status, input)) {
        return NextResponse.json(
          {
            error:
              input.modality === "video"
                ? "ComfyUI 视频引擎当前不可用。"
                : "ComfyUI 图片引擎当前不可用。",
          },
          { status: 503 },
        );
      }
    } else {
      const status = await getLocalMiniDramaStatus();
      if (!status.ok) {
        return NextResponse.json(
          { error: "LocalMiniDrama 图片引擎当前未连接。" },
          { status: 503 },
        );
      }
    }
    const scheduler = getGenerationJobScheduler();
    const job = body.provider === "comfyui"
      ? await scheduler.submitComfyUI(body.input as ComfyUIGenerationJobInput)
      : await scheduler.submitLocalMiniDramaImage(
          body.input as LocalMiniDramaImageJobInput,
        );
    return NextResponse.json({ job }, { status: 202 });
  } catch (error) {
    const forbidden = error instanceof Error && error.message.includes("loopback");
    return NextResponse.json(
      { error: forbidden ? "Forbidden" : "Generation request rejected." },
      { status: forbidden ? 403 : 400 },
    );
  }
}
