# Shared Stories v1 — Operations Runbook

Scope: replay-only sharing of already-generated stories. This subsystem never
generates text, calls a model/provider, charges credits, mirrors remote media,
or stores authored source. All generation remains outside this feature.

## 1. Enablement

The store is **off by default**. Every request reads these environment values;
there is no compile-time switch, in-memory fallback, or auto-created root.

| Variable | Required value |
| --- | --- |
| `AISTORY_SHARED_STORIES_MODE` | exactly `filesystem-v1` |
| `AISTORY_SHARED_STORIES_ROOT` | absolute path to an existing, dedicated, host-provisioned directory |

If either value is missing or wrong, API calls return `503` with
`{"error":"disabled"}`. The service never creates the root. The directory must
already exist, be writable by the app user, and contain no symlinks/reparse
points in any existing ancestor (including the root itself). Do not point this
at a directory shared with unrelated application data.

Recommended provisioned layout:

```text
AISTORY_SHARED_STORIES_ROOT/
  state.json          # only written by the app
  .lock/              # transient cross-process lock directory
```

`state.json` is a single canonical document. Each mutation is written to a
server-generated temp file in the same directory with `wx`, fsynced, then
atomically renamed over `state.json`. Do not edit it by hand.

## 2. Limits

| Limit | Value |
| --- | --- |
| Request body | 1 MiB, enforced by streaming (Content-Length is only a fast precheck) |
| Shared state file | 32 MiB |
| Stories per owner | 100 |
| Stories globally | 1,000 |
| Scenes per document | 1–200 (empty `scenes` is rejected) |
| Beats per document (total) | 1,000 |
| Choices per beat | 20 |
| Title / sourceId | 200 characters each, non-empty |
| Inline image | 1 MiB decoded |
| List page | default 20, maximum 50 |

Capacity, revision, and lock contention failures are `409`. Oversized bodies
and oversized state are `413`. Disabled or failed storage is `503`.

Id uniqueness is scoped like the replay runtime expects: scene ids are unique
document-wide, beat ids are unique **within each scene**, and choice ids are
unique **within each beat**. Ordinary sessions may reuse `b1` in every scene and
`c1` in multiple beats; duplicates in the same scope are rejected.

## 3. Locking and concurrency

Every create/update transaction takes a cross-process exclusive lock by
`mkdir(root/.lock)`, bounded to about one second. If the lock cannot be acquired
the request fails closed with `409 lock_busy`.

- The lock is **never** auto-broken, aged out, or deleted while another process
  may hold it.
- A crashed process can leave `.lock` behind. An operator may remove it **only**
  after confirming no app process is running and no state write is in progress:

  ```sh
  # Stop all app instances first, then:
  rmdir "$AISTORY_SHARED_STORIES_ROOT/.lock"
  ```

- Never remove the lock from inside the application, a cron job, or a retry
  loop. If `.lock` is a file or symlink instead of a directory, treat it as an
  incident: preserve it for investigation rather than deleting blindly.

Reads (`GET`) use an atomic `state.json` snapshot and do not take the lock.
A cursor is an opaque base64url offset plus sort marker
(`createdAt:desc,id:asc`). Cursors are validated strictly; a cursor for `mine`
cannot be replayed against the public list or vice versa.

## 4. Corruption and recovery

`state.json` is validated on every read: schema name, exact key sets, UUIDs,
bounded strings, visibility, revisions, canonical document key order, content
hash, scene count, cover URL, duplicate ids, owner/source uniqueness, and caps.
Any mismatch returns `503 store_corrupt`; reads never reset or overwrite a
corrupted store. A missing `state.json` is an empty store; any other read error
is a failure.

Recovery procedure:

1. Stop all app instances.
2. Preserve the bad file and lock:

   ```sh
   cp "$AISTORY_SHARED_STORIES_ROOT/state.json" /secure/incident/state.json.bad
   ```

3. Validate the copy offline against the schema. If recoverable, restore a
   canonical file only while every instance is stopped.
