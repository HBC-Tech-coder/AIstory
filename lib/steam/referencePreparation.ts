export const STEAM_REFERENCE_PREPARATION_SCHEMA =
  "aistory-steam-reference-local-integrity";
export const STEAM_REFERENCE_PREPARATION_SCHEMA_VERSION = 1 as const;
export const STEAM_REFERENCE_PREPARATION_MODE = "local_verify_only" as const;

export const STEAM_REFERENCE_PREPARATION_AUTHORITY = Object.freeze({
  caseId: "virtual-girlfriend-20260727",
  releaseVersion: "v1.1",
  assetManifest: Object.freeze({
    schemaVersion: 1 as const,
    bytes: 8_256,
    sha256: "b3232a6a9da08bd103c8005aa0569a2412c558d197c6626f762d60d6c23798c0",
  }),
  videoPrompts: Object.freeze({
    schemaVersion: 1 as const,
    bytes: 56_726,
    sha256: "94089ac020424b1b9f425777814820d5626e2d3e514105f9350f82b1ca0f77c6",
  }),
} as const);

export const STEAM_REFERENCE_PREPARATION_TARGETS = Object.freeze([
  Object.freeze({
    nodeId: "vg11_wake_choice",
    shotId: "VG11-SHOT-02",
    sourceFrameAssetId: "vg11-kf-wake",
  }),
  Object.freeze({
    nodeId: "vg11_breakfast_choice",
    shotId: "VG11-SHOT-04",
    sourceFrameAssetId: "vg11-kf-breakfast",
  }),
  Object.freeze({
    nodeId: "vg11_wake_pull",
    shotId: "VG11-SHOT-05",
    sourceFrameAssetId: "vg11-kf-pull-up",
  }),
] as const);

export const STEAM_REFERENCE_PREPARATION_REFERENCE_ROLES = Object.freeze([
  Object.freeze({
    role: "identity_face",
    referenceId: "R1_FACE",
    assetId: "vg11-char-face-reference",
    kind: "character_base",
  }),
  Object.freeze({
    role: "home_outfit",
    referenceId: "R2_HOME_OUTFIT",
    assetId: "vg11-char-home-outfit-reference",
    kind: "outfit_sheet",
  }),
  Object.freeze({
    role: "expressions",
    referenceId: "R4_EXPRESSIONS",
    assetId: "vg11-char-expression-reference",
    kind: "expression_sheet",
  }),
] as const);

export const STEAM_REFERENCE_PREPARATION_ROLE_ORDER = Object.freeze([
  "source_frame",
  "identity_face",
  "home_outfit",
  "expressions",
] as const);

export const STEAM_REFERENCE_PREPARATION_PNG_POLICY = Object.freeze({
  mediaType: "image/png",
  width: 1_672,
  height: 941,
  bitDepth: 8,
  colorType: 2,
  compressionMethod: 0,
  filterMethod: 0,
  interlaceMethod: 0,
} as const);

export const STEAM_REFERENCE_PREPARATION_LIMITS = Object.freeze({
  sourceManifestBytes: 128 * 1024,
  assetBytes: 4 * 1024 * 1024,
  assetCount: 6,
  bindingCount: 12,
  shotCount: 3,
} as const);

export type SteamReferencePreparationRole =
  (typeof STEAM_REFERENCE_PREPARATION_ROLE_ORDER)[number];

export type SteamReferencePreparationFailureCode =
  | "authority_invalid"
  | "authority_case_mismatch"
  | "authority_version_mismatch"
  | "target_shot_missing"
  | "target_shot_duplicate"
  | "target_shot_mismatch"
  | "reference_binding_missing"
  | "reference_binding_duplicate"
  | "reference_binding_mismatch"
  | "asset_missing"
  | "asset_duplicate"
  | "asset_manifest_mismatch"
  | "asset_status_invalid"
  | "asset_release_policy_invalid"
  | "asset_kind_invalid"
  | "local_asset_missing"
  | "local_asset_link_forbidden"
  | "local_asset_not_regular"
  | "local_asset_outside_root"
  | "local_asset_limit_exceeded"
  | "local_asset_bytes_mismatch"
  | "local_asset_sha256_mismatch"
  | "local_asset_png_invalid"
  | "local_verification_unavailable";

