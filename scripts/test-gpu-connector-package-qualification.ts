import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import JSZip from "jszip";

let networkCalls = 0;
globalThis.fetch = (async () => {
  networkCalls += 1;
  throw new Error("network_forbidden_in_gpu_connector_qualification_test");
}) as typeof fetch;

const qualification = await import(
  "../lib/gpu-coordinator/connectorPackageQualification"
);
const compatibility = await import(
  "../lib/gpu-coordinator/connectorCompatibility"
);
const { stableCoordinatorJson } = await import(
  "../lib/gpu-coordinator/protocol"
);
const cli = await import("./qualify-gpu-connector-package");

const {
  CENTRAL_GOLDEN_SOURCE_NAMES,
  CONNECTOR_PACKAGE_MANIFEST_SCHEMA_VERSION,
  CONNECTOR_PACKAGE_QUALIFICATION_LIMITS,
  ConnectorPackageQualificationError,
  P1_7_CENTRAL_GOLDEN_SHA256,
  computeConnectorSourceTreeSha256,
  parseConnectorPackageManifest,
  qualifyGpuConnectorPackage,
  serializeConnectorPackageQualificationReport,
  sha256Hex,
} = qualification;
const {
  GPU_CONNECTOR_COMPATIBILITY_CONTRACT,
  GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE,
} = compatibility;

const root = process.cwd();

function compareAscii(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function testRecord(value: unknown): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function testArray(value: unknown): unknown[] {
  assert(Array.isArray(value));
  return value;
}

const legacyGoldenPath = path.join(
  root,
  ".aistory-gpu",
  "central-golden-contract-v1.json",
);
const legacyGoldenSidecarPath = `${legacyGoldenPath}.sha256`;
const privateMarker = "PRIVATE_CONNECTOR_PACKAGE_MARKER_20260816";
const archiveExecutionMarker = path.join(
  os.tmpdir(),
  `aistory-p18-archive-code-must-not-run-${process.pid}.marker`,
);

function canonicalBytes(value: unknown): Uint8Array {
  return Buffer.from(`${stableCoordinatorJson(value)}\n`, "utf8");
}

function sha(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exportCurrentGolden(outputPath: string): Promise<void> {
  const previousArgv = process.argv;
  process.argv = [
    previousArgv[0] ?? "node",
    path.join(root, "scripts", "export-gpu-coordinator-golden-contract.ts"),
    outputPath,
  ];
  try {
    await import("./export-gpu-coordinator-golden-contract");
  } finally {
    process.argv = previousArgv;
  }
}

async function centralSources() {
  return Promise.all(
    CENTRAL_GOLDEN_SOURCE_NAMES.map(async (name) => ({
      name,
      bytes: await readFile(path.join(root, "lib", "gpu-coordinator", name)),
    })),
  );
}

type FileInput = { path: string; bytes: Uint8Array };

const basePayloads: FileInput[] = [
  { path: ".gitignore", bytes: Buffer.from("*.db\n") },
  { path: "LICENSE", bytes: Buffer.from("synthetic-license\n") },
  { path: "README.md", bytes: Buffer.from("synthetic repaired connector\n") },
  { path: "capability-manifest.json", bytes: canonicalBytes({ approvedWorkflowCount: 0 }) },
  { path: "config.example.env", bytes: Buffer.from("NETWORK=false\n") },
  { path: "contracts/protocol.json", bytes: canonicalBytes({ protocolVersion: "1.0" }) },
  { path: "docs/offline.md", bytes: Buffer.from("offline only\n") },
  {
    path: "hooks/not-executed.js",
    bytes: Buffer.from(
      `require("node:fs").writeFileSync(${JSON.stringify(archiveExecutionMarker)}, ${JSON.stringify(privateMarker)});\n`,
    ),
  },
  { path: "pyproject.toml", bytes: Buffer.from("[project]\nname='connector'\n") },
  { path: "requirements-dev.lock", bytes: Buffer.from("pytest==0\n") },
  { path: "requirements.lock", bytes: Buffer.from("httpx==0\n") },
  {
    path: "sbom.cdx.json",
    bytes: canonicalBytes({ bomFormat: "CycloneDX", components: [] }),
  },
  {
    path: "scripts/source_digest.py",
    bytes: Buffer.from("# synthetic source digest policy fixture\n"),
  },
  { path: "src/aistory_connector/__init__.py", bytes: Buffer.from("VERSION='0.3.0'\n") },
  { path: "tests/test_contract.py", bytes: Buffer.from("def test_contract(): assert True\n") },
].sort((left, right) => compareAscii(left.path, right.path));

function fileRecords(files: readonly FileInput[]) {
  return files.map((file) => ({
    path: file.path,
    bytes: file.bytes.byteLength,
    sha256: sha(file.bytes),
  }));
}

const sourcePaths = new Set([
  ".gitignore",
  "LICENSE",
  "README.md",
  "config.example.env",
  "pyproject.toml",
  "requirements-dev.lock",
  "requirements.lock",
  "sbom.cdx.json",
  "contracts/protocol.json",
  "docs/offline.md",
  "scripts/source_digest.py",
  "src/aistory_connector/__init__.py",
  "tests/test_contract.py",
]);

async function zipFiles(
  files: readonly FileInput[],
  options: { platform?: "DOS" | "UNIX"; unixPermissions?: number } = {},
): Promise<Uint8Array> {
  const zip = new JSZip();
  for (const file of [...files].sort((left, right) => compareAscii(left.path, right.path))) {
    zip.file(file.path, file.bytes, {
      binary: true,
      createFolders: false,
      date: new Date("2020-01-01T00:00:00.000Z"),
      unixPermissions: options.unixPermissions,
    });
  }
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
    platform: options.platform ?? "DOS",
    streamFiles: false,
  });
}

