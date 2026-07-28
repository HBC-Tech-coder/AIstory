import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  ComfyUIModality,
  ComfyUIProviderConfig,
  ComfyUIWorkflowConfig,
} from "./types";
import { validateComfyUIProviderConfig } from "./validation";

const REGISTRY_SCHEMA_VERSION = 1;
const DEFAULT_REGISTRY_ROOT = path.join(
  /* turbopackIgnore: true */ process.cwd(),
  ".aistory-comfyui",
  "workflows",
);

export type ComfyUIWorkflowTemplateVersion = {
  version: number;
  createdAt: string;
  fingerprint: string;
  workflow: ComfyUIWorkflowConfig;
  checkpoint?: string;
  loras?: ComfyUIProviderConfig["loras"];
  controlNets?: ComfyUIProviderConfig["controlNets"];
  faceContinuity?: ComfyUIProviderConfig["faceContinuity"];
};

export type ComfyUIWorkflowTemplate = {
  id: string;
  name: string;
  modality: ComfyUIModality;
  enabled: boolean;
  activeVersion: number;
  updatedAt: string;
  versions: ComfyUIWorkflowTemplateVersion[];
};

type RegistryDocument = {
  schemaVersion: number;
  templates: ComfyUIWorkflowTemplate[];
};

export type ImportComfyUIWorkflowInput = {
  id: string;
  name: string;
  modality: ComfyUIModality;
  enabled?: boolean;
  workflow: ComfyUIWorkflowConfig;
  checkpoint?: string;
  loras?: ComfyUIProviderConfig["loras"];
  controlNets?: ComfyUIProviderConfig["controlNets"];
  faceContinuity?: ComfyUIProviderConfig["faceContinuity"];
};

let registryMutation = Promise.resolve();

function registryRoot(): string {
  return process.env.AISTORY_COMFYUI_REGISTRY_DIR || DEFAULT_REGISTRY_ROOT;
}

function registryFile(): string {
  return path.join(
    /* turbopackIgnore: true */ registryRoot(),
    "registry.json",
  );
}

function registryBackupFile(): string {
  return path.join(
    /* turbopackIgnore: true */ registryRoot(),
    "registry.previous.json",
  );
}

function emptyRegistry(): RegistryDocument {
  return { schemaVersion: REGISTRY_SCHEMA_VERSION, templates: [] };
}

function assertTemplateId(value: string): string {
  const id = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(id)) {
    throw new Error("Workflow id must be a 3-64 character safe slug.");
  }
  return id;
}

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

async function readRegistry(): Promise<RegistryDocument> {
  let primaryError: unknown;
  for (const file of [registryFile(), registryBackupFile()]) {
    try {
      const parsed = JSON.parse(
        await readFile(/* turbopackIgnore: true */ file, "utf8"),
      ) as RegistryDocument;
      if (
        parsed.schemaVersion !== REGISTRY_SCHEMA_VERSION ||
        !Array.isArray(parsed.templates)
      ) {
        throw new Error("Unsupported ComfyUI workflow registry schema.");
      }
      return parsed;
    } catch (error) {
      primaryError ??= error;
    }
  }
  if (
    primaryError &&
    typeof primaryError === "object" &&
    "code" in primaryError &&
    primaryError.code === "ENOENT"
  ) return emptyRegistry();
  throw primaryError;
}

