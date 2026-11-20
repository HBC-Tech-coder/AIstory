import type { SteamworksStatus } from "@/lib/steam/contracts";

export const STEAM_DEMO_REPORT_SCHEMA = "aistory-steam-demo-test-report";
export const STEAM_DEMO_REPORT_SCHEMA_VERSION = 1 as const;
export const STEAM_DEMO_REPORT_FILENAME =
  "aistory-steam-demo-test-report-v1.json";
export const STEAM_DEMO_REPORT_MAX_BYTES = 16 * 1024;
export const STEAM_DEMO_REPORT_MAX_DESCRIPTION_CODEPOINTS = 280;

const STEAM_CAPABILITIES = [
  "identity",
  "cloud",
  "input",
  "overlay",
  "softKeyboard",
  "wallet",
] as const;

const PUBLIC_CASE_IDS = new Set([
  "virtual-girlfriend-20260727",
  "world-model-anime-sunset",
  "world-model-close-encounter",
  "world-model-midnight-heartbeat",
  "world-model-little-chef",
  "world-model-forest-friend",
]);

const PUBLIC_STORY_IDS = new Set([
  ...Array.from({ length: 30 }, (_, index) => `m${index}`),
  ...Array.from({ length: 30 }, (_, index) => `f${index}`),
]);

type SteamCapability = (typeof STEAM_CAPABILITIES)[number];
type SteamDemoPublicRoute = "steam" | "play" | "stories";
type SteamDemoPlatform = "windows" | "linux" | "web";
type SteamDemoArchitecture = "x64" | "unknown";

export type SteamDemoReportInput = {
  releaseId: string;
  generatedAt: string;
  appVersion: string;
  platform: SteamDemoPlatform;
  architecture: SteamDemoArchitecture;
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  publicContext: {
    route: SteamDemoPublicRoute;
    caseId?: string;
    storyId?: string;
  };
  steamworks: SteamworksStatus;
  issueDescription: string;
};

export type SteamDemoReport = {
  schema: typeof STEAM_DEMO_REPORT_SCHEMA;
  schemaVersion: typeof STEAM_DEMO_REPORT_SCHEMA_VERSION;
  releaseId: string;
  generatedAt: string;
  app: {
    version: string;
    platform: SteamDemoPlatform;
    architecture: SteamDemoArchitecture;
  };
  viewport: {
    width: number;
    height: number;
    devicePixelRatio: number;
  };
  publicContext: {
    route: SteamDemoPublicRoute;
    caseId?: string;
    storyId?: string;
  };
  steamCapabilities: {
    configured: boolean;
    identity: boolean;
    cloud: boolean;
    input: boolean;
    overlay: boolean;
    softKeyboard: boolean;
    wallet: boolean;
  };
  issueDescription: string;
};

export type SteamDemoReportBundle = {
  filename: typeof STEAM_DEMO_REPORT_FILENAME;
  mimeType: "application/json;charset=utf-8";
  json: string;
  bytes: number;
  report: SteamDemoReport;
};

export type SteamDemoReportDelivery =
  | { status: "download-started" }
  | { status: "copied" }
  | { status: "unavailable" };

export type SteamDemoReportDeliveryAdapters = {
  download: (bundle: SteamDemoReportBundle) => void | Promise<void>;
  copy: (text: string) => void | Promise<void>;
};

export type SteamDemoReportDownloadEnvironment = {
  createBlob: (parts: BlobPart[], options: BlobPropertyBag) => Blob;
  createObjectUrl: (blob: Blob) => string;
  revokeObjectUrl: (url: string) => void;
  createAnchor: () => {
    href: string;
    download: string;
    rel: string;
    click: () => void;
    remove: () => void;
  };
  appendAnchor: (anchor: ReturnType<SteamDemoReportDownloadEnvironment["createAnchor"]>) => void;
};

export class SteamDemoReportValidationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SteamDemoReportValidationError";
  }
}

function fail(code: string): never {
  throw new SteamDemoReportValidationError(code);
}

function plainRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
  code = "report_input_shape_invalid",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  let ownKeys: PropertyKey[];
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    fail(code);
  }
  if (ownKeys.some((key) => typeof key !== "string")) fail(code);
  const names = ownKeys as string[];
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (
    names.some((key) => !allowed.has(key)) ||
    requiredKeys.some((key) => !names.includes(key))
  ) {
    fail(code);
  }
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      fail(code);
    }
  }
  return value as Record<string, unknown>;
}

function safeBuildIdentifier(value: unknown, code: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,95}$/i.test(value) ||
    /^(?:akia|ltai|sk[-_])/i.test(value)
  ) {
    fail(code);
  }
  return value;
}

function safeIsoTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length !== 24) {
    fail("report_timestamp_invalid");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    fail("report_timestamp_invalid");
  }
  return value;
}

function safeViewportNumber(
  value: unknown,
  min: number,
  max: number,
  integer: boolean,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max ||
    (integer && !Number.isInteger(value))
  ) {
    fail("report_viewport_invalid");
  }
  return value;
}