type Fixture = {
  zipBytes: Uint8Array;
  manifest: Record<string, unknown>;
  manifestBytes: Uint8Array;
  goldenBytes: Uint8Array;
  goldenSidecarBytes: Uint8Array;
  centralSources: Awaited<ReturnType<typeof centralSources>>;
  input: Parameters<typeof qualifyGpuConnectorPackage>[0];
};

async function makeFixture(
  goldenBytes: Uint8Array,
  goldenSidecarBytes: Uint8Array,
  sources: Awaited<ReturnType<typeof centralSources>>,
  options: { embeddedProductionDefault?: boolean } = {},
): Promise<Fixture> {
  const packageName = "aistory-gpu-connector-repaired-test.zip";
  const payloadFiles = fileRecords(basePayloads);
  const sourceFiles = payloadFiles.filter((file) => sourcePaths.has(file.path));
  const sourceTreeSha256 = computeConnectorSourceTreeSha256(sourceFiles);
  const embeddedRelease = canonicalBytes({
    schemaVersion: "aistory-gpu-connector-release-manifest-v2",
    name: packageName.replace(/\.zip$/u, ""),
    version: "0.3.0",
    productionNetworkDefault: options.embeddedProductionDefault ?? false,
    lanLabNetworkDefault: false,
    approvedWorkflowCount: 0,
    files: payloadFiles,
  });
  const allFiles = [
    ...basePayloads,
    { path: "RELEASE-MANIFEST.json", bytes: embeddedRelease },
  ].sort((left, right) => compareAscii(left.path, right.path));
  const zipBytes = await zipFiles(allFiles);
  const releaseSha256 = sha(zipBytes);
  const capabilityDigestSha256 = sha(
    basePayloads.find((file) => file.path === "capability-manifest.json")!.bytes,
  );
  const identity = {
    connectorVersion: "0.3.0",
    buildSha256: sourceTreeSha256,
    releaseSha256,
    capabilityDigestSha256,
    centralContractSha256: P1_7_CENTRAL_GOLDEN_SHA256,
  };
  const manifest = {
    schemaVersion: CONNECTOR_PACKAGE_MANIFEST_SCHEMA_VERSION,
    package: {
      name: packageName,
      bytes: zipBytes.byteLength,
      sha256: releaseSha256,
      entryCount: allFiles.length,
      totalExpandedBytes: allFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0),
      releaseManifest: {
        path: "RELEASE-MANIFEST.json",
        bytes: embeddedRelease.byteLength,
        sha256: sha(embeddedRelease),
      },
      capabilityManifestPath: "capability-manifest.json",
      payloadFiles,
    },
    sourceTree: {
      policy: "aistory-connector-source-tree-v1",
      algorithm: "sha256-path-lf-sha256-lf-bytes-lf-v1",
      sha256: sourceTreeSha256,
      fileCount: sourceFiles.length,
      files: sourceFiles,
    },
    identity,
    compatibilityReport: {
      schemaVersion: "aistory-gpu-connector-package-compatibility-v1",
      binding: {
        buildSha256: identity.buildSha256,
        releaseSha256: identity.releaseSha256,
        capabilityDigestSha256: identity.capabilityDigestSha256,
        centralContractSha256: identity.centralContractSha256,
      },
      contract: structuredClone(GPU_CONNECTOR_COMPATIBILITY_CONTRACT),
      requiredInitialPosture: structuredClone(GPU_CONNECTOR_NO_WORK_NETWORK_POSTURE),
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
      reconcileRequestStates: [
        ...GPU_CONNECTOR_COMPATIBILITY_CONTRACT.reconcileRequestStates,
      ],
      reconcileResponseAuthoritativeStates: [
        ...GPU_CONNECTOR_COMPATIBILITY_CONTRACT.reconcileResponseAuthoritativeStates,
      ],
      leaseClaimCalls: 0,
      providerCalls: 0,
      networkCalls: 0,
      archiveCodeExecutions: 0,
    },
  };
  const manifestBytes = canonicalBytes(manifest);
  const input = {
    zipBytes,
    zipFileName: packageName,
    manifestBytes,
    goldenBytes,
    goldenFileName: "central-golden-contract-v1.json",
    goldenSidecarBytes,
    centralSources: sources,
  };
  return {
    zipBytes,
    manifest,
    manifestBytes,
    goldenBytes,
    goldenSidecarBytes,
    centralSources: sources,
    input,
  };
}

