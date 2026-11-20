import type { ComfyUIGenerationJobInput } from "./types";
import type { ComfyUIProviderStatus } from "@/lib/providers/comfyui/types";

export function canSubmitComfyUIGeneration(
  status: ComfyUIProviderStatus,
  input: Pick<ComfyUIGenerationJobInput, "modality">,
): boolean {
  return (
    status.state === "ready" &&
    status.available &&
    status.modalities[input.modality] === true
  );
}

