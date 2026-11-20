/**
 * Default-off local integration tuple for the Linghao Passport v4 test surface.
 *
 * The selector and every non-secret local posture check are evaluated before
 * the protected secret-file reader is invoked. There is deliberately no
 * environment variable that carries the secret value.
 */

import {
  LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_ENV,
  LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_PATH,
  readLinghaoPassportV4ClientSecretFile,
  type LinghaoPassportV4SecretReader,
} from "./linghaoPassportV4SecretFile";
import {
  LINGHAO_PASSPORT_V4_CLIENT_ID,
  LINGHAO_PASSPORT_V4_DISPLAY_NAME,
  LINGHAO_PASSPORT_V4_ISSUER,
  LINGHAO_PASSPORT_V4_REDIRECT_URI,
  LINGHAO_PASSPORT_V4_RETURN_PATH,
} from "./linghaoPassportV4Public";

export {
  LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_ENV,
  LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_PATH,
  LINGHAO_PASSPORT_V4_CLIENT_ID,
  LINGHAO_PASSPORT_V4_DISPLAY_NAME,
  LINGHAO_PASSPORT_V4_ISSUER,
  LINGHAO_PASSPORT_V4_REDIRECT_URI,
  LINGHAO_PASSPORT_V4_RETURN_PATH,
};

export const LINGHAO_PASSPORT_V4_LOCAL_SELECTOR_ENV =
  "AISTORY_LINGHAO_PASSPORT_V4_LOCAL_MODE";
export const LINGHAO_PASSPORT_V4_LOCAL_SELECTOR_VALUE =
  "aistory-linghao-passport-v4-local-v1:enabled";

export const LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN = "http://127.0.0.1:4200";
export const LINGHAO_PASSPORT_V4_HOST = "127.0.0.1:4200";
export const LINGHAO_PASSPORT_V4_POST_LOGOUT_REDIRECT_URI =
  "http://127.0.0.1:4200/auth/linghao-passport-v4";
export const LINGHAO_PASSPORT_V4_AUTHENTICATED_REDIRECT =
  "http://127.0.0.1:4200/auth/linghao-passport-v4?status=authenticated";

export const LINGHAO_PASSPORT_V4_CALLBACK_PATH =
  "/api/auth/linghao-passport-v4/callback";
export const LINGHAO_PASSPORT_V4_COOKIE_PATH =
  "/api/auth/linghao-passport-v4";

export const LINGHAO_PASSPORT_V4_TRANSACTION_COOKIE =
  "aistory_linghao_passport_v4_tx_v1";
export const LINGHAO_PASSPORT_V4_SESSION_COOKIE =
  "aistory_linghao_passport_v4_session_v1";
export const LINGHAO_PASSPORT_V4_FAMILY_COOKIE =
  "aistory_linghao_passport_v4_family_v1";
export const LINGHAO_PASSPORT_V4_LOGOUT_COOKIE =
  "aistory_linghao_passport_v4_logout_v1";

export const LINGHAO_PASSPORT_V4_SCOPES = [
  "openid",
  "profile",
  "email",
] as const;

export const LINGHAO_PASSPORT_V4_TRANSACTION_TTL_SECONDS = 10 * 60;
export const LINGHAO_PASSPORT_V4_LOGOUT_TTL_SECONDS = 5 * 60;
export const LINGHAO_PASSPORT_V4_SESSION_IDLE_MS = 30 * 60 * 1000;
export const LINGHAO_PASSPORT_V4_SESSION_ABSOLUTE_MS = 7 * 24 * 60 * 60 * 1000;
export const LINGHAO_PASSPORT_V4_DRAFT_MAX_BYTES = 4096;

/** Explicit process-local capacities. No unreachable state may grow without bound. */
export const LINGHAO_PASSPORT_V4_MAX_TRANSACTIONS = 64;
export const LINGHAO_PASSPORT_V4_MAX_SESSIONS = 64;
export const LINGHAO_PASSPORT_V4_MAX_FAMILIES = 64;
export const LINGHAO_PASSPORT_V4_MAX_LOGOUT_RESULTS = 64;
export const LINGHAO_PASSPORT_V4_MAX_PROFILES = 128;
export const LINGHAO_PASSPORT_V4_MAX_REFRESH_FLIGHTS = 64;
export const LINGHAO_PASSPORT_V4_MAX_RATE_BUCKETS = 32;
export const LINGHAO_PASSPORT_V4_START_RATE_WINDOW_MS = 10_000;
export const LINGHAO_PASSPORT_V4_START_RATE_MAX = 8;
export const LINGHAO_PASSPORT_V4_INBOUND_BODY_TIMEOUT_MS = 5_000;