export type SteamReferencePreparationBlockerCode =
  | "source_reference_not_prepared"
  | SteamReferencePreparationFailureCode;

export type SteamReferencePreparationInput = {
  authority: {
    caseId: string;
    releaseVersion: string;
  };
  sourceManifests: {
    assetManifest: {
      schemaVersion: number;
      bytes: number;
      sha256: string;
    };
    videoPrompts: {
      schemaVersion: number;
      bytes: number;
      sha256: string;
    };
  };
  shots: Array<{
    nodeId: string;
    shotId: string;
    sceneId: string;
    episodeId: string;
    durationSeconds: number;
    releasePolicy: string;
    sourceFrameAssetId: string;
    referenceIds: string[];
  }>;
  assets: Array<{
    assetId: string;
    basename: string;
    manifestBasename: string;
    kind: string;
    sceneId: string | null;
    status: string;
    releasePolicy: string;
    bytes: number;
    sha256: string;
    local: {
      bytes: number;
      sha256: string;
      mediaType: string;
      width: number;
      height: number;
      bitDepth: number;
      colorType: number;
      compressionMethod: number;
      filterMethod: number;
      interlaceMethod: number;
      localIntegrity: string;
    };
  }>;
  bindings: Array<{
    nodeId: string;
    shotId: string;
    role: string;
    referenceId: string | null;
    assetId: string;
  }>;
};

export type SteamReferencePreparationAsset = {
  assetId: string;
  kind: "keyframe" | "character_base" | "outfit_sheet" | "expression_sheet";
  sha256: string;
  bytes: number;
  mediaType: "image/png";
  media: {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number;
    compressionMethod: number;
    filterMethod: number;
    interlaceMethod: number;
  };
  localIntegrity: "verified";
};

export type SteamReferencePreparationBinding = {
  role: SteamReferencePreparationRole;
  referenceId: string | null;
  assetId: string;
  sha256: string;
  bytes: number;
  mediaType: "image/png";
  localIntegrity: "verified";
};

export type SteamReferencePreparationShot = {
  nodeId: string;
  shotId: string;
  sceneId: string;
  episodeId: string;
  bindings: SteamReferencePreparationBinding[];
};

type SteamReferencePreparationCommon = {
  schema: typeof STEAM_REFERENCE_PREPARATION_SCHEMA;
  schemaVersion: typeof STEAM_REFERENCE_PREPARATION_SCHEMA_VERSION;
  mode: typeof STEAM_REFERENCE_PREPARATION_MODE;
  authority: {
    caseId: typeof STEAM_REFERENCE_PREPARATION_AUTHORITY.caseId;
    releaseVersion: typeof STEAM_REFERENCE_PREPARATION_AUTHORITY.releaseVersion;
  };
  executionAllowed: false;
  providerPreparation: "NOT_ATTEMPTED";
  providerContacted: false;
  providerReferenceHandlesIssued: 0;
  gpuProbed: false;
  networkCalls: 0;
  writesPerformed: 0;
  releaseGate: {
    satisfied: false;
  };
};

export type SteamReferencePreparationVerifiedManifest =
  SteamReferencePreparationCommon & {
    status: "LOCAL_VERIFIED_ONLY";
    manifestFingerprint: string;
    sourceManifests: SteamReferencePreparationInput["sourceManifests"];
    summary: {
      shots: 3;
      bindings: 12;
      uniqueAssets: 6;
      localVerifiedAssets: 6;
    };
    shots: SteamReferencePreparationShot[];
    assets: SteamReferencePreparationAsset[];
    blockerCodes: ["source_reference_not_prepared"];
  };

export type SteamReferencePreparationBlockedManifest =
  SteamReferencePreparationCommon & {
    status: "BLOCKED";
    manifestFingerprint: null;
    sourceManifests: null;
    summary: {
      shots: 0;
      bindings: 0;
      uniqueAssets: 0;
      localVerifiedAssets: 0;
    };
    shots: [];
    assets: [];
    blockerCodes: [
      "source_reference_not_prepared",
      SteamReferencePreparationFailureCode,
    ];
  };

export type SteamReferencePreparationManifest =
  | SteamReferencePreparationVerifiedManifest
  | SteamReferencePreparationBlockedManifest;

