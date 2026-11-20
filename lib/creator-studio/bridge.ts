export const CREATOR_STUDIO_BRIDGE_PROTOCOL_VERSION = 1 as const;

export const CREATOR_STUDIO_SELECTED_PROJECT_STORAGE_KEY =
  "aistory:studio:selectedProjectId";

export type CreatorStudioBridgeModule =
  | "tasks"
  | "media"
  | "local-generation";

export type CreatorStudioMediaKind = "image" | "video" | "audio" | "all";

export type CreatorStudioOpenModuleIntent =
  | {
      projectId: number;
      module: "tasks";
      taskId?: string;
    }
  | {
      projectId: number;
      module: "media";
      mediaKind: CreatorStudioMediaKind;
    }
  | {
      projectId: number;
      module: "local-generation";
    };

export type CreatorStudioProjectSelectedMessage = {
  protocolVersion: typeof CREATOR_STUDIO_BRIDGE_PROTOCOL_VERSION;
  type: "aistory:localminidrama:project-selected";
  projectId: number;
};

export type CreatorStudioOpenModuleMessage = CreatorStudioOpenModuleIntent & {
  protocolVersion: typeof CREATOR_STUDIO_BRIDGE_PROTOCOL_VERSION;
  type: "aistory:localminidrama:open-module";
};

export type CreatorStudioReadyMessage = {
  protocolVersion: typeof CREATOR_STUDIO_BRIDGE_PROTOCOL_VERSION;
  type: "aistory:localminidrama:ready";
};

export type CreatorStudioInboundMessage =
  | CreatorStudioProjectSelectedMessage
  | CreatorStudioOpenModuleMessage
  | CreatorStudioReadyMessage;

export type CreatorStudioHostContextMessage = {
  protocolVersion: typeof CREATOR_STUDIO_BRIDGE_PROTOCOL_VERSION;
  type: "aistory:host-context";
  projectId: number | null;
  module?: CreatorStudioBridgeModule;
  taskId?: string;
  mediaKind?: CreatorStudioMediaKind;
};

export type CreatorStudioBridgeAction =
  | {
      kind: "project-selected";
      projectId: number;
    }
  | {
      kind: "open-module";
      intent: CreatorStudioOpenModuleIntent;
    }
  | {
      kind: "ready";
    };