4. If not recoverable, move the file aside and start with an empty store. This
   intentionally discards shared stories; notify owners.
5. Start one instance, create/read a test story, then start the rest.

## 5. Reverse proxy / CSRF / shared origin

`POST` and `PATCH` require `Content-Type: application/json` and an `Origin`
header. The origin gate is configured separately from the storage flag:

| Variable | Required value |
| --- | --- |
| `AISTORY_SHARED_STORIES_ORIGIN` | Production: exactly `https://play.hibcglobal.com` (any canonical HTTPS origin the host actually serves) |
| `AISTORY_SHARED_STORIES_INTERNAL_ORIGIN` | Optional, default **off**. Exact internal transport origin, for example `http://127.0.0.1:4200`. Set only when the proxy forwards the public `Host`/`Origin` but Next constructs `Request.url` from its listening socket. |

The external value must be the **exact canonical** origin:

- Public hosts require `https`. A local production-build preview may explicitly pin an exact strict loopback HTTP origin, for example `http://127.0.0.1:4335`; request Host and Origin must match that pin. This exception does not permit HTTP on public hosts.
- no path, query, fragment, credentials, trailing slash, default port, or case
  spelling drift — the original string must equal `new URL(value).origin`
  byte-for-byte;
- a missing, empty, malformed, or non-HTTPS non-loopback value fails closed with
  `503` (`origin_not_configured` / `origin_misconfigured`).

### Internal transport pin (optional, default off)

`next start -H 127.0.0.1 -p 4200` constructs the App Route `Request.url` from
that listening address and port, not from the public reverse-proxy Host. A
verified HTTPS proxy that forwards `Host: play.hibcglobal.com` and
`Origin: https://play.hibcglobal.com` therefore produces a request whose URL is
`http://127.0.0.1:4200/api/shared-stories`. Pin exactly that transport origin
instead of trusting proxy headers:

```ini
# Public HTTPS deployment with Next bound to 127.0.0.1:4200 behind Nginx
AISTORY_SHARED_STORIES_ORIGIN=https://play.hibcglobal.com
AISTORY_SHARED_STORIES_INTERNAL_ORIGIN=http://127.0.0.1:4200
```

Trust boundary for the pin:

- allowed only when `AISTORY_SHARED_STORIES_ORIGIN` is a configured **public
  HTTPS** origin — never local preview, never missing external origin, never an
  external loopback origin;
- must be an exact canonical **plain-HTTP** origin on exactly `127.0.0.1`,
  `localhost`, or `[::1]`, and should include the exact internal port (for
  example `:4200`); the request URL's origin must match byte-for-byte after URL
  parsing;
- no whitespace, uppercase spelling, credentials, trailing slash, path, query,
  fragment, non-HTTP scheme, default-port form (`:80`), or shorthand/octal/
  integer IPv4 spelling; the raw value must equal `new URL(value).origin`;
- an explicitly empty value is invalid, not "off"; an invalid or
  mode-incompatible pin fails closed with `503 origin_misconfigured`;
- absent means default off and preserves the previous behavior: the request URL
  must have the configured external origin host.

### Pinned-origin checks for mutations

- `Origin` must exactly equal the configured external canonical origin (required
  on every mutation; cookies alone are never sufficient);
- the `Host` header must equal the configured external origin host;
- `new URL(request.url).host` must equal the external origin host **or** the
  exact `new URL(request.url).origin` must equal the configured internal pin;
- the internal pin never broadens the accepted caller `Origin` or `Host`, so
  presenting the internal origin as `Origin`/`Host` is rejected;
- embedded credentials, non-`/` origin paths, queries, fragments, and
  `Sec-Fetch-Site: cross-site` are rejected;
- `X-Forwarded-Proto` and `X-Forwarded-Host` are intentionally **never**
  consulted. Do not enable `experimental.trustHostHeader` or another global
  proxy-trust switch to work around this; either keep the request-URL host equal
  to the public host or set the exact internal transport pin.

Local preview only (never production):

- `AISTORY_SHARED_STORIES_ORIGIN` may be omitted only when
  `NODE_ENV !== "production"`;
