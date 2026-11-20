import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import type {
  IndependentAdminPrincipalAuthStateStore,
  IndependentAdminPrincipalCredential,
  IndependentAdminPrincipalCredentialBinding,
  IndependentAdminPrincipalRuntime,
} from "@/lib/admin/independentPrincipal";
import type {
  IndependentAdminPrincipalRpcClient,
} from "@/lib/admin/independentPrincipalRepository";
import type { DatabaseGateRpcClient } from "@/lib/production/databaseGate";

const REACT_SERVER_CHILD_FLAG =
  "--aistory-independent-admin-initializer-react-server-child-v1";

type InitializerEnvironment = Record<string, string | undefined>;
type InitializerRpcClient = IndependentAdminPrincipalRpcClient
  & DatabaseGateRpcClient;

type InitializerRepository = Readonly<{
  assertGateReady(): Promise<void>;
  initializeOnce(input: Readonly<{
    binding: IndependentAdminPrincipalCredentialBinding;
    requestId: string;
  }>): Promise<unknown>;
  rotateCredential(input: Readonly<{
    currentBinding: IndependentAdminPrincipalCredentialBinding;
    nextBinding: IndependentAdminPrincipalCredentialBinding;
    requestId: string;
  }>): Promise<unknown>;
}>;

export type IndependentAdminPrincipalInitializerDependencies = Readonly<{
  modeEnv: string;
  credentialFileEnv: string;
  productionMode: NonNullable<
    IndependentAdminPrincipalRuntime["expectedMode"]
  >;
  assertProtectedDirectoryChain(
    directory: string,
    options: Readonly<{
      effectiveUid: number | undefined;
      ownerOnlyLeaf: boolean;
    }>,
  ): Promise<void>;
  createCredential(input: Readonly<{
    username: string;
    password: string;
  }>): Promise<IndependentAdminPrincipalCredential>;
  createRotatedCredential(input: Readonly<{
    current: IndependentAdminPrincipalCredential;
    username: string;
    password: string;
  }>): Promise<IndependentAdminPrincipalCredential>;
  createStateStore(): IndependentAdminPrincipalAuthStateStore;
  loadCredential(
    runtime: IndependentAdminPrincipalRuntime,
  ): Promise<IndependentAdminPrincipalCredential>;
  projectBinding(
    credential: IndependentAdminPrincipalCredential,
  ): IndependentAdminPrincipalCredentialBinding;
  serializeCredential(credential: IndependentAdminPrincipalCredential): string;
  validateFileReference(
    fileReference: string,
    workspaceRoot: string,
    platform: NodeJS.Platform,
  ): string;
  inspectProductionGate(env: InitializerEnvironment): Readonly<{
    ready: boolean;
  }>;
  createClient(env: InitializerEnvironment): InitializerRpcClient;
  assertDatabaseGateReady(
    capability: "identity",
    client: InitializerRpcClient,
    env: InitializerEnvironment,
  ): Promise<void>;
  createRepository(
    client: InitializerRpcClient,
    binding: IndependentAdminPrincipalCredentialBinding,
  ): InitializerRepository;
}>;

export type IndependentAdminPrincipalInitializerTestRuntimeOptions = Readonly<{
  env?: InitializerEnvironment;
  platform?: NodeJS.Platform;
  effectiveUid?: number;
  workspaceRoot?: string;
  loadDependencies?: () => Promise<
    IndependentAdminPrincipalInitializerDependencies
  >;
  client?: InitializerRpcClient;
  promptHidden?: (label: string, maximumBytes: number) => Promise<string>;
  resolveProtectedAbsentTarget?: (outputPath: string) => Promise<string>;
  writeCredential?: (outputPath: string, serialized: string) => Promise<void>;
  log?: (message: string) => void;
  error?: (message: string) => void;
  setExitCode?: (code: number) => void;
}>;

async function loadInitializerDependencies(): Promise<
  IndependentAdminPrincipalInitializerDependencies
