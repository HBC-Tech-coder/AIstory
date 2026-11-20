import "server-only";

import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { AdminActor } from "@/lib/admin/types";
import { getStoredGenerationJob } from "@/lib/generation-jobs/store";
import type { SceneVideoMedia } from "@infiplot/types";
import {
  getLocalVideoAssetRepository,
  type LocalVideoAssetRepository,
  type StoredVideoAsset,
  type VideoAssetAudit,
  type VideoAssetRepository,
  type VideoAssetStorageReference,
} from "./repository";
import {
  assertVideoObjectEtag,
  assertVideoObjectMetadata,
  buildAliyunOssVideoObjectKey,
  type VideoObjectStorageTransport,
} from "./objectStorage";
import {
  asVideoAssetUnavailableError,
  VideoAssetMetadataWriteRejectedError,
  VideoAssetUnavailableError,
} from "./errors";
import type {
  VideoAssetCapabilityStatus,
  VideoAssetDto,
  VideoAssetReleasePolicy,
  VideoProbeResult,
  VideoSubtitleCue,
} from "./types";
import {
  orientationForVideo,
  parseWebVtt,
  validateSubtitleCues,
  validateVideoBytes,
  validateContainerCodecCombination,
  validateVideoProbe,
} from "./validation";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_UPLOAD_BYTES = 128 * 1024 * 1024;

export type ProductionVideoAssetAdapter = {
  tenantId: string;
  repository: VideoAssetRepository;
  objectStorage: VideoObjectStorageTransport;
  probe: (input: {
    bytes: Uint8Array;
    contentHash: string;
    contentType: "video/mp4" | "video/webm";
  }) => Promise<VideoProbeResult>;
};

export type VideoAssetServiceOptions = {
  repository?: LocalVideoAssetRepository;
  probe?: (file: string) => Promise<VideoProbeResult>;
  production?: ProductionVideoAssetAdapter;
  now?: () => Date;
  randomId?: () => string;
  allowTestAdapter?: boolean;
  maxUploadBytes?: number;
};

type ResolvedVideoAssetAdapter =
  | {
      kind: "local";
      tenantId: string;
      repository: LocalVideoAssetRepository;
      probe: (file: string) => Promise<VideoProbeResult>;
    }
  | {
      kind: "object";
      tenantId: string;
      repository: VideoAssetRepository;
      objectStorage: VideoObjectStorageTransport;
      probe: ProductionVideoAssetAdapter["probe"];
    };

export type VideoAssetContent =
  | {
      kind: "local";
      asset: StoredVideoAsset;
      file: string;
    }
  | {
      kind: "object";
      asset: StoredVideoAsset;
      objectKey: string;
      transport: VideoObjectStorageTransport;
    };

export type VideoAssetUploadInput = {
  bytes: Uint8Array;
  declaredType: string;
  title: string;
  projectId?: number;
  storyId?: string;
  nodeId?: string;
  releasePolicy?: VideoAssetReleasePolicy;
  cues?: unknown;
  webVtt?: string;
  idempotencyKey: string;
  requestId: string;
  /** Server-owned provenance; API upload callers never set these fields. */
  source?: "upload" | "generation_job";
  generation?: StoredVideoAsset["generation"];
};

export type VideoAssetMutationInput = {
  action:
    | "submit_review"
    | "approve"
    | "offline"
    | "restore_draft"
    | "bind";
  idempotencyKey: string;
  requestId: string;
  reason: string;
  projectId?: number;
  storyId?: string;
  nodeId?: string;
  releasePolicy?: VideoAssetReleasePolicy;
  title?: string;
};

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

export function videoAssetMaxUploadBytes(): number {
  return boundedInteger(
    process.env.AISTORY_VIDEO_MAX_UPLOAD_BYTES,
    DEFAULT_MAX_UPLOAD_BYTES,
    1024 * 1024,
    1024 * 1024 * 1024,
  );
}

function cleanTenantId(value: string): string {
  const tenantId = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(tenantId)) {
    throw new Error("生产视频资产租户未配置。");
  }
  return tenantId;
}

function resolveLocalAdapter(
  options: VideoAssetServiceOptions,
): Extract<ResolvedVideoAssetAdapter, { kind: "local" }> {
  if (
    !options.allowTestAdapter &&
    process.env.AISTORY_VIDEO_ASSET_ADAPTER !== "local_development"
  ) {
    throw new VideoAssetUnavailableError("本地视频资产适配器未启用。");
  }
  const repository = options.repository ?? getLocalVideoAssetRepository();
  if (repository.source !== "local_development") {
    throw new Error("本地视频资产元数据仓库不合法。");
  }
  return {
    kind: "local",
    tenantId: repository.tenantId,
    repository,
    probe: options.probe ?? runFfprobe,
  };
}

