import type { ComfyUIModality } from "./types";

export const COMFYUI_WORKFLOW_PACKAGE_SCHEMA_VERSION = 1 as const;
export const COMFYUI_WORKFLOW_PACKAGE_MAX_BYTES = 2 * 1024 * 1024;

export type ComfyUIWorkflowRegistryIssueCode =
  | "invalid_package"
  | "unsupported_schema"
  | "package_too_large"
  | "forbidden_field"
  | "forbidden_path"
  | "secret_material"
  | "invalid_workflow";

export type ComfyUIWorkflowRegistryIssue = {
  code: ComfyUIWorkflowRegistryIssueCode;
  path: string;
  message: string;
};

export type ComfyUIWorkflowPackageDryResult = {
  ok: boolean;
  schemaVersion: typeof COMFYUI_WORKFLOW_PACKAGE_SCHEMA_VERSION;
  templateId?: string;
  name?: string;
  modality?: ComfyUIModality;
  fingerprint?: string;
  nodeCount?: number;
  issues: ComfyUIWorkflowRegistryIssue[];
};

export type ComfyUIWorkflowVersionSummary = {
  version: number;
  createdAt: string;
  fingerprint: string;
  nodeCount: number;
};

export type ComfyUIWorkflowTemplateManagementSummary = {
  id: string;
  name: string;
  modality: ComfyUIModality;
  enabled: boolean;
  activeVersion: number;
  versionCount: number;
  fingerprint: string;
  nodeCount: number;
  updatedAt: string;
  versions: ComfyUIWorkflowVersionSummary[];
};

export type ComfyUIWorkflowRegistryResponse = {
  templates: ComfyUIWorkflowTemplateManagementSummary[];
};