function containsForbiddenDescription(value: string): boolean {
  const normalized = value.normalize("NFKC");
  return (
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(
      normalized,
    ) ||
    /(?:[a-z]:[\\/]|\\\\|(?:^|[\s("'])\/(?:users|home|etc|var|private|opt|tmp|root|mnt)\/|file:|(?:^|[\s("'])\.{1,2}[\\/]|%2e%2e|%2f|%5c)/iu.test(
      normalized,
    ) ||
    /(?:https?|wss?|ftp):\/\//iu.test(normalized) ||
    /\b(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}):\d{2,5}\b/iu.test(normalized) ||
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu.test(normalized) ||
    /\b(?:AKIA[0-9A-Z]{16}|LTAI[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,})\b/u.test(
      normalized,
    ) ||
    /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+\/-]{8,}={0,2}\b/iu.test(normalized) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(normalized) ||
    /\b[A-Za-z0-9_-]{48,}\b/u.test(normalized) ||
    /\b(?:account|user(?:name)?|authorization|cookie|session|api[_-]?key|access[_-]?key|secret|token|password)(?:\s*[:=]\s*|\s+)\S{4,}/iu.test(
      normalized,
    ) ||
    /(?:\u8d26\u53f7|\u5bc6\u7801|\u53e3\u4ee4|\u5bc6\u94a5|\u4ee4\u724c|\u63d0\u793a\u8bcd)\s*[:\uFF1A=]?\s*\S{4,}/u.test(normalized) ||
    /\b(?:prompt|workflow|provider[ _-]?task)\b/iu.test(normalized) ||
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu.test(
      normalized,
    ) ||
    /(?:\+?86[- ]?)?1[3-9]\d{9}/u.test(normalized) ||
    /(?:\+\d{1,3}[ .-]?)?(?:\(\d{2,4}\)[ .-]?|\d{2,4}[ .-])\d{3}[ .-]\d{4}/u.test(normalized)
  );
}

function safeDescription(value: unknown): string {
  if (typeof value !== "string") fail("report_description_invalid");
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").trim();
  const codepoints = [...normalized];
  if (
    codepoints.length < 1 ||
    codepoints.length > STEAM_DEMO_REPORT_MAX_DESCRIPTION_CODEPOINTS ||
    new TextEncoder().encode(normalized).byteLength > 2_048 ||
    containsForbiddenDescription(normalized)
  ) {
    fail("report_description_invalid");
  }
  return normalized;
}

export function isPublicSteamDemoCaseId(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_CASE_IDS.has(value);
}

export function isPublicSteamDemoStoryId(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_STORY_IDS.has(value);
}

function safePublicContext(value: unknown): SteamDemoReport["publicContext"] {
  const record = plainRecord(
    value,
    ["route"],
    ["caseId", "storyId"],
    "report_public_context_invalid",
  );
  if (!new Set(["steam", "play", "stories"]).has(String(record.route))) {
    fail("report_public_context_invalid");
  }
  const route = record.route as SteamDemoPublicRoute;
  if (record.caseId !== undefined && !isPublicSteamDemoCaseId(record.caseId)) {
    fail("report_public_context_invalid");
  }
  if (record.storyId !== undefined && !isPublicSteamDemoStoryId(record.storyId)) {
    fail("report_public_context_invalid");
  }
  if ((record.caseId !== undefined || record.storyId !== undefined) && route !== "play") {
    fail("report_public_context_invalid");
  }
  if (record.caseId !== undefined && record.storyId !== undefined) {
    fail("report_public_context_invalid");
  }
  return {
    route,
    ...(record.caseId === undefined ? {} : { caseId: record.caseId as string }),
    ...(record.storyId === undefined
      ? {}
      : { storyId: record.storyId as string }),
  };
}

function safeSteamCapabilities(
  value: unknown,
): SteamDemoReport["steamCapabilities"] {
  const record = plainRecord(
    value,
    ["configured", "appIdConfigured", "capabilities"],
    [],
    "report_steam_capabilities_invalid",
  );
  if (
    typeof record.configured !== "boolean" ||
    typeof record.appIdConfigured !== "boolean" ||
    !Array.isArray(record.capabilities) ||
    record.capabilities.length !== STEAM_CAPABILITIES.length
  ) {
    fail("report_steam_capabilities_invalid");
  }
  const values = new Map<SteamCapability, boolean>();
  for (const item of record.capabilities) {
    const capability = plainRecord(
      item,
      ["capability", "available", "reason"],
      [],
      "report_steam_capabilities_invalid",
    );
    if (
      !STEAM_CAPABILITIES.includes(capability.capability as SteamCapability) ||
      typeof capability.available !== "boolean" ||
      typeof capability.reason !== "string" ||
      values.has(capability.capability as SteamCapability)
    ) {
      fail("report_steam_capabilities_invalid");
    }
    values.set(capability.capability as SteamCapability, capability.available);
  }
  if (STEAM_CAPABILITIES.some((capability) => !values.has(capability))) {
    fail("report_steam_capabilities_invalid");
  }
  return {
    configured: record.configured,
    identity: values.get("identity")!,
    cloud: values.get("cloud")!,
    input: values.get("input")!,
    overlay: values.get("overlay")!,
    softKeyboard: values.get("softKeyboard")!,
    wallet: values.get("wallet")!,
  };
}

export function buildSteamDemoReport(input: unknown): SteamDemoReport {
  const record = plainRecord(input, [
    "releaseId",
    "generatedAt",
    "appVersion",
    "platform",
    "architecture",
    "viewport",
    "publicContext",
    "steamworks",
    "issueDescription",
  ]);
  if (!new Set(["windows", "linux", "web"]).has(String(record.platform))) {
    fail("report_platform_invalid");
  }
  if (!new Set(["x64", "unknown"]).has(String(record.architecture))) {
    fail("report_architecture_invalid");
  }
  const viewport = plainRecord(
    record.viewport,
    ["width", "height", "devicePixelRatio"],
    [],
    "report_viewport_invalid",
  );
  return {
    schema: STEAM_DEMO_REPORT_SCHEMA,
    schemaVersion: STEAM_DEMO_REPORT_SCHEMA_VERSION,
    releaseId: safeBuildIdentifier(record.releaseId, "report_release_id_invalid"),
    generatedAt: safeIsoTimestamp(record.generatedAt),
    app: {
      version: safeBuildIdentifier(record.appVersion, "report_app_version_invalid"),
      platform: record.platform as SteamDemoPlatform,
      architecture: record.architecture as SteamDemoArchitecture,
    },
    viewport: {
      width: safeViewportNumber(viewport.width, 240, 16_384, true),
      height: safeViewportNumber(viewport.height, 240, 16_384, true),
      devicePixelRatio: safeViewportNumber(
        viewport.devicePixelRatio,
        0.5,
        8,
        false,
      ),
    },
    publicContext: safePublicContext(record.publicContext),
    steamCapabilities: safeSteamCapabilities(record.steamworks),
    issueDescription: safeDescription(record.issueDescription),
  };
}

export function serializeSteamDemoReport(report: SteamDemoReport): string {
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (new TextEncoder().encode(json).byteLength > STEAM_DEMO_REPORT_MAX_BYTES) {
    fail("report_too_large");
  }
  return json;
}

export function createSteamDemoReportBundle(
  input: SteamDemoReportInput,
): SteamDemoReportBundle {
  const report = buildSteamDemoReport(input);
  const json = serializeSteamDemoReport(report);
  return {
    filename: STEAM_DEMO_REPORT_FILENAME,
    mimeType: "application/json;charset=utf-8",
    json,
    bytes: new TextEncoder().encode(json).byteLength,
    report,
  };
}

function defaultDownloadEnvironment(): SteamDemoReportDownloadEnvironment {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    fail("report_download_unavailable");
  }
  return {
    createBlob: (parts, options) => new Blob(parts, options),
    createObjectUrl: (blob) => URL.createObjectURL(blob),
    revokeObjectUrl: (url) => URL.revokeObjectURL(url),
    createAnchor: () => document.createElement("a"),
    appendAnchor: (anchor) => document.body.appendChild(anchor as HTMLAnchorElement),
  };
}

