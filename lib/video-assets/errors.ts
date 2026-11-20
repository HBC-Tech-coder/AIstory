import "server-only";

const DEFAULT_UNAVAILABLE_MESSAGE = "视频资产服务暂不可用。";

export class VideoAssetUnavailableError extends Error {
  readonly code = "VIDEO_ASSET_UNAVAILABLE" as const;

  constructor(message = DEFAULT_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "VideoAssetUnavailableError";
  }
}

/**
 * The metadata database returned an explicit transaction rejection. Object
 * cleanup is safe only for this outcome; transport failures and malformed
 * success responses may have committed and must be reconciled later.
 */
export class VideoAssetMetadataWriteRejectedError extends VideoAssetUnavailableError {
  constructor() {
    super();
    this.name = "VideoAssetMetadataWriteRejectedError";
  }
}

export function isVideoAssetUnavailableError(
  error: unknown,
): error is VideoAssetUnavailableError {
  return error instanceof VideoAssetUnavailableError;
}

export function asVideoAssetUnavailableError(
  error: unknown,
): VideoAssetUnavailableError {
  return isVideoAssetUnavailableError(error)
    ? error
    : new VideoAssetUnavailableError();
}