type HashFunction = (canonicalValue: string) => string;
type DataRecord = Record<string, unknown>;

const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SAFE_PNG_BASENAME = /^[a-z0-9][a-z0-9._-]{0,151}\.png$/;
const INTEGER_KEY = /^(?:0|[1-9][0-9]*)$/;

const ROOT_KEYS = ["authority", "sourceManifests", "shots", "assets", "bindings"];
const AUTHORITY_KEYS = ["caseId", "releaseVersion"];
const SOURCE_MANIFESTS_KEYS = ["assetManifest", "videoPrompts"];
const SOURCE_MANIFEST_KEYS = ["schemaVersion", "bytes", "sha256"];
const SHOT_KEYS = [
  "nodeId",
  "shotId",
  "sceneId",
  "episodeId",
  "durationSeconds",
  "releasePolicy",
  "sourceFrameAssetId",
  "referenceIds",
];
const ASSET_KEYS = [
  "assetId",
  "basename",
  "manifestBasename",
  "kind",
  "sceneId",
  "status",
  "releasePolicy",
  "bytes",
  "sha256",
  "local",
];
const LOCAL_KEYS = [
  "bytes",
  "sha256",
  "mediaType",
  "width",
  "height",
  "bitDepth",
  "colorType",
  "compressionMethod",
  "filterMethod",
  "interlaceMethod",
  "localIntegrity",
];
const BINDING_KEYS = ["nodeId", "shotId", "role", "referenceId", "assetId"];

class ContractFailure {
  readonly code: SteamReferencePreparationFailureCode;

  constructor(code: SteamReferencePreparationFailureCode) {
    this.code = code;
  }
}

function fail(code: SteamReferencePreparationFailureCode): never {
  throw new ContractFailure(code);
}

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: SteamReferencePreparationFailureCode,
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(code);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return fail(code);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.length ||
    ownKeys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return fail(code);
  }
  const output: DataRecord = Object.create(null) as DataRecord;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return fail(code);
    }
    output[key] = descriptor.value;
  }
  return output;
}

function exactDataArray(
  value: unknown,
  code: SteamReferencePreparationFailureCode,
): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return fail(code);
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) return fail(code);
  const stringKeys = ownKeys as string[];
  if (
    !stringKeys.includes("length") ||
    stringKeys.some(
      (key) => key !== "length" && (!INTEGER_KEY.test(key) || Number(key) >= value.length),
    ) ||
    stringKeys.length !== value.length + 1
  ) {
    return fail(code);
  }
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
      return fail(code);
    }
    output.push(descriptor.value);
  }
  return output;
}

function safeString(value: unknown, code: SteamReferencePreparationFailureCode): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) return fail(code);
  return value;
}

function safeHash(value: unknown, code: SteamReferencePreparationFailureCode): string {
  if (typeof value !== "string" || !SHA256.test(value)) return fail(code);
  return value;
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  code: SteamReferencePreparationFailureCode,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail(code);
  }
  return value as number;
}

function safeBasename(
  value: unknown,
  code: SteamReferencePreparationFailureCode,
): string {
  if (typeof value !== "string" || !SAFE_PNG_BASENAME.test(value)) return fail(code);
  if (
    value.includes("/") ||
    value.includes("\\") ||
    value.includes(":") ||
    value === "." ||
    value === ".."
  ) {
    return fail(code);
  }
  return value;
}

function canonical(value: unknown, stack = new Set<object>()): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
      throw new Error("canonical_value_invalid");
    }
    return String(value);
  }
  if (typeof value !== "object") throw new Error("canonical_value_invalid");
  if (stack.has(value)) throw new Error("canonical_value_invalid");
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => canonical(item, stack)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical_value_invalid");
    }
    const record = value as DataRecord;
    const keys = Reflect.ownKeys(record);
    if (keys.some((key) => typeof key !== "string")) {
      throw new Error("canonical_value_invalid");
    }
    return `{${(keys as string[])
      .sort()
      .map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(record, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error("canonical_value_invalid");
        }
        return `${JSON.stringify(key)}:${canonical(descriptor.value, stack)}`;
      })
      .join(",")}}`;
  } finally {
    stack.delete(value);
  }
}