function resolveProductionAdapter(
  options: VideoAssetServiceOptions,
): Extract<ResolvedVideoAssetAdapter, { kind: "object" }> {
  if (
    !options.allowTestAdapter &&
    process.env.AISTORY_VIDEO_ASSET_ADAPTER !== "aliyun_oss"
  ) {
    throw new VideoAssetUnavailableError(
      "生产视频资产对象存储适配器尚未配置。",
    );
  }
  const production = options.production;
  if (
    !production ||
    !production.repository ||
    production.repository.source !== "production_database" ||
    !production.objectStorage ||
    production.objectStorage.provider !== "aliyun_oss" ||
    typeof production.probe !== "function"
  ) {
    throw new VideoAssetUnavailableError(
      "生产视频资产元数据仓库、对象存储或媒体探测器尚未配置。",
    );
  }
  let tenantId: string;
  try {
    tenantId = cleanTenantId(production.tenantId);
  } catch {
    throw new VideoAssetUnavailableError("生产视频资产租户尚未配置。");
  }
  if (production.repository.tenantId !== tenantId) {
    throw new VideoAssetUnavailableError(
      "生产视频资产租户与元数据仓库不一致。",
    );
  }
  return {
    kind: "object",
    tenantId,
    repository: production.repository,
    objectStorage: production.objectStorage,
    probe: production.probe,
  };
}

function resolveAdminAdapter(
  actor: AdminActor,
  options: VideoAssetServiceOptions,
): ResolvedVideoAssetAdapter {
  return actor.mode === "production"
    ? resolveProductionAdapter(options)
    : resolveLocalAdapter(options);
}

function resolvePublicAdapter(
  options: VideoAssetServiceOptions,
): ResolvedVideoAssetAdapter | null {
  const configuredAdapter = process.env.AISTORY_VIDEO_ASSET_ADAPTER;
  if (
    options.production ||
    configuredAdapter === "aliyun_oss"
  ) {
    return resolveProductionAdapter(options);
  }
  if (
    process.env.NODE_ENV === "production" &&
    configuredAdapter !== "local_development" &&
    !options.allowTestAdapter
  ) {
    throw new VideoAssetUnavailableError(
      "生产视频资产服务尚未配置。",
    );
  }
  try {
    return resolveLocalAdapter(options);
  } catch {
    return null;
  }
}

async function callVideoAssetRepository<T>(
  adapter: ResolvedVideoAssetAdapter,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (adapter.kind === "object") {
      throw asVideoAssetUnavailableError(error);
    }
    throw error;
  }
}

function cleanText(
  value: unknown,
  label: string,
  maxLength: number,
  required = false,
): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${label}不能为空。`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${label}格式不合法。`);
  const text = value.trim();
  if (
    !text ||
    text.length > maxLength ||
    /[\u0000-\u001f<>\\]/.test(text) ||
    text.includes("..")
  ) {
    throw new Error(`${label}包含不安全内容。`);
  }
  return text;
}

function cleanProjectId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("项目 ID 不合法。");
  }
  return number;
}

function cleanIdempotencyKey(value: string): string {
  const key = value.trim();
  if (
    key.length < 16 ||
    key.length > 160 ||
    !/^[A-Za-z0-9:._-]+$/.test(key)
  ) {
    throw new Error("幂等键不合法。");
  }
  return key;
}

function cleanAssetId(value: unknown): string {
  const id = cleanText(value, "视频资产 ID", 120, true)!;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(id)) {
    throw new Error("视频资产 ID 不合法。");
  }
  return id;
}

function extensionFor(contentType: "video/mp4" | "video/webm"): string {
  return contentType === "video/mp4" ? ".mp4" : ".webm";
}

function requestFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

function asDto(asset: StoredVideoAsset): VideoAssetDto {
  return {
    id: asset.id,
    contentHash: asset.contentHash,
    contentType: asset.contentType,
    bytes: asset.bytes,
    durationMs: asset.durationMs,
    width: asset.width,
    height: asset.height,
    videoCodec: asset.videoCodec,
    ...(asset.audioCodec ? { audioCodec: asset.audioCodec } : {}),
    hasAudio: asset.hasAudio,
    orientation: orientationForVideo(asset.width, asset.height),
    status: asset.status,
    releasePolicy: asset.releasePolicy,
    ...(asset.projectId ? { projectId: asset.projectId } : {}),
    ...(asset.storyId ? { storyId: asset.storyId } : {}),
    ...(asset.nodeId ? { nodeId: asset.nodeId } : {}),
    title: asset.title,
    subtitles: structuredClone(asset.subtitles),
    source: asset.source,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    ...(asset.reviewNote ? { reviewNote: asset.reviewNote } : {}),
    previewUrl: `/api/admin/video-assets/${encodeURIComponent(asset.id)}/content`,
    ...(asset.status === "publishable" && asset.releasePolicy === "public"
      ? {
          publicUrl: `/api/video-assets/${encodeURIComponent(asset.id)}/content`,
        }
      : {}),
  };
}

