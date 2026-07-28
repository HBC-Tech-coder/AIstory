import { createHash } from "node:crypto";

import type { GenerationJobStatus } from "@/lib/generation-jobs/types";

import type {
  VolcengineVideoRawTask,
  VolcengineVideoSubmitBody,
  VolcengineVideoSubmitInput,
  VolcengineVideoTask,
  VolcengineVideoTransport,
} from "./types";

const TASK_ID = /^cgt-[a-z0-9-]{6,96}$/i;

export function buildVolcengineVideoSubmitBody(
  input: VolcengineVideoSubmitInput,
): VolcengineVideoSubmitBody {
  const model = input.model.trim();
  const prompt = input.prompt.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{2,127}$/.test(model)) {
    throw new Error("Volcengine video model id is invalid.");
  }
  if (!prompt || prompt.length > 4_000) {
    throw new Error("Volcengine video prompt must contain 1-4000 characters.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{7,127}$/.test(input.idempotencyKey)) {
    throw new Error("Volcengine video idempotency key is invalid.");
  }
  const content: VolcengineVideoSubmitBody["content"] = [
    { type: "text", text: prompt },
  ];
  if (input.imageUrl) {
    const image = new URL(input.imageUrl);
    if (image.protocol !== "https:") {
      throw new Error("Volcengine video reference image must use HTTPS.");
    }
    content.push({ type: "image_url", image_url: { url: image.toString() } });
  }
  return {
    model,
    content,
    return_last_frame: input.returnLastFrame || undefined,
  };
}

export function mapVolcengineVideoStatus(
  status: VolcengineVideoRawTask["status"],
): GenerationJobStatus {
  if (status === "queued") return "queued";
  if (status === "running") return "pending";
  if (status === "cancelled") return "cancelled";
  if (status === "succeeded") return "succeeded";
  return "failed";
}

function progressFor(status: GenerationJobStatus): number {
  if (status === "queued") return 5;
  if (status === "running" || status === "pending") return 50;
  return 100;
}

function fingerprint(body: VolcengineVideoSubmitBody): string {
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

function timestamp(value: number | undefined): string | undefined {
  if (!Number.isFinite(value)) return undefined;
  return new Date(value! * 1_000).toISOString();
}

export function normalizeVolcengineVideoTask(
  raw: VolcengineVideoRawTask,
  requestFingerprint: string,
): VolcengineVideoTask {
  if (!TASK_ID.test(raw.id)) throw new Error("Invalid Volcengine provider task id.");
  const status = mapVolcengineVideoStatus(raw.status);
  return {
    provider: "volcengine-agent-plan",
    providerTaskId: raw.id,
    status,
    progress: progressFor(status),
    requestFingerprint,
    resultUrl:
      status === "succeeded" && raw.content?.video_url
        ? raw.content.video_url
        : undefined,
    errorCode: status === "failed" ? raw.error?.code || "provider_failed" : undefined,
    usageTokens: raw.usage?.total_tokens ?? raw.usage?.completion_tokens,
    updatedAt: timestamp(raw.updated_at),
  };
}

export function classifyVolcengineVideoFailure(httpStatus: number): {
  retryable: boolean;
  ambiguousSubmit: boolean;
} {
  if (httpStatus === 429) return { retryable: true, ambiguousSubmit: false };
  if (httpStatus >= 500) return { retryable: true, ambiguousSubmit: true };
  return { retryable: false, ambiguousSubmit: false };
}

export class VolcengineAgentPlanVideoClient {
  private readonly submissions = new Map<string, Promise<VolcengineVideoTask>>();
  private readonly fingerprints = new Map<string, string>();

  constructor(private readonly transport: VolcengineVideoTransport) {}

  submit(input: VolcengineVideoSubmitInput): Promise<VolcengineVideoTask> {
    const existing = this.submissions.get(input.idempotencyKey);
    if (existing) return existing;
    const body = buildVolcengineVideoSubmitBody(input);
    const requestFingerprint = fingerprint(body);
    const submission = this.transport.submit(body).then(({ id }) => {
      if (!TASK_ID.test(id)) throw new Error("Invalid Volcengine provider task id.");
      this.fingerprints.set(id, requestFingerprint);
      return {
        provider: "volcengine-agent-plan" as const,
        providerTaskId: id,
        status: "queued" as const,
        progress: 5,
        requestFingerprint,
      };
    });
    this.submissions.set(input.idempotencyKey, submission);
    return submission;
  }

  async poll(providerTaskId: string): Promise<VolcengineVideoTask> {
    if (!TASK_ID.test(providerTaskId)) {
      throw new Error("Invalid Volcengine provider task id.");
    }
    const raw = await this.transport.get(providerTaskId);
    return normalizeVolcengineVideoTask(
      raw,
      this.fingerprints.get(providerTaskId) ?? "unknown",
    );
  }

  async cancel(task: VolcengineVideoTask): Promise<VolcengineVideoTask> {
    if (task.status !== "queued") {
      throw new Error("Volcengine only supports cancellation while a video task is queued.");
    }
    await this.transport.cancel(task.providerTaskId);
    return { ...task, status: "cancelled", progress: 100 };
  }
}
