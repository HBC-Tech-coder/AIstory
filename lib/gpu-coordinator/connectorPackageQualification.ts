import "server-only";

import { createHash } from "node:crypto";

import JSZip from "jszip";

import {
  GPU_CONNECTOR_COMPATIBILITY_CONTRACT,
  GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE,
  GPU_COORDINATOR_EXPECTED_BUILD_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_CAPABILITY_DIGEST_ENV,
  GPU_COORDINATOR_EXPECTED_CENTRAL_CONTRACT_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_RELEASE_SHA_ENV,
  GPU_COORDINATOR_EXPECTED_RUNNER_MODE_ENV,
} from "./connectorCompatibility";
import { stableCoordinatorJson } from "./protocol";

export const CONNECTOR_PACKAGE_MANIFEST_SCHEMA_VERSION =
  "aistory-gpu-connector-package-sidecar-v1" as const;
export const CONNECTOR_PACKAGE_QUALIFICATION_SCHEMA_VERSION =
  "aistory-gpu-connector-package-qualification-v1" as const;
export const CONNECTOR_PACKAGE_STATIC_QUALIFIED =
  "OFFLINE_PACKAGE_STATIC_QUALIFIED" as const;
export const CONNECTOR_PACKAGE_STATIC_REJECTED =
  "OFFLINE_PACKAGE_STATIC_REJECTED" as const;
export const P1_7_CENTRAL_GOLDEN_SHA256 =
  "e97deff32dbc55f2a4953263289ddbcd3acd75dfd2ca7bca81247d09b3f148b4" as const;
export const P1_7_CENTRAL_GOLDEN_BYTES = 6_699 as const;
export const CENTRAL_GOLDEN_SOURCE_NAMES = Object.freeze([
  "types.ts",
  "connectorCompatibility.ts",
  "protocol.ts",
  "service.ts",
  "server.ts",
] as const);

export const CONNECTOR_PACKAGE_QUALIFICATION_LIMITS = Object.freeze({
  zipBytes: 16 * 1024 * 1024,
  manifestBytes: 2 * 1024 * 1024,
  goldenBytes: 1024 * 1024,
  goldenSidecarBytes: 256,
  entryCount: 512,
  entryUncompressedBytes: 8 * 1024 * 1024,
  totalUncompressedBytes: 64 * 1024 * 1024,
  entryCompressionRatio: 100,
  aggregateCompressionRatio: 50,
  pathUtf8Bytes: 240,
  pathSegmentUtf8Bytes: 100,
});

const SOURCE_TREE_POLICY = "aistory-connector-source-tree-v1" as const;
const SOURCE_TREE_ALGORITHM =
  "sha256-path-lf-sha256-lf-bytes-lf-v1" as const;
const RELEASE_MANIFEST_PATH = "RELEASE-MANIFEST.json" as const;
const CAPABILITY_MANIFEST_PATH = "capability-manifest.json" as const;
const ROOT_SOURCE_FILES = Object.freeze([
  ".gitignore",
  "LICENSE",
  "README.md",
  "config.example.env",
  "pyproject.toml",
  "requirements-dev.lock",
  "requirements.lock",
  "sbom.cdx.json",
] as const);
const RECURSIVE_SOURCE_ROOTS = Object.freeze([
  "approved_workflows",
  "contracts",
  "docs",
  "evidence",
  "lab_workflows",
  "src",
  "tests",
] as const);

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export type ConnectorPackageQualificationErrorCode =
  | "manifest_invalid"
  | "package_invalid"
  | "package_limit_exceeded"
  | "archive_invalid"
  | "archive_encrypted"
  | "archive_path_invalid"
  | "archive_duplicate_entry"
  | "archive_link_forbidden"
  | "archive_unsupported"
  | "archive_manifest_mismatch"
  | "archive_integrity_mismatch"
  | "golden_invalid"
  | "golden_sidecar_mismatch"
  | "golden_contract_mismatch"
  | "central_source_mismatch"
  | "compatibility_mismatch"
  | "fake_evidence_mismatch";

export class ConnectorPackageQualificationError extends Error {
  readonly code: ConnectorPackageQualificationErrorCode;

  constructor(code: ConnectorPackageQualificationErrorCode) {
    super("connector_package_qualification_rejected");
    this.name = "ConnectorPackageQualificationError";
    this.code = code;
  }
}

type PayloadFileRecord = {
  path: string;
  bytes: number;
  sha256: string;
};

