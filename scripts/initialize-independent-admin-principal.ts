import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  link,
  lstat,
  open,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import {
  assertIndependentAdminPrincipalProtectedDirectoryChain,
  createIndependentAdminPrincipalCredential,
  serializeIndependentAdminPrincipalCredential,
  validateIndependentAdminPrincipalFileReference,
} from "@/lib/admin/independentPrincipal";

function fail(): never {
  throw new Error("Independent administrator initialization failed.");
}

function outputPathFromArguments(): string {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--output" || !args[1]) fail();
  return args[1];
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

async function assertProtectedTarget(outputPath: string): Promise<string> {
  if (process.platform !== "linux" || process.geteuid?.() !== 0) fail();
  const resolved = validateIndependentAdminPrincipalFileReference(
    outputPath,
    process.cwd(),
    "linux",
  );
  const parent = path.posix.dirname(resolved);
  await assertIndependentAdminPrincipalProtectedDirectoryChain(parent, {
    effectiveUid: 0,
    ownerOnlyLeaf: true,
  });
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
      || installed.dev !== stagingDevice
      || installed.ino !== stagingInode
    ) fail();
    const directory = await open(parent, fsConstants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    completed = true;
  } finally {
    if (!completed && installedLink) {
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
        const directory = await open(parent, fsConstants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } else if (installed) {
        fail();
      }
    }
    if (stagingCreated) {
      await unlink(staging).catch(() => undefined);
    }
  }
}

const previousUmask = process.umask(0o077);
try {
  const outputPath = await assertProtectedTarget(outputPathFromArguments());
  const username = await hiddenPrompt("Administrator login name (hidden): ", 64);
  const password = await hiddenPrompt("Administrator password (hidden): ", 512);
  const confirmation = await hiddenPrompt("Repeat password (hidden): ", 512);
  if (password !== confirmation) fail();
  const credential = await createIndependentAdminPrincipalCredential({
    username,
    password,
  });
  await writeExclusiveCredential(
    outputPath,
    serializeIndependentAdminPrincipalCredential(credential),
  );
  console.log("Independent administrator credential created.");
} catch {
  console.error("Independent administrator initialization failed.");
  process.exitCode = 1;
} finally {
  process.umask(previousUmask);
}
