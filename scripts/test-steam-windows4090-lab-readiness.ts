import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type {
  SteamWindows4090LabControlledEvidence,
  SteamWindows4090LabPacket,
  SteamWindows4090LabReadinessFailureCode,
  SteamWindows4090LabReadinessResult,
  SteamWindows4090LabReadinessSources,
} from "../lib/steam/windows4090LabReadiness";

const CHILD_FLAG = "--p116-steam-windows4090-lab-readiness-react-server-child";

if (!process.argv.includes(CHILD_FLAG)) {
  const child = spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", fileURLToPath(import.meta.url), CHILD_FLAG],
    { stdio: "inherit" },
  );
  if (child.error) throw child.error;
  process.exitCode = child.status ?? 1;
} else {
  await run();
}

type ContractModule = typeof import("../lib/steam/windows4090LabReadiness");

function sha256(label: string): string {
  return createHash("sha256").update(label, "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(record(value)).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function receiptSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function packet(result: SteamWindows4090LabReadinessResult): SteamWindows4090LabPacket {
  assert.notEqual(result.packet, null);
  if (!result.packet) throw new Error("packet_missing");
  return result.packet;
}

function assertZeroAuthority(result: SteamWindows4090LabReadinessResult): void {
  if (result.packet) {
    const value = result.packet;
    assert.equal(value.playbackReady, false);
    assert.equal(value.playbackSyncVerified, false);
    assert.equal(value.reviewSatisfied, false);
    assert.equal(value.adopted, false);
    assert.equal(value.executionAllowed, false);
    assert.equal(value.jobWriteAllowed, false);
    assert.equal(value.publishAllowed, false);
    assert.equal(value.providerPreparation, "NOT_ATTEMPTED");
    assert.equal(value.providerContacted, false);
    assert.equal(value.providerReferenceHandlesIssuedByPacket, 0);
    assert.equal(value.gpuProbed, false);
    assert.equal(value.networkCalls, 0);
    assert.equal(value.writesPerformed, 0);
    assert.equal(value.releaseGate.satisfied, false);
    assert.equal(value.authorization.authorizationGranted, false);
    assert.equal(value.authorization.foregroundRunsAuthorized, 0);
    assert.equal(value.authorization.retry, 0);
  } else {
    assert.equal(result.executionAllowed, false);
    assert.equal(result.jobWriteAllowed, false);
    assert.equal(result.providerContacted, false);
    assert.equal(result.gpuProbed, false);
    assert.equal(result.networkCalls, 0);
    assert.equal(result.writesPerformed, 0);
  }
}

function assertSafeProjection(value: unknown): void {
  const text = JSON.stringify(value);
  for (const pattern of [
    /negativePrompt/iu,
    /sourceTextVerbatim/iu,
    /publicText/iu,
    /workflowJson/iu,
    /manifestJson/iu,
    /checkpoint/iu,
    /localPath/iu,
    /absolutePath/iu,
    /providerTask/iu,
    /\b(?:token|secret|hmac)\b/iu,
    /https?:\/\//iu,
    /[A-Za-z]:\\/u,
    /WEBVTT|-->/u,
  ]) {
    assert.doesNotMatch(text, pattern);
  }
}

function assertInvalid(
  result: SteamWindows4090LabReadinessResult,
  expected?: SteamWindows4090LabReadinessFailureCode,
  label = "invalid source or evidence",
): void {
  assert.equal(result.status, "BLOCKED", label);
  assert.equal(result.packet, null, label);
  if (expected) assert.equal(result.failureCode, expected, label);
  assertZeroAuthority(result);
  assertSafeProjection(result);
}

function completeEvidence(contract: ContractModule): SteamWindows4090LabControlledEvidence {
  const profileFingerprint = sha256("p116-windows-profile");
  const evaluatedAtEpochMs = 2_000_000;
  const repairedPackageSha256 = sha256("p116-repaired-package");
  const qualificationBody = {
    schemaVersion: "aistory-gpu-connector-package-qualification-v1",
    status: "OFFLINE_PACKAGE_STATIC_QUALIFIED",
    packageDisposition: "REAL_REPAIRED_CONNECTOR_PACKAGE",
    realPackage: true,
    inputCount: 4,
    centralGoldenBytes: contract.STEAM_WINDOWS_4090_P1_8_CENTRAL_PIN.centralGoldenBytes,
    centralGoldenSha256: contract.STEAM_WINDOWS_4090_P1_8_CENTRAL_PIN.centralGoldenSha256,
    packageSha256: repairedPackageSha256,
    externalManifestSha256: sha256("p116-external-manifest"),
    goldenSidecarSha256: sha256("p116-golden-sidecar"),
    identity: {
      connectorVersion: "0.3.0-windows-repaired",
      buildSha256: sha256("p116-build"),
      releaseSha256: repairedPackageSha256,
      capabilityDigestSha256: sha256("p116-capability"),
      centralContractSha256: contract.STEAM_WINDOWS_4090_P1_8_CENTRAL_PIN.centralGoldenSha256,
    },
    staticSafety: {
      provenanceVerified: false,
      signatureVerified: false,
      runtimeBindingVerified: false,
      noWorkExecuted: false,
      gpuExecuted: false,
      deployable: false,
      networkCalls: 0,
      archiveCodeExecuted: false,
    },
    compatibility: {
      firstHeartbeat: "idle",
      runnerMode: "no_work_only",
      noWorkOnlyFirstGate: true,
      connectorFakeTestsExecuted: false,
    },
  } as const;
  const qualificationReceiptSha256 = receiptSha256(qualificationBody);
  const runtimeBindingBody = {
    schema: "aistory-steam-windows-4090-protected-runtime-binding-receipt",
    schemaVersion: 1,
    status: "PROTECTED_RUNTIME_BOUND",
    profileFingerprint,
    qualificationReceiptSha256,
    connectorIdentitySha256: receiptSha256(qualificationBody.identity),
    centralContractSha256: qualificationBody.identity.centralContractSha256,
    productionNetworkEnabled: false,
    lanLabNetworkEnabled: true,
    runnerMode: "no_work_only",
  } as const;
  const runtimeBindingSha256 = receiptSha256(runtimeBindingBody);
  const registrationReceiptSha256 = sha256("p116-fresh-registration");
  const sessionBindingSha256 = sha256("p116-fresh-session");
  const noWorkBody = {
    status: "PASS_FRESH_NO_WORK_ONLY",
    runnerMode: "no_work_only",
    firstHeartbeatState: "idle",
    profileFingerprint,
    runtimeBindingSha256,
    qualificationReceiptSha256,
    registrationReceiptSha256,
    sessionBindingSha256,
    sequence: ["fresh_registration", "first_heartbeat_idle", "no_work_only"],
    observedAtEpochMs: 1_900_000,
    expiresAtEpochMs: 2_100_000,
    businessTasksClaimed: 0,
    providerCalls: 0,
    gpuAcquisitions: 0,
    controlledConnectorRequests: 3,
    externalProviderNetworkCalls: 0,
  } as const;
  const noWorkReceiptSha256 = receiptSha256(noWorkBody);
  const workflowBindingBody = {
    status: "EXACT_WINDOWS_WORKFLOW_BOUND",
    profileFingerprint,
    runtimeBindingSha256,
    workflowId: contract.STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.workflowId,
    workflowSha256: contract.STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.workflowSha256,
    parameterBindingSha256:
      contract.STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.parameterBindingSha256,
    policyVersion: contract.STEAM_WINDOWS_4090_LAB_POLICY.policyVersion,
    shotId: contract.STEAM_WINDOWS_4090_LAB_TARGET.shotId,
    stage: "original",
    noWorkReceiptSha256,
  } as const;
  const bindingReceiptSha256 = receiptSha256(workflowBindingBody);
  const handleReferences = contract.STEAM_WINDOWS_4090_LAB_REFERENCES.map((reference) => ({
    role: reference.role,
    assetId: reference.assetId,
    assetSha256: reference.sha256,
    handleBindingSha256: sha256(`p116-handle-binding-${reference.role}`),
  }));
  const handleSetBody = {
    schema: "aistory-steam-windows-4090-reference-handle-set-receipt",
    schemaVersion: 1,
    status: "CONTROLLED_REFERENCE_HANDLES_BOUND",
    shotId: contract.STEAM_WINDOWS_4090_LAB_TARGET.shotId,
    count: 4,
    workflowBindingReceiptSha256: bindingReceiptSha256,
    references: handleReferences,
  } as const;
  const healthBody = {
    status: "CURRENT_WINDOWS_HOST_HEALTHY",
    profileFingerprint,
    runtimeBindingSha256,
    sessionBindingSha256,
    noWorkReceiptSha256,
    queueState: "empty",
    observedAtEpochMs: 1_990_000,
    expiresAtEpochMs: 2_010_000,
  } as const;
  return {
    schema: "aistory-steam-windows-4090-controlled-evidence",
    schemaVersion: 1,
    evaluationContext: {
      evaluatedAtEpochMs,
      maxNoWorkAgeMs: 300_000,
      maxHostHealthAgeMs: 60_000,
    },
    windowsHostProfile: {
      status: "INDEPENDENT_WINDOWS_HOST_PROFILE_VERIFIED",
      profileId: "windows-rtx4090-lab-v1",
      os: "windows",
      architecture: "x64",
      gpuClass: "NVIDIA_RTX_4090",
      profileFingerprint,
    },
    connectorQualification: {
      ...qualificationBody,
      qualificationReceiptSha256,
    },
    protectedRuntimeBinding: {
      ...runtimeBindingBody,
      runtimeBindingSha256,
    },
    freshNoWorkReceipt: {
      ...noWorkBody,
      sequence: ["fresh_registration", "first_heartbeat_idle", "no_work_only"],
      receiptSha256: noWorkReceiptSha256,
    },
    exactWorkflowBinding: {
      ...workflowBindingBody,
      bindingReceiptSha256,
    },
    controlledReferenceHandles: {
      status: "CONTROLLED_REFERENCE_HANDLES_BOUND",
      shotId: contract.STEAM_WINDOWS_4090_LAB_TARGET.shotId,
      count: 4,
      workflowBindingReceiptSha256: bindingReceiptSha256,
      handleSetReceiptSha256: receiptSha256(handleSetBody),
      references: handleReferences,
    },
    windowsModelProvenanceLicense: {
      status: "WINDOWS_PROVENANCE_LICENSE_VERIFIED",
      workflowSha256: contract.STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.workflowSha256,
      generationUse: "INTERNAL_GENERATION_CONDITIONAL_PASS",
      weightsDistributionAllowed: false,
      provenanceReceiptSha256: sha256("p116-provenance"),
      licenseReceiptSha256: sha256("p116-license"),
    },
    currentHostHealth: {
      ...healthBody,
      healthReceiptSha256: receiptSha256(healthBody),
    },
  };
}

function cloneSources(sources: SteamWindows4090LabReadinessSources): SteamWindows4090LabReadinessSources {
  return structuredClone(sources);
}

function cloneEvidence(
  evidence: SteamWindows4090LabControlledEvidence,
): SteamWindows4090LabControlledEvidence {
  return structuredClone(evidence);
}

function assertPolicyAndReferences(value: SteamWindows4090LabPacket, contract: ContractModule): void {
  assert.deepEqual(value.authority, contract.STEAM_WINDOWS_4090_LAB_AUTHORITY);
  assert.deepEqual(value.sourcePins, contract.STEAM_WINDOWS_4090_LAB_SOURCE_PINS);
  assert.deepEqual(value.target, contract.STEAM_WINDOWS_4090_LAB_TARGET);
  assert.deepEqual(value.policy, {
    ...contract.STEAM_WINDOWS_4090_LAB_POLICY,
    audioMaterialized: false,
    audioSyncVerified: false,
  });
  assert.equal(value.policy.discriminator, "LAB_NON_PUBLISHABLE");
  assert.equal(value.policy.policyVersion, "windows_rtx_4090_lab_original_v1");
  assert.equal(value.policy.hostProfile, "WINDOWS_X64_RTX_4090");
  assert.equal(value.policy.stage, "original");
  assert.equal(value.policy.width, 768);
  assert.equal(value.policy.height, 480);
  assert.equal(value.policy.aspectRatio, "8:5");
  assert.equal(value.policy.frameCount, 81);
  assert.equal(value.policy.fps, 24);
  assert.equal(value.policy.durationMs, 3375);
  assert.equal(value.policy.hasAudio, true);
  assert.equal(value.policy.retry, 0);
  assert.equal(value.policy.upscaleAllowed, false);
  assert.equal(value.policy.subtitleInput, "NONE");
  assert.equal(value.policy.privateReviewVttAttached, false);
  assert.equal(value.policy.attachedSubtitleArtifacts, 0);
  const parameterBindingBody = {
    schema: "aistory-steam-windows-4090-parameter-binding",
    schemaVersion: 1,
    workflowId: "ltx23-original-av-lab",
    workflowSha256:
      "f3465cacbf88e139a0f4708ed887d875edab72cc5d28c0c6b40c91519362794e",
    target: {
      nodeId: "vg11_breakfast_choice",
      shotId: "VG11-SHOT-04",
      sceneId: "VG11-S03",
      episodeId: "VG11-EP01",
      landingBeatId: "vg11_breakfast_choice_b8",
      sourceFrameAssetId: "vg11-kf-breakfast",
      sourceContentHash:
        "c5c6cda991e5f07d2d06a6bfbc42ac6d631588cdde1a60dfa3512075bca1dedc",
    },
    policy: {
      discriminator: "LAB_NON_PUBLISHABLE",
      policyVersion: "windows_rtx_4090_lab_original_v1",
      hostProfile: "WINDOWS_X64_RTX_4090",
      stage: "original",
      width: 768,
      height: 480,
      aspectRatio: "8:5",
      frameCount: 81,
      fps: 24,
      durationMs: 3375,
      hasAudio: true,
      retry: 0,
      upscaleAllowed: false,
      subtitleInput: "NONE",
      privateReviewVttAttached: false,
      attachedSubtitleArtifacts: 0,
    },
    references: [
      {
        role: "source_frame",
        assetId: "vg11-kf-breakfast",
        sha256: "04cc8aadfdd00dd79962bb5062079d09f59e7c173bf3a9419bd56e107d10df15",
      },
      {
        role: "identity_face",
        assetId: "vg11-char-face-reference",
        sha256: "390262b5125b6d3b8b0d02996bd1dab15a4d25d9d5d2f79bd2b849ec3f24032a",
      },
      {
        role: "home_outfit",
        assetId: "vg11-char-home-outfit-reference",
        sha256: "102aae24bfdc03608763f153cfeb5a568776549da2c2722a36814911c593310b",
      },
      {
        role: "expressions",
        assetId: "vg11-char-expression-reference",
        sha256: "26413e9b8c6a690f3284878d3241d630ba755a5bcc393a1099d835b2caa7597f",
      },
    ],
  };
  assert.equal(
    receiptSha256(parameterBindingBody),
    "5da94127a97fe313d1c279f8a486a579faf0eedf4ad2d5f84b14940f73e18d15",
  );
  assert.equal(
    contract.STEAM_WINDOWS_4090_LAB_WORKFLOW_PIN.parameterBindingSha256,
    "5da94127a97fe313d1c279f8a486a579faf0eedf4ad2d5f84b14940f73e18d15",
  );
  assert.equal(value.references.length, 4);
  value.references.forEach((reference, index) => {
    const expected = contract.STEAM_WINDOWS_4090_LAB_REFERENCES[index]!;
    assert.equal(reference.role, expected.role);
    assert.equal(reference.referenceId, expected.referenceId);
    assert.equal(reference.assetId, expected.assetId);
    assert.equal(reference.bytes, expected.bytes);
    assert.equal(reference.sha256, expected.sha256);
    assert.equal(reference.mediaType, "image/png");
    assert.equal(reference.localIntegrity, "verified");
    assert.equal(reference.providerPrepared, false);
  });
  assert.deepEqual(value.inheritedBlockerCodes, {
    release: ["source_reference_not_prepared", "publishable_workflow_missing"],
    targetContent: ["subtitle_density_exceeded"],
    upstreamPrivatePreviewContent: [
      "subtitle_density_exceeded",
      "editorial_marker_present",
    ],
  });
  assert.deepEqual(value.upstreamPrivatePreview, {
    status: "INCOMPLETE",
    contentReviewSatisfied: false,
    candidateSetComplete: false,
    attachedToLabTask: false,
  });
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /ubuntu|3090/iu);
  assert.doesNotMatch(serialized, /1280|720|30000|attach_webvtt/iu);
}

