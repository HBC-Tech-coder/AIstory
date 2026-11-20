export type CredentialMode = "user_byok" | "platform_managed";

/** Product-level custody choice. `user_byok` remains the legacy generation
 * transport tag for the device path until each provider gains a hosted
 * resolver adapter. */
export type CredentialCustodyMode =
  | "device_byok"
  | "hosted_byok"
  | "platform_managed";

export type ByokPersistence = "session" | "local";

export type CredentialModality =
  | "text"
  | "image"
  | "vision"
  | "tts"
  | "video";
