import "server-only";

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { VideoAssetUnavailableError } from "../errors";
import type { ProductionVideoAssetAdapter } from "../server";
import {
  validateContainerCodecCombination,
  validateVideoProbe,
} from "../validation";

const execFileAsync = promisify(execFile);

export type VideoProbeExecRunner = (
  executable: string,
  args: string[],
  options: {
    timeout: number;
    maxBuffer: number;
    windowsHide: boolean;
    cwd: string;
    env: NodeJS.ProcessEnv;
    shell: false;
  },
) => Promise<{ stdout: string }>;

const defaultExecRunner: VideoProbeExecRunner = async (
  executable,
  args,
  options,
) => {
  const result = await execFileAsync(executable, args, options);
  return { stdout: result.stdout };
};

function minimalProbeEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    LANG: "C",
    LC_ALL: "C",
  };
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"] as const) {
      if (process.env[key]) env[key] = process.env[key];
    }
  }
  return env;
}

function isMissingPath(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

export function createProductionVideoByteProbe(
  ffprobePath: string,
  execRunner: VideoProbeExecRunner = defaultExecRunner,
): ProductionVideoAssetAdapter["probe"] {
  if (!path.isAbsolute(ffprobePath)) {
    throw new VideoAssetUnavailableError();
  }
  return async ({ bytes, contentHash, contentType }) => {
    const actualHash = createHash("sha256").update(bytes).digest("hex");
    if (actualHash !== contentHash || bytes.byteLength <= 0) {
      throw new VideoAssetUnavailableError();
    }
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "aistory-video-probe-"),
    ).catch(() => {
      throw new VideoAssetUnavailableError();
    });
    const file = path.join(
      tempRoot,
      contentType === "video/mp4" ? "input.mp4" : "input.webm",
    );
    try {
      await writeFile(file, bytes, { flag: "wx", mode: 0o600 });
      const fileStat = await stat(file);
      if (!fileStat.isFile() || fileStat.size !== bytes.byteLength) {
        throw new Error("Probe temporary file mismatch.");
      }
      const result = await execRunner(
        ffprobePath,
        [
          "-nostdin",
          "-v",
          "error",
          "-hide_banner",
          "-protocol_whitelist",
          "file",
          "-show_entries",
          "format=duration,size:stream=codec_type,codec_name,width,height,duration",
          "-of",
          "json",
          file,
        ],
        {
          timeout: 15_000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
          cwd: tempRoot,
          env: minimalProbeEnvironment(),
          shell: false,
        },
      );
      const parsed = JSON.parse(result.stdout) as {
        streams?: Array<{
          codec_type?: string;
          codec_name?: string;
          width?: number;
          height?: number;
          duration?: string;
        }>;
        format?: { duration?: string; size?: string };
      };
      if (
        parsed.format?.size !== undefined
        && Number(parsed.format.size) !== bytes.byteLength
      ) {
        throw new Error("Probe reported an unexpected byte length.");
      }
      const video = parsed.streams?.find(
        (stream) => stream.codec_type === "video",
      );
      const audio = parsed.streams?.find(
        (stream) => stream.codec_type === "audio",
      );
      const durationSeconds = Number(
        video?.duration ?? parsed.format?.duration ?? 0,
      );
      if (!video?.codec_name) {
        throw new Error("Probe did not report a video stream.");
      }
      return validateContainerCodecCombination(
        contentType,
        validateVideoProbe({
          durationMs: Math.round(durationSeconds * 1000),
          width: Number(video.width),
          height: Number(video.height),
          videoCodec: video.codec_name,
          ...(audio?.codec_name ? { audioCodec: audio.codec_name } : {}),
          hasAudio: !!audio,
        }),
      );
    } catch {
      throw new VideoAssetUnavailableError();
    } finally {
      const unlinkError = await unlink(file).then(
        () => undefined,
        (error: unknown) => error,
      );
      const rmdirError = await rmdir(tempRoot).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (
        (unlinkError && !isMissingPath(unlinkError))
        || (rmdirError && !isMissingPath(rmdirError))
      ) {
        throw new VideoAssetUnavailableError();
      }
    }
  };
}