type ControlledEvidenceKey = Exclude<
  keyof SteamWindows4090LabControlledEvidence,
  "schema" | "schemaVersion" | "evaluationContext"
>;

function nullEvidenceChain(
  evidence: SteamWindows4090LabControlledEvidence,
  key: ControlledEvidenceKey,
): SteamWindows4090LabControlledEvidence {
  const copy = cloneEvidence(evidence);
  const dependent: Record<ControlledEvidenceKey, Array<keyof typeof copy>> = {
    windowsHostProfile: [
      "windowsHostProfile",
      "protectedRuntimeBinding",
      "freshNoWorkReceipt",
      "exactWorkflowBinding",
      "controlledReferenceHandles",
      "currentHostHealth",
    ],
    connectorQualification: [
      "connectorQualification",
      "protectedRuntimeBinding",
      "freshNoWorkReceipt",
      "exactWorkflowBinding",
      "controlledReferenceHandles",
      "currentHostHealth",
    ],
    protectedRuntimeBinding: [
      "protectedRuntimeBinding",
      "freshNoWorkReceipt",
      "exactWorkflowBinding",
      "controlledReferenceHandles",
      "currentHostHealth",
    ],
    freshNoWorkReceipt: [
      "freshNoWorkReceipt",
      "exactWorkflowBinding",
      "controlledReferenceHandles",
      "currentHostHealth",
    ],
    exactWorkflowBinding: ["exactWorkflowBinding", "controlledReferenceHandles"],
    controlledReferenceHandles: ["controlledReferenceHandles"],
    windowsModelProvenanceLicense: ["windowsModelProvenanceLicense"],
    currentHostHealth: ["currentHostHealth"],
  };
  const copyRecord = copy as unknown as Record<string, unknown>;
  for (const missing of dependent[key]) copyRecord[missing] = null;
  return copy;
}

