const CAPABILITIES = Object.freeze([
  "identity",
  "cloud",
  "input",
  "overlay",
  "softKeyboard",
  "wallet",
]);

export function createSteamworksAdapter(env = process.env) {
  const enabled = env.AISTORY_STEAMWORKS_ENABLED === "true";
  const appId = String(env.AISTORY_STEAM_APP_ID || "").trim();
  const appIdConfigured = /^[1-9]\d{1,11}$/.test(appId);

  // P1 deliberately ships no native Steamworks binding. The adapter remains
  // fail-closed until an approved AppID, SDK integration and per-capability
  // mechanical test are all present.
  const adapterAvailable = false;
  const configured = enabled && appIdConfigured && adapterAvailable;
  const capabilities = CAPABILITIES.map((capability) => ({
    capability,
    available: false,
    reason: !enabled
      ? "feature-disabled"
      : !appIdConfigured
        ? "missing-app-id"
        : "adapter-unavailable",
  }));

  return Object.freeze({
    status: Object.freeze({
      configured,
      appIdConfigured,
      capabilities: Object.freeze(capabilities),
    }),
    requestSoftKeyboard() {
      return { status: "unavailable" };
    },
  });
}
