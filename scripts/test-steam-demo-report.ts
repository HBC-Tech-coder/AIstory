import assert from "node:assert/strict";

import {
  buildSteamDemoReport,
  copySteamDemoReportLocally,
  createSteamDemoReportBundle,
  deliverSteamDemoReportLocally,
  downloadSteamDemoReportInBrowser,
  isPublicSteamDemoCaseId,
  isPublicSteamDemoStoryId,
  STEAM_DEMO_REPORT_FILENAME,
  STEAM_DEMO_REPORT_MAX_BYTES,
  STEAM_DEMO_REPORT_MAX_DESCRIPTION_CODEPOINTS,
  SteamDemoReportValidationError,
  type SteamDemoReportDeliveryAdapters,
  type SteamDemoReportDownloadEnvironment,
  type SteamDemoReportInput,
} from "@/lib/steam/demoReport";
import { resolveSteamworksStatus } from "@/lib/steam/contracts";

const generatedAt = "2026-08-13T08:00:00.000Z";
const steamworks = resolveSteamworksStatus({
  enabled: false,
  adapterAvailable: false,
});

function validInput(
  overrides: Partial<SteamDemoReportInput> = {},
): SteamDemoReportInput {
  return {
    releaseId: "steam-windows-demo-20260813-r3",
    generatedAt,
    appVersion: "0.1.0",
    platform: "windows",
    architecture: "x64",
    viewport: {
      width: 1_440,
      height: 900,
      devicePixelRatio: 1.25,
    },
    publicContext: { route: "steam" },
    steamworks,
    issueDescription: "第二章选择后，字幕出现得比声音慢。",
    ...overrides,
  };
}

function assertValidationError(input: unknown, code?: string) {
  assert.throws(
    () => buildSteamDemoReport(input),
    (error) =>
      error instanceof SteamDemoReportValidationError &&
      (code === undefined || error.code === code),
  );
}