type PackageManifest = {
  schemaVersion: typeof CONNECTOR_PACKAGE_MANIFEST_SCHEMA_VERSION;
  package: {
    name: string;
    bytes: number;
    sha256: string;
    entryCount: number;
    totalExpandedBytes: number;
    releaseManifest: PayloadFileRecord;
    capabilityManifestPath: typeof CAPABILITY_MANIFEST_PATH;
    payloadFiles: PayloadFileRecord[];
  };
  sourceTree: {
    policy: typeof SOURCE_TREE_POLICY;
    algorithm: typeof SOURCE_TREE_ALGORITHM;
    sha256: string;
    fileCount: number;
    files: PayloadFileRecord[];
  };
  identity: {
    connectorVersion: string;
    buildSha256: string;
    releaseSha256: string;
    capabilityDigestSha256: string;
    centralContractSha256: string;
  };
  compatibilityReport: {
    schemaVersion: "aistory-gpu-connector-package-compatibility-v1";
    binding: {
      buildSha256: string;
      releaseSha256: string;
      capabilityDigestSha256: string;
      centralContractSha256: string;
    };
    contract: typeof GPU_CONNECTOR_COMPATIBILITY_CONTRACT;
    requiredInitialPosture: typeof GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE;
  };
  staticFakeEvidence: {
    kind: "STATIC_FAKE_CONFORMANCE_ONLY";
    sequence: [
      "register",
      "heartbeat_idle",
      "lease_no_work",
      "lease_no_work",
      "lease_no_work",
    ];
    reconcileRequestStates: string[];
    reconcileResponseAuthoritativeStates: string[];
    leaseClaimCalls: 0;
    providerCalls: 0;
    networkCalls: 0;
    archiveCodeExecutions: 0;
  };
};

type RawZipEntry = {
  path: string;
  crc32: number;
  compressionMethod: number;
  compressedBytes: number;
  uncompressedBytes: number;
  localHeaderOffset: number;
  dataOffset: number;
  dataEnd: number;
};

export type CentralGoldenSource = {
  name: (typeof CENTRAL_GOLDEN_SOURCE_NAMES)[number];
  bytes: Uint8Array;
};

export type ConnectorPackageQualificationInput = {
  zipBytes: Uint8Array;
  zipFileName: string;
  manifestBytes: Uint8Array;
  goldenBytes: Uint8Array;
  goldenFileName: string;
  goldenSidecarBytes: Uint8Array;
  centralSources: readonly CentralGoldenSource[];
};

export type ConnectorPackageQualificationReport = {
  schemaVersion: typeof CONNECTOR_PACKAGE_QUALIFICATION_SCHEMA_VERSION;
  status: typeof CONNECTOR_PACKAGE_STATIC_QUALIFIED;
  package: {
    name: string;
    bytes: number;
    sha256: string;
    entryCount: number;
    totalExpandedBytes: number;
    sourceFileCount: number;
    sourceTreeSha256: string;
  };
  identity: PackageManifest["identity"];
  compatibility: {
    firstHeartbeat: "idle";
    heartbeatRequestStates: readonly string[];
    reconcileRequestStates: readonly string[];
    reconcileResponseAuthoritativeStates: readonly string[];
    productionNetworkDefault: false;
    lanLabNetworkDefault: false;
    networkGatesMutuallyExclusive: true;
    lanLabNetworkEnvironment: string;
    runnerMode: "no_work_only";
    noWorkOnlyFirstGate: true;
    staticFakeEvidenceShapeVerified: true;
    connectorFakeTestsExecuted: false;
  };
  limits: typeof CONNECTOR_PACKAGE_QUALIFICATION_LIMITS;
  provenanceVerified: false;
  signatureVerified: false;
  runtimeBindingVerified: false;
  noWorkExecuted: false;
  gpuExecuted: false;
  deployable: false;
  networkCalls: 0;
  archiveCodeExecuted: false;
};

function reject(code: ConnectorPackageQualificationErrorCode): never {
  throw new ConnectorPackageQualificationError(code);
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8(bytes: Uint8Array, code: ConnectorPackageQualificationErrorCode): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return reject(code);
  }
}

function assertDataOnly(value: unknown): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const visit = (input: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 100_000 || depth > 32) reject("manifest_invalid");
    if (
      input === null ||
      typeof input === "string" ||
      typeof input === "boolean"
    ) {
      return;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) reject("manifest_invalid");
      return;
    }
    if (!input || typeof input !== "object") reject("manifest_invalid");
    if (seen.has(input)) reject("manifest_invalid");
    seen.add(input);
    if (Array.isArray(input)) {
      if (Object.getPrototypeOf(input) !== Array.prototype) {
        reject("manifest_invalid");
      }
      const keys = Reflect.ownKeys(input);
      if (
        keys.length !== input.length + 1 ||
        keys[keys.length - 1] !== "length"
      ) {
        reject("manifest_invalid");
      }
      for (let index = 0; index < input.length; index += 1) {
        if (keys[index] !== String(index)) reject("manifest_invalid");
        const descriptor = Object.getOwnPropertyDescriptor(input, String(index));
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          reject("manifest_invalid");
        }
        visit(descriptor.value, depth + 1);
      }
      return;
    }
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      reject("manifest_invalid");
    }
    for (const key of Reflect.ownKeys(input)) {
      if (typeof key !== "string") reject("manifest_invalid");
      const descriptor = Object.getOwnPropertyDescriptor(input, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        reject("manifest_invalid");
      }
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  code: ConnectorPackageQualificationErrorCode = "manifest_invalid",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject(code);
  const actual = Reflect.ownKeys(value);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== "string" || !keys.includes(key))
  ) {
    reject(code);
  }
  const output: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      reject(code);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function exactArray(
  value: unknown,
  code: ConnectorPackageQualificationErrorCode = "manifest_invalid",
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    reject(code);
  }
  const keys = Reflect.ownKeys(value);
  if (keys.length !== value.length + 1 || keys[keys.length - 1] !== "length") {
    reject(code);
  }
  const result: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (keys[index] !== String(index)) reject(code);
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      reject(code);
    }
    result.push(descriptor.value);
  }
  return result;
}