function fingerprint(sha256: HashFunction, value: unknown): string {
  const result = sha256(canonical(value));
  if (!SHA256.test(result)) throw new Error("sha256_provider_invalid");
  return result;
}

function common(): SteamReferencePreparationCommon {
  return {
    schema: STEAM_REFERENCE_PREPARATION_SCHEMA,
    schemaVersion: STEAM_REFERENCE_PREPARATION_SCHEMA_VERSION,
    mode: STEAM_REFERENCE_PREPARATION_MODE,
    authority: {
      caseId: STEAM_REFERENCE_PREPARATION_AUTHORITY.caseId,
      releaseVersion: STEAM_REFERENCE_PREPARATION_AUTHORITY.releaseVersion,
    },
    executionAllowed: false,
    providerPreparation: "NOT_ATTEMPTED",
    providerContacted: false,
    providerReferenceHandlesIssued: 0,
    gpuProbed: false,
    networkCalls: 0,
    writesPerformed: 0,
    releaseGate: { satisfied: false },
  };
}

export function blockedSteamReferencePreparation(
  code: SteamReferencePreparationFailureCode,
): SteamReferencePreparationBlockedManifest {
  return {
    ...common(),
    status: "BLOCKED",
    manifestFingerprint: null,
    sourceManifests: null,
    summary: { shots: 0, bindings: 0, uniqueAssets: 0, localVerifiedAssets: 0 },
    shots: [],
    assets: [],
    blockerCodes: ["source_reference_not_prepared", code],
  };
}

function roleIndex(role: SteamReferencePreparationRole): number {
  return STEAM_REFERENCE_PREPARATION_ROLE_ORDER.indexOf(role);
}

function targetIndex(nodeId: string): number {
  return STEAM_REFERENCE_PREPARATION_TARGETS.findIndex((target) => target.nodeId === nodeId);
}

