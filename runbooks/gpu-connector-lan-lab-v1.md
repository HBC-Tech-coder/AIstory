# AIstory GPU Connector LAN LAB v1

Status: **local-lab code contract; disabled by default; not production-ready**  
Protocol version: `1.0`  
Minimum Connector version: `0.2.0`

This runbook freezes the smallest safe contract needed to begin a controlled
LAN video-generation trial. The 4090 machine keeps ComfyUI private and only the
Connector performs outbound polling to the AIstory coordinator. This document
contains no IP address, hostname, credential, prompt, model path or secret.

## Verified handoff baseline

- Connector release ZIP SHA-256:
  `a2ebd1ed16de17c03805478e088af4976c92c28bfc9f0650d8cc72b1e6a19d21`
- Connector source digest:
  `58d65a9d71ef69d5b94bbeeaec25b085d90067ba6c8036ae3d0bd1ff56c6acda`
- The upstream handoff reports 22 tests, lint, posture, artifact audit and
  release audit passing.
- Strict mypy was not rerun on this workstation because mypy is not installed.

The current 4090 inventory is **not** an allowlist. Its models/workflows remain
`license_unknown` and `mechanically_verified=false`. No Wan or LTX workflow is
enabled merely because it appears in that inventory.

### R0 lab-only candidate freeze

AIstory records exactly one mechanically completed candidate for LAN LAB
configuration:

- workflow id: `ltx23-original-av-lab`
- workflow identity SHA-256:
  `f3465cacbf88e139a0f4708ed887d875edab72cc5d28c0c6b40c91519362794e`
- classification: `non_publishable`
- output: node `21`, slot `0`, `video/mp4`
- parameter bindings:
  - prompt: node `6` / `text`
  - negative prompt: node `7` / `text`
  - seed: node `12` / `noise_seed`
  - width/height: node `9`
  - frames: node `9` / `length` and node `10` / `frames_number`
  - fps: nodes `8`, `10` and `20`

This is the candidate workflow **identity**, not the sanitized API file byte
hash. The sanitized file hash must never be substituted for it. The R0 route
completed once at 768×480, 81 frames and 24 fps; its installed model
provenance/license remains unconfirmed. The two Wan candidates failed at
`CLIPLoader` with a runtime error and are not represented in the frozen LAB
candidate registry.

The environment allowlist still defaults to empty. When explicitly configured,
the parser accepts only the exact frozen R0 id/identity pair and expands its
server-owned binding/output contract. There is no production workflow
allowlist. Every job from this route carries `non_publishable`; it may be
explicitly adopted into the project-local ProjectAsset registry for review but
is rejected by the VideoAsset publish pipeline.

## Hard lab gates

All conditions must be true before any connector route becomes ready:

1. `AISTORY_GPU_LAN_LAB_ENABLED=true`.
2. Exactly one `AISTORY_GPU_LAN_LAB_CONNECTOR_ID`.
3. One explicit `AISTORY_GPU_LAN_LAB_HMAC_KEY_ID` and one server-only base64
   HMAC secret decoding to at least 32 bytes. There is no implicit key-id
   fallback.
4. An explicit durable `AISTORY_GPU_LAN_LAB_STORE_DIR`.
5. An operator-controlled HTTPS `AISTORY_GPU_LAN_LAB_COORDINATOR_ORIGIN`.
   Every coordinator and artifact request must carry an exact matching `Host`;
   forwarded host headers are not trusted.
6. An operator-controlled HTTPS upload origin with an exact hostname.
7. A non-empty JSON allowlist containing exact workflow id + SHA-256 pairs.

Missing any item fails closed before a lease is issued. The mode has one global
GPU slot shared with AIstory-owned local GenerationJobs. It accepts foreground
jobs only; speculative prefetch is always false and depth `0` never schedules a
job. Existing loopback ComfyUI remains the default execution path.

## Endpoint table

All coordinator JSON endpoints use `POST`, `application/json`, a maximum
128 KiB request body, and the authenticated request/response envelope described
below.

| Operation | Endpoint |
| --- | --- |
| register | `/api/gpu-coordinator/v1/register` |
| heartbeat | `/api/gpu-coordinator/v1/heartbeat` |
| lease / no-work | `/api/gpu-coordinator/v1/lease` |
| acknowledge | `/api/gpu-coordinator/v1/acknowledge` |
| progress | `/api/gpu-coordinator/v1/progress` |
| cancel poll | `/api/gpu-coordinator/v1/cancel-poll` |
| complete | `/api/gpu-coordinator/v1/complete` |
| fail | `/api/gpu-coordinator/v1/fail` |
| cancelled | `/api/gpu-coordinator/v1/cancelled` |
| renew (retained) | `/api/gpu-coordinator/v1/renew` |
| reconcile (retained) | `/api/gpu-coordinator/v1/reconcile` |
| upload ticket exchange | `/api/gpu-coordinator/v1/upload-ticket` |

The upload ticket returns an exact HTTPS `PUT` route:

`/api/gpu-coordinator/v1/artifacts/{ticketId}`

Only `video/mp4` and `video/webm` are accepted. The route requires an exact
`Content-Length`, validates HMAC, ticket expiry, expected bytes, SHA-256, MIME
and container magic, processes the request in at most 1 MiB stream slices, and
stores content under the gitignored LAN LAB root. It never accepts a caller
URL, filesystem path or redirect.

## Request authentication

Headers:

```text
x-aistory-key-id
x-aistory-timestamp
x-aistory-nonce
x-aistory-request-id
x-aistory-content-sha256
x-aistory-signature: v1=<lowercase hex HMAC-SHA256>
```