function safeString(value: unknown, maxLength = 128): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maxLength ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(value)
  ) {
    reject("manifest_invalid");
  }
  return value;
}

function safeInteger(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max) {
    reject("manifest_invalid");
  }
  return Number(value);
}

function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    reject("manifest_invalid");
  }
  return value;
}

function safePackageName(value: unknown): string {
  const name = safeString(value, 96);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.zip$/u.test(name) ||
    name.includes("..")
  ) {
    reject("manifest_invalid");
  }
  return name;
}

function safeArchivePath(value: unknown): string {
  const candidate = safeString(value, CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.pathUtf8Bytes);
  if (
    !/^[\x21-\x7e]+$/u.test(candidate) ||
    candidate.startsWith("/") ||
    candidate.endsWith("/") ||
    candidate.includes("\\") ||
    candidate.includes(":") ||
    candidate.includes("%") ||
    candidate.includes("//") ||
    /^file:/iu.test(candidate)
  ) {
    reject("archive_path_invalid");
  }
  const segments = candidate.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.endsWith(".") ||
        segment.endsWith(" ") ||
        Buffer.byteLength(segment, "utf8") >
          CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.pathSegmentUtf8Bytes ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    )
  ) {
    reject("archive_path_invalid");
  }
  if (
    Buffer.byteLength(candidate, "utf8") >
    CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.pathUtf8Bytes
  ) {
    reject("archive_path_invalid");
  }
  return candidate;
}

function parsePayloadFile(value: unknown): PayloadFileRecord {
  const record = exactRecord(value, ["path", "bytes", "sha256"]);
  return {
    path: safeArchivePath(record.path),
    bytes: safeInteger(
      record.bytes,
      CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.entryUncompressedBytes,
    ),
    sha256: hash(record.sha256),
  };
}

function parseSortedFiles(value: unknown): PayloadFileRecord[] {
  const files = exactArray(value).map(parsePayloadFile);
  if (files.length > CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.entryCount) {
    reject("package_limit_exceeded");
  }
  const paths = files.map((file) => file.path);
  const sorted = [...paths].sort(compareAscii);
  if (paths.some((entry, index) => entry !== sorted[index])) {
    reject("manifest_invalid");
  }
  if (new Set(paths.map((entry) => entry.toLowerCase())).size !== paths.length) {
    reject("archive_duplicate_entry");
  }
  return files;
}

function parsePosture(value: unknown): typeof GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE {
  const record = exactRecord(value, [
    "productionNetworkEnabled",
    "lanLabNetworkEnabled",
    "runnerMode",
  ]);
  if (
    record.productionNetworkEnabled !== false ||
    record.lanLabNetworkEnabled !== true ||
    record.runnerMode !== "no_work_only"
  ) {
    reject("compatibility_mismatch");
  }
  return { ...GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE };
}

function exactStringArray(value: unknown): string[] {
  return exactArray(value).map((entry) => safeString(entry));
}

