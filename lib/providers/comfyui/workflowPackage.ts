import "server-only";

import type {
  ComfyUIControlNetConfig,
  ComfyUILoRAConfig,
  ComfyUINodeInputBinding,
  ComfyUIWorkflowBindings,
  ComfyUIWorkflowConfig,
} from "./types";
import {
  dryValidateComfyUIWorkflowImport,
  type ImportComfyUIWorkflowInput,
} from "./registry";
import {
  COMFYUI_WORKFLOW_PACKAGE_MAX_BYTES,
  COMFYUI_WORKFLOW_PACKAGE_SCHEMA_VERSION,
  type ComfyUIWorkflowPackageDryResult,
  type ComfyUIWorkflowRegistryIssue,
} from "./workflowRegistryPublic";

type ParsedComfyUIWorkflowPackage = {
  input: ImportComfyUIWorkflowInput;
  dryResult: ComfyUIWorkflowPackageDryResult & { ok: true };
};

type PackageParseResult =
  | { ok: true; value: ParsedComfyUIWorkflowPackage }
  | { ok: false; dryResult: ComfyUIWorkflowPackageDryResult };

const FORBIDDEN_OBJECT_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);
const TEMPLATE_KEYS = new Set([
  "id",
  "name",
  "modality",
  "workflow",
  "checkpoint",
  "loras",
  "controlNets",
  "faceContinuity",
]);
const WORKFLOW_CONFIG_KEYS = new Set([
  "workflow",
  "outputNodeIds",
  "bindings",
]);
const WORKFLOW_NODE_KEYS = new Set(["class_type", "inputs", "_meta"]);
const BINDINGS_KEYS = new Set([
  "positivePrompt",
  "negativePrompt",
  "checkpoint",
  "loras",
  "controlNets",
  "referenceImages",
  "faceReference",
  "seed",
  "width",
  "height",
  "videoNodes",
]);
const BINDING_KEYS = new Set(["nodeId", "input"]);
const LORA_BINDING_KEYS = new Set(["name", "modelWeight", "clipWeight"]);
const CONTROL_BINDING_KEYS = new Set([
  "model",
  "strength",
  "startPercent",
  "endPercent",
  "referenceImage",
]);
const LORA_CONFIG_KEYS = new Set(["name", "modelWeight", "clipWeight"]);
const CONTROL_CONFIG_KEYS = new Set([
  "model",
  "strength",
  "startPercent",
  "endPercent",
  "referenceSlot",
]);
const FACE_CONTINUITY_KEYS = new Set(["enabled", "referenceSlot"]);

function issue(
  code: ComfyUIWorkflowRegistryIssue["code"],
  path: string,
  message: string,
): ComfyUIWorkflowRegistryIssue {
  return { code, path, message };
}

function invalidResult(
  item: ComfyUIWorkflowRegistryIssue,
): PackageParseResult {
  return {
    ok: false,
    dryResult: {
      ok: false,
      schemaVersion: COMFYUI_WORKFLOW_PACKAGE_SCHEMA_VERSION,
      issues: [item],
    },
  };
}

function ownDataRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        return null;
      }
    }
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

function ownValue(
  record: Record<string, unknown>,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function exactOrOptionalKeys(
  record: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  required: readonly string[],
): boolean {
  try {
    const keys = Reflect.ownKeys(record);
    return (
      keys.every((key) => typeof key === "string" && allowed.has(key)) &&
      required.every((key) => Object.hasOwn(record, key))
    );
  } catch {
    return false;
  }
}

function isDenseDataArray(value: unknown): value is unknown[] {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return false;
    }
    const expected = new Set<string>([
      "length",
      ...Array.from({ length: value.length }, (_, index) => String(index)),
    ]);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !expected.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return false;
    }
    return Array.from({ length: value.length }, (_, index) => index).every(
      (index) => Object.hasOwn(value, index),
    );
  } catch {
    return false;
  }
}

function normalizedFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSecretField(value: string): boolean {
  const field = normalizedFieldName(value);
  return (
    field === "apikey" ||
    field.includes("apikey") ||
    field.includes("accesskey") ||
    field.includes("secret") ||
    field.includes("privatekey") ||
    field.includes("credential") ||
    field === "token" ||
    field.endsWith("token") ||
    field.endsWith("tokenvalue") ||
    field === "password" ||
    field.startsWith("password") ||
    field.endsWith("password") ||
    field.startsWith("authorization") ||
    field === "cookie" ||
    field.startsWith("cookie") ||
    field.endsWith("cookie")
  );
}

export function containsObviousSecretValue(value: string): boolean {
  return (
    /^\s*(?:bearer|basic)\s+\S+/i.test(value) ||
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value) ||
    /\b(?:sk-(?:proj-)?[A-Za-z0-9_-]{12,}|AKIA[0-9A-Z]{16}|LTAI[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/.test(
      value,
    ) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(
      value,
    ) ||
    /(?:api[_-]?key|access[_-]?key|secret|private[_-]?key|credential|token|password|authorization|cookie)\s*[:=]\s*\S+/i.test(
      value,
    )
  );
}

export function containsUnsafeWorkflowPath(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^[a-zA-Z]:/.test(trimmed) ||
    /^\\\\/.test(trimmed) ||
    /^\//.test(trimmed) ||
    /^file:/i.test(trimmed) ||
    /(^|[\\/])\.\.([\\/]|$)/.test(trimmed) ||
    /%(?:2e|2f|5c)/i.test(trimmed)
  );
}

function inspectPackageTree(
  value: unknown,
  seen = new WeakSet<object>(),
  depth = 0,
): ComfyUIWorkflowRegistryIssue | null {
  if (depth > 64) {
    return issue("invalid_package", "$", "Workflow package nesting is too deep.");
  }
  if (value === null || typeof value === "boolean") return null;
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? null
      : issue("invalid_package", "$", "Workflow package contains an invalid number.");
  }
  if (typeof value === "string") {
    if (containsObviousSecretValue(value)) {
      return issue("secret_material", "$", "Workflow package contains secret material.");
    }
    if (containsUnsafeWorkflowPath(value)) {
      return issue("forbidden_path", "$", "Workflow package contains an unsafe path.");
    }
    return null;
  }
  if (typeof value !== "object" || value === null) {
    return issue("invalid_package", "$", "Workflow package contains an unsupported value.");
  }
  if (seen.has(value)) {
    return issue("invalid_package", "$", "Workflow package must be acyclic JSON.");
  }
  seen.add(value);

  if (Array.isArray(value)) {
    if (!isDenseDataArray(value)) {
      return issue("invalid_package", "$", "Workflow package arrays must contain plain JSON values.");
    }
    for (const child of value) {
      const childIssue = inspectPackageTree(child, seen, depth + 1);
      if (childIssue) return childIssue;
    }
    return null;
  }

  const record = ownDataRecord(value);
  if (!record) {
    return issue("invalid_package", "$", "Workflow package objects must be plain JSON objects.");
  }
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== "string") {
      return issue("forbidden_field", "$", "Workflow package contains a forbidden field.");
    }
    if (FORBIDDEN_OBJECT_KEYS.has(key) || isSecretField(key)) {
      return issue(
        isSecretField(key) ? "secret_material" : "forbidden_field",
        "$",
        isSecretField(key)
          ? "Workflow package contains secret material."
          : "Workflow package contains a forbidden field.",
      );
    }
    if (containsUnsafeWorkflowPath(key)) {
      return issue(
        "forbidden_path",
        "$",
        "Workflow package contains an unsafe path.",
      );
    }
    const childIssue = inspectPackageTree(ownValue(record, key), seen, depth + 1);
    if (childIssue) return childIssue;
  }
  return null;
}

