import "server-only";

export type GpuExecutionOwner = {
  kind: "local" | "lan_lab";
  jobId: string;
  acquiredAt: string;
};

declare global {
  var __aistoryGpuExecutionOwner: GpuExecutionOwner | undefined;
}

export function currentGpuExecutionOwner(): GpuExecutionOwner | undefined {
  return globalThis.__aistoryGpuExecutionOwner
    ? structuredClone(globalThis.__aistoryGpuExecutionOwner)
    : undefined;
}

export function tryAcquireGpuExecution(
  owner: Omit<GpuExecutionOwner, "acquiredAt">,
  now = new Date(),
): boolean {
  const current = globalThis.__aistoryGpuExecutionOwner;
  if (current) {
    return current.kind === owner.kind && current.jobId === owner.jobId;
  }
  globalThis.__aistoryGpuExecutionOwner = {
    ...owner,
    acquiredAt: now.toISOString(),
  };
  return true;
}

export function releaseGpuExecution(
  owner: Pick<GpuExecutionOwner, "kind" | "jobId">,
): void {
  const current = globalThis.__aistoryGpuExecutionOwner;
  if (current?.kind === owner.kind && current.jobId === owner.jobId) {
    globalThis.__aistoryGpuExecutionOwner = undefined;
  }
}

export function transferGpuExecution(
  from: Pick<GpuExecutionOwner, "kind" | "jobId">,
  to: Omit<GpuExecutionOwner, "acquiredAt">,
): boolean {
  const current = globalThis.__aistoryGpuExecutionOwner;
  if (current?.kind !== from.kind || current.jobId !== from.jobId) {
    return false;
  }
  globalThis.__aistoryGpuExecutionOwner = {
    ...to,
    acquiredAt: current.acquiredAt,
  };
  return true;
}

export function resetGpuExecutionGateForTests(): void {
  globalThis.__aistoryGpuExecutionOwner = undefined;
}