export function parseConnectorPackageManifest(value: unknown): PackageManifest {
  assertDataOnly(value);
  const root = exactRecord(value, [
    "schemaVersion",
    "package",
    "sourceTree",
    "identity",
    "compatibilityReport",
    "staticFakeEvidence",
  ]);
  if (root.schemaVersion !== CONNECTOR_PACKAGE_MANIFEST_SCHEMA_VERSION) {
    reject("manifest_invalid");
  }

  const packageRecord = exactRecord(root.package, [
    "name",
    "bytes",
    "sha256",
    "entryCount",
    "totalExpandedBytes",
    "releaseManifest",
    "capabilityManifestPath",
    "payloadFiles",
  ]);
  const releaseManifest = parsePayloadFile(packageRecord.releaseManifest);
  if (releaseManifest.path !== RELEASE_MANIFEST_PATH) reject("manifest_invalid");
  if (packageRecord.capabilityManifestPath !== CAPABILITY_MANIFEST_PATH) {
    reject("manifest_invalid");
  }
  const payloadFiles = parseSortedFiles(packageRecord.payloadFiles);
  if (payloadFiles.some((entry) => entry.path === RELEASE_MANIFEST_PATH)) {
    reject("manifest_invalid");
  }

  const sourceRecord = exactRecord(root.sourceTree, [
    "policy",
    "algorithm",
    "sha256",
    "fileCount",
    "files",
  ]);
  if (
    sourceRecord.policy !== SOURCE_TREE_POLICY ||
    sourceRecord.algorithm !== SOURCE_TREE_ALGORITHM
  ) {
    reject("manifest_invalid");
  }
  const sourceFiles = parseSortedFiles(sourceRecord.files);
  const identityRecord = exactRecord(root.identity, [
    "connectorVersion",
    "buildSha256",
    "releaseSha256",
    "capabilityDigestSha256",
    "centralContractSha256",
  ]);
  const connectorVersion = safeString(identityRecord.connectorVersion, 32);
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u.test(connectorVersion)) {
    reject("manifest_invalid");
  }
  const identity: PackageManifest["identity"] = {
    connectorVersion,
    buildSha256: hash(identityRecord.buildSha256),
    releaseSha256: hash(identityRecord.releaseSha256),
    capabilityDigestSha256: hash(identityRecord.capabilityDigestSha256),
    centralContractSha256: hash(identityRecord.centralContractSha256),
  };

  const compatibilityRecord = exactRecord(root.compatibilityReport, [
    "schemaVersion",
    "binding",
    "contract",
    "requiredInitialPosture",
  ]);
  if (
    compatibilityRecord.schemaVersion !==
    "aistory-gpu-connector-package-compatibility-v1"
  ) {
    reject("compatibility_mismatch");
  }
  const bindingRecord = exactRecord(compatibilityRecord.binding, [
    "buildSha256",
    "releaseSha256",
    "capabilityDigestSha256",
    "centralContractSha256",
  ]);
  const binding = {
    buildSha256: hash(bindingRecord.buildSha256),
    releaseSha256: hash(bindingRecord.releaseSha256),
    capabilityDigestSha256: hash(bindingRecord.capabilityDigestSha256),
    centralContractSha256: hash(bindingRecord.centralContractSha256),
  };
  if (
    stableCoordinatorJson(compatibilityRecord.contract) !==
      stableCoordinatorJson(GPU_CONNECTOR_COMPATIBILITY_CONTRACT) ||
    stableCoordinatorJson(parsePosture(compatibilityRecord.requiredInitialPosture)) !==
      stableCoordinatorJson(GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE)
  ) {
    reject("compatibility_mismatch");
  }

  const fakeRecord = exactRecord(root.staticFakeEvidence, [
    "kind",
    "sequence",
    "reconcileRequestStates",
    "reconcileResponseAuthoritativeStates",
    "leaseClaimCalls",
    "providerCalls",
    "networkCalls",
    "archiveCodeExecutions",
  ]);
  const sequence = exactStringArray(fakeRecord.sequence);
  const expectedSequence = [
    "register",
    "heartbeat_idle",
    "lease_no_work",
    "lease_no_work",
    "lease_no_work",
  ];
  const reconcileRequestStates = exactStringArray(
    fakeRecord.reconcileRequestStates,
  );
  const reconcileResponseAuthoritativeStates = exactStringArray(
    fakeRecord.reconcileResponseAuthoritativeStates,
  );
  if (
    fakeRecord.kind !== "STATIC_FAKE_CONFORMANCE_ONLY" ||
    stableCoordinatorJson(sequence) !== stableCoordinatorJson(expectedSequence) ||
    stableCoordinatorJson(reconcileRequestStates) !==
      stableCoordinatorJson(
        GPU_CONNECTOR_COMPATIBILITY_CONTRACT.reconcileRequestStates,
      ) ||
    stableCoordinatorJson(reconcileResponseAuthoritativeStates) !==
      stableCoordinatorJson(
        GPU_CONNECTOR_COMPATIBILITY_CONTRACT.reconcileResponseAuthoritativeStates,
      ) ||
    fakeRecord.leaseClaimCalls !== 0 ||
    fakeRecord.providerCalls !== 0 ||
    fakeRecord.networkCalls !== 0 ||
    fakeRecord.archiveCodeExecutions !== 0
  ) {
    reject("fake_evidence_mismatch");
  }

  if (
    stableCoordinatorJson(binding) !== stableCoordinatorJson({
      buildSha256: identity.buildSha256,
      releaseSha256: identity.releaseSha256,
      capabilityDigestSha256: identity.capabilityDigestSha256,
      centralContractSha256: identity.centralContractSha256,
    })
  ) {
    reject("compatibility_mismatch");
  }

  return {
    schemaVersion: CONNECTOR_PACKAGE_MANIFEST_SCHEMA_VERSION,
    package: {
      name: safePackageName(packageRecord.name),
      bytes: safeInteger(
        packageRecord.bytes,
        CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.zipBytes,
      ),
      sha256: hash(packageRecord.sha256),
      entryCount: safeInteger(
        packageRecord.entryCount,
        CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.entryCount,
      ),
      totalExpandedBytes: safeInteger(
        packageRecord.totalExpandedBytes,
        CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.totalUncompressedBytes,
      ),
      releaseManifest,
      capabilityManifestPath: CAPABILITY_MANIFEST_PATH,
      payloadFiles,
    },
    sourceTree: {
      policy: SOURCE_TREE_POLICY,
      algorithm: SOURCE_TREE_ALGORITHM,
      sha256: hash(sourceRecord.sha256),
      fileCount: safeInteger(
        sourceRecord.fileCount,
        CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.entryCount,
      ),
      files: sourceFiles,
    },
    identity,
    compatibilityReport: {
      schemaVersion: "aistory-gpu-connector-package-compatibility-v1",
      binding,
      contract: GPU_CONNECTOR_COMPATIBILITY_CONTRACT,
      requiredInitialPosture: GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE,
    },
    staticFakeEvidence: {
      kind: "STATIC_FAKE_CONFORMANCE_ONLY",
      sequence: [
        "register",
        "heartbeat_idle",
        "lease_no_work",
        "lease_no_work",
        "lease_no_work",
      ],
      reconcileRequestStates,
      reconcileResponseAuthoritativeStates,
      leaseClaimCalls: 0,
      providerCalls: 0,
      networkCalls: 0,
      archiveCodeExecutions: 0,
    },
  };
}

