# Production video assets: Gate14 + private Aliyun OSS

Status: the repository contains the server-only implementation and zero-network
fake conformance tests. It has **not** applied Gate14 to staging/production and
has **not** contacted ECS IMDS, Supabase, or Aliyun OSS. Code completion is not
cloud enablement.

## Frozen artifacts

- Gate13 predecessor:
  `supabase/migrations/20260809113000_phone_admin_identity_gate.sql`
  - bytes: `9076`
  - SHA-256: `b922f10078f0eccda9fbb8fc9b821d4d6eb55acb1014db076f96d1788936d32e`
- Gate14 candidate:
  `supabase/migrations/20260811193000_production_video_asset_metadata_gate.sql`
  - bytes: `36034`
  - SHA-256: `2b506307e1b5e42a16ca79d4c3973e44d410cdd00d4228faed012252b3960dc6`
- OSS SDK: exact `ali-oss@6.23.0`, MIT, official repository
  `https://github.com/ali-sdk/ali-oss`.
  - approved registry tarball:
    `https://registry.npmjs.org/ali-oss/-/ali-oss-6.23.0.tgz`
  - npm SHA-1: `0bb236428307986ece0bf9243d77d7029d7b6ed2`
  - npm integrity:
    `sha512-FipRmyd16Pr/tEey/YaaQ/24Pc3HEpLM9S1DRakEuXlSLXNIJnu1oJtHM53eVYpvW3dXapSjrip3xylZUTIZVQ==`

Recompute and compare both migration digests before any apply. Gate1 through
Gate13 are immutable; do not edit or replay them.

## Server-only configuration contract

Values must come from the deployment secret/configuration system. Never place
real values in the repository, browser, support ticket, test fixture, or log.

| Variable | Required invariant |
| --- | --- |
| `AISTORY_VIDEO_ASSET_ADAPTER` | Exact adapter selector `aliyun_oss` |
| `AISTORY_VIDEO_METADATA_REPOSITORY` | Exact repository selector `supabase` |
| `AISTORY_VIDEO_ASSET_TENANT_ID` | One canonical lowercase tenant |
| `AISTORY_VIDEO_DATABASE_GATE_VERSION` | Exact Gate14 version `20260811193000` |
| `AISTORY_DATABASE_GATE_VERSION` | Exact shared Gate14 version `20260811193000` |
| `AISTORY_SUPABASE_SERVER_URL` | Server-only Supabase/PostgREST origin |
| `SUPABASE_SERVICE_ROLE_KEY` | Secret-manager value; never browser-prefixed |
| `AISTORY_VIDEO_OSS_BUCKET` | One fixed private bucket |
| `AISTORY_VIDEO_OSS_REGION` | One fixed OSS region |
| `AISTORY_VIDEO_OSS_INTERNAL_ENDPOINT` | Exact HTTPS internal endpoint for that region; no userinfo, port, path, query, or fragment |
| `AISTORY_VIDEO_OSS_PREFIX` | Exact `aistory/video-assets/v1` |
| `AISTORY_VIDEO_OSS_CREDENTIAL_SOURCE` | Exact `ecs_ram_role` |
| `AISTORY_VIDEO_OSS_ECS_RAM_ROLE_NAME` | Explicit allowlisted ECS RAM role name |
| `AISTORY_VIDEO_OSS_TIMEOUT_MS` | Bounded request timeout |
| `AISTORY_VIDEO_IMDS_CONNECT_TIMEOUT_MS` | Bounded IMDS connect timeout |
| `AISTORY_VIDEO_IMDS_READ_TIMEOUT_MS` | Bounded IMDS read timeout |
| `AISTORY_VIDEO_FFPROBE_PATH` | Absolute path to the controlled ffprobe binary |

The OSS credential path constructs only the explicit ECS RAM Role provider,
sets `disableIMDSv1=true`, disables background credential refresh, and remains
lazy until the first object operation. It never uses the default credential
chain or the SMS access-key variables. `DEBUG` must not enable `ali-oss`, any
`ali-oss:*` namespace, or a wildcard that includes them: the upstream SDK can
print signed headers. `NODE_TLS_REJECT_UNAUTHORIZED=0` is forbidden. Either
condition makes the capability return a generic 503 before any credential,
database, probe, or OSS call.

## Database apply gate

Gate14 advances the shared `production_identity_billing` gate. An old Gate13
application will fail closed against a Gate14 database, and the Gate14
application will fail closed against a Gate13 database. Schedule an explicit
maintenance window and keep identity, SMS, billing, hosted BYOK, and video
mutations disabled while switching.

1. Back up the isolated staging database and record Gate13 plus all four Gate13
   posture results.
2. Verify the frozen Gate13 and Gate14 bytes/SHA-256 values above.
3. Apply Gate14 once. Never run a reverse migration and never modify Gate1-13.
4. As the service role through a loopback/SSH-tunnel staging connection, verify
   `aistory_database_gate_status()` returns `20260811193000` and
   `aistory_video_asset_security_posture()` returns `true`. Re-run the database,
   admin, phone-admin, and hosted-BYOK posture functions.
5. Verify `video_assets` and `video_asset_idempotency` have ENABLE/FORCE RLS;
   public, anon, authenticated, and service_role have no direct table writes or
   reads. Only service_role may execute the six bounded video-asset RPCs and the
   posture RPC. Helper/projection functions remain ungranted.