- the actual request URL must be plain `http` on a loopback host (`localhost`,
  `127.0.0.1`, `[::1]`), `Origin` must equal the request-URL origin, and `Host`
  must match the request-URL host;
- `AISTORY_SHARED_STORIES_INTERNAL_ORIGIN` must not be set in local preview
  mode; a pin present there (or with a missing/loopback external origin) fails
  closed.

If the proxy rewrites the public host to an internal name or port that is not
the exact configured pin, mutations correctly fail. Pin the exact transport
origin only in public HTTPS deployments; do not widen it to another host, port,
scheme, or arbitrary loopback alias. In production a missing external shared
origin is `503`, not an open fallback.

## 6. Authorization and visibility

- `POST` and `PATCH` always require a verified session (`requireUser()` with
  anonymous fallback disabled). The owner is derived only from the verified
  `userId`/`authType`; owner is never read from the body.
- Owner identities are stored as a one-way SHA-256 owner key. They are never
  exposed in DTOs or errors.
- `GET /api/shared-stories/:id` is anonymous and returns only `public` stories.
  `hidden` and unknown ids both return `404`, including for the author.
- Authors manage hidden stories through `GET /api/shared-stories?mine=1`.
- `sourceId` appears only in `?mine=1` summaries. Mutation responses and public
  views omit it.

Endpoints:

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| `POST` | `/api/shared-stories` | `{sourceId,title,visibility?,expectedRevision?,document}` | story item directly (`SharedSummary`) |
| `GET` | `/api/shared-stories` | `?mine=1`, `limit`, `cursor` | `{items,nextCursor}` |
| `GET` | `/api/shared-stories/:id` | — | story item directly with `document`; public only |
| `PATCH` | `/api/shared-stories/:id` | `{visibility,expectedRevision}` | story item directly (`SharedSummary`) |

Create/detail/patch responses are **not** wrapped in `{story: ...}`. Only the
list endpoint has an envelope (`{items,nextCursor}`).

Errors are always:

```json
{ "error": "human-safe text", "code": "stable_error_code" }
```

`error` is safe to display and never contains owner ids, paths, or internal
messages; `code` is the stable machine-readable value (for example
`csrf_rejected`, `invalid_request`, `not_found`, `revision_conflict`,
`origin_not_configured`, `store_corrupt`, `disabled`). Don't parse the text.

Revision rules:

- New owner+sourceId: server-generated UUID, revision `1`, visibility defaults
  to `public`.
- Existing owner+sourceId with identical title/document/effective visibility:
  idempotent, same revision.
- Any change requires `expectedRevision` equal to the current revision and
  increments it by one.
- Omitting `visibility` on an update preserves the existing value, including
  `hidden`.
- Wrong owner is indistinguishable from unknown id (`404`).

All responses set `Cache-Control: no-store`.

## 7. Media

Scene images are validated locally with **no network access, proxies, HEAD
requests, or app-server fetches**. Accepted forms:

1. Canonical `data:image/png|jpeg|webp;base64,...` with decoded bytes ≤ 1 MiB;
   padding/alphabet must be canonical and magic bytes must match the declared
   MIME type.
2. Exact cache paths `/api/aistory-cache/media/<64 lowercase hex>.<png|jpg|jpeg|webp|avif|gif>`
   whose file exists under `MEDIA_CACHE_DIR` (from `AISTORY_CACHE_DIR`), is a
   regular non-symlink file, stays under the cache root, and has matching magic
   bytes.
3. Fixed published static catalog: exactly 122 public first-scene preset paths
   (`/home/firstscene/f0..f29.webp` + `m0..m31.webp`, and
   `/home/firstscene-portrait/f0..f29.webp` + `m0..m29.webp`). The catalog is
   embedded in the browser-safe
   `lib/shared-stories/publishedStaticMedia.ts` module and is the default
   allow-list. A host may inject an explicit override manifest; an empty set
   denies every static path. Matching is exact-string only — no prefix, glob,
   case folding, percent-encoding, query, fragment, traversal, or extension
   inference. A static image is never trusted merely because it exists under
   `public/`: it must also be a regular non-symlink file under the canonical
   public root, have matching raster magic bytes, and be at most 16 MiB (the
   size is checked before reading). The catalog authorizes already-public preset
   media only; it never authorizes authored/restricted scene auto-exports.