> {
  const [principal, repository, server, databaseGate] = await Promise.all([
    import("@/lib/admin/independentPrincipal"),
    import("@/lib/admin/independentPrincipalRepository"),
    import("@/lib/admin/independentPrincipalServer"),
    import("@/lib/production/databaseGate"),
  ]);
  return Object.freeze({
    modeEnv: principal.INDEPENDENT_ADMIN_PRINCIPAL_MODE_ENV,
    credentialFileEnv:
      principal.INDEPENDENT_ADMIN_PRINCIPAL_CREDENTIAL_FILE_ENV,
    productionMode: principal.INDEPENDENT_ADMIN_PRINCIPAL_PRODUCTION_MODE,
    assertProtectedDirectoryChain:
      principal.assertIndependentAdminPrincipalProtectedDirectoryChain,
    createCredential: principal.createIndependentAdminPrincipalCredential,
    createRotatedCredential:
      principal.createRotatedIndependentAdminPrincipalCredential,
    createStateStore: () =>
      new principal.InMemoryIndependentAdminPrincipalAuthStateStore(),
    loadCredential: principal.loadIndependentAdminPrincipalCredential,
    projectBinding: principal.projectIndependentAdminPrincipalCredentialBinding,
    serializeCredential:
      principal.serializeIndependentAdminPrincipalCredential,
    validateFileReference:
      principal.validateIndependentAdminPrincipalFileReference,
    inspectProductionGate:
      server.inspectIndependentAdminPrincipalProductionGate,
    createClient: (env) =>
      databaseGate.createProductionSupabaseServiceClient(env) as InitializerRpcClient,
    assertDatabaseGateReady: async (capability, client, env) => {
      await databaseGate.assertProductionDatabaseGateReady(
        capability,
        client,
        env,
      );
    },
    createRepository: (client, binding) =>
      repository.createSupabaseIndependentAdminPrincipalRepository(
        client as Parameters<
          typeof repository.createSupabaseIndependentAdminPrincipalRepository
        >[0],
        binding,
      ),
  });
}

export type IndependentAdminPrincipalInitializerOperation =
  | Readonly<{ kind: "initialize"; outputPath: string }>
  | Readonly<{ kind: "resume" }>
  | Readonly<{ kind: "rotate"; outputPath: string }>
  | Readonly<{ kind: "resume_rotate"; outputPath: string }>;

function fail(): never {
  throw new Error("Independent administrator initialization failed.");
}

export function parseIndependentAdminPrincipalInitializerArguments(
  args: readonly string[],
): IndependentAdminPrincipalInitializerOperation {
  if (args.length === 1 && args[0] === "--resume") {
    return Object.freeze({ kind: "resume" });
  }
  if (
    args.length === 2
    && (
      args[0] === "--initialize"
      || args[0] === "--rotate"
      || args[0] === "--resume-rotate"
    )
    && args[1]
  ) {
    return Object.freeze({
      kind: args[0] === "--initialize"
        ? "initialize"
        : args[0] === "--rotate"
          ? "rotate"
          : "resume_rotate",
      outputPath: args[1],
    });
  }
  fail();
}

async function hiddenPrompt(label: string, maximumBytes: number): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    fail();
  }
  process.stdout.write(label);
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (error?: Error) => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };
    const onKeypress = (text: string, key: readline.Key) => {
      if (key.ctrl && key.name === "c") {
        finish(new Error("cancelled"));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        finish();
        return;
      }
      if (key.name === "backspace") {
        value = value.slice(0, -1);
        return;
      }
      if (key.ctrl || key.meta || !text) return;
      const next = `${value}${text}`;
      if (Buffer.byteLength(next, "utf8") > maximumBytes) {
        finish(new Error("input too long"));
        return;
      }
      value = next;
    };
    process.stdin.on("keypress", onKeypress);
  });
}

