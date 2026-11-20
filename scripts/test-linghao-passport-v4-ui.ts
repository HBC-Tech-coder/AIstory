import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  allowedLinghaoPassportV4AuthorizationUrl,
  isLinghaoPassportV4PublicEntryCapability,
} from "../components/LinghaoPassportV4LoginButton";
import {
  LINGHAO_PASSPORT_V4_PRODUCTION_CALLBACK,
  LINGHAO_PASSPORT_V4_PRODUCTION_CLIENT_ID,
  LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER,
} from "../lib/auth/linghaoPassportV4ProductionPublic";

const opaque = "a".repeat(43);
const exact = new URL("/login/oauth/authorize", LINGHAO_PASSPORT_V4_PRODUCTION_ISSUER);
exact.searchParams.set("response_type", "code");
exact.searchParams.set("client_id", LINGHAO_PASSPORT_V4_PRODUCTION_CLIENT_ID);
exact.searchParams.set("redirect_uri", LINGHAO_PASSPORT_V4_PRODUCTION_CALLBACK);
exact.searchParams.set("scope", "openid profile email");
exact.searchParams.set("state", opaque);
exact.searchParams.set("nonce", opaque);
exact.searchParams.set("code_challenge", opaque);
exact.searchParams.set("code_challenge_method", "S256");

assert.equal(allowedLinghaoPassportV4AuthorizationUrl(exact.href), exact.href);
for (const mutate of [
  (url: URL) => { url.protocol = "http:"; },
  (url: URL) => { url.hostname = "evil.invalid"; },
  (url: URL) => { url.pathname = "/other"; },
  (url: URL) => { url.searchParams.set("scope", "openid profile email offline_access"); },
  (url: URL) => { url.searchParams.append("state", opaque); },
  (url: URL) => { url.searchParams.set("redirect_uri", `${LINGHAO_PASSPORT_V4_PRODUCTION_CALLBACK}/near`); },
  (url: URL) => { url.searchParams.set("extra", "1"); },
]) {
  const candidate = new URL(exact);
  mutate(candidate);
  assert.equal(allowedLinghaoPassportV4AuthorizationUrl(candidate.href), null);
}
assert.equal(allowedLinghaoPassportV4AuthorizationUrl("not-a-url"), null);

assert.equal(isLinghaoPassportV4PublicEntryCapability({
  enabled: true,
  mode: "production",
  publicEntry: true,
}), true);
for (const value of [
  { enabled: true, mode: "production", publicEntry: false },
  { enabled: true, mode: "local", publicEntry: true },
  { enabled: true, mode: "production", publicEntry: true, extra: true },
  { enabled: "true", mode: "production", publicEntry: true },
]) assert.equal(isLinghaoPassportV4PublicEntryCapability(value), false);

const root = process.cwd();
const sources = Object.fromEntries(await Promise.all([
  "components/AuthModal.tsx",
  "components/LinghaoPassportV4EntryPanel.tsx",
  "components/UserChip.tsx",
  "components/CreditBalance.tsx",
  "lib/auth/accountLogoutRoute.ts",
  "app/api/credentials/hosted/route.ts",
  "lib/admin/security.ts",
  "app/api/admin/bootstrap/route.ts",
].map(async (file) => [file, await readFile(path.join(root, file), "utf8")] as const)));

assert.match(sources["components/AuthModal.tsx"]!, /LinghaoPassportV4LoginBoundary/);
assert.match(sources["components/AuthModal.tsx"]!, /!requirement && !phoneProofOnly/);
assert.match(sources["components/LinghaoPassportV4EntryPanel.tsx"]!, /旧登录入口（回退）/);
assert.match(sources["components/UserChip.tsx"]!, /PASSPORT_V4_SESSION_UNAVAILABLE/);
const entryPanelSource = sources["components/LinghaoPassportV4EntryPanel.tsx"]!;
assert.ok(
  entryPanelSource.indexOf("{account ? (")
    < entryPanelSource.indexOf(") : !capability.enabled || !capability.publicEntry ? ("),
  "an existing Passport session must keep its logout control when new public starts are disabled",
);
assert.match(sources["components/UserChip.tsx"]!, /!aiuserActive\.current && !wasPassport/);
assert.match(sources["components/CreditBalance.tsx"]!, /passport_no_wallet/);
assert.match(sources["components/CreditBalance.tsx"]!, /knownIsolatedIdentity/);
assert.match(sources["lib/auth/accountLogoutRoute.ts"]!, /Preserve every legacy phone/);
assert.match(sources["app/api/credentials/hosted/route.ts"]!, /const auth = await requireUser\(\)/);
assert.match(sources["app/api/credentials/hosted/route.ts"]!, /auth\.authType !== "phone"/);
assert.match(sources["lib/admin/security.ts"]!, /LINGHAO_PASSPORT_V4_PRODUCT_SESSION_COOKIE/);
assert.match(sources["app/api/admin/bootstrap/route.ts"]!, /hasLinghaoPassportV4ProductCookieHeader/);

console.log("PASS_LINGHAO_PASSPORT_V4_UI_BOUNDARY");
console.log(JSON.stringify({
  exactAuthorizationUrlOnly: true,
  publicEntryExactTupleOnly: true,
  legacyRollbackLabeled: true,
  oldBalanceFallbackBlocked: true,
  hostedByokFallbackBlocked: true,
  legacyAdminFallbackBlocked: true,
}));