The configured (or default `<cwd>/public`) directory is a trusted deployment
root. It is resolved once with `realpath` to its canonical directory, so the
root itself may be a Windows deployment junction. Any symlink/junction component
*below* that canonical root is rejected, and the resolved asset must remain
inside the canonical root. The cache path checks are separate and unchanged.

### Host-provisioned persistent media path

Production must set `AISTORY_CACHE_DIR` to a host-verified **persistent**
directory; scene images then resolve under `$AISTORY_CACHE_DIR/media`. The
verified host uses `AISTORY_CACHE_DIR=/data/aistory/cache`, so shared scene URLs
resolve to `/data/aistory/cache/media/<hash>.<ext>` and must still be present
and readable after restarts/redeploys. The fixed published preset catalog does
not replace this: stories that reference generated/cached images still depend on
the host's persistent cache surviving redeploys.

The app's fallback `<cwd>/.aistory-cache/media` is a local-development default
only. Do not rely on it in production: container filesystems are usually
ephemeral, so shared stories would start failing media validation. Verify that
the configured path is the same directory served by the
`/api/aistory-cache/media/` route. An image that is missing, unreadable, a
symlink, outside the cache root, wrongly typed, or larger than the byte cap
rejects the whole request (`400 media_invalid`); images are never silently
omitted. Existing shared stories are not rewritten or repaired when media
disappears — validation fails closed on the next use.

Rejected: SVG, `blob:`, `file:`, `http(s)`, localhost URLs, protocol-relative
URLs, data URLs for non-images, query strings, fragments, percent-encoded
paths, traversal, and missing/inaccessible local files.

### Provenance, hiding, and revocation

Media validation proves the client referenced a locally public/cached asset; it
cannot prove the asset was not authored privately and copied into the cache.
Reject `authoredStory` and similar markers at the document boundary, and rely on
the UI to prevent sharing authored source material.

Hiding a shared story only removes it from public list/detail responses: the
story link returns `404` and the story is no longer served. It is **not** a
revocation mechanism. Existing public cached images, image bytes already served,
and copies already downloaded by clients cannot be revoked. Never delete shared
media as a way to hide a story, and never delete files under the shared media
cache to enforce visibility. Treat hidden as "no longer served", not as DRM.

## 8. Operational checks

- Confirm the storage env values and `AISTORY_SHARED_STORIES_ORIGIN` are set in
  the running process before reporting a `503`.
- Set `AISTORY_SHARED_STORIES_INTERNAL_ORIGIN` only for a public HTTPS
  deployment whose proxy forwards the public `Host`/`Origin` while Next builds
  `Request.url` from its loopback listen address. Confirm the exact value
  (`http://127.0.0.1:4200`, `http://localhost:4200`, or
  `http://[::1]:4200`) matches the instance's bind address and port; leave it
  unset otherwise. Never enable forwarded-header trust to repair a mismatch.
- Verify root permissions and the absence of symlinks/reparse points.
- Verify `AISTORY_CACHE_DIR` is the host-provisioned persistent path (for this
  host, `/data/aistory/cache`) and that `<AISTORY_CACHE_DIR>/media` exists.
- Verify the deployment `public/` root still contains the 122 published preset
  files from the fixed catalog, and that the root's canonical directory has no
  nested symlinks/junctions leading outside it.
- Check for a stale `.lock` only after stopping all instances.
- Check free space and `state.json` size against the 32 MiB cap.
- Tail app logs for `"[shared-stories] unexpected failure"`; do not expose raw
  logs to clients. Domain failures are already mapped without internal ids.
- Health check: create a throwaway public story through the UI, fetch it
  anonymously, hide it, confirm anonymous `404`, then delete/ignore it.
