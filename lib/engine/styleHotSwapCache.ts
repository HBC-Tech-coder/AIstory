import { mkdir, readFile, rename, writeFile } from "fs/promises";
import path from "path";

const CACHE_ROOT =
  process.env.AISTORY_CACHE_DIR || path.join(process.cwd(), ".aistory-cache");
const CACHE_DIR = path.join(CACHE_ROOT, "style-hot-swap");
const TTL_MS = 24 * 60 * 60 * 1000;
const pending = new Map<string, Promise<unknown>>();

type Envelope<T> = {
  version: 1;
  key: string;
  createdAt: number;
  data: T;
};

function fileFor(key: string): string {
  return path.join(CACHE_DIR, `${key}.json`);
}

async function read<T>(key: string): Promise<T | null> {
  try {
    const envelope = JSON.parse(await readFile(fileFor(key), "utf8")) as Envelope<T>;
    if (
      envelope.version !== 1 ||
      envelope.key !== key ||
      Date.now() - envelope.createdAt > TTL_MS
    ) {
      return null;
    }
    return envelope.data;
  } catch {
    return null;
  }
}

export async function peekStyleHotSwapCache<T>(
  key: string,
): Promise<T | null> {
  return read<T>(key);
}

async function write<T>(key: string, data: T): Promise<void> {
  await mkdir(CACHE_DIR, { recursive: true });
  const target = fileFor(key);
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(
    temporary,
    JSON.stringify({ version: 1, key, createdAt: Date.now(), data }),
    "utf8",
  );
  await rename(temporary, target);
}

export async function withStyleHotSwapCache<T>(
  key: string,
  compute: () => Promise<T>,
): Promise<{ data: T; cacheStatus: "hit" | "write" }> {
  const cached = await read<T>(key);
  if (cached) return { data: cached, cacheStatus: "hit" };
  const existing = pending.get(key) as Promise<T> | undefined;
  if (existing) return { data: await existing, cacheStatus: "hit" };
  const promise = compute();
  pending.set(key, promise);
  try {
    const data = await promise;
    await write(key, data);
    return { data, cacheStatus: "write" };
  } finally {
    pending.delete(key);
  }
}
