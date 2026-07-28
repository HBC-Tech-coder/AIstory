export const CHARACTER_PORTRAIT_ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export const CHARACTER_PORTRAIT_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const CHARACTER_PORTRAIT_MAX_SOURCE_PIXELS = 24_000_000;
export const CHARACTER_PORTRAIT_MAX_DIMENSION = 640;
export const CHARACTER_PORTRAIT_MAX_OUTPUT_BYTES = 180 * 1024;

type PortraitFileMetadata = {
  type: string;
  size: number;
};

type BrowserStorageLike = {
  setItem(key: string, value: string): void;
};

export type CharacterPortraitResult = {
  dataUrl: string;
  width: number;
  height: number;
  bytes: number;
  mimeType: "image/jpeg";
};

export type StorageWriteResult =
  | { ok: true }
  | { ok: false; message: string };

export function validateCharacterPortraitFile(
  file: PortraitFileMetadata,
): string | null {
  if (!CHARACTER_PORTRAIT_ALLOWED_MIME_TYPES.includes(
    file.type as (typeof CHARACTER_PORTRAIT_ALLOWED_MIME_TYPES)[number],
  )) {
    return "仅支持 JPEG、PNG 或 WebP 图片，不支持 SVG、GIF 或其他文件。";
  }
  if (!Number.isFinite(file.size) || file.size <= 0) {
    return "图片文件为空或无法读取。";
  }
  if (file.size > CHARACTER_PORTRAIT_MAX_SOURCE_BYTES) {
    return "原图不能超过 8 MB，请先缩小后重试。";
  }
  return null;
}

export function matchesCharacterPortraitSignature(
  mimeType: string,
  header: Uint8Array,
): boolean {
  if (mimeType === "image/jpeg") {
    return header.length >= 3
      && header[0] === 0xff
      && header[1] === 0xd8
      && header[2] === 0xff;
  }
  if (mimeType === "image/png") {
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    return header.length >= png.length
      && png.every((value, index) => header[index] === value);
  }
  if (mimeType === "image/webp") {
    return header.length >= 12
      && String.fromCharCode(...header.slice(0, 4)) === "RIFF"
      && String.fromCharCode(...header.slice(8, 12)) === "WEBP";
  }
  return false;
}

export function estimateDataUrlBytes(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) return Number.POSITIVE_INFINITY;
  const payload = dataUrl.slice(commaIndex + 1).replace(/\s/g, "");
  const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((payload.length * 3) / 4) - padding);
}

export function isSafeStoredCharacterPortrait(dataUrl: unknown): dataUrl is string {
  return typeof dataUrl === "string"
    && dataUrl.startsWith("data:image/jpeg;base64,")
    && estimateDataUrlBytes(dataUrl) <= CHARACTER_PORTRAIT_MAX_OUTPUT_BYTES;
}

export function writeCharacterRolesToStorage(
  storage: BrowserStorageLike,
  key: string,
  roles: unknown[],
): StorageWriteResult {
  try {
    storage.setItem(key, JSON.stringify(roles));
    return { ok: true };
  } catch {
    return {
      ok: false,
      message: "浏览器本地存储空间不足或已被禁用，角色尚未保存。请移除参考照片或清理本站数据后重试。",
    };
  }
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("IMAGE_ENCODE_FAILED"));
      },
      "image/jpeg",
      quality,
    );
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("IMAGE_READ_FAILED"));
    };
    reader.onerror = () => reject(new Error("IMAGE_READ_FAILED"));
    reader.readAsDataURL(blob);
  });
}

function loadBrowserImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("IMAGE_DECODE_FAILED"));
    };
    image.src = objectUrl;
  });
}

export async function processCharacterReferencePhoto(
  file: File,
): Promise<CharacterPortraitResult> {
  const metadataError = validateCharacterPortraitFile(file);
  if (metadataError) throw new Error(metadataError);

  const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (!matchesCharacterPortraitSignature(file.type, header)) {
    throw new Error("图片内容与文件类型不一致，已拒绝读取。");
  }

  const image = await loadBrowserImage(file);
  if (
    image.naturalWidth < 32
    || image.naturalHeight < 32
    || image.naturalWidth * image.naturalHeight > CHARACTER_PORTRAIT_MAX_SOURCE_PIXELS
  ) {
    throw new Error("图片尺寸无效或像素过大，请使用不超过 2400 万像素的照片。");
  }

  const baseScale = Math.min(
    1,
    CHARACTER_PORTRAIT_MAX_DIMENSION
      / Math.max(image.naturalWidth, image.naturalHeight),
  );
  const scaleSteps = [1, 0.86, 0.72, 0.6];
  const qualitySteps = [0.82, 0.74, 0.66, 0.58];

  for (const scaleStep of scaleSteps) {
    const width = Math.max(32, Math.round(image.naturalWidth * baseScale * scaleStep));
    const height = Math.max(32, Math.round(image.naturalHeight * baseScale * scaleStep));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前浏览器无法处理图片。");
    context.fillStyle = "#efe3cf";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);

    for (const quality of qualitySteps) {
      const blob = await canvasToBlob(canvas, quality);
      if (blob.size > CHARACTER_PORTRAIT_MAX_OUTPUT_BYTES) continue;
      const dataUrl = await blobToDataUrl(blob);
      const bytes = estimateDataUrlBytes(dataUrl);
      if (bytes <= CHARACTER_PORTRAIT_MAX_OUTPUT_BYTES) {
        return {
          dataUrl,
          width,
          height,
          bytes,
          mimeType: "image/jpeg",
        };
      }
    }
  }

  throw new Error("照片压缩后仍然过大，请换用更小或细节更少的图片。");
}
