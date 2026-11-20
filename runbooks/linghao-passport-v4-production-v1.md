# Linghao Passport v4 production integration

Status: source-integrated and locally qualified; public entry remains default-off. It is not remotely registered, credentialed, deployed, gray-enabled or cut over.

## Frozen public tuple

- Product origin: `https://play.hibcglobal.com`.
- Issuer: `https://passport.hibcglobal.com`.
- Client and ID-token audience: `aistory-production-passport-v4-web`.
- Callback: `https://play.hibcglobal.com/api/auth/linghao-passport-v4/callback`.
- Post-logout return: `https://play.hibcglobal.com/auth/linghao-passport-v4`.
- Confidential Web, authorization code + PKCE S256, `client_secret_basic`, RS256.
- Scopes: exactly `openid profile email`; never add a resource, `product.access` or `offline_access` without a new review.
- Registration fingerprint: `7d97d64ac570d66e996e89033ad5061fbed3330cf026d70201bbf0cbfd13bd05`.

The source authority is `lib/auth/linghaoPassportV4ProductionContract.ts`. The Windows loopback tuple remains a separate local qualification fixture and must never be promoted.

## Product and rollback boundary

Passport identity resolves before AIUser, phone and legacy Supabase identity. A present but invalid Passport product cookie fails closed; only an absent cookie permits legacy fallback. Middleware does not refresh Supabase for a Passport browser.

The new principal is the domain-separated hash-only namespace `passport_v4:<principal-hash>`. It grants ordinary product access, browser BYOK and a distinct Studio owner namespace only. It grants no old-account read/link/migration, phone identity, administrator, membership, wallet, credits, platform-paid generation, cloud progress or Hosted BYOK.

The formal button appears only for the exact capability `{enabled:true, mode:"production", publicEntry:true}`. The old AIUser/phone entry remains visibly labeled as rollback. Passport logout durably tombstones Passport and clears only Passport cookies; it preserves old phone, AIUser and Supabase credentials. A failed durable logout returns 503 with zero optimistic cookie clears.

## Durable authority

Apply `supabase/migrations/20261119120000_linghao_passport_v4_auth_state_gate.sql` as database owner in its own transaction. Expected SHA-256:

`d173c3868e07ddcd64a9d9cc52df7d73b7862799f2cfe88ebf1aeb0a0dfade49`

The migration creates an empty, independent gate and no legacy migration/backfill. Every Passport table has FORCE RLS, no policies and no direct browser/service-role table grant. Operational RPCs recheck the exact posture and use database time. SQL stores keyed hashes plus application-AEAD envelopes, never plaintext state, nonce, PKCE verifier, subject, email, authorization code or provider token.

The authority provides atomic start reservation/rate limiting, callback consumption before validation/provider work, exact-idempotent callback commit, one live session per family, irreversible refresh-token claims, CAS refresh rotation, logout-first tombstones, revocation outbox/leases and one-time logout receipts. Completed callback replay is accepted only while the referenced durable session remains active and bound to the supplied family cookie.

Production scopes do not request `offline_access`. If the live IdP does not issue a refresh token under its approved policy, the product session expires within the verified token/one-hour bound and requires login again. If the IdP does issue one, only genuinely rotating refresh tokens are accepted by the durable refresh protocol. Do not widen scopes merely to avoid re-login.

## Protected runtime contract

Activation requires all of the following; source selectors alone are insufficient:

- `NODE_ENV=production` on Linux.
- `AISTORY_LINGHAO_PASSPORT_V4_PRODUCTION_MODE=aistory-linghao-passport-v4-production-v1:enabled`.
- Exact protected config reference `/etc/aistory/linghao-passport-v4/production-v1.json`.
- `AISTORY_LINGHAO_PASSPORT_V4_AUTH_REPOSITORY=supabase`.
- `AISTORY_LINGHAO_PASSPORT_V4_AUTH_DATABASE_GATE_VERSION=20261119120000`.
- Fresh client-secret and independent 32-byte state-seal-key leaves owned by the exact recipient UID/GID; parent directories may be root- or recipient-owned.
- Exact AIUser registry receipt and Host deployment receipt hashes in the protected config.
- Exact loopback proxy origin plus a trusted ingress-generated `x-aistory-passport-rate-bucket` 64-hex value; strip any client-supplied copy.
- Shared durable database posture proven across all workers/restarts.

The AIUser receipt must prove the exact registered tuple, live discovery/JWKS, client authentication, and wrong redirect/logout rejection. The Host receipt must prove protected ownership/modes, distinct keys, loopback binding, proxy/header scrubbing, multi-worker/restart behavior, ingress rate bucketing, rollback preservation and no old-data migration. Secrets must never enter Git, `.env*`, CLI arguments, browser state, cookies, DTOs, logs, chat or AIShare.

The public-entry selector is separate:

`AISTORY_LINGHAO_PASSPORT_V4_PUBLIC_ENTRY_MODE=aistory-linghao-passport-v4-public-entry-v1:enabled`

Keep it absent through database installation, package deployment and gray qualification.

## Mechanical acceptance already completed locally

- Focused production TypeScript and zero-warning ESLint.
- Existing local Passport suite: 19/19.
- Production contract: 60 assertions; no credential/old-data/admin/credit access.
- Durable authority unit: 41 assertions.
- PostgreSQL 16 migration/restart/concurrency: exactly one of two refresh claims accepted; refresh/logout and logout-first cleanup linearized; direct table access denied; 10/10 rate capacity accepted and request 11 denied.
- Synthetic production controller: public-entry gate, exact PKCE URL, signed callback, response-loss replay, family-bound completed replay, JWKS rotation refetch, safe local logout fallback, one-time upstream receipt and account-logout barrier.
- Formal UI/policy boundary, credential modes, billing, Hosted BYOK, Studio owner isolation, account projection, AuthModal static/browser smoke, and middleware isolated Next 16 build.
- Development Strict Mode browser smoke: one mocked one-time logout receipt POST despite effect replay, clean return URL, validated success notice retained, existing-session logout visible while new public starts are off, and zero unknown requests. Durable receipt behavior is proven separately by the production-controller and PostgreSQL tests.
- Identity rollback regression: authenticated/invalid Passport performs zero legacy lookup, absent Passport resumes legacy Supabase, and auth-disabled requests never probe Supabase.

These are local qualification receipts, not IdP registration, Host deployment or live-user acceptance.

## Release sequence

1. AIUser registers the exact client and returns the protected registry/live-discovery receipt plus a fresh credential reference. No secret value is shared through AIShare.
2. Host applies the exact migration, verifies posture `20261119120000`, installs protected config/key/receipt leaves, configures the trusted rate bucket and confirms loopback-only application reachability.
3. Build and scan an immutable candidate. Deploy it to lane 4201 with the production mode selected but public entry still off.
4. On 4201, qualify wrong Host/Origin/redirect/logout, real new-account login, safe account projection, two-account isolation, optional-refresh/no-refresh behavior, logout/end-session, restart/multi-worker replay, revocation recovery, old-data non-access and legacy rollback.
5. Enable the separate public-entry selector on 4201 only and repeat the browser acceptance. Confirm the formal button appears only for the exact capability tuple.
6. Promote the identical accepted build/config posture to 4200, repeat the smoke set, then retain the old login as explicit rollback until a separately approved retirement.

Any missing/ambiguous receipt, gate drift, protected-file drift, invalid Passport cookie, provider uncertainty or revocation uncertainty fails closed. Never hot-enable the public entry from source evidence alone.
