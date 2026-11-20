import type { CredentialModality } from "@/lib/credentials/types";

export type HostedCredentialProvider =
  | "openai"
  | "openai_compatible"
  | "dashscope"
  | "runware"
  | "stepfun";

export type HostedCredentialStatus = "active" | "revoked" | "deleted";

export type HostedCredentialSummary = {
  id: string;
  provider: HostedCredentialProvider;
  capabilities: CredentialModality[];
  defaultFor: CredentialModality[];
  maskedLabel: string;
  status: HostedCredentialStatus;
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
};

export type HostedCredentialFeatureCode =
  | "ready"
  | "disabled"
  | "identity_gate_unavailable"
  | "repository_unavailable"
  | "encryption_unavailable"
  | "provider_allowlist_unavailable"
  | "step_up_unavailable";

export type HostedCredentialFeatureStatus = {
  enabled: boolean;
  writable: boolean;
  code: HostedCredentialFeatureCode;
  requiresPhoneLogin: true;
  requiresRecentVerification: true;
};

