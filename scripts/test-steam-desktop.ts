import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  decideSteamExternalTarget,
  detectSteamMediaSupport,
  resolveSteamworksStatus,
  shouldShowSteamCompletionCta,
  STEAM_DECK_VIEWPORTS,
  STEAM_DESKTOP_OFFLINE_POLICY,
  steamReleasePlatformLabel,
  steamGamepadActionForButton,
} from "@/lib/steam/contracts";

async function run() {
  const allowed = decideSteamExternalTarget(
    "https://github.com/HBC-Tech-coder/AIstory",
  );
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.allowed && allowed.domain, "github.com");
  assert.equal(
    decideSteamExternalTarget(
      "https://github.com.evil.example/HBC-Tech-coder/AIstory",
    ).allowed,
    false,
  );
  assert.equal(
    decideSteamExternalTarget(
      "https://github.com/HBC-Tech-coder/AIstory/extra",
    ).allowed,
    false,
  );
  assert.equal(
    decideSteamExternalTarget(
      "https://user:secret@github.com/HBC-Tech-coder/AIstory",
    ).allowed,
    false,
  );
  assert.equal(
    decideSteamExternalTarget(
      "file:///C:/Windows/System32/calc.exe",
    ).allowed,
    false,
  );

  const disabled = resolveSteamworksStatus({
    enabled: false,
    appId: "12345",
    adapterAvailable: true,
  });
  assert.equal(disabled.configured, false);
  assert.ok(disabled.capabilities.every((item) => !item.available));
  const missingApp = resolveSteamworksStatus({
    enabled: true,
    adapterAvailable: true,
  });
  assert.equal(missingApp.appIdConfigured, false);
  assert.ok(
    missingApp.capabilities.every((item) => item.reason === "missing-app-id"),
  );
  const noAdapter = resolveSteamworksStatus({
    enabled: true,
    appId: "12345",
    adapterAvailable: false,
  });
  assert.equal(noAdapter.configured, false);
  assert.ok(
    noAdapter.capabilities.every(
      (item) => item.reason === "adapter-unavailable",
    ),
  );
  const p1Contract = resolveSteamworksStatus({
    enabled: true,
    appId: "12345",
    adapterAvailable: true,
  });
  assert.ok(
    p1Contract.capabilities.every(
      (item) => !item.available && item.reason === "not-implemented",
    ),
  );

  assert.equal(steamGamepadActionForButton(0), "activate");
  assert.equal(steamGamepadActionForButton(1), "back");
  assert.equal(steamGamepadActionForButton(9), "fullscreen");
  assert.equal(steamGamepadActionForButton(12), "up");
  assert.equal(steamGamepadActionForButton(99), null);

  assert.equal(
    shouldShowSteamCompletionCta({
      channel: "web",
      authoredNodeKind: "ending",
      mediaKind: "image",
    }),
    false,
  );
  assert.equal(
    shouldShowSteamCompletionCta({
      channel: "steam",
      authoredNodeKind: "video",
      mediaKind: "video",
      videoInteractionUnlocked: true,
    }),
    false,
  );
  assert.equal(
    shouldShowSteamCompletionCta({
      channel: "steam",
      authoredNodeKind: "ending",
      mediaKind: "video",
      videoInteractionUnlocked: false,
    }),
    false,
  );
  assert.equal(
    shouldShowSteamCompletionCta({
      channel: "steam",
      authoredNodeKind: "ending",
      mediaKind: "video",
      videoInteractionUnlocked: true,
    }),
    true,
  );

  const media = detectSteamMediaSupport((mime) =>
    mime.startsWith("video/webm") ? "probably" : "maybe",
  );
  assert.equal(media.preferred, "webm-vp9-opus");
  assert.equal(media.mp4H264Aac, true);
  assert.deepEqual(
    STEAM_DECK_VIEWPORTS.map(({ width, height }) => [width, height]),
    [
      [1280, 800],
      [1280, 720],
    ],
  );
  assert.equal(steamReleasePlatformLabel("windows-x64"), "Windows x64");
  assert.equal(steamReleasePlatformLabel("linux-x64"), "Linux x64");
  assert.equal(STEAM_DESKTOP_OFFLINE_POLICY.authoredContent, true);
  assert.equal(STEAM_DESKTOP_OFFLINE_POLICY.localSaves, true);
  assert.equal(STEAM_DESKTOP_OFFLINE_POLICY.platformGeneration, false);
  assert.equal(STEAM_DESKTOP_OFFLINE_POLICY.remoteGeneration, false);
  assert.equal(STEAM_DESKTOP_OFFLINE_POLICY.realSms, false);
  assert.equal(STEAM_DESKTOP_OFFLINE_POLICY.formalCredits, false);
  assert.equal(STEAM_DESKTOP_OFFLINE_POLICY.recharge, false);
  assert.equal(STEAM_DESKTOP_OFFLINE_POLICY.hostedCredentialsBundled, false);
  assert.equal(STEAM_DESKTOP_OFFLINE_POLICY.deviceCredentialsBundled, false);

  const desktopMain = await readFile(
    path.resolve("desktop", "main.mjs"),
    "utf8",
  );
  assert.match(desktopMain, /contextIsolation:\s*true/);
  assert.match(desktopMain, /sandbox:\s*true/);
  assert.match(desktopMain, /nodeIntegration:\s*false/);
  assert.match(desktopMain, /setWindowOpenHandler\(\(\) => \(\{ action: "deny" \}\)\)/);
  assert.match(desktopMain, /will-attach-webview/);
  assert.match(desktopMain, /resolveDesktopReleasePlatform/);
  assert.match(desktopMain, /app\.getPath\("userData"\)/);
  assert.doesNotMatch(desktopMain, /app\.getPath\("cache"\)/);
  assert.match(desktopMain, /path\.join\(userDataPath, "cache"\)/);
  assert.match(desktopMain, /isTrustedRendererUrl\(details\.url, runtimeOrigin\)/);
  assert.match(desktopMain, /allowExternalLoopback:\s*!app\.isPackaged/);
  assert.match(desktopMain, /appendSwitch\("proxy-server", "http:\/\/127\.0\.0\.1:9"\)/);
  assert.match(desktopMain, /"proxy-bypass-list"/);
  assert.match(desktopMain, /127\.0\.0\.1;localhost;\[::1\]/);
  assert.doesNotMatch(desktopMain, /appendSwitch\("no-proxy-server"\)/);
  assert.match(desktopMain, /appendSwitch\("disable-background-networking"\)/);
  assert.match(desktopMain, /appendSwitch\("disable-component-update"\)/);
  assert.match(desktopMain, /appendSwitch\("disable-domain-reliability"\)/);
  assert.match(desktopMain, /appendSwitch\("disable-sync"\)/);
  assert.match(desktopMain, /"host-resolver-rules"/);
  assert.match(desktopMain, /MAP \* ~NOTFOUND/);
  assert.match(desktopMain, /webRequest\.onBeforeRequest/);
  assert.match(desktopMain, /app\.setAppLogsPath/);
  assert.match(desktopMain, /process\.once\("SIGTERM"/);
  assert.match(desktopMain, /process\.once\("SIGINT"/);
  assert.doesNotMatch(desktopMain, /nodeIntegration:\s*true/);

  const runtime = await readFile(
    path.resolve("desktop", "runtime.mjs"),
    "utf8",
  );
  assert.match(runtime, /HOSTNAME:\s*"127\.0\.0\.1"/);
  assert.match(runtime, /AISTORY_PLATFORM_BILLING_ENABLED:\s*"false"/);
  assert.match(runtime, /AISTORY_SMS_PROVIDER:\s*"disabled"/);
  assert.match(runtime, /AISTORY_BRANCH_PREFETCH_MAX_DEPTH:\s*"0"/);
  assert.match(runtime, /COMFYUI_ENABLED:\s*"false"/);
  assert.match(runtime, /SAFE_HOST_ENV_KEYS/);
  assert.doesNotMatch(runtime, /env:\s*\{\s*\.\.\.env,/);
  assert.match(runtime, /desktop-runtime\.json/);
  assert.match(runtime, /resolveDesktopRuntimePort/);
  assert.match(runtime, /await stopRuntimeChild\(child\)/);

  const runtimeModule = await import(
    `${pathToFileURL(path.resolve("desktop", "runtime.mjs")).href}?steam-test=1`
  );
  assert.equal(
    runtimeModule.resolveDesktopReleasePlatform("win32", "x64"),
    "windows-x64",
  );
  assert.equal(
    runtimeModule.resolveDesktopReleasePlatform("linux", "x64"),
    "linux-x64",
  );
  assert.equal(runtimeModule.resolveDesktopReleasePlatform("linux", "arm64"), null);
  const desktopEnv = runtimeModule.buildDesktopRuntimeEnvironment({
    sourceEnv: {
      PATH: "fixture-path",
      TEXT_API_KEY: "fixture-secret-never-forwarded",
      ALIBABA_CLOUD_ACCESS_KEY_SECRET: "fixture-secret-never-forwarded",
      AISTORY_PLATFORM_MANAGED_ENABLED: "true",
    },
    port: 45678,
    releasePlatform: "linux-x64",
    userDataPath: path.resolve(".test-steam-user-data"),
    cachePath: path.resolve(".test-steam-cache"),
    runtimeProof: "a".repeat(64),
  });
  assert.equal(desktopEnv.PATH, "fixture-path");
  assert.equal(desktopEnv.HOSTNAME, "127.0.0.1");
  assert.equal(desktopEnv.PORT, "45678");
  assert.equal(desktopEnv.AISTORY_DESKTOP_RELEASE_PLATFORM, "linux-x64");
  assert.equal(desktopEnv.AISTORY_PLATFORM_MANAGED_ENABLED, "false");
  assert.equal(desktopEnv.AISTORY_STEAMWORKS_ENABLED, "false");
  assert.equal(desktopEnv.AISTORY_DESKTOP_RUNTIME_PROOF, "a".repeat(64));
  assert.equal(desktopEnv.AISTORY_BRANCH_PREFETCH_MAX_DEPTH, "0");
  assert.equal("TEXT_API_KEY" in desktopEnv, false);
  assert.equal("ALIBABA_CLOUD_ACCESS_KEY_SECRET" in desktopEnv, false);
  assert.ok(path.isAbsolute(desktopEnv.AISTORY_CACHE_DIR));
  assert.ok(path.isAbsolute(desktopEnv.AISTORY_GENERATION_JOB_DIR));
  const runtimePortRoot = await mkdtemp(
    path.join(os.tmpdir(), "aistory-steam-runtime-port-"),
  );
  try {
    let allocations = 0;
    const firstPort = await runtimeModule.resolveDesktopRuntimePort({
      userDataPath: runtimePortRoot,
      allocatePort: async () => {
        allocations += 1;
        return 54_321;
      },
    });
    const secondPort = await runtimeModule.resolveDesktopRuntimePort({
      userDataPath: runtimePortRoot,
      allocatePort: async () => {
        throw new Error("stable port must not be reallocated");
      },
    });
    assert.equal(firstPort, 54_321);
    assert.equal(secondPort, 54_321);
    assert.equal(allocations, 1);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          path.join(runtimePortRoot, "desktop-runtime.json"),
          "utf8",
        ),
      ),
      { schemaVersion: 1, hostname: "127.0.0.1", port: 54_321 },
    );
    await writeFile(
      path.join(runtimePortRoot, "desktop-runtime.json"),
      '{"schemaVersion":1,"hostname":"0.0.0.0","port":54321}\n',
      "utf8",
    );
    await assert.rejects(
      runtimeModule.resolveDesktopRuntimePort({ userDataPath: runtimePortRoot }),
      /desktop_runtime_port_record_invalid/,
    );
  } finally {
    await rm(runtimePortRoot, { recursive: true, force: true });
  }

  const occupiedServer = net.createServer();
  await new Promise<void>((resolve, reject) => {
    occupiedServer.once("error", reject);
    occupiedServer.listen({ host: "127.0.0.1", port: 0, exclusive: true }, resolve);
  });
  const occupiedAddress = occupiedServer.address();
  assert.ok(occupiedAddress && typeof occupiedAddress === "object");
  await assert.rejects(
    runtimeModule.assertLoopbackPortAvailable(occupiedAddress.port),
    /desktop_runtime_port_in_use/,
  );
  await new Promise<void>((resolve, reject) =>
    occupiedServer.close((error) => (error ? reject(error) : resolve())),
  );

  const launch = await readFile(
    path.resolve("components", "SteamLaunchExperience.tsx"),
    "utf8",
  );
  assert.match(launch, /Powered by AIstory/);
  assert.match(launch, /不会获得积分、道具或剧情权益/);
  assert.match(launch, /Steam Wallet 尚未接通/);
  assert.match(launch, /Linux x64 目录包候选/);
  assert.match(launch, /1280×800 \/ 1280×720/);
  assert.match(launch, /当前离线，外部页面不会自动重试/);
  assert.doesNotMatch(launch, /购买积分/);

  assert.match(launch, /aistory:steam-powered-splash-enabled:v1/);
  assert.match(launch, /Electron userData/);
  assert.match(launch, /BYOK/);

  const linuxPackager = await readFile(
    path.resolve("scripts", "package-steam-linux.mjs"),
    "utf8",
  );
  assert.match(linuxPackager, /platform:\s*"linux"/);
  assert.match(linuxPackager, /arch:\s*"x64"/);
  assert.match(linuxPackager, /electronZipDir:\s*path\.dirname\(electronZip\)/);
  assert.match(
    linuxPackager,
    /BLOCKED_NATIVE_BINARY_NOT_BUILT:missing_cached_electron_linux_x64/,
  );
  assert.match(linuxPackager, /appImageBuilt:\s*false/);
  assert.match(linuxPackager, /steamDepotUploaded:\s*false/);
  assert.match(linuxPackager, /steamDeckMechanicalTested:\s*false/);
  assert.match(linuxPackager, /LTAI\[A-Za-z0-9\]/);
  assert.doesNotMatch(linuxPackager, /https:\/\//);

  const windowsPackager = await readFile(
    path.resolve("scripts", "package-steam-win.mjs"),
    "utf8",
  );
  assert.match(windowsPackager, /platform:\s*"win32"/);
  assert.match(windowsPackager, /arch:\s*"x64"/);
  assert.match(windowsPackager, /electronZipDir:\s*path\.dirname\(electronZip\)/);
  assert.match(
    windowsPackager,
    /eba5f5088af40ecb364fe258809c79a5234c6ece5a75c64722772eba01b02786/,
  );
  assert.match(
    windowsPackager,
    /BLOCKED_NATIVE_BINARY_NOT_BUILT:missing_or_invalid_cached_electron_windows_x64/,
  );
  assert.match(windowsPackager, /README-TESTING\.txt/);
  assert.match(windowsPackager, /steamDepotUploaded:\s*false/);
  assert.match(windowsPackager, /files,/);
  assert.doesNotMatch(windowsPackager, /https:\/\//);

  const runtimeBuilder = await readFile(
    path.resolve("scripts", "prepare-steam-runtime.mjs"),
    "utf8",
  );
  assert.match(runtimeBuilder, /AISTORY_STEAM_TARGET/);
  assert.match(runtimeBuilder, /"linux-x64"/);
  assert.match(runtimeBuilder, /sanitizeStandaloneMetadata/);
  assert.match(
    runtimeBuilder,
    /config\.allowedDevOrigins = \["localhost", "127\.0\.0\.1"\]/,
  );
  assert.match(runtimeBuilder, /config\.outputFileTracingRoot = "\."/);
  assert.match(runtimeBuilder, /steamDeckVerified:\s*false/);
  assert.match(runtimeBuilder, /public\/home\/prompts\.json/);
  assert.match(runtimeBuilder, /"app\/app"/);
  assert.match(runtimeBuilder, /"components\/components"/);
  assert.match(runtimeBuilder, /"lib\/lib"/);
  assert.match(runtimeBuilder, /"\.next\/dev"/);

  const steamBuild = await readFile(
    path.resolve("scripts", "build-steam-runtime.mjs"),
    "utf8",
  );
  assert.match(steamBuild, /steam_build_env_file_forbidden/);
  assert.match(steamBuild, /NEXT_PUBLIC_SUPABASE_URL:\s*""/);
  assert.match(steamBuild, /NEXT_PUBLIC_UMAMI_SRC:\s*""/);
  assert.match(steamBuild, /NEXT_PUBLIC_IMAGE_PROXY_URL:\s*""/);
  assert.match(steamBuild, /AISTORY_STEAM_OFFLINE_BUILD:\s*"true"/);
  assert.match(steamBuild, /--verify-build/);
  assert.match(steamBuild, /AISTORY_STEAM_TURBOPACK_ROOT/);

  const nextConfig = await readFile(path.resolve("next.config.ts"), "utf8");
  assert.match(
    nextConfig,
    /unoptimized:\s*process\.env\.AISTORY_STEAM_OFFLINE_BUILD\s*===\s*"true"/,
  );

  process.stdout.write("Steam desktop P1 contract tests passed.\n");
}

await run();