function audit(
  actor: AdminActor,
  assetId: string,
  action: string,
  reason: string,
  requestId: string,
  now: Date,
): VideoAssetAudit {
  return {
    id: randomUUID(),
    actorId: actor.userId,
    action,
    assetId,
    reason: reason.slice(0, 500),
    requestId,
    createdAt: now.toISOString(),
  };
}

async function runFfprobe(file: string): Promise<VideoProbeResult> {
  const executable = process.env.AISTORY_VIDEO_FFPROBE_PATH?.trim();
  if (!executable || !path.isAbsolute(executable)) {
    throw new Error("视频探测器未配置。");
  }
  const result = await execFileAsync(
    executable,
    [
      "-v",
      "error",
      "-print_format",
      "json",
      "-show_streams",
      "-show_format",
      file,
    ],
    { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true },
  );
  const parsed = JSON.parse(result.stdout) as {
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
    }>;
    format?: { duration?: string };
  };
  const video = parsed.streams?.find((stream) => stream.codec_type === "video");
  const audio = parsed.streams?.find((stream) => stream.codec_type === "audio");
  const durationSeconds = Number(
    video?.duration ?? parsed.format?.duration ?? 0,
  );
  if (!video?.codec_name) throw new Error("视频轨道不存在。");
  return validateVideoProbe({
    durationMs: Math.round(durationSeconds * 1000),
    width: Number(video.width),
    height: Number(video.height),
    videoCodec: video.codec_name,
    ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}),
    hasAudio: !!audio,
  });
}

