import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import {
  compileCaseStudyBundle,
  validateCaseStudyAssetManifest,
  validateCaseStudySource,
} from "../lib/case-studies/schema";

const CASE_ID = "virtual-girlfriend-20260727";
const projectRoot = resolve(import.meta.dirname, "..");
const caseRoot = join(projectRoot, "content", "case-studies", CASE_ID);
const authorLockedRoot = join(caseRoot, "author-locked-v1.1");
const publicRoot = join(projectRoot, "public", "case-studies", CASE_ID);
const publicAssetsRoot = join(publicRoot, "assets");
const bundlePath = join(publicRoot, "story.json");
const catalogPath = join(projectRoot, "content", "case-studies.catalog.json");
const pendingPublicPath = `/case-studies/${CASE_ID}/pending.svg`;
const SAFE_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".avif"]);

type CaseDelivery = {
  root: string;
  storyPath: string;
  manifestPath: string;
  release: "author-locked-v1.1" | "v1.0";
};

async function selectCaseDelivery(): Promise<CaseDelivery> {
  try {
    const info = await stat(authorLockedRoot);
    if (!info.isDirectory()) throw new Error("author-locked-v1.1 不是目录");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    return {
      root: caseRoot,
      storyPath: join(caseRoot, "virtual-girlfriend.story.json"),
      manifestPath: join(caseRoot, "asset-manifest.json"),
      release: "v1.0",
    };
  }
  const delivery = {
    root: authorLockedRoot,
    storyPath: join(
      authorLockedRoot,
      "virtual-girlfriend.author-locked.v1.1.story.json",
    ),
    manifestPath: join(authorLockedRoot, "asset-manifest.v1.1.json"),
    release: "author-locked-v1.1" as const,
  };
  await Promise.all([stat(delivery.storyPath), stat(delivery.manifestPath)]);
  return delivery;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function assertRasterImage(path: string): Promise<{ bytes: number; sha256: string }> {
  const extension = extname(path).toLowerCase();
  if (!SAFE_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`不支持的案例图片格式：${extension || "<none>"}`);
  }
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size > 25 * 1024 * 1024) {
    throw new Error(`案例图片大小不合法：${basename(path)}`);
  }
  const data = await readFile(path);
  const looksLikePng = extension === ".png" && data.subarray(0, 8).equals(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  const looksLikeJpeg =
    (extension === ".jpg" || extension === ".jpeg") &&
    data[0] === 0xff &&
    data[1] === 0xd8;
  const looksLikeRiffWebp =
    extension === ".webp" &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP";
  const looksLikeAvif =
    extension === ".avif" &&
    data.subarray(4, 12).toString("ascii").includes("ftyp");
  if (!looksLikePng && !looksLikeJpeg && !looksLikeRiffWebp && !looksLikeAvif) {
    throw new Error(`案例图片文件签名不合法：${basename(path)}`);
  }
  return {
    bytes: info.size,
    sha256: createHash("sha256").update(data).digest("hex"),
  };
}

async function main() {
  const delivery = await selectCaseDelivery();
  const [sourceRaw, manifestRaw] = await Promise.all([
    readFile(delivery.storyPath, "utf8").then(JSON.parse),
    readFile(delivery.manifestPath, "utf8").then(JSON.parse),
  ]);
  const sourceResult = validateCaseStudySource(sourceRaw, CASE_ID);
  if (!sourceResult.ok) throw new Error(sourceResult.errors.join("\n"));
  const manifestResult = validateCaseStudyAssetManifest(manifestRaw, CASE_ID);
  if (!manifestResult.ok) throw new Error(manifestResult.errors.join("\n"));  if (
    sourceResult.value.releaseVersion &&
    manifestResult.value.releaseVersion !== sourceResult.value.releaseVersion
  ) {
    throw new Error("story 与 asset manifest 的 releaseVersion 不一致");
  }
  if (
    delivery.release === "author-locked-v1.1" &&
    (sourceResult.value.authorLocked !== true ||
      sourceResult.value.releaseVersion !== "v1.1")
  ) {
    throw new Error("author-locked-v1.1 交付缺少作者锁定或版本标记");
  }
  const restrictedNodeIds = new Set(
    sourceResult.value.releasePolicy?.restrictedNodeIds ?? [],
  );
  const restrictedSceneIds = new Set(
    sourceResult.value.interactiveGraph.nodes
      .filter(
        (node) =>
          node.restricted === true ||
          (node.releasePolicy !== undefined &&
            node.releasePolicy !== "public") ||
          restrictedNodeIds.has(node.nodeId),
      )
      .map((node) => node.sceneId),
  );

  await mkdir(publicAssetsRoot, { recursive: true });
  const generatedRoot = resolve(delivery.root, "generated-assets");
  const assetPaths: Record<string, string> = {};
  const copiedAssets: Array<{
    assetId: string;
    publicPath: string;
    bytes: number;
    sha256: string;
  }> = [];

  for (const asset of manifestResult.value.assets) {
    if (asset.status !== "generated") continue;
    if (
      (asset.releasePolicy !== undefined &&
        asset.releasePolicy !== "public") ||
      (asset.sceneId !== null && restrictedSceneIds.has(asset.sceneId))
    ) {
      continue;
    }
    if (!asset.localPath) throw new Error(`${asset.assetId} 缺少 localPath`);
    const sourcePath = resolve(
      caseRoot,
      isAbsolute(asset.localPath) ? relative(caseRoot, asset.localPath) : asset.localPath,
    );
    if (!isWithin(generatedRoot, sourcePath)) {
      throw new Error(`${asset.assetId} 必须来自 generated-assets，不能公开 source 参考素材`);
    }
    const verified = await assertRasterImage(sourcePath);
    const extension = extname(sourcePath).toLowerCase();
    const targetName = `${asset.assetId}${extension}`;
    const targetPath = join(publicAssetsRoot, targetName);
    await copyFile(sourcePath, targetPath);
    const publicPath = `/case-studies/${CASE_ID}/assets/${targetName}`;
    assetPaths[asset.assetId] = publicPath;
    copiedAssets.push({ assetId: asset.assetId, publicPath, ...verified });
  }

  const bundle = compileCaseStudyBundle(
    sourceResult.value,
    manifestResult.value,
    assetPaths,
    pendingPublicPath,
  );
  await mkdir(publicRoot, { recursive: true });
  await writeJsonAtomic(bundlePath, bundle);
  await writeJsonAtomic(catalogPath, {
    schemaVersion: 1,
    cases: [bundle.card],
  });

  console.log(JSON.stringify({
    caseStudyId: CASE_ID,
    nodes: bundle.session.authoredStory?.nodes.length ?? 0,
    choices: sourceResult.value.interactiveGraph.nodes.reduce(
      (sum, node) => sum + (node.choices?.length ?? 0),
      0,
    ),
    assets: bundle.assetSummary,
    release: delivery.release,
    runtimeVersion: bundle.session.authoredStory?.version,
    copiedAssets,
    bundlePath,
    catalogPath,
  }, null, 2));
}

await main();
