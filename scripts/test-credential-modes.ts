import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  clearStoredModelConfig,
  readByokPersistence,
  readStoredModelConfig,
  writeStoredModelConfig,
  type StoredModelConfig,
} from "@/lib/clientModelConfig";
import { coercePublicPrefetchDepth } from "@/lib/credentials/publicSettings";
import {
  assertCompleteByok,
  authorizeCredentialAccess,
  redactCredentialError,
} from "@/lib/credentials/serverPolicy";
import { proxyLLM } from "@/lib/byoProxy";
import { LocalAdminRepository } from "@/lib/admin/localRepository";
import { buildAdminSnapshot } from "@/lib/admin/service";

class MemoryStorage implements Storage {
  private readonly data = new Map<string, string>();
  get length(): number { return this.data.size; }
  clear(): void { this.data.clear(); }
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  key(index: number): string | null { return [...this.data.keys()][index] ?? null; }
  removeItem(key: string): void { this.data.delete(key); }
  setItem(key: string, value: string): void { this.data.set(key, String(value)); }
}

const modelConfig: StoredModelConfig = {
  settingsMode: "split",
  textBaseUrl: "https://models.example/v1",
  textApiKey: "text-secret-value",
  textModel: "text-model",
  textProvider: "openai_compatible",
  imageBaseUrl: "https://images.example/v1",
  imageApiKey: "image-secret-value",
  imageModel: "image-model",
  imageProvider: "openai_compatible",
  visionBaseUrl: "https://vision.example/v1",
  visionApiKey: "vision-secret-value",
  visionModel: "vision-model",
  visionProvider: "openai_compatible",
  videoBaseUrl: "https://video.example/v1",
  videoApiKey: "video-secret-value",
  videoModel: "video-model",
  videoProvider: "openai_compatible",
};

async function main(): Promise<void> {
  assert.equal(authorizeCredentialAccess({
    requestedMode: "platform_managed",
    hasByok: false,
    userId: "external-user",
    env: {
      AISTORY_PLATFORM_MANAGED_ENABLED: "true",
      AISTORY_PLATFORM_MANAGED_ALLOWLIST: "internal-user",
    },
  }).allowed, false);
  assert.equal(authorizeCredentialAccess({
    requestedMode: "platform_managed",
    hasByok: false,
    userId: "internal-user",
    env: {
      AISTORY_PLATFORM_MANAGED_ENABLED: "true",
      AISTORY_PLATFORM_MANAGED_ALLOWLIST: "internal-user",
    },
  }).allowed, true);
  assert.equal(authorizeCredentialAccess({
    requestedMode: "platform_managed",
    hasByok: false,
    userId: "anonymous",
    env: {
      AISTORY_PLATFORM_MANAGED_ENABLED: "true",
      AISTORY_PLATFORM_MANAGED_ALLOWLIST: "anonymous",
    },
  }).allowed, false);
  assert.throws(
    () => assertCompleteByok({ text: { apiKey: "x" } }),
    /platform fallback is disabled/,
  );
  assert.doesNotThrow(() => assertCompleteByok({
    text: { apiKey: "t" },
    image: { apiKey: "i" },
    vision: { apiKey: "v" },
  }));
  assert.equal(coercePublicPrefetchDepth(0), 0);
  assert.equal(coercePublicPrefetchDepth(1), 1);
  assert.equal(coercePublicPrefetchDepth(2), 1);

  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage, sessionStorage },
  });
  writeStoredModelConfig(modelConfig);
  assert.ok(sessionStorage.getItem("infiplot:model"));
  assert.equal(localStorage.getItem("infiplot:model"), null);
  assert.equal(readByokPersistence(), "session");
  assert.equal(readStoredModelConfig()?.videoApiKey, "video-secret-value");
  writeStoredModelConfig(modelConfig, "local");
  assert.equal(sessionStorage.getItem("infiplot:model"), null);
  assert.ok(localStorage.getItem("infiplot:model"));
  assert.equal(readByokPersistence(), "local");
  clearStoredModelConfig();
  assert.equal(localStorage.getItem("infiplot:model"), null);
  assert.equal(sessionStorage.getItem("infiplot:model"), null);
  Reflect.deleteProperty(globalThis, "window");

  const originalFetch = globalThis.fetch;
  let upstreamUrl = "";
  let upstreamHeaders: HeadersInit | undefined;
  globalThis.fetch = async (input, init) => {
    upstreamUrl = String(input);
    upstreamHeaders = init?.headers;
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const rawKey = "gemini-super-secret-key";
  await proxyLLM({
    provider: "gemini",
    apiKey: rawKey,
    baseUrl: "https://generativelanguage.googleapis.com",
    model: "gemini-test",
    body: { contents: [] },
    stream: false,
  });
  assert.equal(upstreamUrl.includes(rawKey), false);
  assert.equal(new Headers(upstreamHeaders).get("x-goog-api-key"), rawKey);
  assert.equal(upstreamUrl.includes("?key="), false);
  globalThis.fetch = async () => new Response(
    JSON.stringify({ error: rawKey }),
    { status: 401 },
  );
  const redactedResponse = await proxyLLM({
    provider: "openai_compatible",
    apiKey: rawKey,
    baseUrl: "https://models.example/v1",
    body: { messages: [] },
    stream: false,
  });
  assert.equal((await redactedResponse.text()).includes(rawKey), false);
  globalThis.fetch = originalFetch;
  assert.equal(
    redactCredentialError(new Error(`api_key=${rawKey} failed`)).includes(rawKey),
    false,
  );

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aistory-credentials-"));
  try {
    const storePath = path.join(tempRoot, "admin.json");
    const repository = new LocalAdminRepository(storePath);
    await repository.saveProviderConfig({
      id: "provider-text",
      tenantId: "platform",
      modality: "text",
      provider: "openai_compatible",
      baseUrl: "https://models.example/v1",
      model: "test-model",
      capabilities: ["text"],
      enabled: false,
      status: "disabled",
      secretReference: "env:PLATFORM_TEXT_API_KEY",
      updatedAt: new Date(0).toISOString(),
    });
    const snapshot = await buildAdminSnapshot(repository);
    const serialized = JSON.stringify(snapshot);
    assert.equal(serialized.includes("PLATFORM_TEXT_API_KEY"), false);
    assert.match(snapshot.providerConfigs[0]?.secretReference || "", /^env:/);

    const persisted = await readFile(storePath, "utf8");
    for (const key of [
      modelConfig.textApiKey,
      modelConfig.imageApiKey,
      modelConfig.visionApiKey,
      modelConfig.videoApiKey!,
    ]) {
      assert.equal(persisted.includes(key), false);
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  console.log("credential mode tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