export function deriveSteamReferencePreparation(
  rawInput: unknown,
  sha256: HashFunction,
): SteamReferencePreparationManifest {
  try {
    const root = exactDataRecord(rawInput, ROOT_KEYS, "authority_invalid");
    const rawAuthority = exactDataRecord(
      root.authority,
      AUTHORITY_KEYS,
      "authority_invalid",
    );
    if (rawAuthority.caseId !== STEAM_REFERENCE_PREPARATION_AUTHORITY.caseId) {
      return fail("authority_case_mismatch");
    }
    if (rawAuthority.releaseVersion !== STEAM_REFERENCE_PREPARATION_AUTHORITY.releaseVersion) {
      return fail("authority_version_mismatch");
    }

    const rawPins = exactDataRecord(
      root.sourceManifests,
      SOURCE_MANIFESTS_KEYS,
      "authority_invalid",
    );
    const parsePin = (
      value: unknown,
      expected: (typeof STEAM_REFERENCE_PREPARATION_AUTHORITY)[
        | "assetManifest"
        | "videoPrompts"],
    ) => {
      const pin = exactDataRecord(value, SOURCE_MANIFEST_KEYS, "authority_invalid");
      const schemaVersion = safeInteger(pin.schemaVersion, 1, 1, "authority_invalid");
      const bytes = safeInteger(
        pin.bytes,
        1,
        STEAM_REFERENCE_PREPARATION_LIMITS.sourceManifestBytes,
        "authority_invalid",
      );
      const sha = safeHash(pin.sha256, "authority_invalid");
      if (
        schemaVersion !== expected.schemaVersion ||
        bytes !== expected.bytes ||
        sha !== expected.sha256
      ) {
        return fail("authority_invalid");
      }
      return { schemaVersion, bytes, sha256: sha };
    };
    const sourceManifests = {
      assetManifest: parsePin(
        rawPins.assetManifest,
        STEAM_REFERENCE_PREPARATION_AUTHORITY.assetManifest,
      ),
      videoPrompts: parsePin(
        rawPins.videoPrompts,
        STEAM_REFERENCE_PREPARATION_AUTHORITY.videoPrompts,
      ),
    };

    const rawShots = exactDataArray(root.shots, "target_shot_mismatch");
    const shots = rawShots.map((value) => {
      const shot = exactDataRecord(value, SHOT_KEYS, "target_shot_mismatch");
      const referenceIds = exactDataArray(
        shot.referenceIds,
        "reference_binding_mismatch",
      ).map((referenceId) =>
        safeString(referenceId, "reference_binding_mismatch"),
      );
      return {
        nodeId: safeString(shot.nodeId, "target_shot_mismatch"),
        shotId: safeString(shot.shotId, "target_shot_mismatch"),
        sceneId: safeString(shot.sceneId, "target_shot_mismatch"),
        episodeId: safeString(shot.episodeId, "target_shot_mismatch"),
        durationSeconds: safeInteger(
          shot.durationSeconds,
          1,
          600,
          "target_shot_mismatch",
        ),
        releasePolicy: safeString(shot.releasePolicy, "target_shot_mismatch"),
        sourceFrameAssetId: safeString(
          shot.sourceFrameAssetId,
          "target_shot_mismatch",
        ),
        referenceIds,
      };
    });
    if (shots.length !== STEAM_REFERENCE_PREPARATION_LIMITS.shotCount) {
      return fail("target_shot_missing");
    }
    const shotByNode = new Map<string, (typeof shots)[number]>();
    for (const shot of shots) {
      if (shotByNode.has(shot.nodeId)) return fail("target_shot_duplicate");
      shotByNode.set(shot.nodeId, shot);
    }
    const expectedReferenceIds = STEAM_REFERENCE_PREPARATION_REFERENCE_ROLES.map(
      (reference) => reference.referenceId,
    ).sort();
    for (const target of STEAM_REFERENCE_PREPARATION_TARGETS) {
      const shot = shotByNode.get(target.nodeId);
      if (!shot) return fail("target_shot_missing");
      if (
        shot.shotId !== target.shotId ||
        shot.sourceFrameAssetId !== target.sourceFrameAssetId ||
        shot.releasePolicy !== "public" ||
        shot.durationSeconds !== 30
      ) {
        return fail("target_shot_mismatch");
      }
      if (new Set(shot.referenceIds).size !== shot.referenceIds.length) {
        return fail("reference_binding_duplicate");
      }
      if (
        shot.referenceIds.length !== expectedReferenceIds.length ||
        [...shot.referenceIds].sort().some((value, index) => value !== expectedReferenceIds[index])
      ) {
        return fail("reference_binding_mismatch");
      }
    }

    const rawAssets = exactDataArray(root.assets, "asset_manifest_mismatch");
    const assets = rawAssets.map((value) => {
      const asset = exactDataRecord(value, ASSET_KEYS, "asset_manifest_mismatch");
      const local = exactDataRecord(asset.local, LOCAL_KEYS, "local_asset_png_invalid");
      const sceneId =
        asset.sceneId === null
          ? null
          : safeString(asset.sceneId, "asset_manifest_mismatch");
      return {
        assetId: safeString(asset.assetId, "asset_manifest_mismatch"),
        basename: safeBasename(asset.basename, "asset_manifest_mismatch"),
        manifestBasename: safeBasename(
          asset.manifestBasename,
          "asset_manifest_mismatch",
        ),
        kind: safeString(asset.kind, "asset_kind_invalid"),
        sceneId,
        status: safeString(asset.status, "asset_status_invalid"),
        releasePolicy: safeString(
          asset.releasePolicy,
          "asset_release_policy_invalid",
        ),
        bytes: safeInteger(
          asset.bytes,
          1,
          STEAM_REFERENCE_PREPARATION_LIMITS.assetBytes,
          "asset_manifest_mismatch",
        ),
        sha256: safeHash(asset.sha256, "asset_manifest_mismatch"),
        local: {
          bytes: safeInteger(
            local.bytes,
            1,
            STEAM_REFERENCE_PREPARATION_LIMITS.assetBytes,
            "local_asset_limit_exceeded",
          ),
          sha256: safeHash(local.sha256, "local_asset_sha256_mismatch"),
          mediaType: local.mediaType,
          width: local.width,
          height: local.height,
          bitDepth: local.bitDepth,
          colorType: local.colorType,
          compressionMethod: local.compressionMethod,
          filterMethod: local.filterMethod,
          interlaceMethod: local.interlaceMethod,
          localIntegrity: local.localIntegrity,
        },
      };
    });
    if (assets.length !== STEAM_REFERENCE_PREPARATION_LIMITS.assetCount) {
      return fail("asset_missing");
    }
    const assetById = new Map<string, (typeof assets)[number]>();
    for (const asset of assets) {
      if (assetById.has(asset.assetId)) return fail("asset_duplicate");
      assetById.set(asset.assetId, asset);
    }
    const expectedAssetIds = new Set<string>([
      ...STEAM_REFERENCE_PREPARATION_TARGETS.map((target) => target.sourceFrameAssetId),
      ...STEAM_REFERENCE_PREPARATION_REFERENCE_ROLES.map((reference) => reference.assetId),
    ]);
    if (
      assetById.size !== expectedAssetIds.size ||
      [...assetById.keys()].some((assetId) => !expectedAssetIds.has(assetId))
    ) {
      return fail("asset_manifest_mismatch");
    }
    for (const asset of assets) {
      if (
        asset.basename !== `${asset.assetId}.png` ||
        asset.manifestBasename !== asset.basename
      ) {
        return fail("asset_manifest_mismatch");
      }
      if (asset.status !== "generated") return fail("asset_status_invalid");
      if (asset.releasePolicy !== "public") return fail("asset_release_policy_invalid");
      const sourceTarget = STEAM_REFERENCE_PREPARATION_TARGETS.find(
        (target) => target.sourceFrameAssetId === asset.assetId,
      );
      const sharedReference = STEAM_REFERENCE_PREPARATION_REFERENCE_ROLES.find(
        (reference) => reference.assetId === asset.assetId,
      );
      const shot = sourceTarget ? shotByNode.get(sourceTarget.nodeId) : undefined;
      const expectedKind = sourceTarget ? "keyframe" : sharedReference?.kind;
      const expectedSceneId = sourceTarget ? shot?.sceneId : null;
      if (!expectedKind || asset.kind !== expectedKind) return fail("asset_kind_invalid");
      if (asset.sceneId !== expectedSceneId) return fail("asset_manifest_mismatch");
      if (asset.local.localIntegrity !== "verified") {
        return fail("local_verification_unavailable");
      }
      if (asset.local.bytes !== asset.bytes) return fail("local_asset_bytes_mismatch");
      if (asset.local.sha256 !== asset.sha256) return fail("local_asset_sha256_mismatch");
      const policy = STEAM_REFERENCE_PREPARATION_PNG_POLICY;
      if (
        asset.local.mediaType !== policy.mediaType ||
        asset.local.width !== policy.width ||
        asset.local.height !== policy.height ||
        asset.local.bitDepth !== policy.bitDepth ||
        asset.local.colorType !== policy.colorType ||
        asset.local.compressionMethod !== policy.compressionMethod ||
        asset.local.filterMethod !== policy.filterMethod ||
        asset.local.interlaceMethod !== policy.interlaceMethod
      ) {
        return fail("local_asset_png_invalid");
      }
    }

    const rawBindings = exactDataArray(root.bindings, "reference_binding_mismatch");
    const bindings = rawBindings.map((value) => {
      const binding = exactDataRecord(
        value,
        BINDING_KEYS,
        "reference_binding_mismatch",
      );
      const referenceId =
        binding.referenceId === null
          ? null
          : safeString(binding.referenceId, "reference_binding_mismatch");
      return {
        nodeId: safeString(binding.nodeId, "reference_binding_mismatch"),
        shotId: safeString(binding.shotId, "reference_binding_mismatch"),
        role: safeString(binding.role, "reference_binding_mismatch"),
        referenceId,
        assetId: safeString(binding.assetId, "reference_binding_mismatch"),
      };
    });
    if (bindings.length !== STEAM_REFERENCE_PREPARATION_LIMITS.bindingCount) {
      return fail("reference_binding_missing");
    }
    const bindingKeys = new Set<string>();
    for (const binding of bindings) {
      const key = `${binding.nodeId}\0${binding.role}`;
      if (bindingKeys.has(key)) return fail("reference_binding_duplicate");
      bindingKeys.add(key);
      const shot = shotByNode.get(binding.nodeId);
      const asset = assetById.get(binding.assetId);
      if (!shot || !asset || binding.shotId !== shot.shotId) {
        return fail("reference_binding_mismatch");
      }
      if (binding.role === "source_frame") {
        if (
          binding.referenceId !== null ||
          binding.assetId !== shot.sourceFrameAssetId
        ) {
          return fail("reference_binding_mismatch");
        }
      } else {
        const reference = STEAM_REFERENCE_PREPARATION_REFERENCE_ROLES.find(
          (candidate) => candidate.role === binding.role,
        );
        if (
          !reference ||
          binding.referenceId !== reference.referenceId ||
          binding.assetId !== reference.assetId
        ) {
          return fail("reference_binding_mismatch");
        }
      }
    }
    for (const target of STEAM_REFERENCE_PREPARATION_TARGETS) {
      for (const role of STEAM_REFERENCE_PREPARATION_ROLE_ORDER) {
        if (!bindingKeys.has(`${target.nodeId}\0${role}`)) {
          return fail("reference_binding_missing");
        }
      }
    }

    const publicAssets: SteamReferencePreparationAsset[] = [...assets]
      .sort((left, right) =>
        left.assetId < right.assetId ? -1 : left.assetId > right.assetId ? 1 : 0,
      )
      .map((asset) => ({
        assetId: asset.assetId,
        kind: asset.kind as SteamReferencePreparationAsset["kind"],
        sha256: asset.sha256,
        bytes: asset.bytes,
        mediaType: "image/png",
        media: {
          width: asset.local.width as number,
          height: asset.local.height as number,
          bitDepth: asset.local.bitDepth as number,
          colorType: asset.local.colorType as number,
          compressionMethod: asset.local.compressionMethod as number,
          filterMethod: asset.local.filterMethod as number,
          interlaceMethod: asset.local.interlaceMethod as number,
        },
        localIntegrity: "verified",
      }));
    const publicShots: SteamReferencePreparationShot[] = STEAM_REFERENCE_PREPARATION_TARGETS.map(
      (target) => {
        const shot = shotByNode.get(target.nodeId)!;
        return {
          nodeId: shot.nodeId,
          shotId: shot.shotId,
          sceneId: shot.sceneId,
          episodeId: shot.episodeId,
          bindings: bindings
            .filter((binding) => binding.nodeId === shot.nodeId)
            .sort(
              (left, right) =>
                roleIndex(left.role as SteamReferencePreparationRole) -
                roleIndex(right.role as SteamReferencePreparationRole),
            )
            .map((binding) => {
              const asset = assetById.get(binding.assetId)!;
              return {
                role: binding.role as SteamReferencePreparationRole,
                referenceId: binding.referenceId,
                assetId: binding.assetId,
                sha256: asset.sha256,
                bytes: asset.bytes,
                mediaType: "image/png" as const,
                localIntegrity: "verified" as const,
              };
            }),
        };
      },
    );
    publicShots.sort((left, right) => targetIndex(left.nodeId) - targetIndex(right.nodeId));

    const fingerprintValue = fingerprint(sha256, {
      schema: STEAM_REFERENCE_PREPARATION_SCHEMA,
      schemaVersion: STEAM_REFERENCE_PREPARATION_SCHEMA_VERSION,
      mode: STEAM_REFERENCE_PREPARATION_MODE,
      authority: {
        caseId: STEAM_REFERENCE_PREPARATION_AUTHORITY.caseId,
        releaseVersion: STEAM_REFERENCE_PREPARATION_AUTHORITY.releaseVersion,
      },
      sourceManifests,
      shots: publicShots,
      assets: publicAssets,
    });

    return {
      ...common(),
      status: "LOCAL_VERIFIED_ONLY",
      manifestFingerprint: fingerprintValue,
      sourceManifests,
      summary: { shots: 3, bindings: 12, uniqueAssets: 6, localVerifiedAssets: 6 },
      shots: publicShots,
      assets: publicAssets,
      blockerCodes: ["source_reference_not_prepared"],
    };
  } catch (error) {
    return blockedSteamReferencePreparation(
      error instanceof ContractFailure ? error.code : "local_verification_unavailable",
    );
  }
}

export function serializeSteamReferencePreparation(
  manifest: SteamReferencePreparationManifest,
): string {
  return `${canonical(manifest)}\n`;
}