async function run(): Promise<void> {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    writable: true,
    value: async () => {
      fetchCalls += 1;
      throw new Error("network_forbidden");
    },
  });
  try {
    const [contract, server] = await Promise.all([
      import("../lib/steam/windows4090LabReadiness"),
      import("../lib/steam/windows4090LabReadinessServer"),
    ]);
    assert.equal(server.readSteamWindows4090LabReadiness.length, 0);
    const sources = await server.readSteamWindows4090LabReadinessSourcesForTest();
    const rawSourceBefore = JSON.stringify(sources);
    const sourceBefore = contract.serializeSteamWindows4090LabReadiness(
      contract.deriveSteamWindows4090LabReadiness(sources, null),
    );

    const current = await server.readSteamWindows4090LabReadiness();
    assert.equal(current.status, "BLOCKED");
    assert.equal(current.failureCode, null);
    const currentPacket = packet(current);
    assert.equal(currentPacket.status, "BLOCKED");
    assert.equal(currentPacket.controlledEvidence.evidenceSetFingerprint, null);
    assert.equal(currentPacket.controlledEvidence.allSatisfied, false);
    assert.equal(currentPacket.authorization.proposedAction, null);
    assert.equal(currentPacket.authorization.foregroundOnceProposalAllowed, false);
    assert.equal(
      Object.values(currentPacket.controlledEvidence).filter((value) => value === true).length,
      0,
    );
    for (const blocker of contract.STEAM_WINDOWS_4090_CONTROLLED_EVIDENCE_BLOCKERS) {
      assert.ok(currentPacket.blockerCodes.includes(blocker));
    }
    assert.ok(currentPacket.blockerCodes.includes("founder_authorization_required"));
    assertPolicyAndReferences(currentPacket, contract);
    assertZeroAuthority(current);
    assertSafeProjection(current);

    const repeated = await server.readSteamWindows4090LabReadiness();
    assert.equal(
      contract.serializeSteamWindows4090LabReadiness(repeated),
      contract.serializeSteamWindows4090LabReadiness(current),
      "real authority is byte deterministic",
    );
    assert.equal(sourceBefore, contract.serializeSteamWindows4090LabReadiness(current));

    const evidence = completeEvidence(contract);
    const ceiling = contract.deriveSteamWindows4090LabReadiness(sources, evidence);
    assert.equal(
      ceiling.status,
      "FOUNDER_AUTHORIZATION_REQUIRED",
      JSON.stringify(ceiling),
    );
    assert.equal(ceiling.failureCode, null);
    const ceilingPacket = packet(ceiling);
    assert.equal(ceilingPacket.status, "FOUNDER_AUTHORIZATION_REQUIRED");
    assert.equal(ceilingPacket.controlledEvidence.allSatisfied, true);
    assert.match(ceilingPacket.controlledEvidence.evidenceSetFingerprint ?? "", /^[a-f0-9]{64}$/u);
    assert.equal(ceilingPacket.authorization.registrationAndNoWorkOnlyPassed, true);
    assert.equal(ceilingPacket.authorization.foregroundOnceProposalAllowed, true);
    assert.equal(ceilingPacket.authorization.secondExactFounderAuthorizationRequired, true);
    assert.equal(ceilingPacket.authorization.authorizationGranted, false);
    assert.equal(ceilingPacket.authorization.foregroundRunsAuthorized, 0);
    assert.equal(ceilingPacket.authorization.proposedAction, "foreground_once");
    assert.equal(ceilingPacket.authorization.taskCount, 1);
    assert.ok(ceilingPacket.blockerCodes.includes("lab_non_publishable"));
    assert.ok(ceilingPacket.blockerCodes.includes("founder_authorization_required"));
    for (const blocker of contract.STEAM_WINDOWS_4090_CONTROLLED_EVIDENCE_BLOCKERS) {
      assert.equal(ceilingPacket.blockerCodes.includes(blocker), false);
    }
    assertPolicyAndReferences(ceilingPacket, contract);
    assertZeroAuthority(ceiling);
    assertSafeProjection(ceiling);

    const injected = await server.readSteamWindows4090LabReadinessForTest({
      sources,
      controlledEvidence: evidence,
    });
    assert.equal(
      contract.serializeSteamWindows4090LabReadiness(injected),
      contract.serializeSteamWindows4090LabReadiness(ceiling),
    );

    const evidenceKeys = [
      "windowsHostProfile",
      "connectorQualification",
      "protectedRuntimeBinding",
      "freshNoWorkReceipt",
      "exactWorkflowBinding",
      "controlledReferenceHandles",
      "windowsModelProvenanceLicense",
      "currentHostHealth",
    ] as const;
    for (const key of evidenceKeys) {
      const partial = contract.deriveSteamWindows4090LabReadiness(
        sources,
        nullEvidenceChain(evidence, key),
      );
      assert.equal(partial.status, "BLOCKED", `missing ${key}`);
      assert.equal(partial.failureCode, null, `missing ${key}`);
      assert.equal(packet(partial).controlledEvidence.allSatisfied, false, `missing ${key}`);
      assertZeroAuthority(partial);
    }

    const reversedEvidence = cloneEvidence(evidence);
    reversedEvidence.controlledReferenceHandles!.references.reverse();
    const reordered = contract.deriveSteamWindows4090LabReadiness(sources, reversedEvidence);
    assert.equal(reordered.status, "FOUNDER_AUTHORIZATION_REQUIRED");
    assert.equal(packet(reordered).packetFingerprint, ceilingPacket.packetFingerprint);
    assert.equal(
      contract.serializeSteamWindows4090LabReadiness(reordered),
      contract.serializeSteamWindows4090LabReadiness(ceiling),
      "reference input order cannot perturb packet bytes",
    );

    const reorderedIntegrity = cloneSources(sources);
    const reorderedManifest = record(reorderedIntegrity.referencePreparation);
    array(reorderedManifest.shots).reverse();
    array(reorderedManifest.assets).reverse();
    for (const shot of array(reorderedManifest.shots)) {
      array(record(shot).bindings).reverse();
    }
    const normalizedIntegrityResult = contract.deriveSteamWindows4090LabReadiness(
      reorderedIntegrity,
      null,
    );
    assert.equal(
      contract.serializeSteamWindows4090LabReadiness(normalizedIntegrityResult),
      contract.serializeSteamWindows4090LabReadiness(current),
      "P1.9 set reordering cannot perturb packet bytes",
    );

    const sourceDrifts: Array<[string, (copy: SteamWindows4090LabReadinessSources) => void]> = [
      ["p1.9 nested gate", (copy) => {
        record(copy.referencePreparation).providerContacted = true;
      }],
      ["p1.9 fingerprint", (copy) => {
        record(copy.referencePreparation).manifestFingerprint = sha256("wrong-p19");
      }],
      ["p1.10 authority", (copy) => {
        const result = record(copy.reviewPacket);
        record(result.packet).executionAllowed = true;
      }],
      ["p1.10 packet fingerprint", (copy) => {
        record(record(copy.reviewPacket).packet).packetFingerprint = sha256("wrong-p110");
      }],
      ["p1.10 cross shot", (copy) => {
        const shots = array(record(record(copy.reviewPacket).packet).shots);
        record(shots[1]).shotId = "VG11-SHOT-05";
      }],
      ["p1.11 nested gate", (copy) => {
        record(record(copy.cueReview).review).executionAllowed = true;
      }],
      ["p1.11 overlay fingerprint", (copy) => {
        record(record(copy.cueReview).review).overlayFingerprint = sha256("wrong-p111");
      }],
      ["p1.12 nested gate", (copy) => {
        record(record(copy.materializationPreflight).preflight).executionAllowed = true;
      }],
      ["p1.12 preflight fingerprint", (copy) => {
        record(record(copy.materializationPreflight).preflight).preflightFingerprint =
          sha256("wrong-p112");
      }],
      ["p1.15 nested gate", (copy) => {
        const bundle = record(record(copy.previewBundle).bundle);
        record(bundle.manifest).executionAllowed = true;
      }],
      ["p1.15 bundle fingerprint", (copy) => {
        const bundle = record(record(copy.previewBundle).bundle);
        record(bundle.manifest).bundleFingerprint = sha256("wrong-p115");
      }],
    ];
    for (const [label, mutate] of sourceDrifts) {
      const copy = cloneSources(sources);
      mutate(copy);
      assertInvalid(
        contract.deriveSteamWindows4090LabReadiness(copy, null),
        undefined,
        label,
      );
    }

    const evidenceHostiles: Array<[
      string,
      SteamWindows4090LabControlledEvidence,
      SteamWindows4090LabReadinessFailureCode,
    ]> = [];
    const ubuntu = cloneEvidence(evidence);
    record(ubuntu.windowsHostProfile).profileId = "ubuntu_3090_lab_preview_v1";
    evidenceHostiles.push(["ubuntu profile", ubuntu, "ubuntu_profile_forbidden"]);
    const wrongCentral = cloneEvidence(evidence);
    record(wrongCentral.connectorQualification).centralGoldenSha256 = sha256("old-central");
    evidenceHostiles.push(["old central pin", wrongCentral, "evidence_join_mismatch"]);
    const oldPackage = cloneEvidence(evidence);
    record(oldPackage.connectorQualification).packageSha256 =
      contract.STEAM_WINDOWS_4090_FORBIDDEN_CONNECTOR_PACKAGE_SHA256;
    evidenceHostiles.push(["forbidden old connector package", oldPackage, "evidence_join_mismatch"]);
    const wrongQualificationSchema = cloneEvidence(evidence);
    record(wrongQualificationSchema.connectorQualification).schemaVersion =
      "aistory-gpu-connector-package-qualification-v0";
    evidenceHostiles.push(["qualification schema", wrongQualificationSchema, "evidence_join_mismatch"]);
    const qualificationIdentityDrift = cloneEvidence(evidence);
    record(record(qualificationIdentityDrift.connectorQualification).identity).buildSha256 =
      sha256("other-build");
    evidenceHostiles.push(["qualification identity receipt", qualificationIdentityDrift, "evidence_join_mismatch"]);
    const qualificationReleaseMismatch = cloneEvidence(evidence);
    record(record(qualificationReleaseMismatch.connectorQualification).identity).releaseSha256 =
      sha256("not-the-package");
    evidenceHostiles.push(["qualification release/package mismatch", qualificationReleaseMismatch, "evidence_join_mismatch"]);
    const qualificationVersionMismatch = cloneEvidence(evidence);
    record(record(qualificationVersionMismatch.connectorQualification).identity).connectorVersion =
      "windows-repaired";
    evidenceHostiles.push(["qualification semver", qualificationVersionMismatch, "evidence_join_mismatch"]);
    const unsafeStaticProjection = cloneEvidence(evidence);
    record(record(unsafeStaticProjection.connectorQualification).staticSafety).runtimeBindingVerified =
      true;
    evidenceHostiles.push(["qualification static safety", unsafeStaticProjection, "evidence_join_mismatch"]);
    const compatibilityDrift = cloneEvidence(evidence);
    record(record(compatibilityDrift.connectorQualification).compatibility).connectorFakeTestsExecuted =
      true;
    evidenceHostiles.push(["qualification compatibility projection", compatibilityDrift, "evidence_join_mismatch"]);
    const runtimeJoin = cloneEvidence(evidence);
    record(runtimeJoin.protectedRuntimeBinding).profileFingerprint = sha256("other-profile");
    evidenceHostiles.push(["runtime/profile join", runtimeJoin, "evidence_join_mismatch"]);
    const arbitraryRuntimeReceipt = cloneEvidence(evidence);
    record(arbitraryRuntimeReceipt.protectedRuntimeBinding).runtimeBindingSha256 =
      sha256("arbitrary-runtime-receipt");
    evidenceHostiles.push(["runtime canonical receipt", arbitraryRuntimeReceipt, "evidence_join_mismatch"]);
    const staleNoWork = cloneEvidence(evidence);
    record(staleNoWork.freshNoWorkReceipt).status = "STALE_NO_WORK_ONLY";
    evidenceHostiles.push(["stale no_work", staleNoWork, "evidence_join_mismatch"]);
    const expiredNoWork = cloneEvidence(evidence);
    record(expiredNoWork.freshNoWorkReceipt).observedAtEpochMs = 1_000_000;
    record(expiredNoWork.freshNoWorkReceipt).expiresAtEpochMs = 1_500_000;
    evidenceHostiles.push(["expired no_work with PASS status", expiredNoWork, "freshness_invalid"]);
    const busyNoWork = cloneEvidence(evidence);
    record(busyNoWork.freshNoWorkReceipt).firstHeartbeatState = "busy";
    evidenceHostiles.push(["non-idle first heartbeat", busyNoWork, "evidence_join_mismatch"]);
    const wrongWorkflow = cloneEvidence(evidence);
    record(wrongWorkflow.exactWorkflowBinding).workflowSha256 = sha256("wrong-workflow");
    evidenceHostiles.push(["workflow identity", wrongWorkflow, "workflow_pin_mismatch"]);
    const crossShot = cloneEvidence(evidence);
    record(crossShot.exactWorkflowBinding).shotId = "VG11-SHOT-05";
    evidenceHostiles.push(["cross shot", crossShot, "workflow_pin_mismatch"]);
    const wrongPolicy = cloneEvidence(evidence);
    record(wrongPolicy.exactWorkflowBinding).policyVersion = "ubuntu_3090_lab_preview_v1";
    evidenceHostiles.push(["wrong policy version", wrongPolicy, "workflow_pin_mismatch"]);
    const wrongHandleReceipt = cloneEvidence(evidence);
    record(wrongHandleReceipt.controlledReferenceHandles).workflowBindingReceiptSha256 =
      sha256("other-binding");
    evidenceHostiles.push(["handle/workflow join", wrongHandleReceipt, "evidence_join_mismatch"]);
    const threeReferences = cloneEvidence(evidence);
    threeReferences.controlledReferenceHandles!.references.pop();
    record(threeReferences.controlledReferenceHandles).count = 3;
    evidenceHostiles.push(["three references", threeReferences, "reference_handle_binding_mismatch"]);
    const fiveReferences = cloneEvidence(evidence);
    fiveReferences.controlledReferenceHandles!.references.push(
      structuredClone(fiveReferences.controlledReferenceHandles!.references[0]!),
    );
    record(fiveReferences.controlledReferenceHandles).count = 5;
    evidenceHostiles.push(["five references", fiveReferences, "reference_handle_binding_mismatch"]);
    const duplicateRole = cloneEvidence(evidence);
    duplicateRole.controlledReferenceHandles!.references[1]!.role = "source_frame";
    evidenceHostiles.push(["duplicate role", duplicateRole, "reference_handle_binding_mismatch"]);
    const unknownRole = cloneEvidence(evidence);
    record(unknownRole.controlledReferenceHandles!.references[1]).role = "native_body";
    evidenceHostiles.push(["unknown role", unknownRole, "reference_handle_binding_mismatch"]);
    const wrongAsset = cloneEvidence(evidence);
    wrongAsset.controlledReferenceHandles!.references[1]!.assetId = "cross-shot-asset";
    evidenceHostiles.push(["reference asset", wrongAsset, "reference_handle_binding_mismatch"]);
    const wrongAssetHash = cloneEvidence(evidence);
    wrongAssetHash.controlledReferenceHandles!.references[1]!.assetSha256 = sha256("wrong-asset");
    evidenceHostiles.push(["reference sha", wrongAssetHash, "reference_handle_binding_mismatch"]);
    const unboundHandleReceipt = cloneEvidence(evidence);
    unboundHandleReceipt.controlledReferenceHandles!.references[1]!.handleBindingSha256 =
      sha256("replacement-handle-binding");
    evidenceHostiles.push([
      "reference set receipt does not match role receipt",
      unboundHandleReceipt,
      "reference_handle_binding_mismatch",
    ]);
    const wrongLicense = cloneEvidence(evidence);
    record(wrongLicense.windowsModelProvenanceLicense).weightsDistributionAllowed = true;
    evidenceHostiles.push(["license scope", wrongLicense, "evidence_join_mismatch"]);
    const staleHealth = cloneEvidence(evidence);
    record(staleHealth.currentHostHealth).queueState = "unknown";
    evidenceHostiles.push(["host health", staleHealth, "evidence_join_mismatch"]);
    const expiredHealth = cloneEvidence(evidence);
    record(expiredHealth.currentHostHealth).observedAtEpochMs = 1_800_000;
    record(expiredHealth.currentHostHealth).expiresAtEpochMs = 1_900_000;
    evidenceHostiles.push(["expired healthy receipt", expiredHealth, "freshness_invalid"]);
    for (const [label, hostile, failureCode] of evidenceHostiles) {
      assertInvalid(
        contract.deriveSteamWindows4090LabReadiness(sources, hostile),
        failureCode,
        label,
      );
    }

    const sensitive = cloneEvidence(evidence) as unknown as Record<string, unknown>;
    sensitive.token = "must-never-echo";
    const sensitiveResult = contract.deriveSteamWindows4090LabReadiness(sources, sensitive);
    assertInvalid(sensitiveResult, "evidence_invalid", "sensitive unknown field");
    assert.doesNotMatch(contract.serializeSteamWindows4090LabReadiness(sensitiveResult), /must-never-echo/u);

    const hiddenSensitive = cloneEvidence(evidence);
    Object.defineProperty(hiddenSensitive, "token", {
      configurable: true,
      enumerable: false,
      value: "hidden-token",
    });
    assertInvalid(
      contract.deriveSteamWindows4090LabReadiness(sources, hiddenSensitive),
      "evidence_invalid",
      "non-enumerable evidence field",
    );
    const hiddenNestedSensitive = cloneEvidence(evidence);
    Object.defineProperty(hiddenNestedSensitive.connectorQualification!, "prompt", {
      configurable: true,
      enumerable: false,
      value: "hidden-prompt",
    });
    assertInvalid(
      contract.deriveSteamWindows4090LabReadiness(sources, hiddenNestedSensitive),
      "evidence_invalid",
      "non-enumerable nested field",
    );
    const hiddenSourceField = cloneSources(sources);
    Object.defineProperty(hiddenSourceField.referencePreparation, "negativePrompt", {
      configurable: true,
      enumerable: false,
      value: "hidden-source-value",
    });
    assertInvalid(
      contract.deriveSteamWindows4090LabReadiness(hiddenSourceField, null),
      "source_contract_mismatch",
      "non-enumerable source field",
    );
    const hiddenArrayElement = cloneEvidence(evidence);
    const firstHandleReference = hiddenArrayElement.controlledReferenceHandles!.references[0]!;
    Object.defineProperty(hiddenArrayElement.controlledReferenceHandles!.references, "0", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: firstHandleReference,
    });
    assertInvalid(
      contract.deriveSteamWindows4090LabReadiness(sources, hiddenArrayElement),
      "evidence_invalid",
      "non-enumerable array element",
    );
    let proxyTrapCalls = 0;
    const proxyEvidence = new Proxy(cloneEvidence(evidence), {
      getPrototypeOf() {
        proxyTrapCalls += 1;
        return Object.prototype;
      },
      ownKeys() {
        proxyTrapCalls += 1;
        return [];
      },
    });
    assertInvalid(
      contract.deriveSteamWindows4090LabReadiness(sources, proxyEvidence),
      "evidence_invalid",
      "proxy evidence",
    );
    assert.equal(proxyTrapCalls, 0);

    let getterCalls = 0;
    const accessorSource = cloneSources(sources);
    Object.defineProperty(accessorSource.referencePreparation, "status", {
      configurable: true,
      enumerable: true,
      get() {
        getterCalls += 1;
        return "LOCAL_VERIFIED_ONLY";
      },
    });
    assertInvalid(
      contract.deriveSteamWindows4090LabReadiness(accessorSource, null),
      "source_contract_mismatch",
      "accessor source",
    );
    assert.equal(getterCalls, 0);

    let serializerGetterCalls = 0;
    const hostileSerializedResult = structuredClone(current);
    Object.defineProperty(record(hostileSerializedResult.packet), "packetFingerprint", {
      configurable: true,
      enumerable: true,
      get() {
        serializerGetterCalls += 1;
        return "unsafe";
      },
    });
    const safeSerializedFallback = contract.serializeSteamWindows4090LabReadiness(
      hostileSerializedResult,
    );
    assert.equal(serializerGetterCalls, 0);
    assert.match(safeSerializedFallback, /source_contract_mismatch/u);
    assert.doesNotMatch(safeSerializedFallback, /unsafe/u);

    const prototypeSource = cloneSources(sources);
    Object.setPrototypeOf(prototypeSource.referencePreparation, { hostile: true });
    assertInvalid(
      contract.deriveSteamWindows4090LabReadiness(prototypeSource, null),
      "source_contract_mismatch",
      "custom prototype",
    );
    const symbolSource = cloneSources(sources);
    Object.defineProperty(symbolSource.referencePreparation, Symbol("secret"), {
      enumerable: true,
      value: "hidden",
    });
    assertInvalid(
      contract.deriveSteamWindows4090LabReadiness(symbolSource, null),
      "source_contract_mismatch",
      "symbol property",
    );
    const holeSource = cloneSources(sources);
    const p19Shots = array(record(holeSource.referencePreparation).shots);
    delete p19Shots[0];
    assertInvalid(
      contract.deriveSteamWindows4090LabReadiness(holeSource, null),
      "source_contract_mismatch",
      "array hole",
    );

    const purePath = fileURLToPath(
      new URL("../lib/steam/windows4090LabReadiness.ts", import.meta.url),
    );
    const serverPath = fileURLToPath(
      new URL("../lib/steam/windows4090LabReadinessServer.ts", import.meta.url),
    );
    const [pureSource, serverSource] = await Promise.all([
      readFile(purePath, "utf8"),
      readFile(serverPath, "utf8"),
    ]);
    for (const [label, source] of [
      ["pure", pureSource],
      ["server", serverSource],
    ] as const) {
      for (const pattern of [
        /node:(?:http|https|net|tls|dgram|dns)/u,
        /\bundici\b/u,
        /\bfetch\s*\(/u,
        /process\.env/u,
        /generation-jobs/u,
        /gpu-coordinator/u,
        /providers\/comfyui/u,
        /project-assets/u,
        /video-assets/u,
        /from\s+["'][^"']*(?:connector|gpu-coordinator)/iu,
        /\b(?:submit|enqueue|upload|publish)\w*\s*\(/u,
        /node:fs(?:\/promises)?/u,
        /\b(?:writeFile|mkdir|rename|rm|unlink)\s*\(/u,
      ]) {
        assert.doesNotMatch(source, pattern, `${label} static zero-side-effect gate`);
      }
    }
    assert.doesNotMatch(serverSource, /launchCueReviewPreviewBundleServer/u);
    assert.doesNotMatch(pureSource, /productionSpec|ubuntu_3090_lab_preview_v1/u);
    assert.equal(JSON.stringify(sources), rawSourceBefore, "authority sources remain unchanged");
    assert.equal(fetchCalls, 0);
    process.stdout.write(
      `steam Windows 4090 LAB readiness tests passed (current=BLOCKED; ceiling=FOUNDER_AUTHORIZATION_REQUIRED; shot=VG11-SHOT-04; refs=4; packet=${currentPacket.packetFingerprint}; network=0; writes=0)\n`,
    );
  } finally {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      writable: true,
      value: originalFetch,
    });
  }
}