function isBinding(value: unknown): value is ComfyUINodeInputBinding {
  const record = ownDataRecord(value);
  const nodeId = record ? ownValue(record, "nodeId") : undefined;
  const input = record ? ownValue(record, "input") : undefined;
  return Boolean(
    record &&
      exactOrOptionalKeys(record, BINDING_KEYS, ["nodeId", "input"]) &&
      typeof nodeId === "string" &&
      nodeId.length > 0 &&
      nodeId.length <= 128 &&
      !/[\u0000-\u001f\u007f]/.test(nodeId) &&
      typeof input === "string" &&
      input.length > 0 &&
      input.length <= 128 &&
      !/[\u0000-\u001f\u007f]/.test(input),
  );
}

function isSafeWorkflowIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/.test(value) &&
    !containsUnsafeWorkflowPath(value)
  );
}

function arrayOfBindings(value: unknown): boolean {
  return isDenseDataArray(value) && value.every(isBinding);
}

function validateBindingsShape(value: unknown): value is ComfyUIWorkflowBindings {
  const record = ownDataRecord(value);
  if (!record || !exactOrOptionalKeys(record, BINDINGS_KEYS, [])) return false;
  for (const key of [
    "positivePrompt",
    "negativePrompt",
    "checkpoint",
    "faceReference",
    "seed",
    "width",
    "height",
  ]) {
    const binding = ownValue(record, key);
    if (binding !== undefined && !isBinding(binding)) return false;
  }
  const loras = ownValue(record, "loras");
  if (
    loras !== undefined &&
    (!isDenseDataArray(loras) ||
      !loras.every((item) => {
        const entry = ownDataRecord(item);
        return Boolean(
          entry &&
            exactOrOptionalKeys(entry, LORA_BINDING_KEYS, ["name", "modelWeight"]) &&
            isBinding(ownValue(entry!, "name")) &&
            isBinding(ownValue(entry!, "modelWeight")) &&
            (ownValue(entry!, "clipWeight") === undefined ||
              isBinding(ownValue(entry!, "clipWeight"))),
        );
      }))
  ) return false;
  const controlNets = ownValue(record, "controlNets");
  if (
    controlNets !== undefined &&
    (!isDenseDataArray(controlNets) ||
      !controlNets.every((item) => {
        const entry = ownDataRecord(item);
        return Boolean(
          entry &&
            exactOrOptionalKeys(entry, CONTROL_BINDING_KEYS, ["model", "strength"]) &&
            [...CONTROL_BINDING_KEYS].every((key) =>
              ownValue(entry!, key) === undefined || isBinding(ownValue(entry!, key)),
            ),
        );
      }))
  ) return false;
  const references = ownValue(record, "referenceImages");
  if (references !== undefined) {
    const referenceRecord = ownDataRecord(references);
    if (
      !referenceRecord ||
      !Reflect.ownKeys(referenceRecord).every(
        (key) =>
          typeof key === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(key) &&
          isBinding(ownValue(referenceRecord, key)),
      )
    ) return false;
  }
  const videoNodes = ownValue(record, "videoNodes");
  return videoNodes === undefined || arrayOfBindings(videoNodes);
}

function validateWorkflowConfigShape(value: unknown): value is ComfyUIWorkflowConfig {
  const record = ownDataRecord(value);
  if (
    !record ||
    !exactOrOptionalKeys(record, WORKFLOW_CONFIG_KEYS, ["workflow", "outputNodeIds"])
  ) return false;
  const workflow = ownDataRecord(ownValue(record, "workflow"));
  const outputNodeIds = ownValue(record, "outputNodeIds");
  if (
    !workflow ||
    Reflect.ownKeys(workflow).length === 0 ||
    !isDenseDataArray(outputNodeIds) ||
    !outputNodeIds.every(isSafeWorkflowIdentifier)
  ) return false;
  for (const nodeId of Reflect.ownKeys(workflow)) {
    if (!isSafeWorkflowIdentifier(nodeId)) return false;
    const node = ownDataRecord(ownValue(workflow, nodeId));
    if (
      !node ||
      !exactOrOptionalKeys(node, WORKFLOW_NODE_KEYS, ["class_type", "inputs"]) ||
      !isSafeWorkflowIdentifier(ownValue(node, "class_type")) ||
      !ownDataRecord(ownValue(node, "inputs")) ||
      (ownValue(node, "_meta") !== undefined &&
        !ownDataRecord(ownValue(node, "_meta")))
    ) return false;
  }
  const bindings = ownValue(record, "bindings");
  return bindings === undefined || validateBindingsShape(bindings);
}