function withZipIdentity(
  manifest: Record<string, unknown>,
  zipBytes: Uint8Array,
): Uint8Array {
  const copy = structuredClone(manifest);
  const releaseSha256 = sha(zipBytes);
  const packageRecord = testRecord(copy.package);
  packageRecord.bytes = zipBytes.byteLength;
  packageRecord.sha256 = releaseSha256;
  testRecord(copy.identity).releaseSha256 = releaseSha256;
  testRecord(testRecord(copy.compatibilityReport).binding).releaseSha256 =
    releaseSha256;
  return canonicalBytes(copy);
}

async function assertRejected(
  input: Parameters<typeof qualifyGpuConnectorPackage>[0],
  code: string,
): Promise<void> {
  await assert.rejects(
    () => qualifyGpuConnectorPackage(input),
    (error: unknown) =>
      error instanceof ConnectorPackageQualificationError && error.code === code,
  );
}

async function makeHostileZip(pathName: string): Promise<Uint8Array> {
  return zipFiles([{ path: pathName, bytes: Buffer.from("hostile") }]);
}

function signatureAt(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x10000 +
    bytes[offset + 3]! * 0x1000000
  );
}

function firstSignatureOffset(bytes: Uint8Array, signature: number): number {
  for (let offset = 0; offset <= bytes.byteLength - 4; offset += 1) {
    if (signatureAt(bytes, offset) === signature) return offset;
  }
  assert.fail("expected ZIP signature");
}

function lastSignatureOffset(bytes: Uint8Array, signature: number): number {
  for (let offset = bytes.byteLength - 4; offset >= 0; offset -= 1) {
    if (signatureAt(bytes, offset) === signature) return offset;
  }
  assert.fail("expected ZIP signature");
}

