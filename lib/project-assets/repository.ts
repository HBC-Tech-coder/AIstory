import "server-only";

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import type {
  AdoptProjectAssetResult,
  ProjectAsset,
  ProjectAssetList,
} from "./types";

type ProjectAssetStore = {
  schemaVersion: 1;
  assets: ProjectAsset[];
};

const DEFAULT_ROOT = path.join(process.cwd(), ".aistory-assets");
let mutationQueue = Promise.resolve();

function root(): string {
  return process.env.AISTORY_PROJECT_ASSET_DIR || DEFAULT_ROOT;
}

function targetFile(): string {
  return path.join(root(), "project-assets.json");
}

function backupFile(): string {
  return path.join(root(), "project-assets.previous.json");
}

function emptyStore(): ProjectAssetStore {
  return { schemaVersion: 1, assets: [] };
}

async function parseFile(file: string): Promise<ProjectAssetStore> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as ProjectAssetStore;
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.assets)) {
    throw new Error("Unsupported project asset store schema.");
  }
  return parsed;
}

async function readStore(): Promise<ProjectAssetStore> {
  let firstError: unknown;
  for (const file of [targetFile(), backupFile()]) {
    try {
      return await parseFile(file);
    } catch (error) {
      firstError ??= error;
    }
  }
  if (
    firstError &&
    typeof firstError === "object" &&
    "code" in firstError &&
    firstError.code === "ENOENT"
  ) {
    return emptyStore();
  }
  throw firstError;
}

async function writeStore(store: ProjectAssetStore): Promise<void> {
  await mkdir(root(), { recursive: true });
  const target = targetFile();
  const backup = backupFile();
  const temp = path.join(
    root(),
    `.project-assets-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`,
  );
  let movedPrimary = false;
  try {
    await writeFile(temp, JSON.stringify(store, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    await unlink(backup).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await rename(target, backup)
      .then(() => {
        movedPrimary = true;
      })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    await rename(temp, target);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    if (movedPrimary) await rename(backup, target).catch(() => undefined);
    throw error;
  }
}

async function mutate<T>(
  operation: (store: ProjectAssetStore) => Promise<T> | T,
): Promise<T> {
  let release: (() => void) | undefined;
  const previous = mutationQueue;
  mutationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const store = await readStore();
    const result = await operation(store);
    await writeStore(store);
    return result;
  } finally {
    release?.();
  }
}

export async function listProjectAssets(
  projectId: number,
): Promise<ProjectAssetList> {
  const items = (await readStore()).assets
    .filter((asset) => asset.projectId === projectId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    projectId,
    total: items.length,
    items: structuredClone(items),
  };
}

export async function getProjectAsset(
  projectId: number,
  assetId: string,
): Promise<ProjectAsset | undefined> {
  const asset = (await readStore()).assets.find(
    (item) => item.projectId === projectId && item.id === assetId,
  );
  return asset ? structuredClone(asset) : undefined;
}

export async function saveProjectAssetIfAbsent(
  candidate: ProjectAsset,
): Promise<AdoptProjectAssetResult> {
  return mutate((store) => {
    const existing = store.assets.find(
      (asset) =>
        asset.projectId === candidate.projectId &&
        asset.jobId === candidate.jobId,
    );
    if (existing) {
      return { asset: structuredClone(existing), created: false };
    }
    store.assets.push(structuredClone(candidate));
    return { asset: structuredClone(candidate), created: true };
  });
}