export function parseCanonicalConnectorPackageManifest(
  bytes: Uint8Array,
): PackageManifest {
  if (
    bytes.byteLength < 2 ||
    bytes.byteLength > CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.manifestBytes
  ) {
    reject("package_limit_exceeded");
  }
  const decoded = utf8(bytes, "manifest_invalid");
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return reject("manifest_invalid");
  }
  const parsed = parseConnectorPackageManifest(value);
  if (decoded !== `${stableCoordinatorJson(parsed)}\n`) reject("manifest_invalid");
  return parsed;
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.byteLength) reject("archive_invalid");
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.byteLength) reject("archive_invalid");
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x10000 +
    bytes[offset + 3]! * 0x1000000
  );
}

function asciiPath(bytes: Uint8Array): string {
  if (
    bytes.byteLength < 1 ||
    bytes.byteLength > CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.pathUtf8Bytes ||
    bytes.some((value) => value < 0x21 || value > 0x7e)
  ) {
    reject("archive_path_invalid");
  }
  return safeArchivePath(String.fromCharCode(...bytes));
}

function parseRawZip(zipBytes: Uint8Array): RawZipEntry[] {
  if (
    zipBytes.byteLength < 22 ||
    zipBytes.byteLength > CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.zipBytes
  ) {
    reject("package_limit_exceeded");
  }
  let eocd = -1;
  for (let offset = zipBytes.byteLength - 22; offset >= 0; offset -= 1) {
    if (readU32(zipBytes, offset) === 0x06054b50) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0 || readU16(zipBytes, eocd + 20) !== 0 || eocd + 22 !== zipBytes.byteLength) {
    reject("archive_invalid");
  }
  const disk = readU16(zipBytes, eocd + 4);
  const centralDisk = readU16(zipBytes, eocd + 6);
  const diskEntries = readU16(zipBytes, eocd + 8);
  const entryCount = readU16(zipBytes, eocd + 10);
  const centralBytes = readU32(zipBytes, eocd + 12);
  const centralOffset = readU32(zipBytes, eocd + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    diskEntries !== entryCount ||
    entryCount === 0xffff ||
    centralBytes === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    reject("archive_unsupported");
  }
  if (
    entryCount < 1 ||
    entryCount > CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.entryCount
  ) {
    reject("package_limit_exceeded");
  }
  if (centralOffset + centralBytes !== eocd) reject("archive_invalid");

  const entries: RawZipEntry[] = [];
  let cursor = centralOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(zipBytes, cursor) !== 0x02014b50) reject("archive_invalid");
    const versionMadeBy = readU16(zipBytes, cursor + 4);
    const flags = readU16(zipBytes, cursor + 8);
    const compressionMethod = readU16(zipBytes, cursor + 10);
    const crc32 = readU32(zipBytes, cursor + 16);
    const compressedBytes = readU32(zipBytes, cursor + 20);
    const uncompressedBytes = readU32(zipBytes, cursor + 24);
    const nameBytes = readU16(zipBytes, cursor + 28);
    const extraBytes = readU16(zipBytes, cursor + 30);
    const commentBytes = readU16(zipBytes, cursor + 32);
    const diskStart = readU16(zipBytes, cursor + 34);
    const externalAttributes = readU32(zipBytes, cursor + 38);
    const localHeaderOffset = readU32(zipBytes, cursor + 42);
    if ((flags & 0x41) !== 0) reject("archive_encrypted");
    if (flags !== 0 || ![0, 8].includes(compressionMethod)) {
      reject("archive_unsupported");
    }
    if (
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff ||
      localHeaderOffset === 0xffffffff ||
      diskStart !== 0 ||
      extraBytes !== 0 ||
      commentBytes !== 0
    ) {
      reject("archive_unsupported");
    }
    if (
      compressedBytes > CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.entryUncompressedBytes ||
      uncompressedBytes > CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.entryUncompressedBytes
    ) {
      reject("package_limit_exceeded");
    }
    if (
      uncompressedBytes > 0 &&
      (compressedBytes === 0 ||
        uncompressedBytes / compressedBytes >
          CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.entryCompressionRatio)
    ) {
      reject("package_limit_exceeded");
    }
    const creatorPlatform = versionMadeBy >>> 8;
    if (![0, 3].includes(creatorPlatform)) reject("archive_unsupported");
    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const unixType = unixMode & 0xf000;
    const dosAttributes = externalAttributes & 0xffff;
    if (
      (creatorPlatform === 3 && unixType !== 0 && unixType !== 0x8000) ||
      (dosAttributes & 0x410) !== 0
    ) {
      reject("archive_link_forbidden");
    }
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameBytes;
    if (nameEnd > centralOffset + centralBytes) reject("archive_invalid");
    const entryPath = asciiPath(zipBytes.subarray(nameStart, nameEnd));
    if (readU32(zipBytes, localHeaderOffset) !== 0x04034b50) {
      reject("archive_invalid");
    }
    const localFlags = readU16(zipBytes, localHeaderOffset + 6);
    const localMethod = readU16(zipBytes, localHeaderOffset + 8);
    const localCrc32 = readU32(zipBytes, localHeaderOffset + 14);
    const localCompressed = readU32(zipBytes, localHeaderOffset + 18);
    const localUncompressed = readU32(zipBytes, localHeaderOffset + 22);
    const localNameBytes = readU16(zipBytes, localHeaderOffset + 26);
    const localExtraBytes = readU16(zipBytes, localHeaderOffset + 28);
    if (
      localFlags !== flags ||
      localMethod !== compressionMethod ||
      localCrc32 !== crc32 ||
      localCompressed !== compressedBytes ||
      localUncompressed !== uncompressedBytes ||
      localExtraBytes !== 0 ||
      localNameBytes !== nameBytes
    ) {
      reject("archive_invalid");
    }
    const localNameStart = localHeaderOffset + 30;
    const localNameEnd = localNameStart + localNameBytes;
    const localPath = asciiPath(zipBytes.subarray(localNameStart, localNameEnd));
    if (localPath !== entryPath) reject("archive_invalid");
    const dataOffset = localNameEnd;
    const dataEnd = dataOffset + compressedBytes;
    if (dataEnd > centralOffset) reject("archive_invalid");
    entries.push({
      path: entryPath,
      crc32,
      compressionMethod,
      compressedBytes,
      uncompressedBytes,
      localHeaderOffset,
      dataOffset,
      dataEnd,
    });
    totalCompressed += compressedBytes;
    totalUncompressed += uncompressedBytes;
    cursor = nameEnd;
  }
  if (cursor !== centralOffset + centralBytes) reject("archive_invalid");
  if (
    totalUncompressed > CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.totalUncompressedBytes ||
    (totalUncompressed > 0 &&
      (totalCompressed === 0 ||
        totalUncompressed / totalCompressed >
          CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.aggregateCompressionRatio))
  ) {
    reject("package_limit_exceeded");
  }
  const sortedByLocal = [...entries].sort(
    (left, right) => left.localHeaderOffset - right.localHeaderOffset,
  );
  let expectedOffset = 0;
  for (const entry of sortedByLocal) {
    if (entry.localHeaderOffset !== expectedOffset) reject("archive_invalid");
    expectedOffset = entry.dataEnd;
  }
  if (expectedOffset !== centralOffset) reject("archive_invalid");
  const names = entries.map((entry) => entry.path);
  const sortedNames = [...names].sort(compareAscii);
  if (names.some((entry, index) => entry !== sortedNames[index])) {
    reject("archive_invalid");
  }
  const normalized = names.map((name) => name.normalize("NFKC").toLowerCase());
  if (new Set(normalized).size !== names.length) reject("archive_duplicate_entry");
  const fileSet = new Set(normalized);
  for (const name of normalized) {
    const segments = name.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      if (fileSet.has(segments.slice(0, length).join("/"))) {
        reject("archive_duplicate_entry");
      }
    }
  }
  return entries;
}