6. With synthetic tenant/admin data only, verify atomic create and mutation,
   identical replay without a second audit row, conflicting replay rejection,
   revision CAS, draft-review-publish-offline transitions, cross-tenant denial,
   canonical object-key rejection, and transaction rollback of asset,
   idempotency, and audit together.
7. Capture a catalog snapshot proving the append-only trigger, SECURITY DEFINER
   functions, fixed `search_path`, constraints, grants, and RLS posture.

The repository's static test does not parse or apply SQL in a real PostgreSQL
instance. Steps 1-7 are mandatory external staging gates.

## Private bucket and least-privilege RAM role

The bucket must be private. The application never returns an OSS URL, bucket,
object key, ETag, credential, request id, provider task id, prompt, workflow, or
local path in browser DTOs or logs.

Grant only the object operations used by the adapter on the one bucket and the
canonical tenant subtree:

- `oss:PutObject` (conditional create; no overwrite)
- `oss:GetObject` (HEAD/full/single-range reads)
- `oss:DeleteObject` (only cleanup/reconciliation after metadata checks)
- `oss:ListObjects` for `listV2`, restricted by prefix to
  `aistory/video-assets/v1/tenants/<tenant>/` and a small page size

Do not grant bucket-wide listing, `ListBuckets`, ACL/policy/lifecycle changes,
bucket creation/deletion, public-read changes, or another tenant/prefix. The
operator must validate the exact RAM policy and OSS action names against the
approved cloud environment before enablement.

Object keys remain content-addressed:

`aistory/video-assets/v1/tenants/<tenant>/projects/<project>/sha256/<first-two>/<sha256>.<mp4|webm>`

The server-only reconciliation primitive accepts a project id, never an
arbitrary prefix; it uses at most 100 keys per page, validates every returned
key/timestamp, drops owner/URL fields, and accepts only a bounded continuation
token. It has no HTTP route and must be operator-invoked after an approved
grace period. Before invoking it, disable uploads on every application
instance, drain in-flight upload/RPC work, record the quiescence timestamp,
and wait at least the configured grace period. The primitive rejects a more
recent quiescence timestamp, ignores objects newer than it, double-checks DB
references, HEAD metadata/hash/ETag, then uses a conditional delete. Never run
reconciliation while uploads are enabled and never run bucket-wide cleanup.

## Upload, cleanup, and delivery invariants

- Strong administrator authorization and same-origin mutation checks run before
  runtime composition or file parsing.
- MIME, magic bytes, size, SHA-256, server-side ffprobe, codec/container, and
  subtitle duration validation finish before object metadata commits.
- Conditional PUT is idempotent. Existing objects must match byte count, MIME,
  content hash, ETag, tenant, project, and canonical key.
- An explicit PostgreSQL/PostgREST transaction rejection may clean up only the
  object created by that request, after an object-reference recheck and matching
  ETag/hash. A network/gateway timeout, malformed success response, or any other
  unknown commit outcome never deletes synchronously; it leaves a possible
  orphan for delayed, scoped reconciliation.
- A conditional-PUT collision without committed metadata is treated as an
  in-flight/orphan condition and returns generic 503 instead of attaching new
  metadata.
- ffprobe runs by absolute path with no shell, a private 0600 temporary file,
  a minimal non-secret environment, local-file-only protocol, timeout/output
  limits, and confirmed cleanup. Production still requires a restricted OS
  account, controlled binary digest, temp-volume permissions, and monitoring.
- Review, publish, offline, and restore remain DB-checked transitions with
  append-only administrator audit. Public delivery exposes only publishable,
  public assets through the controlled AIstory route.
- GET/HEAD delivery reuses the controlled 200/206/416 helper. Invalid or
  unsatisfiable Range is 416 with `Content-Range: bytes */<size>`; no request is
  converted to an OSS URL or a 200 fallback.

## Zero-network and real-cloud acceptance

The local test suite injects fake credentials, OSS SDK calls, RPCs, and ffprobe
execution. It must make no IMDS, Supabase, OSS, SMS, ComfyUI, GPU, or model
request. Required local evidence includes:

- exact SDK version/integrity/license/repository;
- IMDSv2-only builder arguments and explicit role provenance;
- invalid/missing config, SDK debug, or disabled TLS returns generic 503 with
  zero dependency calls;
- fixed endpoint/bucket/prefix, conditional put, head, full/range read, delete,
  project-scoped list, metadata tamper/missing, cross-tenant/key rejection;
- created-only cleanup, unknown-commit preservation, replay, state machine,
  append-only audit, DTO/error redaction, and 200/206/416/HEAD semantics;
- Gate14 static RLS/GRANT/RPC/constraint contract plus canonical build.

Separate approval is required for the first staging/production cloud test. It
must use one synthetic tenant/project and a small validated video, capture only
allowlisted metrics, and prove private-bucket access, IMDSv2 token/role source,
internal endpoint, conditional overwrite denial, actual DeleteObject If-Match
behavior, scoped list pagination, range/seek, credential rotation, and log
redaction. Do not enable production traffic until this real-cloud gate and the
database apply gate both pass.

## Emergency disable and rollback

Unset/disable `AISTORY_VIDEO_ASSET_ADAPTER` and restart the application. The
feature must return a generic 503 and must not fall back to local storage.
Disable new uploads before investigating. Do not reverse Gate14, edit audit or
idempotency rows, delete bucket objects, broaden IAM, or expose direct OSS URLs.
Keep possible orphan objects private for approved tenant/prefix-scoped
reconciliation after a grace period.
