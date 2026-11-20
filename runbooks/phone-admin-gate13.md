# AIstory phone administrator Gate13

> **SUPERSEDED / HISTORICAL EVIDENCE ONLY — DO NOT EXECUTE.**
> Founder 于 2026-08-28 决定生产管理员不使用手机号。本文件保留已冻结 Gate13
> migration 的历史安全审计，不再授权 staging 或 production phone bootstrap，亦不得
> 据此写 allowlist、注入手机号身份或授予角色。新的独立管理员方向当前只有默认关闭的
> local-fake 候选，生产仍被 durable auth-state/audit 与独立 DB principal gate 阻断；
> 见 `runbooks/independent-admin-principal-v1.md`。

## Purpose

Gate13 moves production administrator role ownership onto the stable AIstory
application UUID used by verified phone accounts. It does not make an ordinary
phone user an administrator and it does not enable billing, Hosted BYOK, or any
model provider.

The forward migration is:

`supabase/migrations/20260809113000_phone_admin_identity_gate.sql`

Reviewed local candidate: 9,076 bytes; SHA-256
`b922f10078f0eccda9fbb8fc9b821d4d6eb55acb1014db076f96d1788936d32e`.
Any byte or digest mismatch requires a new forward migration and review; do not
edit this candidate after it has been accepted or applied.

It must only be applied after Gate12 (`20260802113000`) is installed and all
existing database, administrator, and Hosted BYOK security postures are true.
Gate10 through Gate12 are immutable and must not be replayed or edited.

## Security model

- Phone identities remain stable `app_users.id` UUIDs derived through the
  existing phone-identity mapping. No phone number, OTP, phone HMAC, or secret
  is returned to the administrator UI.
- `user_roles`, administrator audit actors, and the bootstrap allowlist refer
  to `app_users`, so both legacy Supabase-auth administrators and phone
  administrators share one application identity boundary.
- Browser roles cannot execute the phone bootstrap RPC or write role tables.
- The bootstrap RPC accepts only a service-role JWT and an active phone user.
- First-super-admin creation requires two independent gates:
  1. the server-only `AISTORY_ADMIN_BOOTSTRAP_USER_ID` must exactly match the
     verified phone session UUID;
  2. a one-shot row for the same UUID must exist in
     `admin_bootstrap_allowlist`.
- Bootstrap is advisory-locked, deterministic on replay, refuses a different
  second super administrator, and commits the role and append-only audit row
  in one database transaction.

## Staging procedure

Do not perform these steps without a current staging maintenance approval.

1. Confirm staging is isolated, database ports are not public, and no
   production traffic or provider calls can reach it.
2. Create a recoverable pre-Gate13 database dump and record its SHA-256.
3. Mechanically verify the migration filename, byte count, and SHA-256 against
   the reviewed local file.
4. Confirm ledger/gate is exactly Gate12 and every prerequisite posture is
   true.
5. Apply Gate13 exactly once. Stop on any error; do not hot-patch SQL on the
   server.
6. Verify the migration ledger and gate are `20260809113000`, and verify:
   - database, administrator, Hosted BYOK, and phone-admin postures are true;
   - browser roles cannot execute bootstrap or mutate administrator tables;
   - legacy administrator rows retain valid application identities;
   - a synthetic verified phone user without both gates cannot self-promote;
   - matching environment and one-shot database gates bootstrap exactly one
     synthetic super administrator;
   - identical replay is idempotent;
   - a different phone user is refused;
   - administrator reads remain tenant-scoped;
   - role and bootstrap audit records are append-only and contain no sensitive
     phone or credential material.
7. Run the staging administrator integration harness through loopback or an SSH
   tunnel only.
8. Create a post-Gate13 dump, upload it to the existing restricted OSS prefix
   through the ECS RAM role, download it, compare SHA-256, and restore it into
   a disposable isolated Postgres instance. Compare ledger, gate, postures,
   role counts, audit counts, and deterministic synthetic fixtures.
9. Remove temporary adapters, tunnels, containers, and synthetic credentials.
   Keep only non-sensitive evidence and approved backup objects.

## Production cutover (separate approval)

Staging PASS does not authorize production use. A production change requires a
separate explicit approval and a named first administrator who has already
completed phone verification.

The cutover order is:

1. recoverable production backup;
2. exact migration hash verification and one-time Gate13 application;
3. set the root-only bootstrap UUID allowlist and insert the matching one-shot
   database allowlist row through controlled operations;
4. deploy Gate13-compatible application code and restart only the AIstory
   service;
5. have the designated account open `/admin/login`, complete phone login, and
   invoke bootstrap once;
6. remove/disable the environment bootstrap allowlist immediately after the
   verified role and audit record exist;
7. verify ordinary users receive 403, the administrator workbench is readable,
   and no sensitive identity data is exposed;
8. retain rollback evidence. Never roll back by deleting ledger or audit rows.

Formal platform billing, real provider costs, Hosted BYOK production use, and
payment remain independent gates even after the first production administrator
is active.