function sourcePolicyIncludes(path: string): boolean {
  if ((ROOT_SOURCE_FILES as readonly string[]).includes(path)) return true;
  if (/^scripts\/[^/]+\.py$/u.test(path)) return true;
  const first = path.split("/")[0];
  if (!first || !(RECURSIVE_SOURCE_ROOTS as readonly string[]).includes(first)) {
    return false;
  }
  const segments = path.split("/");
  return (
    !segments.includes("__pycache__") &&
    !path.endsWith(".approved.json")
  );
}

export function computeConnectorSourceTreeSha256(
  files: readonly PayloadFileRecord[],
): string {
  const outer = createHash("sha256");
  for (const file of files) {
    outer.update(file.path, "utf8");
    outer.update("\n", "ascii");
    outer.update(file.sha256, "ascii");
    outer.update("\n", "ascii");
    outer.update(String(file.bytes), "ascii");
    outer.update("\n", "ascii");
  }
  return outer.digest("hex");
}

function parseCanonicalJson(
  bytes: Uint8Array,
  code: ConnectorPackageQualificationErrorCode,
): unknown {
  const decoded = utf8(bytes, code);
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return reject(code);
  }
  try {
    assertDataOnly(value);
  } catch {
    return reject(code);
  }
  if (decoded !== `${stableCoordinatorJson(value)}\n`) reject(code);
  return value;
}