function writeU16(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function patchZipFlags(zipBytes: Uint8Array, flag: number): Uint8Array {
  const patched = Uint8Array.from(zipBytes);
  for (let offset = 0; offset <= patched.byteLength - 4; offset += 1) {
    const signature = signatureAt(patched, offset);
    if (signature === 0x04034b50) patched[offset + 6] = patched[offset + 6]! | flag;
    if (signature === 0x02014b50) patched[offset + 8] = patched[offset + 8]! | flag;
  }
  return patched;
}

function patchZipMethod(zipBytes: Uint8Array, method: number): Uint8Array {
  const patched = Uint8Array.from(zipBytes);
  for (let offset = 0; offset <= patched.byteLength - 4; offset += 1) {
    const signature = signatureAt(patched, offset);
    if (signature === 0x04034b50) patched[offset + 8] = method;
    if (signature === 0x02014b50) patched[offset + 10] = method;
  }
  return patched;
}

function patchDosReparse(zipBytes: Uint8Array): Uint8Array {
  const patched = Uint8Array.from(zipBytes);
  const central = firstSignatureOffset(patched, 0x02014b50);
  writeU32(patched, central + 38, 0x400);
  return patched;
}

function patchSingleExpandedLimit(zipBytes: Uint8Array): Uint8Array {
  const patched = Uint8Array.from(zipBytes);
  const local = firstSignatureOffset(patched, 0x04034b50);
  const central = firstSignatureOffset(patched, 0x02014b50);
  const tooLarge =
    CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.entryUncompressedBytes + 1;
  writeU32(patched, local + 22, tooLarge);
  writeU32(patched, central + 24, tooLarge);
  return patched;
}

function patchZip64Marker(zipBytes: Uint8Array): Uint8Array {
  const patched = Uint8Array.from(zipBytes);
  const central = firstSignatureOffset(patched, 0x02014b50);
  writeU32(patched, central + 20, 0xffffffff);
  return patched;
}

function patchMultiDisk(zipBytes: Uint8Array): Uint8Array {
  const patched = Uint8Array.from(zipBytes);
  const eocd = lastSignatureOffset(patched, 0x06054b50);
  writeU16(patched, eocd + 4, 1);
  return patched;
}

function patchLocalNameMismatch(zipBytes: Uint8Array): Uint8Array {
  const patched = Uint8Array.from(zipBytes);
  const local = firstSignatureOffset(patched, 0x04034b50);
  patched[local + 30] = patched[local + 30] === 0x41 ? 0x42 : 0x41;
  return patched;
}

function deterministicModerateCompressionBytes(
  length: number,
  seed: number,
): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed >>> 0;
  for (let index = 0; index < length; index += 32) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

function corruptFirstPayloadByte(zipBytes: Uint8Array): Uint8Array {
  const patched = Uint8Array.from(zipBytes);
  const nameLength = patched[26]! | (patched[27]! << 8);
  const extraLength = patched[28]! | (patched[29]! << 8);
  const dataOffset = 30 + nameLength + extraLength;
  patched[dataOffset] = patched[dataOffset]! ^ 0x01;
  return patched;
}

async function readLegacyGoldenSnapshot() {
  const [goldenDetails, sidecarDetails, goldenBytes, sidecarBytes] =
    await Promise.all([
      stat(legacyGoldenPath),
      stat(legacyGoldenSidecarPath),
      readFile(legacyGoldenPath),
      readFile(legacyGoldenSidecarPath),
    ]);
  assert.deepEqual(
    {
      bytes: goldenDetails.size,
      sha256: sha(goldenBytes),
      sidecarBytes: sidecarDetails.size,
      sidecar: sidecarBytes.toString("utf8"),
    },
    {
      bytes: 4_135,
      sha256:
        "1d0c94a8dc5dac13b621fabc36dd8cd8904ffd02af2c442dfa1ece045b9d5b78",
      sidecarBytes: 98,
      sidecar:
        "1d0c94a8dc5dac13b621fabc36dd8cd8904ffd02af2c442dfa1ece045b9d5b78  central-golden-contract-v1.json\n",
    },
  );
  return {
    goldenBytes,
    sidecarBytes,
    goldenMtimeMs: goldenDetails.mtimeMs,
    sidecarMtimeMs: sidecarDetails.mtimeMs,
  };
}

const legacyGoldenBefore = await readLegacyGoldenSnapshot();
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aistory-p18-"));
try {
  const goldenPath = path.join(tempRoot, "golden", "central-golden-contract-v1.json");
  await exportCurrentGolden(goldenPath);
  const goldenBytes = await readFile(goldenPath);
  const goldenSidecarBytes = await readFile(`${goldenPath}.sha256`);
  assert.equal(goldenBytes.byteLength, 6_699);
  assert.equal(sha(goldenBytes), P1_7_CENTRAL_GOLDEN_SHA256);
  const sources = await centralSources();
  const fixture = await makeFixture(goldenBytes, goldenSidecarBytes, sources);
  assert.equal(
    computeConnectorSourceTreeSha256([
      {
        path: "LICENSE",
        bytes: 3,
        sha256:
          "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
      {
        path: "README.md",
        bytes: 0,
        sha256:
          "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      },
    ]),
    "53f93b0ebfa802a900f3e115ef96c513aa301dd58b66d86188a2d89052ab96d6",
  );

  const firstReport = await qualifyGpuConnectorPackage(fixture.input);
  const secondReport = await qualifyGpuConnectorPackage(fixture.input);
  const firstJson = serializeConnectorPackageQualificationReport(firstReport);
  const secondJson = serializeConnectorPackageQualificationReport(secondReport);
  assert.equal(firstJson, secondJson);
  assert.equal(firstReport.status, "OFFLINE_PACKAGE_STATIC_QUALIFIED");
  assert.equal(firstReport.runtimeBindingVerified, false);
  assert.equal(firstReport.noWorkExecuted, false);
  assert.equal(firstReport.gpuExecuted, false);
  assert.equal(firstReport.deployable, false);
  assert.equal(firstReport.provenanceVerified, false);
  assert.equal(firstReport.signatureVerified, false);
  assert.equal(firstReport.compatibility.staticFakeEvidenceShapeVerified, true);
  assert.equal(firstReport.compatibility.connectorFakeTestsExecuted, false);
  assert.equal(firstReport.networkCalls, 0);
  assert.equal(firstReport.archiveCodeExecuted, false);
  assert.equal(firstReport.compatibility.firstHeartbeat, "idle");
  assert.deepEqual(firstReport.compatibility.heartbeatRequestStates, [
    "idle",
    "leased",
    "running",
    "draining",
    "recovery_required",
    "revoked",
  ]);
  assert(!firstJson.includes("registered"));
  assert(!firstJson.includes("ambiguous"));
  assert(!firstJson.includes(tempRoot));
  assert(!firstJson.includes(privateMarker));
  await assert.rejects(() => access(archiveExecutionMarker));

  const locations = [path.join(tempRoot, "one"), path.join(tempRoot, "two")];
  for (const location of locations) {
    await mkdir(location, { recursive: true });
    await writeFile(path.join(location, "connector.zip"), fixture.zipBytes);
    await writeFile(path.join(location, "manifest.json"), fixture.manifestBytes);
    await writeFile(path.join(location, "central-golden-contract-v1.json"), goldenBytes);
    await writeFile(
      path.join(location, "central-golden-contract-v1.json.sha256"),
      goldenSidecarBytes,
    );
  }
  const cliArgs = (location: string) => [
    "--zip",
    path.join(location, "connector.zip"),
    "--manifest",
    path.join(location, "manifest.json"),
    "--golden",
    path.join(location, "central-golden-contract-v1.json"),
    "--golden-sidecar",
    path.join(location, "central-golden-contract-v1.json.sha256"),
  ];
  const cliOne = await cli.runGpuConnectorQualifierCli(cliArgs(locations[0]!), root);
  const cliTwo = await cli.runGpuConnectorQualifierCli(cliArgs(locations[1]!), root);
  assert.equal(cliOne.exitCode, 1);
  assert.equal(cliTwo.exitCode, 1);
  // The CLI compares the ZIP basename to the signed package name; use the signed name.
  for (const location of locations) {
    await cp(
      path.join(location, "connector.zip"),
      path.join(location, "aistory-gpu-connector-repaired-test.zip"),
    );
  }
  const signedCliArgs = (location: string) => [
    "--zip",
    path.join(location, "aistory-gpu-connector-repaired-test.zip"),
    ...cliArgs(location).slice(2),
  ];
  const signedOne = await cli.runGpuConnectorQualifierCli(
    signedCliArgs(locations[0]!),
    root,
  );
  const signedTwo = await cli.runGpuConnectorQualifierCli(
    signedCliArgs(locations[1]!),
    root,
  );
  assert.equal(signedOne.exitCode, 0);
  assert.equal(signedTwo.exitCode, 0);
  assert.equal(signedOne.output, signedTwo.output);
  assert.deepEqual(
    cli.normalizeGpuConnectorQualifierProcessArguments([
      "--",
      ...signedCliArgs(locations[0]!),
    ]),
    signedCliArgs(locations[0]!),
  );
  const signedFromOtherCwd = await cli.runGpuConnectorQualifierCli(
    signedCliArgs(locations[0]!),
    locations[1]!,
  );
  assert.equal(signedFromOtherCwd.exitCode, 0);
  assert.equal(signedFromOtherCwd.output, signedOne.output);
  assert(!signedOne.output.includes(locations[0]!));
  assert(!signedOne.output.includes(locations[1]!));
  const unknownFlagArgs = [...signedCliArgs(locations[0]!)];
  unknownFlagArgs[0] = "--unknown";
  const duplicateFlagArgs = [...signedCliArgs(locations[0]!)];
  duplicateFlagArgs[6] = "--zip";
  for (const invalidArgs of [
    [],
    signedCliArgs(locations[0]!).slice(0, 6),
    [...signedCliArgs(locations[0]!), "--extra", "value"],
    unknownFlagArgs,
    duplicateFlagArgs,
    [
      ...signedCliArgs(locations[0]!).slice(0, 6),
      "--golden",
      goldenPath,
    ],
  ]) {
    const result = await cli.runGpuConnectorQualifierCli(invalidArgs, root);
    assert.equal(result.exitCode, 1);
    assert(result.output.includes("cli_arguments_invalid"));
    assert(!result.output.includes(tempRoot));
  }

  const manifestValue = structuredClone(fixture.manifest);
  assert.throws(
    () => parseConnectorPackageManifest({ ...manifestValue, extra: true }),
    (error: unknown) =>
      error instanceof ConnectorPackageQualificationError &&
      error.code === "manifest_invalid",
  );
  const accessorManifest = structuredClone(fixture.manifest);
  Object.defineProperty(accessorManifest, "schemaVersion", {
    enumerable: true,
    get: () => CONNECTOR_PACKAGE_MANIFEST_SCHEMA_VERSION,
  });
  assert.throws(() => parseConnectorPackageManifest(accessorManifest));
  const prototypeManifest = Object.assign(
    Object.create({ inherited: true }),
    structuredClone(fixture.manifest),
  );
  assert.throws(() => parseConnectorPackageManifest(prototypeManifest));
  const symbolManifest = structuredClone(fixture.manifest);
  Reflect.defineProperty(symbolManifest, Symbol("hidden"), {
    enumerable: true,
    value: true,
  });
  assert.throws(() => parseConnectorPackageManifest(symbolManifest));
  const missingManifest = structuredClone(fixture.manifest);
  Reflect.deleteProperty(missingManifest, "identity");
  assert.throws(() => parseConnectorPackageManifest(missingManifest));

  await assertRejected(
    {
      ...fixture.input,
      goldenBytes: legacyGoldenBefore.goldenBytes,
      goldenSidecarBytes: legacyGoldenBefore.sidecarBytes,
    },
    "golden_contract_mismatch",
  );
  await assertRejected(
    { ...fixture.input, goldenSidecarBytes: Buffer.from("invalid\n") },
    "golden_sidecar_mismatch",
  );
  const driftedSources = sources.map((source, index) =>
    index === 0 ? { ...source, bytes: Buffer.from("drift") } : source,
  );
  await assertRejected(
    { ...fixture.input, centralSources: driftedSources },
    "central_source_mismatch",
  );

  const compatibilityMutations: Array<
    (value: Record<string, unknown>) => void
  > = [
    (value) => {
      testRecord(testRecord(value.compatibilityReport).contract).firstHeartbeat =
        "registered";
    },
    (value) => {
      testArray(
        testRecord(testRecord(value.compatibilityReport).contract)
          .reconcileRequestStates,
      ).push("ambiguous");
    },
    (value) => {
      const defaults = testRecord(
        testRecord(
          testRecord(testRecord(value.compatibilityReport).contract)
            .connectorNetwork,
        ).defaults,
      );
      defaults.productionNetworkEnabled = true;
      defaults.lanLabNetworkEnabled = true;
    },
  ];
  for (const mutation of compatibilityMutations) {
    const changed = structuredClone(fixture.manifest);
    mutation(changed);
    await assertRejected(
      { ...fixture.input, manifestBytes: canonicalBytes(changed) },
      "compatibility_mismatch",
    );
  }
  const fakeDrift = structuredClone(fixture.manifest);
  testRecord(fakeDrift.staticFakeEvidence).networkCalls = 1;
  await assertRejected(
    { ...fixture.input, manifestBytes: canonicalBytes(fakeDrift) },
    "fake_evidence_mismatch",
  );

  const assertManifestMutationRejected = async (
    code: string,
    mutate: (value: Record<string, unknown>) => void,
  ) => {
    const changed = structuredClone(fixture.manifest);
    mutate(changed);
    await assertRejected(
      { ...fixture.input, manifestBytes: canonicalBytes(changed) },
      code,
    );
  };
  await assertManifestMutationRejected("package_invalid", (value) => {
    const packageRecord = testRecord(value.package);
    packageRecord.bytes = Number(packageRecord.bytes) + 1;
  });
  await assertManifestMutationRejected("package_invalid", (value) => {
    const replacement = "0".repeat(64);
    testRecord(value.package).sha256 = replacement;
    testRecord(value.identity).releaseSha256 = replacement;
    testRecord(
      testRecord(value.compatibilityReport).binding,
    ).releaseSha256 = replacement;
  });
  await assertManifestMutationRejected("archive_integrity_mismatch", (value) => {
    const replacement = "1".repeat(64);
    testRecord(value.identity).buildSha256 = replacement;
    testRecord(testRecord(value.compatibilityReport).binding).buildSha256 =
      replacement;
  });
  await assertManifestMutationRejected("archive_integrity_mismatch", (value) => {
    const replacement = "2".repeat(64);
    testRecord(value.identity).capabilityDigestSha256 = replacement;
    testRecord(
      testRecord(value.compatibilityReport).binding,
    ).capabilityDigestSha256 = replacement;
  });
  await assertManifestMutationRejected("package_invalid", (value) => {
    const replacement = "3".repeat(64);
    testRecord(value.identity).centralContractSha256 = replacement;
    testRecord(
      testRecord(value.compatibilityReport).binding,
    ).centralContractSha256 = replacement;
  });
  await assertManifestMutationRejected("archive_manifest_mismatch", (value) => {
    const releaseManifest = testRecord(
      testRecord(value.package).releaseManifest,
    );
    releaseManifest.bytes = Number(releaseManifest.bytes) + 1;
  });
  await assertManifestMutationRejected("archive_integrity_mismatch", (value) => {
    testRecord(testRecord(value.package).releaseManifest).sha256 =
      "4".repeat(64);
  });
  await assertManifestMutationRejected("archive_manifest_mismatch", (value) => {
    const packageRecord = testRecord(value.package);
    packageRecord.payloadFiles = testArray(packageRecord.payloadFiles).slice(1);
  });

  for (const hostilePath of [
    "../escape.py",
    "/absolute.py",
    "C:/drive.py",
    "file:///payload.py",
    "safe\\mixed.py",
  ]) {
    const hostileZip = await makeHostileZip(hostilePath);
    await assertRejected(
      {
        ...fixture.input,
        zipBytes: hostileZip,
        manifestBytes: withZipIdentity(fixture.manifest, hostileZip),
      },
      "archive_path_invalid",
    );
  }

  const duplicateZip = await zipFiles([
    { path: "Case.py", bytes: Buffer.from("a") },
    { path: "case.py", bytes: Buffer.from("b") },
  ]);
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: duplicateZip,
      manifestBytes: withZipIdentity(fixture.manifest, duplicateZip),
    },
    "archive_duplicate_entry",
  );

  const symlinkZip = await zipFiles(
    [{ path: "link", bytes: Buffer.from("target") }],
    { platform: "UNIX", unixPermissions: 0o120777 },
  );
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: symlinkZip,
      manifestBytes: withZipIdentity(fixture.manifest, symlinkZip),
    },
    "archive_link_forbidden",
  );

  const encryptedZip = patchZipFlags(fixture.zipBytes, 0x01);
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: encryptedZip,
      manifestBytes: withZipIdentity(fixture.manifest, encryptedZip),
    },
    "archive_encrypted",
  );
  const descriptorZip = patchZipFlags(fixture.zipBytes, 0x08);
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: descriptorZip,
      manifestBytes: withZipIdentity(fixture.manifest, descriptorZip),
    },
    "archive_unsupported",
  );
  const methodZip = patchZipMethod(fixture.zipBytes, 99);
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: methodZip,
      manifestBytes: withZipIdentity(fixture.manifest, methodZip),
    },
    "archive_unsupported",
  );
  const reparseZip = patchDosReparse(fixture.zipBytes);
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: reparseZip,
      manifestBytes: withZipIdentity(fixture.manifest, reparseZip),
    },
    "archive_link_forbidden",
  );
  const singleExpandedLimitZip = patchSingleExpandedLimit(fixture.zipBytes);
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: singleExpandedLimitZip,
      manifestBytes: withZipIdentity(
        fixture.manifest,
        singleExpandedLimitZip,
      ),
    },
    "package_limit_exceeded",
  );
  const zip64MarkerZip = patchZip64Marker(fixture.zipBytes);
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: zip64MarkerZip,
      manifestBytes: withZipIdentity(fixture.manifest, zip64MarkerZip),
    },
    "archive_unsupported",
  );
  const multiDiskZip = patchMultiDisk(fixture.zipBytes);
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: multiDiskZip,
      manifestBytes: withZipIdentity(fixture.manifest, multiDiskZip),
    },
    "archive_unsupported",
  );
  const localNameMismatchZip = patchLocalNameMismatch(fixture.zipBytes);
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: localNameMismatchZip,
      manifestBytes: withZipIdentity(
        fixture.manifest,
        localNameMismatchZip,
      ),
    },
    "archive_invalid",
  );
  const trailingZip = new Uint8Array(fixture.zipBytes.byteLength + 1);
  trailingZip.set(fixture.zipBytes);
  trailingZip[trailingZip.byteLength - 1] = 0x41;
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: trailingZip,
      manifestBytes: withZipIdentity(fixture.manifest, trailingZip),
    },
    "archive_invalid",
  );

  const tooManyEntriesZip = await zipFiles(
    Array.from(
      { length: CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.entryCount + 1 },
      (_, index) => ({
        path: `count/${String(index).padStart(3, "0")}.txt`,
        bytes: Buffer.from("x"),
      }),
    ),
  );
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: tooManyEntriesZip,
      manifestBytes: withZipIdentity(fixture.manifest, tooManyEntriesZip),
    },
    "package_limit_exceeded",
  );

  const moderateBytes = deterministicModerateCompressionBytes(1_050_000, 17);
  const totalExpandedLimitZip = await zipFiles(
    Array.from({ length: 65 }, (_, index) => ({
      path: `expanded/${String(index).padStart(2, "0")}.bin`,
      bytes: moderateBytes,
    })),
  );
  assert(
    totalExpandedLimitZip.byteLength <
      CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.zipBytes,
  );
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: totalExpandedLimitZip,
      manifestBytes: withZipIdentity(
        fixture.manifest,
        totalExpandedLimitZip,
      ),
    },
    "package_limit_exceeded",
  );

  const bombZip = await zipFiles([
    { path: "bomb.bin", bytes: new Uint8Array(1024 * 1024) },
  ]);
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: bombZip,
      manifestBytes: withZipIdentity(fixture.manifest, bombZip),
    },
    "package_limit_exceeded",
  );

  const unknownExtraZip = await zipFiles([
    ...basePayloads,
    { path: "RELEASE-MANIFEST.json", bytes: Buffer.from("{}\n") },
    { path: "unknown-extra.txt", bytes: Buffer.from("extra") },
  ]);
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: unknownExtraZip,
      manifestBytes: withZipIdentity(fixture.manifest, unknownExtraZip),
    },
    "archive_manifest_mismatch",
  );
  const missingPayloadZip = await zipFiles(basePayloads.slice(1));
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: missingPayloadZip,
      manifestBytes: withZipIdentity(fixture.manifest, missingPayloadZip),
    },
    "archive_manifest_mismatch",
  );

  const corruptZip = corruptFirstPayloadByte(fixture.zipBytes);
  await assertRejected(
    {
      ...fixture.input,
      zipBytes: corruptZip,
      manifestBytes: withZipIdentity(fixture.manifest, corruptZip),
    },
    "archive_integrity_mismatch",
  );

  const digestDrift = structuredClone(fixture.manifest);
  const firstPayload = testRecord(
    testArray(testRecord(digestDrift.package).payloadFiles)[0],
  );
  firstPayload.sha256 = "0".repeat(64);
  await assertRejected(
    { ...fixture.input, manifestBytes: canonicalBytes(digestDrift) },
    "archive_integrity_mismatch",
  );
  const sourceDrift = structuredClone(fixture.manifest);
  const sourceTree = testRecord(sourceDrift.sourceTree);
  sourceTree.files = testArray(sourceTree.files).slice(1);
  sourceTree.fileCount = Number(sourceTree.fileCount) - 1;
  await assertRejected(
    { ...fixture.input, manifestBytes: canonicalBytes(sourceDrift) },
    "archive_manifest_mismatch",
  );

  const badEmbedded = await makeFixture(goldenBytes, goldenSidecarBytes, sources, {
    embeddedProductionDefault: true,
  });
  await assertRejected(badEmbedded.input, "archive_manifest_mismatch");

  assert.equal(CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.entryCount, 512);
  assert.equal(CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.zipBytes, 16 * 1024 * 1024);
  assert.equal(networkCalls, 0);
  await assert.rejects(() => access(archiveExecutionMarker));

  const sourceText = `${await readFile(
    path.join(root, "lib", "gpu-coordinator", "connectorPackageQualification.ts"),
    "utf8",
  )}\n${await readFile(
    path.join(root, "scripts", "qualify-gpu-connector-package.ts"),
    "utf8",
  )}`;
  for (const forbidden of [
    /node:child_process/u,
    /node:net/u,
    /node:http/u,
    /node:https/u,
    /node:tls/u,
    /node:vm/u,
    /\bundici\b/u,
    /process\.env/u,
    /\brequire\s*\(/u,
    /\bimport\s*\(/u,
    /\beval\s*\(/u,
    /\bnew Function\b/u,
    /generation-jobs/u,
    /gpu-coordinator\/service/u,
    /gpu-coordinator\/server/u,
  ]) {
    assert(!forbidden.test(sourceText), `forbidden qualifier source token: ${forbidden}`);
  }

  const legacyGoldenAfter = await readLegacyGoldenSnapshot();
  assert.deepEqual(legacyGoldenAfter, legacyGoldenBefore);

  process.stdout.write(
    `${JSON.stringify({
      status: "gpu_connector_package_qualification_tests_passed",
      deterministicReportSha256: sha(firstJson),
      syntheticPackageSha256: sha256Hex(fixture.zipBytes),
      centralGoldenSha256: P1_7_CENTRAL_GOLDEN_SHA256,
      networkCalls,
      archiveCodeExecutions: 0,
      realPackageQualified: false,
    })}\n`,
  );
} finally {
  const resolvedTemp = path.resolve(tempRoot);
  const expectedPrefix = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (
    resolvedTemp.startsWith(expectedPrefix) &&
    path.basename(resolvedTemp).startsWith("aistory-p18-")
  ) {
    await rm(resolvedTemp, { recursive: true, force: true });
  }
  await rm(archiveExecutionMarker, { force: true });
}
