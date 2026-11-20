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
import type { ComfyUIWorkflowTemplateManagementSummary } from "./workflowRegistryPublic";

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

type RegistrySource = "primary" | "backup" | "empty";

type RegistryReadResult = {
  document: RegistryDocument;
  source: RegistrySource;
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

export type ComfyUIWorkflowRegistryMutationOutcome = {
  template: ComfyUIWorkflowTemplate;
  previous?: ComfyUIWorkflowTemplate;
  changed: boolean;
};

export type ComfyUIWorkflowVersionSelection = {
  id: string;
  version: number;
  fingerprint: string;
};

export type ComfyUIWorkflowSelectionChange = {
  templateId: string;
  activeVersionChanged: boolean;
  disabling: boolean;
};

export type ComfyUIWorkflowConfigureOptions = {
  assertSelectionChangeAllowed?: (
    change: ComfyUIWorkflowSelectionChange,
  ) => Promise<void> | void;
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

function isPlainJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
  );
}

function hasExactJsonKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  allowed: readonly string[] = required,
): boolean {
  const keys = Object.keys(value);
  const allowedSet = new Set(allowed);
  return (
    keys.every((key) => allowedSet.has(key)) &&
    required.every((key) => Object.hasOwn(value, key))
  );
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function isSafeTemplateName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 120 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isSafeRegistryConfigString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isSafeRegistrySlot(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
  );
}

function isValidStoredLoras(
  value: unknown,
): value is NonNullable<ComfyUIProviderConfig["loras"]> {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (
        !isPlainJsonRecord(entry) ||
        !hasExactJsonKeys(
          entry,
          ["name", "modelWeight"],
          ["name", "modelWeight", "clipWeight"],
        )
      ) return false;
      return (
        isSafeRegistryConfigString(entry.name) &&
        typeof entry.modelWeight === "number" &&
        Number.isFinite(entry.modelWeight) &&
        Math.abs(entry.modelWeight) <= 4 &&
        (entry.clipWeight === undefined ||
          (typeof entry.clipWeight === "number" &&
            Number.isFinite(entry.clipWeight) &&
            Math.abs(entry.clipWeight) <= 4))
      );
    })
  );
}

function isValidStoredControlNets(
  value: unknown,
): value is NonNullable<ComfyUIProviderConfig["controlNets"]> {
  return (
    Array.isArray(value) &&
    value.every((entry) => {
      if (
        !isPlainJsonRecord(entry) ||
        !hasExactJsonKeys(
          entry,
          ["model", "strength"],
          ["model", "strength", "startPercent", "endPercent", "referenceSlot"],
        )
      ) return false;
      const start = entry.startPercent ?? 0;
      const end = entry.endPercent ?? 1;
      return (
        isSafeRegistryConfigString(entry.model) &&
        typeof entry.strength === "number" &&
        Number.isFinite(entry.strength) &&
        entry.strength >= 0 &&
        entry.strength <= 2 &&
        typeof start === "number" &&
        Number.isFinite(start) &&
        typeof end === "number" &&
        Number.isFinite(end) &&
        start >= 0 &&
        end <= 1 &&
        start <= end &&
        (entry.referenceSlot === undefined ||
          isSafeRegistrySlot(entry.referenceSlot))
      );
    })
  );
}

function isValidStoredFaceContinuity(
  value: unknown,
): value is NonNullable<ComfyUIProviderConfig["faceContinuity"]> {
  return (
    isPlainJsonRecord(value) &&
    hasExactJsonKeys(value, ["enabled"], ["enabled", "referenceSlot"]) &&
    typeof value.enabled === "boolean" &&
    (value.referenceSlot === undefined || isSafeRegistrySlot(value.referenceSlot))
  );
}

