type AIstoryDesktopSteamworksCapability = {
  capability:
    | "identity"
    | "cloud"
    | "input"
    | "overlay"
    | "softKeyboard"
    | "wallet";
  available: boolean;
  reason:
    | "ready"
    | "feature-disabled"
    | "missing-app-id"
    | "adapter-unavailable"
    | "not-implemented";
};

type AIstoryDesktopRuntimeInfo = {
  appVersion: string;
  platform: "steam-desktop";
  releasePlatform: "windows-x64" | "linux-x64";
  packaged: boolean;
  steamworks: {
    configured: boolean;
    appIdConfigured: boolean;
    capabilities: AIstoryDesktopSteamworksCapability[];
  };
};

type AIstoryDesktopExternalResult = {
  status: "opened" | "denied" | "unavailable" | "failed";
  domain?: string;
  reason?: string;
};

interface Window {
  aistoryDesktop?: {
    getRuntimeInfo: () => Promise<AIstoryDesktopRuntimeInfo>;
    openExternal: (url: string) => Promise<AIstoryDesktopExternalResult>;
    requestSoftKeyboard: (bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
      multiline: boolean;
    }) => Promise<{ status: "opened" | "unavailable" | "failed" }>;
    setFullscreen: (enabled: boolean) => Promise<{ fullscreen: boolean }>;
    toggleFullscreen: () => Promise<{ fullscreen: boolean }>;
  };
}