Canonical request, UTF-8 with LF:

```text
aistory-hmac-v1
<key-id>
<unix-seconds>
<nonce>
<request-id>
<uppercase-method>
<path-and-key-sorted-query>
<lowercase-body-sha256>

```

Canonical response:

```text
aistory-response-v1
<key-id>
<unix-seconds>
<nonce>
<request-id>
<http-status>
<path-and-key-sorted-query>
<lowercase-body-sha256>

```

Timestamp tolerance is bounded to five minutes and every `(keyId, nonce)` is
single-use. A repeated request uses the same request id and identical semantic
body; a reused id with a different body is an idempotency conflict.

## Language-neutral canonical HMAC vector

```json
{
  "secretBase64": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
  "keyId": "connector-test-current",
  "timestamp": 1785400000,
  "nonce": "test-nonce-000000000001",
  "requestId": "req-test-0001",
  "method": "POST",
  "path": "/api/gpu-coordinator/v1/heartbeat?beta=two&alpha=1",
  "canonicalPath": "/api/gpu-coordinator/v1/heartbeat?alpha=1&beta=two",
  "bodyUtf8": "{\"connectorId\":\"connector-test\",\"protocolVersion\":\"1.0\",\"sequence\":7}",
  "bodySha256": "90ab1be8fcb57880460363421aff9a22fa5778d7aefd525edef4b79bd6c3f71e",
  "requestSignatureHex": "2a9e3797529a09e3817c509abb64cce06faee48bdaee2c96a5b219c33e108496",
  "responseStatus": 200,
  "responseBodySha256": "ecb7ab4e264e0518b7f3086cc122992d54ad1e6a0cebdd971f6aff45063c75d9",
  "responseSignatureHex": "73fb9af2906cf79c21a86e01af44edb470e50e7337748f3d21ad5c8b6ebb1807"
}
```

The vector secret is synthetic and exists only for conformance tests.

## State and ordering

```text
queued -> offered -> acknowledged -> running
running -> succeeded | failed | cancelled
```

- `register` rejects versions below `0.2.0` and connector ids other than the
  single allowlisted id.
- All non-register calls carry the returned `sessionId` and a strictly
  increasing connector sequence.
- `lease` returns either one lease or `no_work`. There is never a second active
  lease.
- `acknowledge` locks `promptIdentitySha256`; later progress/terminal calls must
  repeat it.
- `progressSequence` and `terminalSequence` are monotonic.
- `cancelled` is accepted only after the coordinator issued a cancellation id.
- `complete` is accepted only after a matching upload ticket was consumed.
- Restart reconciliation never automatically resubmits a paid or GPU-heavy
  operation; ambiguous state requires an explicit operator decision.

Advanced production key rotation, connector revocation administration and
multi-instance reconciliation remain deliberately deferred. The protocol
fields are retained so adding them later does not break Connector 0.2.0.

## Public and administrator projections

Ordinary GenerationJob DTOs contain status, progress and the content-addressed
AIstory artifact only. They never contain:

- prompt or negative prompt;
- raw workflow JSON or model name;
- provider task id;
- local filesystem path;
- signed ticket or signed URL query;
- HMAC key material.

The strong-admin panel may show online/offline, last heartbeat, active job,
progress, cancellation state and allowlisted workflow ids. It does not display
the HMAC secret or workflow JSON.

## Workflow manifest template

The 4090 operator must return a mechanically verified manifest before the
allowlist is populated:

```json
{
  "schemaVersion": 1,
  "connectorVersion": "0.2.0",
  "workflowId": "operator-assigned-stable-id",
  "workflowSha256": "64-lowercase-hex",
  "modality": "video",
  "workflowSource": "official-or-reviewed-source",
  "sourceRevision": "immutable-revision",
  "licenseId": "verified-license-id",
  "licenseUrl": "https://official-license.example/path",
  "mechanicallyVerified": true,
  "thirdPartyLoras": [],
  "requiredWeightSha256": ["64-lowercase-hex"],
  "comfyUiVersion": "immutable-version",
  "verifiedAt": "RFC3339 UTC timestamp"
}
```

`license_unknown`, `mechanicallyVerified=false`, missing SHA values, additional
unreviewed LoRAs, or a changed workflow byte hash are hard rejection cases.

## First real LAN trial checklist

1. Keep ComfyUI bound to loopback on the 4090 machine.
2. Configure the Connector for outbound polling only.
3. Provision one connector id and one independent 32+ byte lab HMAC secret to
   both endpoints through secret stores; never paste either into source.
4. Establish operator-controlled HTTPS and verify the certificate/hostname
   matches the exact configured upload origin.
   Before doing so, mechanically identify the active physical network adapter,
   its default gateway and outbound reachability to the coordinator exact
   host. Reject Docker, WSL and Hyper-V virtual adapters as evidence of a
   reachable physical LAN path. Never copy a discovered address into source,
   documentation or logs.
5. Return one reviewed workflow manifest using the template above.
6. Add only that exact id/SHA pair to the server-side allowlist.
7. Start with register, heartbeat and repeated `no_work`; confirm no GPU work.
8. Submit one approved, low-cost foreground test from the local admin panel.
9. Confirm lease, ack, progress, upload ticket, content hash, complete and
   explicit ProjectAsset adoption.
10. Confirm cancellation polling and a deliberate fake failure.
11. Review the adopted video before any VideoAsset publish action.

No step opens ComfyUI to the LAN or Internet. No workflow is promoted merely
because it exists in the 214-model/401-workflow inventory.