function validateLoras(value: unknown): value is ComfyUILoRAConfig[] {
  return (
    isDenseDataArray(value) &&
    value.every((item) => {
      const record = ownDataRecord(item);
      const name = record ? ownValue(record, "name") : undefined;
      const modelWeight = record ? ownValue(record, "modelWeight") : undefined;
      const clipWeight = record ? ownValue(record, "clipWeight") : undefined;
      return Boolean(
        record &&
          exactOrOptionalKeys(record, LORA_CONFIG_KEYS, ["name", "modelWeight"]) &&
          isSafeConfigString(name) &&
          typeof modelWeight === "number" &&
          Number.isFinite(modelWeight) &&
          (clipWeight === undefined ||
            (typeof clipWeight === "number" && Number.isFinite(clipWeight))),
      );
    })
  );
}

function validateControlNets(value: unknown): value is ComfyUIControlNetConfig[] {
  return (
    isDenseDataArray(value) &&
    value.every((item) => {
      const record = ownDataRecord(item);
      const model = record ? ownValue(record, "model") : undefined;
      const strength = record ? ownValue(record, "strength") : undefined;
      const startPercent = record ? ownValue(record, "startPercent") : undefined;
      const endPercent = record ? ownValue(record, "endPercent") : undefined;
      const referenceSlot = record ? ownValue(record, "referenceSlot") : undefined;
      return Boolean(
        record &&
          exactOrOptionalKeys(record, CONTROL_CONFIG_KEYS, ["model", "strength"]) &&
          isSafeConfigString(model) &&
          typeof strength === "number" &&
          Number.isFinite(strength) &&
          (startPercent === undefined ||
            (typeof startPercent === "number" && Number.isFinite(startPercent))) &&
          (endPercent === undefined ||
            (typeof endPercent === "number" && Number.isFinite(endPercent))) &&
          (referenceSlot === undefined || isSafeSlot(referenceSlot)),
      );
    })
  );
}

function isSafeConfigString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isSafeSlot(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value)
  );
}

function publicValidationPath(value: string): string {
  if (value.includes("bindings")) return "template.workflow.bindings";
  if (value.startsWith("checkpoint")) return "template.checkpoint";
  if (value.startsWith("loras")) return "template.loras";
  if (value.startsWith("controlNets")) return "template.controlNets";
  if (value.startsWith("faceContinuity")) return "template.faceContinuity";
  return "template.workflow";
}

