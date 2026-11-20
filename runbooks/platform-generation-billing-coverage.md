# Platform generation billing coverage

This matrix is the fail-closed inventory for server entry points that can reach
text, image, vision, TTS, or video generation. The executable counterpart is
`pnpm test:platform-billing`.

| Capability | Server routes | Zero-cost path before auth/reserve | Paid miss order | Terminal behavior |
| --- | --- | --- | --- | --- |
| Mixed text/image/optional voice | `/api/start`, `/api/scene` | Published cache; provider config preflight; depth-0 speculation is rejected | quote → verified phone → immutable reserve → provider | trusted result settles; cache/single-flight follower refunds; uncertain provider outcome stays pending |
| Text | `/api/classify-freeform`, `/api/insert-beat`, `/api/character-names`, style rewrite | Provider config preflight; author-locked continuation is rejected; local name generator remains client-side | quote → verified phone → reserve → provider | trusted result settles; callback-not-entered cache/config path refunds; throw/timeout stays pending |
| Image | style redraw | Style cache; mock-only config; author-locked continuation is rejected | quote → verified phone → reserve → provider | real trusted result settles; cache follower refunds; provider-attempt mock/throw stays pending |
| Vision | `/api/vision`, `/api/parse-style-image` | Provider config preflight; author-locked vision branch is rejected | quote → verified phone → reserve → provider | trusted provider return settles even if local parsed payload is unusable; throw/timeout stays pending |
| TTS | `/api/beat-audio` | TTS cache hit, disabled TTS and embedded-audio scenes | quote → verified phone → reserve → provider | audio result settles; cache follower refunds; null/timeout after callback entry stays pending |
| BYOK | browser-direct providers and BYOK engine routes | Entire request; no platform reservation | no platform-paid path | zero platform credits; partial BYOK is rejected and server TTS is disabled |
| Local image/video | ComfyUI, LocalMiniDrama, LAN GPU connector | Loopback/local-admin only | not a platform-paid supplier path | no platform credit ledger; non-loopback targets and requests fail closed |
| Cloud async video | Volcengine Agent Plan | Contract/status only | unavailable | `networkEnabled=false`; no submit transport or paid request |

Additional invariants:

- Formal and legacy platform-managed generation both require a phone-authenticated
  identity and a caller-supplied idempotency key.
- Only a typed provider receipt with the policy currency and minor-unit scale may
  produce `costSource=provider_settlement`. Without one, settlement is explicitly
  `price_catalog`.
- Fixed beta quotes/reserves additionally compare the current route's exact
  server-only runtime-binding SHA against the content-addressed policy entry;
  provider/model/TTS drift fails before ledger or provider work.
- A client abort after provider callback entry is never proof that the provider
  did not start. A trusted result still settles; otherwise the reserve remains
  pending for same-terminal reconciliation. No error path may manufacture the
  opposite terminal.
- A replayed reserve idempotency key is rejected before provider entry with
  `BILLING_OPERATION_REPLAYED`; it cannot invoke the provider a second time.
- Anonymous users may consume published/template/cache content without login and
  without a provider call. Authored story nodes before the continuation boundary
  are rejected server-side before cache, billing, or provider work.
- No route may turn a depth-0 speculative request into text, image, TTS, video, or
  GPU work.
