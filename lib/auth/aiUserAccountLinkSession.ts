import "server-only";
import { hkdfSync } from "node:crypto";
import { EncryptJWT, jwtDecrypt } from "jose";
import { oidcData } from "./aiUserOidcCallback";
import { AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION as tuple,
  AIUSER_OIDC_PRODUCTION_BETA_REGISTRATION_SHA256 as registration } from "./aiUserOidcProductionBeta";
import type { LinkIntent } from "./aiUserAccountLinkPolicy";

export const AIUSER_LINK_INTENT_COOKIE = "__Host-aistory_aiuser_link_v1";
export function clearAiUserLinkIntent(): string {
  return `${AIUSER_LINK_INTENT_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`;
}
export function createAiUserLinkIntents(secret: string, now: () => number) {
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(secret)) throw Error("ACCOUNT_LINK_REJECTED");
  const key = new Uint8Array(hkdfSync("sha256", secret, registration, "aistory.aiuser.account-link-intent.v1", 32));
  return {
    async seal(intent: LinkIntent): Promise<string> {
      oidcData(intent);
      const iat = Math.floor(now() / 1000);
      if (!Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= now() || intent.expiresAt - now() > 60000) throw Error("ACCOUNT_LINK_REJECTED");
      const token = await new EncryptJWT({ intent, registration })
        .setProtectedHeader({ alg: "dir", enc: "A256GCM", typ: "aistory-link-intent+jwt" })
        .setIssuer(tuple.publicOrigin).setAudience("aistory-aiuser-link-v1").setIssuedAt(iat)
        .setExpirationTime(Math.ceil(intent.expiresAt / 1000)).encrypt(key);
      return `${AIUSER_LINK_INTENT_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=60`;
    },
    async read(request: Request): Promise<LinkIntent | null> {
      try {
        const raw = request.headers.get("cookie") ?? "";
        const found = raw.split(";").map((part) => part.trim()).filter((part) => part.startsWith(`${AIUSER_LINK_INTENT_COOKIE}=`));
        if (raw.length > 16384 || found.length !== 1) return null;
        const token = found[0]!.slice(AIUSER_LINK_INTENT_COOKIE.length + 1);
        if (!/^[A-Za-z0-9_.-]{1,4096}$/.test(token)) return null;
        const { payload, protectedHeader } = await jwtDecrypt(token, key, { issuer: tuple.publicOrigin,
          audience: "aistory-aiuser-link-v1", keyManagementAlgorithms: ["dir"], contentEncryptionAlgorithms: ["A256GCM"],
          currentDate: new Date(now()), clockTolerance: 0, requiredClaims: ["iat", "exp", "iss", "aud"] });
        oidcData(payload);
        if (protectedHeader.typ !== "aistory-link-intent+jwt" || payload.registration !== registration
          || Object.keys(payload).sort().join(",") !== "aud,exp,iat,intent,iss,registration"
          || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
          || payload.iat! > Math.floor(now() / 1000) || payload.exp! - payload.iat! > 61) return null;
        // The policy rechecks every intent field, millisecond deadline and both current proofs.
        return payload.intent as LinkIntent;
      } catch { return null; }
    },
  };
}