function validateGolden(
  goldenBytes: Uint8Array,
  goldenFileName: string,
  goldenSidecarBytes: Uint8Array,
  centralSources: readonly CentralGoldenSource[],
): void {
  if (
    goldenBytes.byteLength > CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.goldenBytes ||
    goldenSidecarBytes.byteLength >
      CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.goldenSidecarBytes
  ) {
    reject("package_limit_exceeded");
  }
  const goldenSha256 = sha256Hex(goldenBytes);
  if (
    goldenBytes.byteLength !== P1_7_CENTRAL_GOLDEN_BYTES ||
    goldenSha256 !== P1_7_CENTRAL_GOLDEN_SHA256
  ) {
    reject("golden_contract_mismatch");
  }
  const safeGoldenName = safeString(goldenFileName, 96);
  if (!/^[A-Za-z0-9._-]+\.json$/u.test(safeGoldenName)) {
    reject("golden_sidecar_mismatch");
  }
  const sidecar = utf8(goldenSidecarBytes, "golden_sidecar_mismatch");
  if (sidecar !== `${goldenSha256}  ${safeGoldenName}\n`) {
    reject("golden_sidecar_mismatch");
  }
  const golden = parseCanonicalJson(goldenBytes, "golden_invalid");
  const root = exactRecord(
    golden,
    [
      "schemaVersion",
      "producer",
      "sourceDigests",
      "connectorCompatibility",
      "runtimePosture",
      "schemas",
      "transcripts",
    ],
    "golden_invalid",
  );
  if (root.schemaVersion !== "1.1") reject("golden_contract_mismatch");
  const sources = exactArray(root.sourceDigests, "golden_invalid");
  if (
    sources.length !== CENTRAL_GOLDEN_SOURCE_NAMES.length ||
    centralSources.length !== CENTRAL_GOLDEN_SOURCE_NAMES.length
  ) {
    reject("central_source_mismatch");
  }
  for (let index = 0; index < CENTRAL_GOLDEN_SOURCE_NAMES.length; index += 1) {
    const expectedName = CENTRAL_GOLDEN_SOURCE_NAMES[index]!;
    const declared = exactRecord(
      sources[index],
      ["name", "sha256"],
      "golden_invalid",
    );
    const actual = centralSources[index];
    if (
      declared.name !== expectedName ||
      actual?.name !== expectedName ||
      declared.sha256 !== sha256Hex(actual.bytes)
    ) {
      reject("central_source_mismatch");
    }
  }
  if (
    stableCoordinatorJson(root.connectorCompatibility) !==
    stableCoordinatorJson(GPU_CONNECTOR_COMPATIBILITY_CONTRACT)
  ) {
    reject("golden_contract_mismatch");
  }
  const expectedRuntimePosture = {
    centralDefaultEnabled: false,
    expectedBindingEnvironment: {
      buildSha256: GPU_COORDINATOR_EXPECTED_BUILD_SHA_ENV,
      releaseSha256: GPU_COORDINATOR_EXPECTED_RELEASE_SHA_ENV,
      capabilityDigestSha256: GPU_COORDINATOR_EXPECTED_CAPABILITY_DIGEST_ENV,
      centralContractSha256: GPU_COORDINATOR_EXPECTED_CENTRAL_CONTRACT_SHA_ENV,
      runnerMode: GPU_COORDINATOR_EXPECTED_RUNNER_MODE_ENV,
    },
    requiredRegistrationPosture: { ...GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE },
    noWorkOnlyBeforeLeaseClaim: true,
    signedDeclarationIsNotRemoteNetworkProof: true,
  };
  if (
    stableCoordinatorJson(root.runtimePosture) !==
    stableCoordinatorJson(expectedRuntimePosture)
  ) {
    reject("golden_contract_mismatch");
  }
}

function validateEmbeddedReleaseManifest(
  bytes: Uint8Array,
  packageName: string,
  connectorVersion: string,
  payloadFiles: readonly PayloadFileRecord[],
): void {
  const value = parseCanonicalJson(bytes, "archive_manifest_mismatch");
  const record = exactRecord(
    value,
    [
      "schemaVersion",
      "name",
      "version",
      "productionNetworkDefault",
      "lanLabNetworkDefault",
      "approvedWorkflowCount",
      "files",
    ],
    "archive_manifest_mismatch",
  );
  if (
    record.schemaVersion !== "aistory-gpu-connector-release-manifest-v2" ||
    record.name !== packageName.replace(/\.zip$/u, "") ||
    record.version !== connectorVersion ||
    record.productionNetworkDefault !== false ||
    record.lanLabNetworkDefault !== false ||
    record.approvedWorkflowCount !== 0
  ) {
    reject("archive_manifest_mismatch");
  }
  const files = exactArray(record.files, "archive_manifest_mismatch").map(
    parsePayloadFile,
  );
  if (stableCoordinatorJson(files) !== stableCoordinatorJson(payloadFiles)) {
    reject("archive_manifest_mismatch");
  }
}

export function serializeConnectorPackageQualificationReport(
  report: ConnectorPackageQualificationReport,
): string {
  return `${stableCoordinatorJson(report)}\n`;
}