type MessageEventLike = {
  origin: string;
  source: unknown;
  data: unknown;
};

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const MEDIA_KINDS = new Set<CreatorStudioMediaKind>([
  "image",
  "video",
  "audio",
  "all",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return false;
    }
    return Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function ownDataValue(record: Record<string, unknown>, key: string): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

function hasExactKeys(
  record: Record<string, unknown>,
  expectedKeys: readonly string[],
): boolean {
  try {
    const ownKeys = Reflect.ownKeys(record);
    if (ownKeys.some((key) => typeof key !== "string")) return false;
    const keys = (ownKeys as string[]).sort();
    const expected = [...expectedKeys].sort();
    return (
      keys.length === expected.length &&
      keys.every((key, index) => key === expected[index])
    );
  } catch {
    return false;
  }
}

function isPositiveProjectId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isSafeTaskId(value: unknown): value is string {
  return typeof value === "string" && TASK_ID_PATTERN.test(value);
}

function isMediaKind(value: unknown): value is CreatorStudioMediaKind {
  return typeof value === "string" && MEDIA_KINDS.has(value as CreatorStudioMediaKind);
}

function normalizeOpenModuleIntent(
  input: CreatorStudioOpenModuleIntent,
): CreatorStudioOpenModuleIntent | null {
  if (!isPositiveProjectId(input.projectId)) return null;
  if (input.module === "tasks") {
    if (input.taskId !== undefined && !isSafeTaskId(input.taskId)) return null;
    return input.taskId === undefined
      ? { projectId: input.projectId, module: "tasks" }
      : { projectId: input.projectId, module: "tasks", taskId: input.taskId };
  }
  if (input.module === "media") {
    if (!isMediaKind(input.mediaKind)) return null;
    return {
      projectId: input.projectId,
      module: "media",
      mediaKind: input.mediaKind,
    };
  }
  if (input.module === "local-generation") {
    return { projectId: input.projectId, module: "local-generation" };
  }
  return null;
}

export function buildCreatorStudioProjectSelectedMessage(
  projectId: number,
): CreatorStudioProjectSelectedMessage | null {
  if (!isPositiveProjectId(projectId)) return null;
  return {
    protocolVersion: CREATOR_STUDIO_BRIDGE_PROTOCOL_VERSION,
    type: "aistory:localminidrama:project-selected",
    projectId,
  };
}

export function buildCreatorStudioOpenModuleMessage(
  input: CreatorStudioOpenModuleIntent,
): CreatorStudioOpenModuleMessage | null {
  const intent = normalizeOpenModuleIntent(input);
  if (!intent) return null;
  return {
    protocolVersion: CREATOR_STUDIO_BRIDGE_PROTOCOL_VERSION,
    type: "aistory:localminidrama:open-module",
    ...intent,
  };
}

export function buildCreatorStudioReadyMessage(): CreatorStudioReadyMessage {
  return {
    protocolVersion: CREATOR_STUDIO_BRIDGE_PROTOCOL_VERSION,
    type: "aistory:localminidrama:ready",
  };
}

export function buildCreatorStudioHostContext(input: {
  projectId: number | null;
  intent?: CreatorStudioOpenModuleIntent | null;
}): CreatorStudioHostContextMessage | null {
  if (input.projectId !== null && !isPositiveProjectId(input.projectId)) return null;
  const base: CreatorStudioHostContextMessage = {
    protocolVersion: CREATOR_STUDIO_BRIDGE_PROTOCOL_VERSION,
    type: "aistory:host-context",
    projectId: input.projectId,
  };
  if (!input.intent) return base;
  const intent = normalizeOpenModuleIntent(input.intent);
  if (!intent || input.projectId === null || intent.projectId !== input.projectId) {
    return null;
  }
  if (intent.module === "tasks") {
    return intent.taskId === undefined
      ? { ...base, module: "tasks" }
      : { ...base, module: "tasks", taskId: intent.taskId };
  }
  if (intent.module === "media") {
    return { ...base, module: "media", mediaKind: intent.mediaKind };
  }
  return { ...base, module: "local-generation" };
}

export function parseCreatorStudioInboundMessage(
  input: unknown,
): CreatorStudioInboundMessage | null {
  if (!isPlainRecord(input)) return null;
  const protocolVersion = ownDataValue(input, "protocolVersion");
  const type = ownDataValue(input, "type");
  if (
    protocolVersion !== CREATOR_STUDIO_BRIDGE_PROTOCOL_VERSION ||
    typeof type !== "string"
  ) {
    return null;
  }

  if (type === "aistory:localminidrama:ready") {
    return hasExactKeys(input, ["protocolVersion", "type"])
      ? buildCreatorStudioReadyMessage()
      : null;
  }

  const projectId = ownDataValue(input, "projectId");
  if (!isPositiveProjectId(projectId)) return null;

  if (type === "aistory:localminidrama:project-selected") {
    return hasExactKeys(input, ["protocolVersion", "type", "projectId"])
      ? buildCreatorStudioProjectSelectedMessage(projectId)
      : null;
  }

  if (type !== "aistory:localminidrama:open-module") return null;
  const moduleId = ownDataValue(input, "module");
  if (moduleId === "tasks") {
    const taskId = ownDataValue(input, "taskId");
    const expectedKeys = taskId === undefined
      ? ["protocolVersion", "type", "projectId", "module"]
      : ["protocolVersion", "type", "projectId", "module", "taskId"];
    if (!hasExactKeys(input, expectedKeys)) return null;
    if (taskId !== undefined && !isSafeTaskId(taskId)) return null;
    return buildCreatorStudioOpenModuleMessage(
      taskId === undefined
        ? { projectId, module: "tasks" }
        : { projectId, module: "tasks", taskId },
    );
  }
  if (moduleId === "media") {
    const mediaKind = ownDataValue(input, "mediaKind");
    if (
      !hasExactKeys(input, [
        "protocolVersion",
        "type",
        "projectId",
        "module",
        "mediaKind",
      ]) ||
      !isMediaKind(mediaKind)
    ) {
      return null;
    }
    return buildCreatorStudioOpenModuleMessage({
      projectId,
      module: "media",
      mediaKind,
    });
  }
  if (moduleId === "local-generation") {
    if (
      !hasExactKeys(input, ["protocolVersion", "type", "projectId", "module"])
    ) {
      return null;
    }
    return buildCreatorStudioOpenModuleMessage({
      projectId,
      module: "local-generation",
    });
  }
  return null;
}

export function resolveCreatorStudioBridgeAction(
  event: MessageEventLike,
  context: {
    trustedOrigin: string;
    trustedSource: unknown;
    knownProjectIds: readonly number[];
    currentProjectId: number | null;
  },
): CreatorStudioBridgeAction | null {
  if (
    !context.trustedSource ||
    event.origin !== context.trustedOrigin ||
    event.source !== context.trustedSource
  ) {
    return null;
  }
  const message = parseCreatorStudioInboundMessage(event.data);
  if (!message) return null;
  if (message.type === "aistory:localminidrama:ready") {
    return { kind: "ready" };
  }
  if (!context.knownProjectIds.includes(message.projectId)) return null;
  if (message.type === "aistory:localminidrama:project-selected") {
    return { kind: "project-selected", projectId: message.projectId };
  }
  if (context.currentProjectId !== message.projectId) return null;
  return {
    kind: "open-module",
    intent: {
      projectId: message.projectId,
      module: message.module,
      ...(message.module === "tasks" && message.taskId
        ? { taskId: message.taskId }
        : {}),
      ...(message.module === "media"
        ? { mediaKind: message.mediaKind }
        : {}),
    } as CreatorStudioOpenModuleIntent,
  };
}

export function readRememberedCreatorStudioProject(
  storage: StorageReader,
  knownProjectIds: readonly number[],
): number | null {
  try {
    const raw = storage.getItem(CREATOR_STUDIO_SELECTED_PROJECT_STORAGE_KEY);
    if (raw === null || !/^[1-9]\d*$/.test(raw)) return null;
    const projectId = Number(raw);
    return isPositiveProjectId(projectId) && knownProjectIds.includes(projectId)
      ? projectId
      : null;
  } catch {
    return null;
  }
}

export function rememberCreatorStudioProject(
  storage: StorageWriter,
  projectId: number,
): boolean {
  if (!isPositiveProjectId(projectId)) return false;
  try {
    storage.setItem(CREATOR_STUDIO_SELECTED_PROJECT_STORAGE_KEY, String(projectId));
    return true;
  } catch {
    return false;
  }
}