export function parseComfyUIWorkflowPackage(
  value: unknown,
): PackageParseResult {
  let treeIssue: ComfyUIWorkflowRegistryIssue | null;
  try {
    treeIssue = inspectPackageTree(value);
  } catch {
    treeIssue = issue(
      "invalid_package",
      "$",
      "Workflow package objects must be plain JSON objects.",
    );
  }
  if (treeIssue) return invalidResult(treeIssue);

  let packageBytes: number;
  try {
    packageBytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return invalidResult(
      issue("invalid_package", "$", "Workflow package must be valid JSON."),
    );
  }
  if (packageBytes <= 0 || packageBytes > COMFYUI_WORKFLOW_PACKAGE_MAX_BYTES) {
    return invalidResult(
      issue("package_too_large", "$", "Workflow package exceeds the 2 MB limit."),
    );
  }

  const packageRecord = ownDataRecord(value);
  if (
    !packageRecord ||
    !exactOrOptionalKeys(
      packageRecord,
      new Set(["schemaVersion", "template"]),
      ["schemaVersion", "template"],
    )
  ) {
    return invalidResult(
      issue("invalid_package", "$", "Workflow package envelope is invalid."),
    );
  }
  if (
    ownValue(packageRecord, "schemaVersion") !==
    COMFYUI_WORKFLOW_PACKAGE_SCHEMA_VERSION
  ) {
    return invalidResult(
      issue("unsupported_schema", "schemaVersion", "Workflow package schema is unsupported."),
    );
  }

  const template = ownDataRecord(ownValue(packageRecord, "template"));
  if (
    !template ||
    !exactOrOptionalKeys(template, TEMPLATE_KEYS, ["id", "name", "modality", "workflow"])
  ) {
    return invalidResult(
      issue("invalid_package", "template", "Workflow package template is invalid."),
    );
  }
  const id = ownValue(template, "id");
  const name = ownValue(template, "name");
  const modality = ownValue(template, "modality");
  const workflow = ownValue(template, "workflow");
  const checkpoint = ownValue(template, "checkpoint");
  const loras = ownValue(template, "loras");
  const controlNets = ownValue(template, "controlNets");
  const faceContinuity = ownValue(template, "faceContinuity");
  const faceRecord = faceContinuity === undefined
    ? undefined
    : ownDataRecord(faceContinuity);
  if (
    typeof id !== "string" ||
    typeof name !== "string" ||
    !name.trim() ||
    name.trim().length > 120 ||
    /[\u0000-\u001f\u007f]/.test(name) ||
    (modality !== "image" && modality !== "video") ||
    !validateWorkflowConfigShape(workflow) ||
    (checkpoint !== undefined && !isSafeConfigString(checkpoint)) ||
    (loras !== undefined && !validateLoras(loras)) ||
    (controlNets !== undefined && !validateControlNets(controlNets)) ||
    (faceContinuity !== undefined &&
      (!faceRecord ||
        !exactOrOptionalKeys(faceRecord, FACE_CONTINUITY_KEYS, ["enabled"]) ||
        typeof ownValue(faceRecord, "enabled") !== "boolean" ||
        (ownValue(faceRecord, "referenceSlot") !== undefined &&
          !isSafeSlot(ownValue(faceRecord, "referenceSlot")))))
  ) {
    return invalidResult(
      issue("invalid_package", "template", "Workflow package template is invalid."),
    );
  }

  const input: ImportComfyUIWorkflowInput = {
    id,
    name: name.trim(),
    modality,
    workflow: structuredClone(workflow),
    ...(checkpoint === undefined ? {} : { checkpoint }),
    ...(loras === undefined ? {} : { loras: structuredClone(loras) }),
    ...(controlNets === undefined
      ? {}
      : { controlNets: structuredClone(controlNets) }),
    ...(faceRecord === undefined
      ? {}
      : {
          faceContinuity: structuredClone(
            faceRecord as ImportComfyUIWorkflowInput["faceContinuity"],
          ),
        }),
  };

  let checked: ReturnType<typeof dryValidateComfyUIWorkflowImport>;
  try {
    checked = dryValidateComfyUIWorkflowImport(input);
  } catch {
    return invalidResult(
      issue("invalid_workflow", "template", "Workflow package validation failed."),
    );
  }
  if (!checked.ok || !checked.fingerprint) {
    const issues = [...new Set(checked.issues.map((item) => publicValidationPath(item.path)))]
      .slice(0, 16)
      .map((path) =>
        issue(
          "invalid_workflow",
          path,
          "Workflow package does not satisfy the registered ComfyUI contract.",
        ),
      );
    return {
      ok: false,
      dryResult: {
        ok: false,
        schemaVersion: COMFYUI_WORKFLOW_PACKAGE_SCHEMA_VERSION,
        templateId: id.trim().toLowerCase(),
        name: name.trim(),
        modality,
        nodeCount: Object.keys(workflow.workflow).length,
        issues: issues.length
          ? issues
          : [issue("invalid_workflow", "template.workflow", "Workflow package validation failed.")],
      },
    };
  }

  return {
    ok: true,
    value: {
      input,
      dryResult: {
        ok: true,
        schemaVersion: COMFYUI_WORKFLOW_PACKAGE_SCHEMA_VERSION,
        templateId: checked.templateId,
        name: name.trim(),
        modality,
        fingerprint: checked.fingerprint,
        nodeCount: Object.keys(workflow.workflow).length,
        issues: [],
      },
    },
  };
}