async function writeRegistry(document: RegistryDocument): Promise<void> {
  const root = registryRoot();
  await mkdir(/* turbopackIgnore: true */ root, { recursive: true });
  const target = registryFile();
  const temp = path.join(
    /* turbopackIgnore: true */ root,
    `.registry-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  const backup = registryBackupFile();
  let movedPrimary = false;
  try {
    await writeFile(
      /* turbopackIgnore: true */ temp,
      JSON.stringify(document, null, 2),
      {
        encoding: "utf8",
        flag: "wx",
      },
    );
    await unlink(/* turbopackIgnore: true */ backup).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
    await rename(
      /* turbopackIgnore: true */ target,
      /* turbopackIgnore: true */ backup,
    )
      .then(() => {
        movedPrimary = true;
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    await rename(
      /* turbopackIgnore: true */ temp,
      /* turbopackIgnore: true */ target,
    );
  } catch (error) {
    await unlink(/* turbopackIgnore: true */ temp).catch(() => undefined);
    if (movedPrimary) {
      await rename(
        /* turbopackIgnore: true */ backup,
        /* turbopackIgnore: true */ target,
      ).catch(() => undefined);
    }
    throw error;
  }
}

async function mutate<T>(
  operation: (document: RegistryDocument) => Promise<T> | T,
): Promise<T> {
  let resolveMutation: (() => void) | undefined;
  const previous = registryMutation;
  registryMutation = new Promise<void>((resolve) => {
    resolveMutation = resolve;
  });
  await previous;
  try {
    const document = await readRegistry();
    const result = await operation(document);
    await writeRegistry(document);
    return result;
  } finally {
    resolveMutation?.();
  }
}

function activeVersion(
  template: ComfyUIWorkflowTemplate,
): ComfyUIWorkflowTemplateVersion {
  const version = template.versions.find(
    (item) => item.version === template.activeVersion,
  );
  if (!version) throw new Error("Active workflow version is missing.");
  return version;
}

export async function listComfyUIWorkflowTemplates(): Promise<
  Array<Omit<ComfyUIWorkflowTemplate, "versions"> & {
    versionCount: number;
    fingerprint: string;
    nodeCount: number;
  }>
> {
  const document = await readRegistry();
  return document.templates.map((template) => {
    const current = activeVersion(template);
    return {
      id: template.id,
      name: template.name,
      modality: template.modality,
      enabled: template.enabled,
      activeVersion: template.activeVersion,
      updatedAt: template.updatedAt,
      versionCount: template.versions.length,
      fingerprint: current.fingerprint,
      nodeCount: Object.keys(current.workflow.workflow).length,
    };
  });
}

export async function getComfyUIWorkflowTemplate(
  id: string,
  options: { includeDisabled?: boolean } = {},
): Promise<
  | {
      template: ComfyUIWorkflowTemplate;
      version: ComfyUIWorkflowTemplateVersion;
    }
  | undefined
> {
  const safeId = assertTemplateId(id);
  const document = await readRegistry();
  const template = document.templates.find((item) => item.id === safeId);
  if (!template || (!template.enabled && !options.includeDisabled)) {
    return undefined;
  }
  return { template, version: activeVersion(template) };
}

export function dryValidateComfyUIWorkflowImport(
  input: ImportComfyUIWorkflowInput,
) {
  const id = assertTemplateId(input.id);
  const config: ComfyUIProviderConfig = {
    enabled: true,
    baseUrl: "http://127.0.0.1:8188",
    checkpoint: input.checkpoint,
    loras: input.loras,
    controlNets: input.controlNets,
    faceContinuity: input.faceContinuity,
    workflows: { [input.modality]: input.workflow },
  };
  const validation = validateComfyUIProviderConfig(config);
  return {
    ...validation,
    templateId: id,
    fingerprint: validation.ok
      ? fingerprint({
          modality: input.modality,
          workflow: input.workflow,
          checkpoint: input.checkpoint,
          loras: input.loras,
          controlNets: input.controlNets,
          faceContinuity: input.faceContinuity,
        })
      : undefined,
  };
}

export async function importComfyUIWorkflowTemplate(
  input: ImportComfyUIWorkflowInput,
): Promise<ComfyUIWorkflowTemplate> {
  const checked = dryValidateComfyUIWorkflowImport(input);
  if (!checked.ok || !checked.fingerprint) {
    throw new Error(checked.issues.map((item) => item.message).join(" "));
  }
  const id = checked.templateId;
  const name = input.name.trim().slice(0, 120);
  if (!name) throw new Error("Workflow name is required.");

  return mutate((document) => {
    const now = new Date().toISOString();
    const existing = document.templates.find((item) => item.id === id);
    const nextVersion = (existing?.versions.at(-1)?.version ?? 0) + 1;
    const version: ComfyUIWorkflowTemplateVersion = {
      version: nextVersion,
      createdAt: now,
      fingerprint: checked.fingerprint!,
      workflow: structuredClone(input.workflow),
      checkpoint: input.checkpoint,
      loras: structuredClone(input.loras),
      controlNets: structuredClone(input.controlNets),
      faceContinuity: structuredClone(input.faceContinuity),
    };
    if (existing) {
      existing.name = name;
      existing.modality = input.modality;
      existing.enabled = input.enabled ?? existing.enabled;
      existing.activeVersion = nextVersion;
      existing.updatedAt = now;
      existing.versions.push(version);
      return structuredClone(existing);
    }
    const created: ComfyUIWorkflowTemplate = {
      id,
      name,
      modality: input.modality,
      enabled: input.enabled ?? false,
      activeVersion: nextVersion,
      updatedAt: now,
      versions: [version],
    };
    document.templates.push(created);
    return structuredClone(created);
  });
}

export async function configureComfyUIWorkflowTemplate(
  id: string,
  input: { enabled?: boolean; activeVersion?: number },
): Promise<ComfyUIWorkflowTemplate> {
  const safeId = assertTemplateId(id);
  return mutate((document) => {
    const template = document.templates.find((item) => item.id === safeId);
    if (!template) throw new Error("Workflow template not found.");
    if (input.activeVersion !== undefined) {
      if (
        !Number.isSafeInteger(input.activeVersion) ||
        !template.versions.some((item) => item.version === input.activeVersion)
      ) {
        throw new Error("Workflow version not found.");
      }
      template.activeVersion = input.activeVersion;
    }
    if (input.enabled !== undefined) template.enabled = input.enabled;
    template.updatedAt = new Date().toISOString();
    return structuredClone(template);
  });
}
