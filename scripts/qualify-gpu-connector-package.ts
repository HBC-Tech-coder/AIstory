import { constants as fsConstants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CENTRAL_GOLDEN_SOURCE_NAMES,
  CONNECTOR_PACKAGE_QUALIFICATION_LIMITS,
  CONNECTOR_PACKAGE_QUALIFICATION_SCHEMA_VERSION,
  CONNECTOR_PACKAGE_STATIC_REJECTED,
  ConnectorPackageQualificationError,
  qualifyGpuConnectorPackage,
  serializeConnectorPackageQualificationReport,
  type CentralGoldenSource,
} from "../lib/gpu-coordinator/connectorPackageQualification";

const CLI_FLAGS = Object.freeze([
  "--zip",
  "--manifest",
  "--golden",
  "--golden-sidecar",
] as const);
const QUALIFIER_REPOSITORY_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

type QualifierPaths = {
  zip: string;
  manifest: string;
  golden: string;
  goldenSidecar: string;
};

export type QualifierCliResult = {
  exitCode: 0 | 1;
  output: string;
};

export function normalizeGpuConnectorQualifierProcessArguments(
  args: readonly string[],
): string[] {
  return args[0] === "--" ? args.slice(1) : [...args];
}

class QualifierCliError extends Error {
  readonly code: "cli_arguments_invalid" | "input_unavailable";

  constructor(code: "cli_arguments_invalid" | "input_unavailable") {
    super("gpu_connector_package_qualification_failed");
    this.name = "QualifierCliError";
    this.code = code;
  }
}

export function parseGpuConnectorQualifierArguments(
  args: readonly string[],
  cwd: string,
): QualifierPaths {
  if (args.length !== CLI_FLAGS.length * 2) {
    throw new QualifierCliError("cli_arguments_invalid");
  }
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !flag ||
      !(CLI_FLAGS as readonly string[]).includes(flag) ||
      values.has(flag) ||
      !value ||
      value.startsWith("--") ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new QualifierCliError("cli_arguments_invalid");
    }
    values.set(flag, path.resolve(cwd, value));
  }
  return {
    zip: values.get("--zip")!,
    manifest: values.get("--manifest")!,
    golden: values.get("--golden")!,
    goldenSidecar: values.get("--golden-sidecar")!,
  };
}

async function readBoundedRegularFile(
  filePath: string,
  maxBytes: number,
): Promise<Uint8Array> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const pathBefore = await lstat(filePath, { bigint: true });
    if (
      !pathBefore.isFile() ||
      pathBefore.isSymbolicLink() ||
      pathBefore.size < 1n ||
      pathBefore.size > BigInt(maxBytes)
    ) {
      throw new QualifierCliError("input_unavailable");
    }
    handle = await open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const before = await handle.stat({ bigint: true });
    const samePathObject =
      before.dev === pathBefore.dev && before.ino === pathBefore.ino;
    if (
      !samePathObject ||
      !before.isFile() ||
      before.size < 1n ||
      before.size > BigInt(maxBytes)
    ) {
      throw new QualifierCliError("input_unavailable");
    }
    const bytes = await handle.readFile();
    const [after, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      lstat(filePath, { bigint: true }),
    ]);
    if (
      !after.isFile() ||
      !pathAfter.isFile() ||
      pathAfter.isSymbolicLink() ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      pathAfter.dev !== before.dev ||
      pathAfter.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      pathAfter.size !== before.size ||
      pathAfter.mtimeNs !== before.mtimeNs ||
      pathAfter.ctimeNs !== before.ctimeNs ||
      BigInt(bytes.byteLength) !== before.size
    ) {
      throw new QualifierCliError("input_unavailable");
    }
    return bytes;
  } catch (error) {
    if (error instanceof QualifierCliError) throw error;
    throw new QualifierCliError("input_unavailable");
  } finally {
    await handle?.close();
  }
}

async function readCentralSources(root: string): Promise<CentralGoldenSource[]> {
  const result: CentralGoldenSource[] = [];
  for (const name of CENTRAL_GOLDEN_SOURCE_NAMES) {
    const bytes = await readBoundedRegularFile(
      path.join(root, "lib", "gpu-coordinator", name),
      2 * 1024 * 1024,
    );
    result.push({ name, bytes });
  }
  return result;
}

export async function qualifyGpuConnectorPackageFromFiles(
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const paths = parseGpuConnectorQualifierArguments(args, cwd);
  if (new Set(Object.values(paths).map((value) => path.normalize(value).toLowerCase())).size !== 4) {
    throw new QualifierCliError("cli_arguments_invalid");
  }
  const [zipBytes, manifestBytes, goldenBytes, goldenSidecarBytes, centralSources] =
    await Promise.all([
      readBoundedRegularFile(
        paths.zip,
        CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.zipBytes,
      ),
      readBoundedRegularFile(
        paths.manifest,
        CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.manifestBytes,
      ),
      readBoundedRegularFile(
        paths.golden,
        CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.goldenBytes,
      ),
      readBoundedRegularFile(
        paths.goldenSidecar,
        CONNECTOR_PACKAGE_QUALIFICATION_LIMITS.goldenSidecarBytes,
      ),
      readCentralSources(QUALIFIER_REPOSITORY_ROOT),
    ]);
  const report = await qualifyGpuConnectorPackage({
    zipBytes,
    zipFileName: path.basename(paths.zip),
    manifestBytes,
    goldenBytes,
    goldenFileName: path.basename(paths.golden),
    goldenSidecarBytes,
    centralSources,
  });
  return serializeConnectorPackageQualificationReport(report);
}

function rejectionOutput(error: unknown): string {
  const errorCode =
    error instanceof ConnectorPackageQualificationError ||
    error instanceof QualifierCliError
      ? error.code
      : "qualification_unavailable";
  return `${JSON.stringify({
    schemaVersion: CONNECTOR_PACKAGE_QUALIFICATION_SCHEMA_VERSION,
    status: CONNECTOR_PACKAGE_STATIC_REJECTED,
    errorCode,
  })}\n`;
}

export async function runGpuConnectorQualifierCli(
  args: readonly string[],
  cwd: string,
): Promise<QualifierCliResult> {
  try {
    return {
      exitCode: 0,
      output: await qualifyGpuConnectorPackageFromFiles(args, cwd),
    };
  } catch (error) {
    return { exitCode: 1, output: rejectionOutput(error) };
  }
}

const isMain = Boolean(
  process.argv[1] &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href,
);

if (isMain) {
  const result = await runGpuConnectorQualifierCli(
    normalizeGpuConnectorQualifierProcessArguments(process.argv.slice(2)),
    process.cwd(),
  );
  if (result.exitCode === 0) {
    process.stdout.write(result.output);
  } else {
    process.stderr.write(result.output);
    process.exitCode = result.exitCode;
  }
}