export async function qualifyGpuConnectorPackage(
  input: ConnectorPackageQualificationInput,
): Promise<ConnectorPackageQualificationReport> {
  const manifest = parseCanonicalConnectorPackageManifest(input.manifestBytes);
  validateGolden(
    input.goldenBytes,
    input.goldenFileName,
    input.goldenSidecarBytes,
    input.centralSources,
  );
  if (
    manifest.package.name !== input.zipFileName ||
    input.zipBytes.byteLength !== manifest.package.bytes ||
    sha256Hex(input.zipBytes) !== manifest.package.sha256 ||
    manifest.identity.releaseSha256 !== manifest.package.sha256 ||
    manifest.identity.centralContractSha256 !== P1_7_CENTRAL_GOLDEN_SHA256
  ) {
    reject("package_invalid");
  }

  const rawEntries = parseRawZip(input.zipBytes);
  if (
    rawEntries.length !== manifest.package.entryCount ||
    rawEntries.reduce((sum, entry) => sum + entry.uncompressedBytes, 0) !==
      manifest.package.totalExpandedBytes
  ) {
    reject("archive_manifest_mismatch");
  }
  const declaredAll = [
    manifest.package.releaseManifest,
    ...manifest.package.payloadFiles,
  ].sort((left, right) => compareAscii(left.path, right.path));
  if (
    stableCoordinatorJson(
      rawEntries.map((entry) => ({ path: entry.path, bytes: entry.uncompressedBytes })),
    ) !==
    stableCoordinatorJson(
      declaredAll.map((entry) => ({ path: entry.path, bytes: entry.bytes })),
    )
  ) {
    reject("archive_manifest_mismatch");
  }

  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(input.zipBytes, {
      checkCRC32: true,
      createFolders: false,
    });
  } catch {
    return reject("archive_integrity_mismatch");
  }
  const loadedEntries = Object.values(zip.files);
  if (loadedEntries.length !== rawEntries.length) {
    reject("archive_integrity_mismatch");
  }
  const extracted = new Map<string, Uint8Array>();
  for (const raw of rawEntries) {
    const entry = zip.file(raw.path);
    if (
      !entry ||
      entry.dir ||
      entry.name !== raw.path ||
      entry.unsafeOriginalName !== raw.path
    ) {
      reject("archive_integrity_mismatch");
    }
    let bytes: Uint8Array;
    try {
      bytes = await entry.async("uint8array");
    } catch {
      return reject("archive_integrity_mismatch");
    }
    if (bytes.byteLength !== raw.uncompressedBytes) {
      reject("archive_integrity_mismatch");
    }
    extracted.set(raw.path, bytes);
  }
  for (const declared of declaredAll) {
    const bytes = extracted.get(declared.path);
    if (
      !bytes ||
      bytes.byteLength !== declared.bytes ||
      sha256Hex(bytes) !== declared.sha256
    ) {
      reject("archive_integrity_mismatch");
    }
  }

  const embeddedRelease = extracted.get(RELEASE_MANIFEST_PATH);
  const capabilityManifest = extracted.get(CAPABILITY_MANIFEST_PATH);
  if (!embeddedRelease || !capabilityManifest) {
    reject("archive_manifest_mismatch");
  }
  validateEmbeddedReleaseManifest(
    embeddedRelease,
    manifest.package.name,
    manifest.identity.connectorVersion,
    manifest.package.payloadFiles,
  );
  const sourceFiles = manifest.package.payloadFiles.filter((file) =>
    sourcePolicyIncludes(file.path),
  );
  if (
    ROOT_SOURCE_FILES.some(
      (required) => !sourceFiles.some((file) => file.path === required),
    ) ||
    !sourceFiles.some((file) => file.path === "scripts/source_digest.py") ||
    !sourceFiles.some((file) => file.path.startsWith("src/")) ||
    !sourceFiles.some((file) => file.path.startsWith("tests/")) ||
    !sourceFiles.some((file) => file.path.startsWith("contracts/")) ||
    manifest.sourceTree.fileCount !== sourceFiles.length ||
    stableCoordinatorJson(manifest.sourceTree.files) !==
      stableCoordinatorJson(sourceFiles)
  ) {
    reject("archive_manifest_mismatch");
  }
  const sourceTreeSha256 = computeConnectorSourceTreeSha256(sourceFiles);
  if (
    sourceTreeSha256 !== manifest.sourceTree.sha256 ||
    manifest.identity.buildSha256 !== sourceTreeSha256 ||
    manifest.identity.capabilityDigestSha256 !== sha256Hex(capabilityManifest)
  ) {
    reject("archive_integrity_mismatch");
  }

  return {
    schemaVersion: CONNECTOR_PACKAGE_QUALIFICATION_SCHEMA_VERSION,
    status: CONNECTOR_PACKAGE_STATIC_QUALIFIED,
    package: {
      name: manifest.package.name,
      bytes: manifest.package.bytes,
      sha256: manifest.package.sha256,
      entryCount: manifest.package.entryCount,
      totalExpandedBytes: manifest.package.totalExpandedBytes,
      sourceFileCount: manifest.sourceTree.fileCount,
      sourceTreeSha256,
    },
    identity: { ...manifest.identity },
    compatibility: {
      firstHeartbeat: GPU_CONNECTOR_COMPATIBILITY_CONTRACT.firstHeartbeat,
      heartbeatRequestStates: [
        ...GPU_CONNECTOR_COMPATIBILITY_CONTRACT.heartbeatRequestStates,
      ],
      reconcileRequestStates: [
        ...GPU_CONNECTOR_COMPATIBILITY_CONTRACT.reconcileRequestStates,
      ],
      reconcileResponseAuthoritativeStates: [
        ...GPU_CONNECTOR_COMPATIBILITY_CONTRACT.reconcileResponseAuthoritativeStates,
      ],
      productionNetworkDefault: false,
      lanLabNetworkDefault: false,
      networkGatesMutuallyExclusive: true,
      lanLabNetworkEnvironment:
        GPU_CONNECTOR_COMPATIBILITY_CONTRACT.connectorNetwork.lanLabEnv,
      runnerMode: GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE.runnerMode,
      noWorkOnlyFirstGate:
        GPU_CONNECTOR_COMPATIBILITY_CONTRACT.noWorkOnlyFirstGate,
      staticFakeEvidenceShapeVerified: true,
      connectorFakeTestsExecuted: false,
    },
    limits: CONNECTOR_PACKAGE_QUALIFICATION_LIMITS,
    provenanceVerified: false,
    signatureVerified: false,
    runtimeBindingVerified: false,
    noWorkExecuted: false,
    gpuExecuted: false,
    deployable: false,
    networkCalls: 0,
    archiveCodeExecuted: false,
  };
}