function assertValidRegistryDocument(value: unknown): RegistryDocument {
  if (
    !isPlainJsonRecord(value) ||
    !hasExactJsonKeys(value, ["schemaVersion", "templates"]) ||
    value.schemaVersion !== REGISTRY_SCHEMA_VERSION ||
    !Array.isArray(value.templates)
  ) {
    throw new Error("Unsupported ComfyUI workflow registry schema.");
  }
  const templateIds = new Set<string>();
  for (const rawTemplate of value.templates) {
    if (
      !isPlainJsonRecord(rawTemplate) ||
      !hasExactJsonKeys(rawTemplate, [
        "id",
        "name",
        "modality",
        "enabled",
        "activeVersion",
        "updatedAt",
        "versions",
      ]) ||
      typeof rawTemplate.id !== "string" ||
      assertTemplateId(rawTemplate.id) !== rawTemplate.id ||
      templateIds.has(rawTemplate.id) ||
      !isSafeTemplateName(rawTemplate.name) ||
      (rawTemplate.modality !== "image" && rawTemplate.modality !== "video") ||
      typeof rawTemplate.enabled !== "boolean" ||
      !Number.isSafeInteger(rawTemplate.activeVersion) ||
      Number(rawTemplate.activeVersion) <= 0 ||
      !isIsoTimestamp(rawTemplate.updatedAt) ||
      !Array.isArray(rawTemplate.versions) ||
      rawTemplate.versions.length === 0
    ) {
      throw new Error("Invalid ComfyUI workflow registry template.");
    }
    templateIds.add(rawTemplate.id);
    const versions = new Set<number>();
    for (const rawVersion of rawTemplate.versions) {
      if (
        !isPlainJsonRecord(rawVersion) ||
        !hasExactJsonKeys(
          rawVersion,
          ["version", "createdAt", "fingerprint", "workflow"],
          [
            "version",
            "createdAt",
            "fingerprint",
            "workflow",
            "checkpoint",
            "loras",
            "controlNets",
            "faceContinuity",
          ],
        ) ||
        !Number.isSafeInteger(rawVersion.version) ||
        Number(rawVersion.version) <= 0 ||
        versions.has(Number(rawVersion.version)) ||
        !isIsoTimestamp(rawVersion.createdAt) ||
        typeof rawVersion.fingerprint !== "string" ||
        !/^[a-f0-9]{64}$/.test(rawVersion.fingerprint) ||
        (rawVersion.checkpoint !== undefined &&
          !isSafeRegistryConfigString(rawVersion.checkpoint)) ||
        (rawVersion.loras !== undefined &&
          !isValidStoredLoras(rawVersion.loras)) ||
        (rawVersion.controlNets !== undefined &&
          !isValidStoredControlNets(rawVersion.controlNets)) ||
        (rawVersion.faceContinuity !== undefined &&
          !isValidStoredFaceContinuity(rawVersion.faceContinuity))
      ) {
        throw new Error("Invalid ComfyUI workflow registry version.");
      }
      versions.add(Number(rawVersion.version));
      let checked: ReturnType<typeof dryValidateComfyUIWorkflowImport>;
      try {
        checked = dryValidateComfyUIWorkflowImport({
          id: rawTemplate.id,
          name: rawTemplate.name,
          modality: rawTemplate.modality,
          workflow: rawVersion.workflow as ComfyUIWorkflowConfig,
          checkpoint: rawVersion.checkpoint as string | undefined,
          loras: rawVersion.loras as ComfyUIProviderConfig["loras"],
          controlNets:
            rawVersion.controlNets as ComfyUIProviderConfig["controlNets"],
          faceContinuity:
            rawVersion.faceContinuity as ComfyUIProviderConfig["faceContinuity"],
        });
      } catch {
        throw new Error("Invalid ComfyUI workflow registry version.");
      }
      if (!checked.ok || checked.fingerprint !== rawVersion.fingerprint) {
        throw new Error("Invalid ComfyUI workflow registry fingerprint.");
      }
    }
    if (!versions.has(Number(rawTemplate.activeVersion))) {
      throw new Error("Active ComfyUI workflow registry version is missing.");
    }
  }
  return value as RegistryDocument;
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

function isMissingFileError(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}

async function readRegistry(): Promise<RegistryReadResult> {
  let firstNonMissingError: unknown;
  for (const [file, source] of [
    [registryFile(), "primary"],
    [registryBackupFile(), "backup"],
  ] as const) {
    try {
      const parsed = assertValidRegistryDocument(JSON.parse(
        await readFile(/* turbopackIgnore: true */ file, "utf8"),
      ));
      return { document: parsed, source };
    } catch (error) {
      if (!isMissingFileError(error)) firstNonMissingError ??= error;
    }
  }
  if (firstNonMissingError) throw firstNonMissingError;
  return { document: emptyRegistry(), source: "empty" };
}

async function writeRegistry(
  document: RegistryDocument,
  source: RegistrySource,
): Promise<void> {
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
        mode: 0o600,
      },
    );
    if (source === "backup") {
      await unlink(/* turbopackIgnore: true */ target).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        },
      );
      await rename(
        /* turbopackIgnore: true */ temp,
        /* turbopackIgnore: true */ target,
      );
      return;
    }
    if (source === "empty") {
      await rename(
        /* turbopackIgnore: true */ temp,
        /* turbopackIgnore: true */ target,
      );
      return;
    }
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
  operation: (
    document: RegistryDocument,
  ) => Promise<{ value: T; changed: boolean }> | { value: T; changed: boolean },
): Promise<T> {
  let resolveMutation: (() => void) | undefined;
  const previous = registryMutation;
  registryMutation = new Promise<void>((resolve) => {
    resolveMutation = resolve;
  });
  await previous;
  try {
    const { document, source } = await readRegistry();
    const result = await operation(document);
    if (result.changed) await writeRegistry(document, source);
    return result.value;
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

export function summarizeComfyUIWorkflowTemplate(
  template: ComfyUIWorkflowTemplate,
): ComfyUIWorkflowTemplateManagementSummary {
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
    versions: template.versions
      .map((version) => ({
        version: version.version,
        createdAt: version.createdAt,
        fingerprint: version.fingerprint,
        nodeCount: Object.keys(version.workflow.workflow).length,
      }))
      .sort((left, right) => left.version - right.version),
  };
}

export async function listComfyUIWorkflowTemplateManagementSummaries(): Promise<
  ComfyUIWorkflowTemplateManagementSummary[]
> {
  const { document } = await readRegistry();
  return document.templates.map(summarizeComfyUIWorkflowTemplate);
}

export async function listComfyUIWorkflowTemplates(): Promise<
  Array<Omit<ComfyUIWorkflowTemplate, "versions"> & {
    versionCount: number;
    fingerprint: string;
    nodeCount: number;
  }>
> {
  const { document } = await readRegistry();
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
  const { document } = await readRegistry();
  const template = document.templates.find((item) => item.id === safeId);
  if (!template || (!template.enabled && !options.includeDisabled)) {
    return undefined;
  }
  return { template, version: activeVersion(template) };
}

export async function getComfyUIWorkflowTemplateVersion(
  selection: ComfyUIWorkflowVersionSelection,
  options: { includeDisabled?: boolean } = {},
): Promise<
  | {
      template: ComfyUIWorkflowTemplate;
      version: ComfyUIWorkflowTemplateVersion;
    }
  | undefined
> {
  const safeId = assertTemplateId(selection.id);
  if (
    !Number.isSafeInteger(selection.version) ||
    selection.version <= 0 ||
    !/^[a-f0-9]{64}$/.test(selection.fingerprint)
  ) {
    return undefined;
  }
  const { document } = await readRegistry();
  const template = document.templates.find((item) => item.id === safeId);
  if (!template || (!template.enabled && !options.includeDisabled)) {
    return undefined;
  }
  const version = template.versions.find(
    (item) =>
      item.version === selection.version &&
      item.fingerprint === selection.fingerprint,
  );
  return version ? { template, version } : undefined;
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

export async function importComfyUIWorkflowTemplateWithOutcome(
  input: ImportComfyUIWorkflowInput,
): Promise<ComfyUIWorkflowRegistryMutationOutcome> {
  const checked = dryValidateComfyUIWorkflowImport(input);
  if (!checked.ok || !checked.fingerprint) {
    throw new Error(checked.issues.map((item) => item.message).join(" "));
  }
  const id = checked.templateId;
  const name = input.name.trim();
  if (!isSafeTemplateName(name)) {
    throw new Error("Workflow name must be a safe 1-120 character label.");
  }

  return mutate((document) => {
    const now = new Date().toISOString();
    const existing = document.templates.find((item) => item.id === id);
    const previous = existing ? structuredClone(existing) : undefined;
    if (existing && existing.modality !== input.modality) {
      throw new Error("Workflow modality cannot change for an existing template.");
    }
    const matchingVersion = existing?.versions.find(
      (version) => version.fingerprint === checked.fingerprint,
    );
    if (existing && matchingVersion) {
      let changed = false;
      if (existing.name !== name) {
        existing.name = name;
        changed = true;
      }
      if (input.enabled !== undefined && existing.enabled !== input.enabled) {
        existing.enabled = input.enabled;
        changed = true;
      }
      if (changed) existing.updatedAt = now;
      return {
        value: { template: structuredClone(existing), previous, changed },
        changed,
      };
    }
    const nextVersion = Math.max(0, ...(existing?.versions.map((item) => item.version) ?? [])) + 1;
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
      return {
        value: {
          template: structuredClone(existing),
          previous,
          changed: true,
        },
        changed: true,
      };
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
    return {
      value: {
        template: structuredClone(created),
        previous: undefined,
        changed: true,
      },
      changed: true,
    };
  });
}

export async function importComfyUIWorkflowTemplate(
  input: ImportComfyUIWorkflowInput,
): Promise<ComfyUIWorkflowTemplate> {
  return (await importComfyUIWorkflowTemplateWithOutcome(input)).template;
}

export async function configureComfyUIWorkflowTemplateWithOutcome(
  id: string,
  input: { enabled?: boolean; activeVersion?: number },
  options: ComfyUIWorkflowConfigureOptions = {},
): Promise<ComfyUIWorkflowRegistryMutationOutcome> {
  const safeId = assertTemplateId(id);
  if (input.enabled === undefined && input.activeVersion === undefined) {
    throw new Error("Workflow configuration change is empty.");
  }
  return mutate(async (document) => {
    const template = document.templates.find((item) => item.id === safeId);
    if (!template) throw new Error("Workflow template not found.");
    const previous = structuredClone(template);
    let nextActiveVersion = template.activeVersion;
    if (input.activeVersion !== undefined) {
      if (
        !Number.isSafeInteger(input.activeVersion) ||
        !template.versions.some((item) => item.version === input.activeVersion)
      ) {
        throw new Error("Workflow version not found.");
      }
      nextActiveVersion = input.activeVersion;
    }
    const nextEnabled = input.enabled ?? template.enabled;
    const activeVersionChanged = template.activeVersion !== nextActiveVersion;
    const disabling = template.enabled && !nextEnabled;
    if (activeVersionChanged || disabling) {
      await options.assertSelectionChangeAllowed?.({
        templateId: safeId,
        activeVersionChanged,
        disabling,
      });
    }
    const changed = activeVersionChanged || template.enabled !== nextEnabled;
    template.activeVersion = nextActiveVersion;
    template.enabled = nextEnabled;
    if (changed) template.updatedAt = new Date().toISOString();
    return {
      value: { template: structuredClone(template), previous, changed },
      changed,
    };
  });
}

export async function configureComfyUIWorkflowTemplate(
  id: string,
  input: { enabled?: boolean; activeVersion?: number },
): Promise<ComfyUIWorkflowTemplate> {
  return (await configureComfyUIWorkflowTemplateWithOutcome(id, input)).template;
}
