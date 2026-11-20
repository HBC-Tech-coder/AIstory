export const STEAM_CHANNEL = "steam";
export const STEAM_RELEASE_PLATFORM = "windows-x64";
export const STEAM_DECK_RUNTIME = "proton-planned";

export const STEAM_RELEASE_PLATFORMS = ["windows-x64", "linux-x64"] as const;
export type SteamReleasePlatform = (typeof STEAM_RELEASE_PLATFORMS)[number];

export const STEAM_DECK_VIEWPORTS = Object.freeze([
  Object.freeze({ width: 1280, height: 800, label: "Steam Deck 16:10" }),
  Object.freeze({ width: 1280, height: 720, label: "Steam Deck docked 16:9" }),
]);

export const STEAM_DESKTOP_OFFLINE_POLICY = Object.freeze({
  authoredContent: true,
  publishedLocalMedia: true,
  localSaves: true,
  platformGeneration: false,
  remoteGeneration: false,
  realSms: false,
  formalCredits: false,
  recharge: false,
  hostedCredentialsBundled: false,
  deviceCredentialsBundled: false,
});

export function steamReleasePlatformLabel(
  platform: SteamReleasePlatform,
): string {
  return platform === "linux-x64" ? "Linux x64" : "Windows x64";
}

export type SteamworksCapability =
  | "identity"
  | "cloud"
  | "input"
  | "overlay"
  | "softKeyboard"
  | "wallet";

export type SteamworksCapabilityState = {
  capability: SteamworksCapability;
  available: boolean;
  reason:
    | "ready"
    | "feature-disabled"
    | "missing-app-id"
    | "adapter-unavailable"
    | "not-implemented";
};

export type SteamworksStatus = {
  configured: boolean;
  appIdConfigured: boolean;
  capabilities: SteamworksCapabilityState[];
};

export type SteamworksConfigInput = {
  enabled: boolean;
  appId?: string;
  adapterAvailable?: boolean;
};

const STEAMWORKS_P1_UNIMPLEMENTED = new Set<SteamworksCapability>([
  "identity",
  "cloud",
  "input",
  "overlay",
  "softKeyboard",
  "wallet",
]);

export function resolveSteamworksStatus(
  input: SteamworksConfigInput,
): SteamworksStatus {
  const appIdConfigured = /^[1-9]\d{1,11}$/.test(input.appId?.trim() || "");
  const configured =
    input.enabled === true &&
    appIdConfigured &&
    input.adapterAvailable === true;
  const capabilities = (
    [
      "identity",
      "cloud",
      "input",
      "overlay",
      "softKeyboard",
      "wallet",
    ] as const
  ).map((capability): SteamworksCapabilityState => {
    if (!input.enabled) {
      return { capability, available: false, reason: "feature-disabled" };
    }
    if (!appIdConfigured) {
      return { capability, available: false, reason: "missing-app-id" };
    }
    if (!input.adapterAvailable) {
      return { capability, available: false, reason: "adapter-unavailable" };
    }
    if (STEAMWORKS_P1_UNIMPLEMENTED.has(capability)) {
      return { capability, available: false, reason: "not-implemented" };
    }
    return { capability, available: true, reason: "ready" };
  });
  return { configured, appIdConfigured, capabilities };
}

export type SteamExternalTarget = {
  id: string;
  label: string;
  url: string;
};

export const STEAM_DEFAULT_EXTERNAL_TARGETS: readonly SteamExternalTarget[] = [
  {
    id: "aistory-github",
    label: "AIstory 项目主页",
    url: "https://github.com/HBC-Tech-coder/AIstory",
  },
] as const;

export type SteamExternalTargetDecision =
  | {
      allowed: true;
      id: string;
      label: string;
      url: string;
      domain: string;
    }
  | {
      allowed: false;
      reason:
        | "invalid-url"
        | "unsupported-protocol"
        | "not-allowlisted"
        | "embedded-credentials";
    };

function canonicalExternalUrl(input: string): URL | null {
  try {
    const parsed = new URL(input);
    if (parsed.username || parsed.password) return null;
    parsed.hash = "";
    return parsed;
  } catch {
    return null;
  }
}

export function decideSteamExternalTarget(
  input: string,
  allowlist: readonly SteamExternalTarget[] = STEAM_DEFAULT_EXTERNAL_TARGETS,
): SteamExternalTargetDecision {
  const parsed = canonicalExternalUrl(input);
  if (!parsed) {
    return { allowed: false, reason: "invalid-url" };
  }
  if (parsed.protocol !== "https:") {
    return { allowed: false, reason: "unsupported-protocol" };
  }

  for (const target of allowlist) {
    const allowedUrl = canonicalExternalUrl(target.url);
    if (!allowedUrl) continue;
    if (
      parsed.origin === allowedUrl.origin &&
      parsed.pathname === allowedUrl.pathname &&
      parsed.search === allowedUrl.search
    ) {
      return {
        allowed: true,
        id: target.id,
        label: target.label,
        url: parsed.toString(),
        domain: parsed.hostname,
      };
    }
  }
  return { allowed: false, reason: "not-allowlisted" };
}

export type SteamGamepadAction =
  | "activate"
  | "back"
  | "previous"
  | "next"
  | "up"
  | "down"
  | "left"
  | "right"
  | "fullscreen";

export function steamGamepadActionForButton(
  buttonIndex: number,
): SteamGamepadAction | null {
  switch (buttonIndex) {
    case 0:
      return "activate";
    case 1:
      return "back";
    case 4:
      return "previous";
    case 5:
      return "next";
    case 9:
      return "fullscreen";
    case 12:
      return "up";
    case 13:
      return "down";
    case 14:
      return "left";
    case 15:
      return "right";
    default:
      return null;
  }
}

export function shouldShowSteamCompletionCta(input: {
  channel?: string | null;
  authoredNodeKind?: string | null;
  mediaKind?: "image" | "video" | null;
  videoInteractionUnlocked?: boolean;
}): boolean {
  if (input.channel !== STEAM_CHANNEL) return false;
  if (input.authoredNodeKind !== "ending") return false;
  if (
    input.mediaKind === "video" &&
    input.videoInteractionUnlocked !== true
  ) {
    return false;
  }
  return true;
}

export type SteamMediaSupport = {
  mp4H264Aac: boolean;
  webmVp9Opus: boolean;
  preferred: "webm-vp9-opus" | "mp4-h264-aac" | "unsupported";
};

export function detectSteamMediaSupport(
  canPlayType: (mime: string) => string,
): SteamMediaSupport {
  const mp4H264Aac =
    canPlayType('video/mp4; codecs="avc1.42E01E, mp4a.40.2"') !== "";
  const webmVp9Opus =
    canPlayType('video/webm; codecs="vp09.00.10.08, opus"') !== "";
  return {
    mp4H264Aac,
    webmVp9Opus,
    preferred: webmVp9Opus
      ? "webm-vp9-opus"
      : mp4H264Aac
        ? "mp4-h264-aac"
        : "unsupported",
  };
}