export function downloadSteamDemoReportInBrowser(
  bundle: SteamDemoReportBundle,
  environment: SteamDemoReportDownloadEnvironment = defaultDownloadEnvironment(),
): void {
  const blob = environment.createBlob([bundle.json], {
    type: bundle.mimeType,
  });
  const objectUrl = environment.createObjectUrl(blob);
  let anchor: ReturnType<SteamDemoReportDownloadEnvironment["createAnchor"]> | undefined;
  try {
    anchor = environment.createAnchor();
    anchor.href = objectUrl;
    anchor.download = bundle.filename;
    anchor.rel = "noopener";
    environment.appendAnchor(anchor);
    anchor.click();
  } finally {
    try {
      anchor?.remove();
    } catch {
      // Cleanup remains best effort; the object URL is always revoked below.
    }
    try {
      environment.revokeObjectUrl(objectUrl);
    } catch {
      // Do not turn a completed local download into an unhandled UI failure.
    }
  }
}

export async function deliverSteamDemoReportLocally(
  bundle: SteamDemoReportBundle,
  adapters: SteamDemoReportDeliveryAdapters,
): Promise<SteamDemoReportDelivery> {
  try {
    await adapters.download(bundle);
    return { status: "download-started" };
  } catch {
    try {
      await adapters.copy(bundle.json);
      return { status: "copied" };
    } catch {
      return { status: "unavailable" };
    }
  }
}

export async function copySteamDemoReportLocally(
  bundle: SteamDemoReportBundle,
  copy: (text: string) => void | Promise<void>,
): Promise<SteamDemoReportDelivery> {
  try {
    await copy(bundle.json);
    return { status: "copied" };
  } catch {
    return { status: "unavailable" };
  }
}