async function materializeContentAddressedVideo(
  repository: LocalVideoAssetRepository,
  bytes: Uint8Array,
  contentHash: string,
  contentType: "video/mp4" | "video/webm",
  probe: (file: string) => Promise<VideoProbeResult>,
): Promise<{ storage: VideoAssetStorageReference; probe: VideoProbeResult }> {
  await mkdir(repository.mediaDir(), { recursive: true });
  const extension = extensionFor(contentType);
  const storageFile = `${contentHash}${extension}`;
  const target = path.join(repository.mediaDir(), storageFile);
  const temp = path.join(
    repository.mediaDir(),
    `.${contentHash}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  try {
    await writeFile(temp, bytes, { flag: "wx" });
    const metadata = validateContainerCodecCombination(
      contentType,
      await probe(temp),
    );
    try {
      await rename(temp, target);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM") throw error;
      const existing = await stat(target);
      if (existing.size !== bytes.byteLength) {
        throw new Error("视频内容寻址文件冲突。");
      }
      await unlink(temp).catch(() => undefined);
    }
    return {
      storage: { kind: "local", fileName: storageFile },
      probe: metadata,
    };
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function assertStoredVideoAssetRecord(asset: StoredVideoAsset): void {
  if (
    !asset ||
    typeof asset.id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(asset.id) ||
    typeof asset.tenantId !== "string" ||
    !asset.tenantId ||
    !asset.storage ||
    typeof asset.storage !== "object" ||
    !/^[a-f0-9]{64}$/i.test(asset.contentHash) ||
    (asset.contentType !== "video/mp4" &&
      asset.contentType !== "video/webm") ||
    !Number.isSafeInteger(asset.bytes) ||
    asset.bytes <= 0 ||
    !["draft", "review_pending", "publishable", "offline"].includes(
      asset.status,
    ) ||
    !["public", "internal", "enterprise"].includes(asset.releasePolicy) ||
    !["upload", "generation_job"].includes(asset.source) ||
    !Number.isFinite(Date.parse(asset.createdAt)) ||
    !Number.isFinite(Date.parse(asset.updatedAt))
  ) {
    throw new Error("视频资产元数据记录不合法。");
  }
  if (
    asset.revision !== undefined
    && (!Number.isSafeInteger(asset.revision) || asset.revision <= 0)
  ) {
    throw new Error("Invalid video asset metadata revision.");
  }
  const projectId = cleanProjectId(asset.projectId);
  if (projectId !== asset.projectId) {
    throw new Error("视频资产项目绑定记录不合法。");
  }
  if (cleanText(asset.title, "标题", 160, true) !== asset.title) {
    throw new Error("视频资产标题记录不合法。");
  }
  for (const [value, label] of [
    [asset.storyId, "作品 ID"],
    [asset.nodeId, "剧情节点 ID"],
  ] as const) {
    if (value !== undefined && cleanText(value, label, 120) !== value) {
      throw new Error("视频资产绑定记录不合法。");
    }
  }
  const checkedProbe = validateContainerCodecCombination(
    asset.contentType,
    asset,
  );
  if (
    checkedProbe.durationMs !== asset.durationMs ||
    checkedProbe.width !== asset.width ||
    checkedProbe.height !== asset.height ||
    checkedProbe.videoCodec !== asset.videoCodec ||
    checkedProbe.audioCodec !== asset.audioCodec ||
    checkedProbe.hasAudio !== asset.hasAudio
  ) {
    throw new Error("视频资产媒体探测记录不合法。");
  }
  validateSubtitleCues(asset.subtitles, asset.durationMs);
  if (
    asset.status === "publishable" &&
    (!asset.projectId || !asset.storyId || !asset.nodeId)
  ) {
    throw new Error("可发布视频资产缺少完整绑定记录。");
  }
}

function assertAssetMatchesAdapterUnchecked(
  adapter: ResolvedVideoAssetAdapter,
  asset: StoredVideoAsset,
): void {
  assertStoredVideoAssetRecord(asset);
  if (asset.tenantId !== adapter.tenantId) {
    throw new Error("视频资产不属于当前租户。");
  }
  if (adapter.kind === "local") {
    if (
      asset.storage.kind !== "local" ||
      !/^[a-f0-9]{64}\.(?:mp4|webm)$/i.test(asset.storage.fileName)
    ) {
      throw new Error("视频资产本地存储记录不合法。");
    }
    return;
  }
  if (asset.storage.kind !== "object" || !asset.projectId) {
    throw new Error("视频资产对象存储记录不合法。");
  }
  const expectedObjectKey = buildAliyunOssVideoObjectKey({
    tenantId: adapter.tenantId,
    projectId: asset.projectId,
    contentHash: asset.contentHash,
    contentType: asset.contentType,
  });
  if (
    asset.storage.provider !== adapter.objectStorage.provider ||
    asset.storage.objectKey !== expectedObjectKey
  ) {
    throw new Error("视频资产对象键与租户、项目或内容哈希不一致。");
  }
}

function assertAssetMatchesAdapter(
  adapter: ResolvedVideoAssetAdapter,
  asset: StoredVideoAsset,
): void {
  try {
    assertAssetMatchesAdapterUnchecked(adapter, asset);
  } catch (error) {
    if (adapter.kind === "object") {
      throw asVideoAssetUnavailableError(error);
    }
    throw error;
  }
}

async function assertObjectAvailable(
  adapter: Extract<ResolvedVideoAssetAdapter, { kind: "object" }>,
  asset: StoredVideoAsset,
): Promise<void> {
  assertAssetMatchesAdapter(adapter, asset);
  const storage = asset.storage;
  if (storage.kind !== "object") {
    throw new Error("视频资产对象存储记录不合法。");
  }
  let metadata;
  try {
    metadata = await adapter.objectStorage.headObject({
      objectKey: storage.objectKey,
    });
  } catch (error) {
    throw asVideoAssetUnavailableError(error);
  }
  if (!metadata) {
    throw new VideoAssetUnavailableError("视频资产对象存储内容不可用。");
  }
  try {
    assertVideoObjectMetadata(metadata, asset);
    assertVideoObjectEtag(metadata, storage.etag);
  } catch (error) {
    throw asVideoAssetUnavailableError(error);
  }
}

async function rollbackCreatedObject(
  adapter: Extract<ResolvedVideoAssetAdapter, { kind: "object" }>,
  objectKey: string,
  contentHash: string,
  etag: string | undefined,
  originalError: unknown,
): Promise<never> {
  try {
    if (await adapter.repository.hasObjectReference(objectKey)) {
      throw originalError;
    }
    const cleanup = await adapter.objectStorage.deleteObjectIfMatch({
      objectKey,
      contentHash,
      ...(etag ? { etag } : {}),
    });
    if (!cleanup.deleted) {
      throw new Error("VIDEO_OBJECT_CLEANUP_NOT_CONFIRMED");
    }
  } catch (error) {
    if (error === originalError) throw originalError;
    throw new VideoAssetUnavailableError(
      "视频资产对象上传未提交且安全清理失败。",
    );
  }
  throw originalError;
}

export function videoAssetCapabilityStatus(
  actor: AdminActor,
  options: VideoAssetServiceOptions = {},
): VideoAssetCapabilityStatus {
  const maxUploadBytes = options.maxUploadBytes ?? videoAssetMaxUploadBytes();
  if (actor.mode === "production") {
    let reason: string | undefined;
    try {
      resolveProductionAdapter(options);
    } catch (error) {
      reason = error instanceof VideoAssetUnavailableError
        ? error.message
        : "生产视频资产服务暂不可用。";
    }
    return {
      adapter: "production_object_storage",
      available: !reason,
      uploadAvailable: !reason,
      generationAvailable: false,
      ...(reason ? { reason } : {}),
      maxUploadBytes,
      acceptedTypes: ["video/mp4", "video/webm"],
    };
  }
  const adapterEnabled =
    options.allowTestAdapter ||
    process.env.AISTORY_VIDEO_ASSET_ADAPTER === "local_development";
  const probeConfigured =
    typeof options.probe === "function" ||
    !!process.env.AISTORY_VIDEO_FFPROBE_PATH?.trim();
  return {
    adapter: "local_development",
    available: adapterEnabled && probeConfigured,
    uploadAvailable: adapterEnabled && probeConfigured,
    generationAvailable: false,
    ...(!adapterEnabled
      ? { reason: "本地视频资产适配器未启用。" }
      : !probeConfigured
        ? { reason: "本地 ffprobe 未配置，上传已关闭。" }
        : {}),
    maxUploadBytes,
    acceptedTypes: ["video/mp4", "video/webm"],
  };
}

export async function listAdminVideoAssets(
  actor: AdminActor,
  options: VideoAssetServiceOptions = {},
): Promise<VideoAssetDto[]> {
  const adapter = resolveAdminAdapter(actor, options);
  const assets = await callVideoAssetRepository(adapter, () =>
    adapter.repository.list(),
  );
  for (const asset of assets) assertAssetMatchesAdapter(adapter, asset);
  return assets.map(asDto);
}

export async function uploadAdminVideoAsset(
  actor: AdminActor,
  input: VideoAssetUploadInput,
  options: VideoAssetServiceOptions = {},
): Promise<{ asset: VideoAssetDto; created: boolean }> {
  const adapter = resolveAdminAdapter(actor, options);
  const repository = adapter.repository;
  const idempotencyKey = cleanIdempotencyKey(input.idempotencyKey);
  const maxBytes = options.maxUploadBytes ?? videoAssetMaxUploadBytes();
  const checked = validateVideoBytes(
    input.bytes,
    input.declaredType,
    maxBytes,
  );
  const title = cleanText(input.title, "标题", 160, true)!;
  const projectId = cleanProjectId(input.projectId);
  if (adapter.kind === "object" && !projectId) {
    throw new Error("生产视频资产上传必须绑定项目 ID。");
  }
  const storyId = cleanText(input.storyId, "作品 ID", 120);
  const nodeId = cleanText(input.nodeId, "剧情节点 ID", 120);
  const releasePolicy = input.releasePolicy ?? "public";
  if (!["public", "internal", "enterprise"].includes(releasePolicy)) {
    throw new Error("发布策略不合法。");
  }
  const preliminaryCues = input.webVtt
    ? parseWebVtt(input.webVtt)
    : validateSubtitleCues(input.cues);
  const fingerprint = requestFingerprint({
    operation: input.source ?? "upload",
    contentHash: checked.contentHash,
    title,
    projectId,
    storyId,
    nodeId,
    releasePolicy,
    subtitles: preliminaryCues,
    generation: input.generation
      ? {
          jobId: input.generation.jobId,
          provider: input.generation.provider,
          workflowId: input.generation.workflowId,
          workflowVersion: input.generation.workflowVersion,
          seed: input.generation.seed,
        }
      : undefined,
  });
  const replay = await callVideoAssetRepository(adapter, () =>
    repository.findIdempotency(idempotencyKey),
  );
  if (replay) {
    if (replay.fingerprint !== fingerprint) {
      throw new Error("幂等键已用于不同的视频资产请求。");
    }
    const existing = await callVideoAssetRepository(adapter, () =>
      repository.get(replay.assetId),
    );
    if (!existing) throw new Error("视频资产幂等记录损坏。");
    assertAssetMatchesAdapter(adapter, existing);
    if (adapter.kind === "object") {
      await assertObjectAvailable(adapter, existing);
    }
    return { asset: asDto(existing), created: false };
  }

  let storage: VideoAssetStorageReference;
  let probe: VideoProbeResult;
  let subtitles: VideoSubtitleCue[];
  let createdObjectKey: string | undefined;
  let createdObjectEtag: string | undefined;
  if (adapter.kind === "local") {
    const materialized = await materializeContentAddressedVideo(
      adapter.repository,
      input.bytes,
      checked.contentHash,
      checked.contentType,
      adapter.probe,
    );
    storage = materialized.storage;
    probe = materialized.probe;
    subtitles = input.webVtt
      ? parseWebVtt(input.webVtt, probe.durationMs)
      : validateSubtitleCues(input.cues, probe.durationMs);
  } else {
    let probed: VideoProbeResult;
    try {
      probed = await adapter.probe({
        bytes: input.bytes,
        contentHash: checked.contentHash,
        contentType: checked.contentType,
      });
    } catch (error) {
      throw asVideoAssetUnavailableError(error);
    }
    probe = validateContainerCodecCombination(
      checked.contentType,
      probed,
    );
    subtitles = input.webVtt
      ? parseWebVtt(input.webVtt, probe.durationMs)
      : validateSubtitleCues(input.cues, probe.durationMs);
    const objectKey = buildAliyunOssVideoObjectKey({
      tenantId: adapter.tenantId,
      projectId: projectId!,
      contentHash: checked.contentHash,
      contentType: checked.contentType,
    });
    try {
      const put = await adapter.objectStorage.putObjectIfAbsent({
        objectKey,
        bytes: input.bytes,
        contentType: checked.contentType,
        contentHash: checked.contentHash,
        tenantId: adapter.tenantId,
        projectId: projectId!,
      });
      if (put.created) {
        createdObjectKey = objectKey;
        createdObjectEtag = put.etag;
      }
      assertVideoObjectMetadata(put, {
        bytes: input.bytes.byteLength,
        contentHash: checked.contentHash,
        contentType: checked.contentType,
      });
      if (!put.etag) {
        throw new Error("VIDEO_OBJECT_ETAG_REQUIRED");
      }
      if (
        !put.created
        && !await callVideoAssetRepository(adapter, () =>
          repository.hasObjectReference(objectKey))
      ) {
        // A conditional-put collision without committed metadata is an
        // in-flight upload or an orphan. Do not race its creator by attaching
        // new metadata; scoped reconciliation owns that recovery path.
        throw new VideoAssetUnavailableError();
      }
      storage = {
        kind: "object",
        provider: adapter.objectStorage.provider,
        objectKey,
        etag: put.etag,
      };
    } catch (error) {
      if (createdObjectKey) {
        return rollbackCreatedObject(
          adapter,
          createdObjectKey,
          checked.contentHash,
          createdObjectEtag,
          asVideoAssetUnavailableError(error),
        );
      }
      throw asVideoAssetUnavailableError(error);
    }
  }
  const now = (options.now ?? (() => new Date()))();
  const id = cleanAssetId((options.randomId ?? randomUUID)());
  const asset: StoredVideoAsset = {
    id,
    tenantId: adapter.tenantId,
    contentHash: checked.contentHash,
    contentType: checked.contentType,
    bytes: input.bytes.byteLength,
    storage,
    ...probe,
    status: "draft",
    releasePolicy,
    ...(projectId ? { projectId } : {}),
    ...(storyId ? { storyId } : {}),
    ...(nodeId ? { nodeId } : {}),
    title,
    subtitles,
    source: input.source ?? "upload",
    ...(input.generation
      ? { generation: structuredClone(input.generation) }
      : {}),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  let result: { asset: StoredVideoAsset; created: boolean };
  try {
    result = await callVideoAssetRepository(adapter, () =>
      repository.create(
        asset,
        {
          key: idempotencyKey,
          fingerprint,
          assetId: id,
          operation: input.source === "generation_job" ? "adopt" : "upload",
          createdAt: now.toISOString(),
        },
        audit(
          actor,
          id,
          input.source === "generation_job"
            ? "video_asset.adopt_generation"
            : "video_asset.upload",
          input.source === "generation_job"
            ? "纳管视频生成结果为草稿"
            : "上传视频资产草稿",
          input.requestId,
          now,
        ),
      ),
    );
  } catch (error) {
    if (
      adapter.kind === "object"
      && createdObjectKey
      && error instanceof VideoAssetMetadataWriteRejectedError
    ) {
      return rollbackCreatedObject(
        adapter,
        createdObjectKey,
        checked.contentHash,
        createdObjectEtag,
        error,
      );
    }
    throw asVideoAssetUnavailableError(error);
  }
  assertAssetMatchesAdapter(adapter, result.asset);
  return { asset: asDto(result.asset), created: result.created };
}

export async function adoptGenerationVideoAsset(
  actor: AdminActor,
  input: Omit<VideoAssetUploadInput, "bytes" | "declaredType"> & {
    jobId: string;
  },
  options: VideoAssetServiceOptions = {},
): Promise<{ asset: VideoAssetDto; created: boolean }> {
  if (actor.mode === "production") {
    throw new VideoAssetUnavailableError(
      "生产视频生成结果纳管适配器尚未配置。",
    );
  }
  const job = await getStoredGenerationJob(input.jobId);
  if (
    !job ||
    job.status !== "succeeded" ||
    job.modality !== "video" ||
    !job.artifact
  ) {
    throw new Error("只能纳管已成功且具有安全镜像产物的视频任务。");
  }
  if (job.releaseClassification === "non_publishable") {
    throw new Error(
      "LAN LAB 非发布级视频不可进入 VideoAsset 发布链路。",
    );
  }
  const match = /^\/api\/aistory-cache\/media\/([a-f0-9]{64}\.(?:mp4|webm))$/i.exec(
    job.artifact.url,
  );
  if (!match) throw new Error("生成任务没有安全的 AIstory 视频镜像。");
  const contentType = job.artifact.contentType;
  if (contentType !== "video/mp4" && contentType !== "video/webm") {
    throw new Error("生成任务视频 MIME 不受支持。");
  }
  const source = path.join(
    process.env.AISTORY_CACHE_DIR || path.join(process.cwd(), ".aistory-cache"),
    "media",
    match[1]!,
  );
  const bytes = await readFile(source);
  if (bytes.byteLength !== job.artifact.bytes) {
    throw new Error("生成任务视频镜像完整性校验失败。");
  }
  return uploadAdminVideoAsset(
    actor,
    {
      ...input,
      bytes,
      declaredType: contentType,
      idempotencyKey: input.idempotencyKey,
      source: "generation_job",
      generation: {
        jobId: job.id,
        provider: job.provider,
        ...(job.workflowId ? { workflowId: job.workflowId } : {}),
        ...(job.workflowVersion
          ? { workflowVersion: job.workflowVersion }
          : {}),
        ...("seed" in job.input && typeof job.input.seed === "number"
          ? { seed: job.input.seed }
          : {}),
      },
    },
    options,
  );
}

export async function mutateAdminVideoAsset(
  actor: AdminActor,
  assetId: string,
  input: VideoAssetMutationInput,
  options: VideoAssetServiceOptions = {},
): Promise<{ asset: VideoAssetDto; changed: boolean }> {
  const adapter = resolveAdminAdapter(actor, options);
  const repository = adapter.repository;
  if (
    ![
      "submit_review",
      "approve",
      "offline",
      "restore_draft",
      "bind",
    ].includes(input.action)
  ) {
    throw new Error("视频资产操作不受支持。");
  }
  const id = cleanAssetId(assetId);
  const key = cleanIdempotencyKey(input.idempotencyKey);
  const reason = cleanText(input.reason, "操作原因", 500, true)!;
  const projectId = cleanProjectId(input.projectId);
  const storyId = cleanText(input.storyId, "作品 ID", 120);
  const nodeId = cleanText(input.nodeId, "剧情节点 ID", 120);
  const title = cleanText(input.title, "标题", 160);
  const releasePolicy = input.releasePolicy;
  if (
    releasePolicy &&
    !["public", "internal", "enterprise"].includes(releasePolicy)
  ) {
    throw new Error("发布策略不合法。");
  }
  const fingerprint = requestFingerprint({
    operation: "mutation",
    assetId: id,
    action: input.action,
    projectId,
    storyId,
    nodeId,
    releasePolicy,
    title,
    reason,
    actorId: actor.userId,
  });
  const replay = await callVideoAssetRepository(adapter, () =>
    repository.findIdempotency(key),
  );
  if (replay) {
    if (
      replay.fingerprint !== fingerprint ||
      replay.assetId !== id
    ) {
      throw new Error("幂等键已用于不同的视频资产操作。");
    }
    const replayedAsset = await callVideoAssetRepository(adapter, () =>
      repository.get(id),
    );
    if (!replayedAsset) throw new Error("视频资产幂等记录损坏。");
    assertAssetMatchesAdapter(adapter, replayedAsset);
    if (adapter.kind === "object") {
      await assertObjectAvailable(adapter, replayedAsset);
    }
    return { asset: asDto(replayedAsset), changed: false };
  }
  const current = await callVideoAssetRepository(adapter, () =>
    repository.get(id),
  );
  if (!current) throw new Error("视频资产不存在。");
  assertAssetMatchesAdapter(adapter, current);
  if (input.action === "bind" && current.status !== "draft") {
    throw new Error("只有草稿视频资产可以更新绑定或发布策略。");
  }
  if (input.action === "submit_review" && current.status !== "draft") {
    throw new Error("只有草稿可以提交审核。");
  }
  if (input.action === "approve" && current.status !== "review_pending") {
    throw new Error("只有待审核资产可以批准。");
  }
  if (input.action === "offline" && current.status !== "publishable") {
    throw new Error("只有已批准资产可以下线。");
  }
  if (input.action === "restore_draft" && current.status !== "offline") {
    throw new Error("只有已下线资产可以恢复为草稿。");
  }
  if (
    adapter.kind === "object" &&
    input.action === "bind" &&
    projectId !== undefined &&
    projectId !== current.projectId
  ) {
    throw new Error("生产对象存储视频资产不可跨项目重新绑定。");
  }
  if (adapter.kind === "object" && input.action === "approve") {
    await assertObjectAvailable(adapter, current);
  }
  const now = (options.now ?? (() => new Date()))();
  const result = await callVideoAssetRepository(adapter, () =>
    repository.mutateAsset(
      id,
      {
        key,
        fingerprint,
        assetId: id,
        operation: "mutation",
        createdAt: now.toISOString(),
      },
      audit(
        actor,
        id,
        `video_asset.${input.action}`,
        reason,
        input.requestId,
        now,
      ),
      (asset) => {
        if (input.action === "bind") {
          if (asset.status !== "draft") {
            throw new Error("只有草稿视频资产可以更新绑定或发布策略。");
          }
          if (adapter.kind === "local") asset.projectId = projectId;
          asset.storyId = storyId;
          asset.nodeId = nodeId;
          if (releasePolicy) asset.releasePolicy = releasePolicy;
          if (title) asset.title = title;
          asset.reviewNote = reason;
          return;
        }
        if (input.action === "submit_review") {
          if (asset.status !== "draft") {
            throw new Error("只有草稿可以提交审核。");
          }
          asset.status = "review_pending";
        } else if (input.action === "approve") {
          if (asset.status !== "review_pending") {
            throw new Error("只有待审核资产可以批准。");
          }
          if (!asset.projectId || !asset.storyId || !asset.nodeId) {
            throw new Error("发布前必须绑定项目、作品和剧情节点。");
          }
          asset.status = "publishable";
        } else if (input.action === "offline") {
          if (asset.status !== "publishable") {
            throw new Error("只有已批准资产可以下线。");
          }
          asset.status = "offline";
        } else if (input.action === "restore_draft") {
          if (asset.status !== "offline") {
            throw new Error("只有已下线资产可以恢复为草稿。");
          }
          asset.status = "draft";
        }
        asset.reviewNote = reason;
      },
    ),
  );
  assertAssetMatchesAdapter(adapter, result.asset);
  return { asset: asDto(result.asset), changed: result.changed };
}

function contentForAsset(
  adapter: ResolvedVideoAssetAdapter,
  asset: StoredVideoAsset,
): VideoAssetContent {
  assertAssetMatchesAdapter(adapter, asset);
  if (adapter.kind === "object") {
    if (asset.storage.kind !== "object") {
      throw new Error("视频资产对象存储记录不合法。");
    }
    return {
      kind: "object",
      asset,
      objectKey: asset.storage.objectKey,
      transport: adapter.objectStorage,
    };
  }
  if (asset.storage.kind !== "local") {
    throw new Error("视频资产本地存储记录不合法。");
  }
  const file = path.resolve(adapter.repository.mediaDir(), asset.storage.fileName);
  const mediaRoot = path.resolve(adapter.repository.mediaDir());
  if (!file.startsWith(`${mediaRoot}${path.sep}`)) {
    throw new Error("视频资产路径不合法。");
  }
  return { kind: "local", asset, file };
}

export async function getAdminVideoAssetContent(
  actor: AdminActor,
  assetId: string,
  options: VideoAssetServiceOptions = {},
): Promise<VideoAssetContent> {
  const adapter = resolveAdminAdapter(actor, options);
  const id = cleanAssetId(assetId);
  const asset = await callVideoAssetRepository(adapter, () =>
    adapter.repository.get(id),
  );
  if (!asset) throw new Error("视频资产不存在。");
  return contentForAsset(adapter, asset);
}

export async function getAdminVideoAssetFile(
  actor: AdminActor,
  assetId: string,
  options: VideoAssetServiceOptions = {},
): Promise<{ asset: StoredVideoAsset; file: string }> {
  const content = await getAdminVideoAssetContent(actor, assetId, options);
  if (content.kind !== "local") {
    throw new Error("视频资产不是本地文件。");
  }
  return { asset: content.asset, file: content.file };
}

export async function getPublicVideoAssetContent(
  assetId: string,
  options: VideoAssetServiceOptions = {},
): Promise<VideoAssetContent | null> {
  const adapter = resolvePublicAdapter(options);
  if (!adapter) return null;
  const id = cleanAssetId(assetId);
  const asset = await callVideoAssetRepository(adapter, () =>
    adapter.repository.get(id),
  );
  if (
    !asset ||
    asset.status !== "publishable" ||
    asset.releasePolicy !== "public"
  ) {
    return null;
  }
  return contentForAsset(adapter, asset);
}

export async function getPublicVideoAssetFile(
  assetId: string,
  options: VideoAssetServiceOptions = {},
): Promise<{ asset: StoredVideoAsset; file: string } | null> {
  const content = await getPublicVideoAssetContent(assetId, options);
  return content?.kind === "local"
    ? { asset: content.asset, file: content.file }
    : null;
}

export function projectPublishedVideoAsset(
  asset: StoredVideoAsset,
): SceneVideoMedia | null {
  if (
    asset.status !== "publishable" ||
    asset.releasePolicy !== "public" ||
    !asset.projectId ||
    !asset.storyId ||
    !asset.nodeId
  ) {
    return null;
  }
  return {
    kind: "video",
    assetId: asset.id,
    url: `/api/video-assets/${encodeURIComponent(asset.id)}/content`,
    durationMs: asset.durationMs,
    hasAudio: asset.hasAudio,
    subtitles: asset.subtitles,
    endBehavior: "unlock-interaction",
    hotspotsEnabled: false,
  };
}