async function assertProtectedAbsentTarget(
  outputPath: string,
  dependencies: IndependentAdminPrincipalInitializerDependencies,
  runtime: Readonly<{
    platform: NodeJS.Platform;
    effectiveUid: number | undefined;
    workspaceRoot: string;
  }>,
): Promise<string> {
  if (runtime.platform !== "linux" || runtime.effectiveUid !== 0) fail();
  const resolved = dependencies.validateFileReference(
    outputPath,
    runtime.workspaceRoot,
    "linux",
  );
  await dependencies.assertProtectedDirectoryChain(
    path.posix.dirname(resolved),
    { effectiveUid: 0, ownerOnlyLeaf: true },
  );
  try {
    await lstat(resolved);
    fail();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail();
  }
  return resolved;
}

async function writeExclusiveCredential(
  outputPath: string,
  serialized: string,
): Promise<void> {
  const parent = path.posix.dirname(outputPath);
  const staging = path.posix.join(
    parent,
    `.${path.posix.basename(outputPath)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let stagingCreated = false;
  let installedLink = false;
  let completed = false;
  let stagingDevice: number | undefined;
  let stagingInode: number | undefined;
  const syncParent = async () => {
    const directory = await open(parent, fsConstants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  };
  try {
    const handle = await open(staging, "wx", 0o600);
    stagingCreated = true;
    try {
      await handle.writeFile(serialized, { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    const staged = await lstat(staging);
    if (
      !staged.isFile()
      || staged.isSymbolicLink()
      || staged.uid !== 0
      || (staged.mode & 0o077) !== 0
      || staged.nlink !== 1
    ) fail();
    stagingDevice = staged.dev;
    stagingInode = staged.ino;
    await link(staging, outputPath);
    installedLink = true;
    const installed = await lstat(outputPath);
    if (
      !installed.isFile()
      || installed.isSymbolicLink()
      || installed.uid !== 0
      || (installed.mode & 0o077) !== 0
      || installed.nlink !== 2
      || installed.dev !== stagingDevice
      || installed.ino !== stagingInode
    ) fail();
    await unlink(staging);
    stagingCreated = false;
    const finalMetadata = await lstat(outputPath);
    if (
      !finalMetadata.isFile()
      || finalMetadata.isSymbolicLink()
      || finalMetadata.uid !== 0
      || (finalMetadata.mode & 0o077) !== 0
      || finalMetadata.nlink !== 1
      || finalMetadata.dev !== stagingDevice
      || finalMetadata.ino !== stagingInode
    ) fail();
    await syncParent();
    completed = true;
  } finally {
    let cleanupFailed = false;
    if (!completed && installedLink) {
      try {
        const installed = await lstat(outputPath).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return undefined;
            throw error;
          },
        );
        if (
          installed
          && installed.dev === stagingDevice
          && installed.ino === stagingInode
        ) {
          await unlink(outputPath);
        } else if (installed) {
          cleanupFailed = true;
        }
      } catch {
        cleanupFailed = true;
      }
    }
    if (stagingCreated) {
      try {
        await unlink(staging);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          cleanupFailed = true;
        }
      }
    }
    if (!completed) {
      try {
        await syncParent();
      } catch {
        cleanupFailed = true;
      }
    }
    if (cleanupFailed) fail();
  }
}

export function independentAdminPrincipalInitializerRequestId(
  domain: "initialize" | "rotate",
  material: string,
): string {
  return `ipr_${createHash("sha256")
    .update(`aistory:independent-admin:${domain}:v1\n`, "utf8")
    .update(material, "utf8")
    .digest("base64url")}`;
}

async function loadCredentialAtReference(
  fileReference: string,
  dependencies: IndependentAdminPrincipalInitializerDependencies,
  env: InitializerEnvironment,
  workspaceRoot: string,
) {
  return dependencies.loadCredential({
    env: {
      ...env,
      [dependencies.modeEnv]: dependencies.productionMode,
      [dependencies.credentialFileEnv]: fileReference,
    },
    workspaceRoot,
    store: dependencies.createStateStore(),
    expectedMode: dependencies.productionMode,
    actorMode: "production",
  });
}

async function loadCurrentCredential(
  dependencies: IndependentAdminPrincipalInitializerDependencies,
  env: InitializerEnvironment,
  workspaceRoot: string,
) {
  const configuredReference = env[dependencies.credentialFileEnv]?.trim();
  if (!configuredReference) fail();
  return loadCredentialAtReference(
    configuredReference,
    dependencies,
    env,
    workspaceRoot,
  );
}

async function promptCredential(
  dependencies: IndependentAdminPrincipalInitializerDependencies,
  promptHidden: (label: string, maximumBytes: number) => Promise<string>,
  current?: IndependentAdminPrincipalCredential,
) {
  const username = await promptHidden(
    "Administrator login name (hidden): ",
    64,
  );
  const password = await promptHidden(
    "Administrator password (hidden): ",
    512,
  );
  const confirmation = await promptHidden(
    "Repeat password (hidden): ",
    512,
  );
  if (password !== confirmation) fail();
  return current
    ? dependencies.createRotatedCredential({
        current,
        username,
        password,
      })
    : dependencies.createCredential({ username, password });
}

async function runIndependentAdminPrincipalInitializerCore(
  args: readonly string[],
  options: IndependentAdminPrincipalInitializerTestRuntimeOptions,
): Promise<void> {
  const previousUmask = process.umask(0o077);
  try {
    const env = options.env ?? process.env;
    const platform = options.platform ?? process.platform;
    const effectiveUid = options.effectiveUid ?? process.geteuid?.();
    const workspaceRoot = options.workspaceRoot ?? process.cwd();
    if (platform !== "linux" || effectiveUid !== 0) fail();
    const operation = parseIndependentAdminPrincipalInitializerArguments(args);
    const dependencies = await (
      options.loadDependencies ?? loadInitializerDependencies
    )();
    const configuredMode = env[dependencies.modeEnv]?.trim();
    if (
      (operation.kind === "initialize" || operation.kind === "resume")
        ? !!configuredMode
        : configuredMode !== dependencies.productionMode
    ) fail();
    const gateEnv = {
      ...env,
      [dependencies.modeEnv]: dependencies.productionMode,
    };
    if (!dependencies.inspectProductionGate(gateEnv).ready) fail();
    const configuredReference = env[
      dependencies.credentialFileEnv
    ]?.trim();
    if (!configuredReference) fail();

    const client = options.client ?? dependencies.createClient(env);
    await dependencies.assertDatabaseGateReady("identity", client, env);

    if (operation.kind === "resume") {
      const credential = await loadCurrentCredential(
        dependencies,
        env,
        workspaceRoot,
      );
      const binding = dependencies.projectBinding(credential);
      const repository = dependencies.createRepository(client, binding);
      await repository.assertGateReady();
      await repository.initializeOnce({
        binding,
        requestId: independentAdminPrincipalInitializerRequestId(
          "initialize",
          binding.credentialBindingSha256,
        ),
      });
      (options.log ?? console.log)(
        "Independent administrator initialization reconciled.",
      );
      return;
    }
    if (operation.kind === "initialize") {
      const outputPath = options.resolveProtectedAbsentTarget
        ? await options.resolveProtectedAbsentTarget(operation.outputPath)
        : await assertProtectedAbsentTarget(
            operation.outputPath,
            dependencies,
            { platform, effectiveUid, workspaceRoot },
          );
      if (path.posix.resolve(configuredReference) !== outputPath) fail();
      const credential = await promptCredential(
        dependencies,
        options.promptHidden ?? hiddenPrompt,
      );
      await (options.writeCredential ?? writeExclusiveCredential)(
        outputPath,
        dependencies.serializeCredential(credential),
      );
      const binding = dependencies.projectBinding(credential);
      const repository = dependencies.createRepository(client, binding);
      await repository.assertGateReady();
      await repository.initializeOnce({
        binding,
        requestId: independentAdminPrincipalInitializerRequestId(
          "initialize",
          binding.credentialBindingSha256,
        ),
      });
      (options.log ?? console.log)("Independent administrator initialized.");
      return;
    }

    const current = await loadCurrentCredential(
      dependencies,
      env,
      workspaceRoot,
    );
    const outputPath = dependencies.validateFileReference(
      operation.outputPath,
      workspaceRoot,
      "linux",
    );
    if (path.posix.resolve(configuredReference) === outputPath) fail();
    const next = operation.kind === "rotate"
      ? await (async () => {
          const protectedOutputPath = options.resolveProtectedAbsentTarget
            ? await options.resolveProtectedAbsentTarget(outputPath)
            : await assertProtectedAbsentTarget(
                outputPath,
                dependencies,
                { platform, effectiveUid, workspaceRoot },
              );
          if (protectedOutputPath !== outputPath) fail();
          const created = await promptCredential(
            dependencies,
            options.promptHidden ?? hiddenPrompt,
            current,
          );
          await (options.writeCredential ?? writeExclusiveCredential)(
            outputPath,
            dependencies.serializeCredential(created),
          );
          return created;
        })()
      : await loadCredentialAtReference(
          outputPath,
          dependencies,
          env,
          workspaceRoot,
        );
    const currentBinding = dependencies.projectBinding(current);
    const nextBinding = dependencies.projectBinding(next);
    const repository = dependencies.createRepository(client, currentBinding);
    await repository.assertGateReady();
    await repository.rotateCredential({
      currentBinding,
      nextBinding,
      requestId: independentAdminPrincipalInitializerRequestId(
        "rotate",
        `${currentBinding.credentialBindingSha256}\n${nextBinding.credentialBindingSha256}`,
      ),
    });
    (options.log ?? console.log)(
      operation.kind === "resume_rotate"
        ? "Independent administrator credential rotation reconciled."
        : "Independent administrator credential rotation recorded.",
    );
  } catch {
    (options.error ?? console.error)(
      "Independent administrator initialization failed.",
    );
    (options.setExitCode ?? ((code) => {
      process.exitCode = code;
    }))(1);
  } finally {
    process.umask(previousUmask);
  }
}

export async function runIndependentAdminPrincipalInitializer(
  args: readonly string[] = process.argv.slice(2),
): Promise<void> {
  await runIndependentAdminPrincipalInitializerCore(args, {});
}

/** Programmatic synthetic-only boundary; never selected by CLI arguments or env. */
export async function runIndependentAdminPrincipalInitializerForTest(
  args: readonly string[],
  options: IndependentAdminPrincipalInitializerTestRuntimeOptions,
): Promise<void> {
  await runIndependentAdminPrincipalInitializerCore(args, options);
}

function canonicalExecutablePath(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // A missing or unreadable path cannot gain a distinct execution identity.
  }
  return process.platform === "win32"
    ? canonical.toLocaleLowerCase("en-US")
    : canonical;
}

const currentScriptPath = canonicalExecutablePath(fileURLToPath(import.meta.url));
const invokedScriptPath = process.argv[1]
  ? canonicalExecutablePath(process.argv[1])
  : undefined;
const isDirectExecution =
  (import.meta as ImportMeta & { main?: boolean }).main === true
  || invokedScriptPath === currentScriptPath;
if (isDirectExecution) {
  const childFlagIndex = process.argv.indexOf(REACT_SERVER_CHILD_FLAG);
  if (childFlagIndex < 0) {
    const tsxImportUrl = import.meta.resolve("tsx");
    const child = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        tsxImportUrl,
        currentScriptPath,
        REACT_SERVER_CHILD_FLAG,
        ...process.argv.slice(2),
      ],
      {
        stdio: "inherit",
        shell: false,
        windowsHide: true,
      },
    );
    if (child.error || child.signal || child.status === null) {
      console.error("Independent administrator initialization failed.");
      process.exitCode = 1;
    } else {
      process.exitCode = child.status === 0 ? 0 : 1;
    }
  } else if (childFlagIndex !== 2) {
    console.error("Independent administrator initialization failed.");
    process.exitCode = 1;
  } else {
    await runIndependentAdminPrincipalInitializer(
      process.argv.slice(childFlagIndex + 1),
    );
  }
}