export type LinghaoPassportV4Environment = Readonly<
  Record<string, string | undefined>
>;

export interface LinghaoPassportV4EnabledConfig {
  readonly issuer: typeof LINGHAO_PASSPORT_V4_ISSUER;
  readonly clientId: typeof LINGHAO_PASSPORT_V4_CLIENT_ID;
  readonly clientSecret: string;
  readonly publicOrigin: typeof LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN;
  readonly redirectUri: typeof LINGHAO_PASSPORT_V4_REDIRECT_URI;
  readonly postLogoutRedirectUri: typeof LINGHAO_PASSPORT_V4_POST_LOGOUT_REDIRECT_URI;
  readonly scopes: typeof LINGHAO_PASSPORT_V4_SCOPES;
}

export interface LinghaoPassportV4ConfigOptions {
  /** Test seam only; production uses the protected file reader. */
  readonly readSecretFile?: LinghaoPassportV4SecretReader;
  readonly platform?: NodeJS.Platform;
}

function exactLoopbackOrigin(value: string, expected: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.origin === expected &&
      url.pathname === "/" &&
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

/**
 * True only for the exact opt-in selector, a non-production runtime, and
 * Windows. This function never touches the secret file or its path.
 */
export function linghaoPassportV4LocalModeRequested(
  env: LinghaoPassportV4Environment,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== "win32") return false;
  if (env.NODE_ENV === "production") return false;
  return (
    env[LINGHAO_PASSPORT_V4_LOCAL_SELECTOR_ENV] ===
    LINGHAO_PASSPORT_V4_LOCAL_SELECTOR_VALUE
  );
}

/**
 * The exact secret-file reference, or null. Calling this function performs no
 * filesystem operation; it only compares already-present non-secret posture.
 */
export function linghaoPassportV4SecretFileReference(
  env: LinghaoPassportV4Environment,
  platform: NodeJS.Platform = process.platform,
): string | null {
  if (!linghaoPassportV4LocalModeRequested(env, platform)) return null;
  if (
    !exactLoopbackOrigin(
      LINGHAO_PASSPORT_V4_ISSUER,
      LINGHAO_PASSPORT_V4_ISSUER,
    ) ||
    !exactLoopbackOrigin(
      LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN,
      LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN,
    )
  ) {
    return null;
  }
  return env[LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_ENV] ===
    LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_PATH
    ? LINGHAO_PASSPORT_V4_CLIENT_SECRET_FILE_PATH
    : null;
}

/**
 * Loads the confidential client configuration only after the exact local
 * selector, production posture, platform, and exact file reference pass.
 * Callers must fail closed without exposing a reason.
 */
export function loadLinghaoPassportV4Config(
  env: LinghaoPassportV4Environment,
  options: LinghaoPassportV4ConfigOptions = {},
): LinghaoPassportV4EnabledConfig | null {
  const platform = options.platform ?? process.platform;
  const secretFile = linghaoPassportV4SecretFileReference(env, platform);
  if (secretFile === null) return null;

  let secret: string;
  try {
    secret = (options.readSecretFile ??
      ((filePath) =>
        readLinghaoPassportV4ClientSecretFile(filePath, { platform })))(
      secretFile,
    );
  } catch {
    return null;
  }
  if (
    typeof secret !== "string" ||
    secret.length < 32 ||
    secret.length > 256 ||
    !/^[\x21-\x7e]+$/.test(secret)
  ) {
    return null;
  }

  return Object.freeze({
    issuer: LINGHAO_PASSPORT_V4_ISSUER,
    clientId: LINGHAO_PASSPORT_V4_CLIENT_ID,
    clientSecret: secret,
    publicOrigin: LINGHAO_PASSPORT_V4_PUBLIC_ORIGIN,
    redirectUri: LINGHAO_PASSPORT_V4_REDIRECT_URI,
    postLogoutRedirectUri:
      LINGHAO_PASSPORT_V4_POST_LOGOUT_REDIRECT_URI,
    scopes: LINGHAO_PASSPORT_V4_SCOPES,
  });
}

