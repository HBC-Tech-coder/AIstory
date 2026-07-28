import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { getComfyUIProviderConfig } from "@/lib/providers/comfyui/server";
import { uploadComfyUIImage } from "@/lib/providers/comfyui/transport";
import { validateComfyUIProviderConfig } from "@/lib/providers/comfyui/validation";
import { assertTrustedLoopbackMutation } from "@/lib/security/localMutation";

export const runtime = "nodejs";

const EXTENSIONS: Record<string, string> = {
  "image/avif": ".avif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export async function POST(request: Request): Promise<Response> {
  try {
    assertTrustedLoopbackMutation(request);
    const config = getComfyUIProviderConfig();
    const validation = validateComfyUIProviderConfig(config);
    if (!config.enabled || !validation.ok) {
      return NextResponse.json(
        { error: "ComfyUI is not configured." },
        { status: 503 },
      );
    }
    const form = await request.formData();
    const file = form.get("image");
    if (
      !(file instanceof File) ||
      !EXTENSIONS[file.type] ||
      file.size === 0 ||
      file.size > 20 * 1024 * 1024
    ) {
      return NextResponse.json(
        { error: "A supported image is required." },
        { status: 400 },
      );
    }
    const uploaded = await uploadComfyUIImage(config, {
      bytes: new Uint8Array(await file.arrayBuffer()),
      filename: `${randomUUID()}${EXTENSIONS[file.type]}`,
      mimeType: file.type,
      subfolder: "aistory",
    });
    return NextResponse.json({ reference: uploaded });
  } catch (error) {
    const forbidden = error instanceof Error && error.message.includes("loopback");
    return NextResponse.json(
      { error: forbidden ? "Forbidden" : "Reference upload failed." },
      { status: forbidden ? 403 : 502 },
    );
  }
}