async function run() {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = (async () => {
    networkCalls += 1;
    throw new Error("network_forbidden");
  }) as typeof fetch;

  try {
    const report = buildSteamDemoReport(validInput());
    assert.deepEqual(Object.keys(report), [
      "schema",
      "schemaVersion",
      "releaseId",
      "generatedAt",
      "app",
      "viewport",
      "publicContext",
      "steamCapabilities",
      "issueDescription",
    ]);
    assert.deepEqual(Object.keys(report.app), [
      "version",
      "platform",
      "architecture",
    ]);
    assert.deepEqual(Object.keys(report.viewport), [
      "width",
      "height",
      "devicePixelRatio",
    ]);
    assert.deepEqual(Object.keys(report.publicContext), ["route"]);
    assert.deepEqual(Object.keys(report.steamCapabilities), [
      "configured",
      "identity",
      "cloud",
      "input",
      "overlay",
      "softKeyboard",
      "wallet",
    ]);
    assert.equal(report.schema, "aistory-steam-demo-test-report");
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.generatedAt, generatedAt);
    assert.equal(report.app.version, "0.1.0");
    assert.equal(report.app.platform, "windows");
    assert.equal(report.app.architecture, "x64");
    assert.equal(report.steamCapabilities.configured, false);
    assert.ok(
      Object.values(report.steamCapabilities).every((value) => value === false),
    );

    const normalized = buildSteamDemoReport(
      validInput({ issueDescription: "  第一行\r\n第二行  " }),
    );
    assert.equal(normalized.issueDescription, "第一行\n第二行");
    const exactLimit = "测".repeat(
      STEAM_DEMO_REPORT_MAX_DESCRIPTION_CODEPOINTS,
    );
    assert.equal(
      buildSteamDemoReport(validInput({ issueDescription: exactLimit }))
        .issueDescription,
      exactLimit,
    );
    assertValidationError(
      validInput({
        issueDescription: "测".repeat(
          STEAM_DEMO_REPORT_MAX_DESCRIPTION_CODEPOINTS + 1,
        ),
      }),
      "report_description_invalid",
    );
    assertValidationError(
      validInput({ issueDescription: "" }),
      "report_description_invalid",
    );
    assertValidationError(
      validInput({ issueDescription: "问题\u0000正文" }),
      "report_description_invalid",
    );

    const forbiddenDescriptions = [
      "手机号 13800138000",
      "uuid 550e8400-e29b-41d4-a716-446655440000",
      "路径 C:\\Users\\tester\\save.json",
      "路径 /home/tester/save.json",
      "链接 https://private.invalid/report",
      "apiKey=synthetic-secret-marker",
      "Authorization: Bearer synthetic-token-marker",
      "sk-synthetic-secret-marker-123456789",
      "请看 prompt 正文",
      "请看 workflow JSON",
      "provider task id 在这里",
    ];
    for (const issueDescription of forbiddenDescriptions) {
      assertValidationError(
        validInput({ issueDescription }),
        "report_description_invalid",
      );
    }

    assert.equal(isPublicSteamDemoCaseId("virtual-girlfriend-20260727"), true);
    assert.equal(isPublicSteamDemoCaseId("world-model-anime-sunset"), true);
    assert.equal(isPublicSteamDemoCaseId("private-case"), false);
    assert.equal(isPublicSteamDemoStoryId("m0"), true);
    assert.equal(isPublicSteamDemoStoryId("f29"), true);
    assert.equal(isPublicSteamDemoStoryId("private-story"), false);
    assert.equal(
      buildSteamDemoReport(
        validInput({
          publicContext: {
            route: "play",
            caseId: "world-model-anime-sunset",
          },
        }),
      ).publicContext.caseId,
      "world-model-anime-sunset",
    );
    assert.equal(
      buildSteamDemoReport(
        validInput({
          publicContext: { route: "play", storyId: "m12" },
        }),
      ).publicContext.storyId,
      "m12",
    );
    assertValidationError(
      validInput({
        publicContext: { route: "play", caseId: "unknown-case" },
      }),
      "report_public_context_invalid",
    );
    assertValidationError(
      validInput({
        publicContext: {
          route: "steam",
          caseId: "virtual-girlfriend-20260727",
        },
      }),
      "report_public_context_invalid",
    );

    assertValidationError(
      { ...validInput(), localPath: "C:\\private\\story.json" },
      "report_input_shape_invalid",
    );
    assertValidationError(
      { ...validInput(), prompt: "private prompt" },
      "report_input_shape_invalid",
    );
    const inherited = Object.create({ token: "synthetic-secret-marker" });
    Object.assign(inherited, validInput());
    assertValidationError(inherited, "report_input_shape_invalid");
    const nonEnumerable = validInput() as SteamDemoReportInput & {
      token?: string;
    };
    Object.defineProperty(nonEnumerable, "token", {
      value: "synthetic-secret-marker",
      enumerable: false,
    });
    assertValidationError(nonEnumerable, "report_input_shape_invalid");
    const symbolBearing = validInput() as SteamDemoReportInput & {
      [key: symbol]: string;
    };
    symbolBearing[Symbol("token")] = "synthetic-secret-marker";
    assertValidationError(symbolBearing, "report_input_shape_invalid");
    assertValidationError(
      validInput({ releaseId: "../private" }),
      "report_release_id_invalid",
    );
    assertValidationError(
      validInput({ generatedAt: "not-an-iso-time" }),
      "report_timestamp_invalid",
    );
    assertValidationError(
      validInput({
        viewport: { width: 0, height: 900, devicePixelRatio: 1 },
      }),
      "report_viewport_invalid",
    );

    const bundle = createSteamDemoReportBundle(validInput());
    assert.equal(bundle.filename, STEAM_DEMO_REPORT_FILENAME);
    assert.match(bundle.filename, /^[a-z0-9._-]+\.json$/);
    assert.equal(bundle.filename.includes(".."), false);
    assert.equal(bundle.mimeType, "application/json;charset=utf-8");
    assert.ok(bundle.bytes > 0 && bundle.bytes <= STEAM_DEMO_REPORT_MAX_BYTES);
    assert.equal(new TextEncoder().encode(bundle.json).byteLength, bundle.bytes);
    assert.deepEqual(JSON.parse(bundle.json), bundle.report);
    assert.doesNotMatch(
      bundle.json.toLowerCase(),
      /phone|uuid|session|cookie|localstorage|sessionstorage|byok|hosted.?key|api.?key|access.?key|secret|token|prompt|workflow|provider.?task|local.?path|user.?agent|stack|log.?file/,
    );
    assert.doesNotMatch(
      bundle.json,
      /C:\\Users\\|\/home\/|synthetic-secret-marker|13800138000/,
    );

    const downloadEvents: string[] = [];
    let removed = 0;
    let revoked = 0;
    const fakeBlob = {} as Blob;
    const environment: SteamDemoReportDownloadEnvironment = {
      createBlob(parts, options) {
        assert.deepEqual(parts, [bundle.json]);
        assert.equal(options.type, bundle.mimeType);
        downloadEvents.push("blob");
        return fakeBlob;
      },
      createObjectUrl(blob) {
        assert.equal(blob, fakeBlob);
        downloadEvents.push("url");
        return "blob:aistory-report";
      },
      revokeObjectUrl(url) {
        assert.equal(url, "blob:aistory-report");
        revoked += 1;
      },
      createAnchor() {
        return {
          href: "",
          download: "",
          rel: "",
          click() {
            downloadEvents.push("click");
          },
          remove() {
            removed += 1;
          },
        };
      },
      appendAnchor(anchor) {
        assert.equal(anchor.href, "blob:aistory-report");
        assert.equal(anchor.download, STEAM_DEMO_REPORT_FILENAME);
        assert.equal(anchor.rel, "noopener");
        downloadEvents.push("append");
      },
    };
    downloadSteamDemoReportInBrowser(bundle, environment);
    assert.deepEqual(downloadEvents, ["blob", "url", "append", "click"]);
    assert.equal(removed, 1);
    assert.equal(revoked, 1);

    let copied = "";
    let downloadCount = 0;
    let copyCount = 0;
    const delivered = await deliverSteamDemoReportLocally(bundle, {
      download() {
        downloadCount += 1;
      },
      copy() {
        copyCount += 1;
      },
    });
    assert.deepEqual(delivered, { status: "download-started" });
    assert.equal(downloadCount, 1);
    assert.equal(copyCount, 0);

    const fallbackAdapters: SteamDemoReportDeliveryAdapters = {
      download() {
        throw new Error("download_blocked");
      },
      copy(text) {
        copyCount += 1;
        copied = text;
      },
    };
    assert.deepEqual(
      await deliverSteamDemoReportLocally(bundle, fallbackAdapters),
      { status: "copied" },
    );
    assert.equal(copied, bundle.json);
    assert.deepEqual(
      await deliverSteamDemoReportLocally(bundle, {
        download() {
          throw new Error("download_blocked");
        },
        copy() {
          throw new Error("clipboard_blocked");
        },
      }),
      { status: "unavailable" },
    );
    assert.deepEqual(
      await copySteamDemoReportLocally(bundle, (text) => {
        assert.equal(text, bundle.json);
      }),
      { status: "copied" },
    );

    assert.equal(networkCalls, 0);
    process.stdout.write("Steam Demo redacted report tests passed.\n");
  } finally {
    globalThis.fetch = originalFetch;
  }
}

await run();
