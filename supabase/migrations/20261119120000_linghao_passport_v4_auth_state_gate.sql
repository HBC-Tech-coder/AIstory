-- Linghao Passport v4 production auth-state authority.
--
-- This is an empty, isolated namespace. It performs no legacy-account read,
-- migration, claim, link, role grant, credit grant or billing mutation.
-- Browser artifacts are keyed digests; provider material reaches SQL only as
-- application-authenticated encrypted envelopes.

begin;

do $migration_guard$
begin
  if current_user <> 'postgres' then
    raise exception 'linghao passport v4 gate must be applied by postgres';
  end if;
  if exists (
    select 1 from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname like 'linghao_passport_v4_%'
  ) or exists (
    select 1 from pg_catalog.pg_proc p
    join pg_catalog.pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname like 'aistory_linghao_passport_v4_%'
  ) then
    raise exception 'linghao passport v4 gate or partial object set already exists';
  end if;
end
$migration_guard$;

create table public.linghao_passport_v4_auth_gates (
  singleton boolean primary key default true check (singleton),
  gate_name text not null unique check (gate_name = 'linghao_passport_v4_auth_state'),
  version text not null check (version = '20261119120000'),
  applied_at timestamptz not null default pg_catalog.clock_timestamp()
);

create table public.linghao_passport_v4_principals (
  principal_key text primary key check (principal_key ~ '^[0-9a-f]{64}$'),
  registration_sha256 text not null check (registration_sha256 ~ '^[0-9a-f]{64}$'),
  account_namespace text not null check (account_namespace = 'passport_v4_new_v1'),
  status text not null default 'active' check (status in ('active', 'revoked')),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  last_login_at timestamptz not null default pg_catalog.clock_timestamp()
);

create table public.linghao_passport_v4_browser_families (
  family_hash text primary key check (family_hash ~ '^[0-9a-f]{64}$'),
  principal_key text references public.linghao_passport_v4_principals(principal_key),
  current_session_hash text,
  status text not null check (status in ('reserved', 'active', 'revoked', 'expired')),
  generation bigint not null default 0 check (generation >= 0),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  last_seen_at timestamptz not null default pg_catalog.clock_timestamp(),
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revocation_code text check (revocation_code is null or revocation_code in
    ('user_logout', 'refresh_uncertain', 'session_expired', 'replaced')),
  check ((status = 'revoked') = (revoked_at is not null))
);

create table public.linghao_passport_v4_authorization_transactions (
  transaction_hash text primary key check (transaction_hash ~ '^[0-9a-f]{64}$'),
  family_hash text not null references public.linghao_passport_v4_browser_families(family_hash),
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  nonce_hash text not null check (nonce_hash ~ '^[0-9a-f]{64}$'),
  verifier_envelope text,
  status text not null check (status in
    ('pending', 'callback_consumed', 'completed', 'replaced', 'cancelled',
     'logout_revoked', 'expired', 'state_mismatch')),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  completed_at timestamptz,
  completion_hash text check (completion_hash is null or completion_hash ~ '^[0-9a-f]{64}$'),
  completion_envelope text,
  completed_session_hash text check (completed_session_hash is null or completed_session_hash ~ '^[0-9a-f]{64}$'),
  completion_expires_at timestamptz,
  check ((status = 'pending') = (verifier_envelope is not null)),
  check ((status = 'completed') =
    (completion_hash is not null and completion_envelope is not null and
     completed_session_hash is not null and completion_expires_at is not null))
);

create unique index linghao_passport_v4_one_pending_transaction_per_family
  on public.linghao_passport_v4_authorization_transactions(family_hash)
  where status = 'pending';

create table public.linghao_passport_v4_sessions (
  session_hash text primary key check (session_hash ~ '^[0-9a-f]{64}$'),
  family_hash text not null references public.linghao_passport_v4_browser_families(family_hash),
  principal_key text not null references public.linghao_passport_v4_principals(principal_key),
  generation bigint not null check (generation >= 1),
  status text not null check (status in
    ('active', 'refreshing', 'superseded', 'revoked', 'expired', 'refresh_uncertain')),
  authenticated_at timestamptz not null default pg_catalog.clock_timestamp(),
  last_seen_at timestamptz not null default pg_catalog.clock_timestamp(),
  idle_expires_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  provider_expires_at timestamptz not null,
  id_token_hint_envelope text,
  refresh_fingerprint text check (refresh_fingerprint is null or refresh_fingerprint ~ '^[0-9a-f]{64}$'),
  refresh_envelope text,
  terminal_at timestamptz,
  terminal_reason text,
  check ((refresh_fingerprint is null) = (refresh_envelope is null)),
  check ((status in ('active', 'refreshing')) = (terminal_at is null)),
  check (idle_expires_at <= absolute_expires_at),
  check (authenticated_at < absolute_expires_at)
);

create unique index linghao_passport_v4_one_live_session_per_family
  on public.linghao_passport_v4_sessions(family_hash)
  where status in ('active', 'refreshing');
create unique index linghao_passport_v4_unique_current_refresh
  on public.linghao_passport_v4_sessions(refresh_fingerprint)
  where refresh_fingerprint is not null;

create table public.linghao_passport_v4_refresh_attempts (
  attempt_hash text primary key check (attempt_hash ~ '^[0-9a-f]{64}$'),
  family_hash text not null references public.linghao_passport_v4_browser_families(family_hash),
  session_hash text not null references public.linghao_passport_v4_sessions(session_hash),
  expected_generation bigint not null check (expected_generation >= 1),
  old_refresh_fingerprint text not null unique check (old_refresh_fingerprint ~ '^[0-9a-f]{64}$'),
  used_refresh_envelope text,
  replacement_refresh_fingerprint text check
    (replacement_refresh_fingerprint is null or replacement_refresh_fingerprint ~ '^[0-9a-f]{64}$'),
  replacement_refresh_envelope text,
  completion_hash text check (completion_hash is null or completion_hash ~ '^[0-9a-f]{64}$'),
  status text not null check (status in
    ('claimed', 'committed', 'uncertain', 'cleanup_required', 'cleanup_confirmed')),
  claimed_at timestamptz not null default pg_catalog.clock_timestamp(),
  deadline_at timestamptz not null,
  completed_at timestamptz,
  unique (session_hash, expected_generation),
  check ((status = 'claimed') = (used_refresh_envelope is not null)),
  check (
    (replacement_refresh_fingerprint is null and replacement_refresh_envelope is null)
    or (replacement_refresh_fingerprint is not null and
      (replacement_refresh_envelope is not null or status in ('committed','cleanup_confirmed')))
  )
);

create table public.linghao_passport_v4_replay_claims (
  purpose text not null check (purpose in
    ('transaction', 'refresh_fingerprint', 'logout_receipt', 'session')),
  digest text not null check (digest ~ '^[0-9a-f]{64}$'),
  family_hash text check (family_hash is null or family_hash ~ '^[0-9a-f]{64}$'),
  claimed_at timestamptz not null default pg_catalog.clock_timestamp(),
  retain_until timestamptz not null,
  primary key (purpose, digest),
  check (retain_until > claimed_at)
);

create table public.linghao_passport_v4_revocation_outbox (
  outbox_hash text primary key check (outbox_hash ~ '^[0-9a-f]{64}$'),
  family_hash text not null references public.linghao_passport_v4_browser_families(family_hash),
  attempt_hash text references public.linghao_passport_v4_refresh_attempts(attempt_hash),
  token_kind text not null check (token_kind in ('access_token','refresh_token')),
  token_fingerprint text not null check (token_fingerprint ~ '^[0-9a-f]{64}$'),
  token_envelope text,
  status text not null check (status in ('pending', 'claimed', 'confirmed', 'unconfirmed')),
  claim_hash text check (claim_hash is null or claim_hash ~ '^[0-9a-f]{64}$'),
  lease_expires_at timestamptz,
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  completed_at timestamptz,
  unique (token_fingerprint),
  check ((status in ('pending', 'claimed')) = (token_envelope is not null))
);

create table public.linghao_passport_v4_logout_results (
  receipt_hash text primary key check (receipt_hash ~ '^[0-9a-f]{64}$'),
  state_hash text not null unique check (state_hash ~ '^[0-9a-f]{64}$'),
  family_hash text not null references public.linghao_passport_v4_browser_families(family_hash),
  session_hash text not null check (session_hash ~ '^[0-9a-f]{64}$'),
  id_token_hint_envelope text,
  upstream_return_expected boolean not null,
  upstream_returned_at timestamptz,
  local_revoked_at timestamptz not null,
  created_at timestamptz not null default pg_catalog.clock_timestamp(),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  check (expires_at > created_at)
);

create table public.linghao_passport_v4_start_rate_buckets (
  bucket_hash text primary key check (bucket_hash ~ '^[0-9a-f]{64}$'),
  window_started_at timestamptz not null,
  attempt_count integer not null check (attempt_count between 1 and 1000),
  updated_at timestamptz not null
);

create table public.linghao_passport_v4_auth_audit (
  event_id bigint generated always as identity primary key,
  event_type text not null check (event_type in
    ('start_reserved', 'start_rate_limited', 'start_cancelled', 'callback_consumed',
     'callback_rejected', 'session_established', 'session_replayed', 'session_expired',
     'refresh_claimed', 'refresh_committed', 'refresh_uncertain', 'refresh_cleanup_required',
     'logout_started', 'revocation_completed', 'logout_result_consumed')),
  result_code text not null check (result_code ~ '^[a-z_]{2,48}$'),
  family_hash text check (family_hash is null or family_hash ~ '^[0-9a-f]{64}$'),
  transaction_hash text check (transaction_hash is null or transaction_hash ~ '^[0-9a-f]{64}$'),
  session_hash text check (session_hash is null or session_hash ~ '^[0-9a-f]{64}$'),
  attempt_hash text check (attempt_hash is null or attempt_hash ~ '^[0-9a-f]{64}$'),
  occurred_at timestamptz not null default pg_catalog.clock_timestamp()
);

create table public.linghao_passport_v4_catalog_manifest (
  object_identity text primary key,
  definition_md5 text not null check (definition_md5 ~ '^[0-9a-f]{32}$')
);

alter table public.linghao_passport_v4_auth_gates enable row level security;
alter table public.linghao_passport_v4_auth_gates force row level security;
alter table public.linghao_passport_v4_principals enable row level security;
alter table public.linghao_passport_v4_principals force row level security;
alter table public.linghao_passport_v4_browser_families enable row level security;
alter table public.linghao_passport_v4_browser_families force row level security;
alter table public.linghao_passport_v4_authorization_transactions enable row level security;
alter table public.linghao_passport_v4_authorization_transactions force row level security;
alter table public.linghao_passport_v4_sessions enable row level security;
alter table public.linghao_passport_v4_sessions force row level security;
alter table public.linghao_passport_v4_refresh_attempts enable row level security;
alter table public.linghao_passport_v4_refresh_attempts force row level security;
alter table public.linghao_passport_v4_replay_claims enable row level security;
alter table public.linghao_passport_v4_replay_claims force row level security;
alter table public.linghao_passport_v4_revocation_outbox enable row level security;
alter table public.linghao_passport_v4_revocation_outbox force row level security;
alter table public.linghao_passport_v4_logout_results enable row level security;
alter table public.linghao_passport_v4_logout_results force row level security;
alter table public.linghao_passport_v4_start_rate_buckets enable row level security;
alter table public.linghao_passport_v4_start_rate_buckets force row level security;
alter table public.linghao_passport_v4_auth_audit enable row level security;
alter table public.linghao_passport_v4_auth_audit force row level security;
alter table public.linghao_passport_v4_catalog_manifest enable row level security;
alter table public.linghao_passport_v4_catalog_manifest force row level security;

create function public.aistory_linghao_passport_v4_exact_object(input jsonb, expected text[])
returns boolean
language sql immutable
set search_path = pg_catalog
as $function$
  select pg_catalog.jsonb_typeof(input) = 'object'
    and (select pg_catalog.count(*) from pg_catalog.jsonb_object_keys(input)) = pg_catalog.array_length(expected, 1)
    and input ?& expected;
$function$;

create function public.aistory_linghao_passport_v4_assert_service_role()
returns void
language plpgsql stable security definer
set search_path = pg_catalog
as $function$
declare
  claimed_role text;
begin
  claimed_role := nullif(pg_catalog.current_setting('request.jwt.claim.role', true), '');
  if claimed_role is null then
    begin
      claimed_role := (pg_catalog.current_setting('request.jwt.claims', true)::jsonb)->>'role';
    exception when others then
      claimed_role := null;
    end;
  end if;
  if claimed_role is distinct from 'service_role' then
    raise exception 'linghao passport v4 service role required';
  end if;
end
$function$;

create function public.aistory_linghao_passport_v4_assert_ready()
returns void
language plpgsql stable security definer
set search_path = pg_catalog
as $function$
declare
  gate_version text;
begin
  perform public.aistory_linghao_passport_v4_assert_service_role();
  select g.version into gate_version
  from public.linghao_passport_v4_auth_gates g
  where g.singleton = true;
  if gate_version is distinct from '20261119120000' then
    raise exception 'linghao passport v4 auth gate unavailable';
  end if;
end
$function$;

create function public.aistory_linghao_passport_v4_internal_hash(label text)
returns text
language sql volatile security definer
set search_path = pg_catalog
as $function$
  select pg_catalog.md5(label || E'\\000' || pg_catalog.clock_timestamp()::text || E'\\000' || pg_catalog.random()::text)
      || pg_catalog.md5(pg_catalog.txid_current()::text || E'\\000' || pg_catalog.random()::text || E'\\000' || label);
$function$;

create function public.aistory_linghao_passport_v4_immutable_guard()
returns trigger
language plpgsql security definer
set search_path = pg_catalog
as $function$
begin
  raise exception 'linghao passport v4 immutable relation';
end
$function$;

create trigger linghao_passport_v4_gate_immutable
before update or delete on public.linghao_passport_v4_auth_gates
for each row execute function public.aistory_linghao_passport_v4_immutable_guard();
create trigger linghao_passport_v4_gate_no_truncate
before truncate on public.linghao_passport_v4_auth_gates
for each statement execute function public.aistory_linghao_passport_v4_immutable_guard();
create trigger linghao_passport_v4_audit_immutable
before update or delete on public.linghao_passport_v4_auth_audit
for each row execute function public.aistory_linghao_passport_v4_immutable_guard();
create trigger linghao_passport_v4_audit_no_truncate
before truncate on public.linghao_passport_v4_auth_audit
for each statement execute function public.aistory_linghao_passport_v4_immutable_guard();
create trigger linghao_passport_v4_manifest_immutable
before update or delete on public.linghao_passport_v4_catalog_manifest
for each row execute function public.aistory_linghao_passport_v4_immutable_guard();
create trigger linghao_passport_v4_manifest_no_truncate
before truncate on public.linghao_passport_v4_catalog_manifest
for each statement execute function public.aistory_linghao_passport_v4_immutable_guard();

create function public.aistory_linghao_passport_v4_reserve_start(request_payload jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog
as $function$
declare
  now_at timestamptz := pg_catalog.clock_timestamp();
  family_id text;
  transaction_id text;
  state_id text;
  nonce_id text;
  bucket_id text;
  verifier text;
  bucket public.linghao_passport_v4_start_rate_buckets%rowtype;
  family public.linghao_passport_v4_browser_families%rowtype;
  expiry timestamptz;
begin
  perform public.aistory_linghao_passport_v4_assert_ready();
  if not public.aistory_linghao_passport_v4_exact_object(request_payload,
    array['familyHash','transactionHash','stateHash','nonceHash','rateBucketHash','verifierEnvelope']) then
    raise exception 'invalid reserve start payload';
  end if;
  family_id := request_payload->>'familyHash';
  transaction_id := request_payload->>'transactionHash';
  state_id := request_payload->>'stateHash';
  nonce_id := request_payload->>'nonceHash';
  bucket_id := request_payload->>'rateBucketHash';
  verifier := request_payload->>'verifierEnvelope';
  if family_id !~ '^[0-9a-f]{64}$' or transaction_id !~ '^[0-9a-f]{64}$'
    or state_id !~ '^[0-9a-f]{64}$' or nonce_id !~ '^[0-9a-f]{64}$'
    or bucket_id !~ '^[0-9a-f]{64}$'
    or pg_catalog.length(verifier) > 22000
    or verifier !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$' then
    raise exception 'invalid reserve start values';
  end if;

  insert into public.linghao_passport_v4_start_rate_buckets
    (bucket_hash, window_started_at, attempt_count, updated_at)
  values (bucket_id, now_at, 1, now_at)
  on conflict (bucket_hash) do nothing;
  select * into bucket from public.linghao_passport_v4_start_rate_buckets
    where bucket_hash = bucket_id for update;
  if bucket.window_started_at + interval '60 seconds' <= now_at then
    update public.linghao_passport_v4_start_rate_buckets
      set window_started_at = now_at, attempt_count = 1, updated_at = now_at
      where bucket_hash = bucket_id;
    bucket.attempt_count := 1;
  elsif bucket.updated_at <> now_at then
    update public.linghao_passport_v4_start_rate_buckets
      set attempt_count = attempt_count + 1, updated_at = now_at
      where bucket_hash = bucket_id
      returning attempt_count into bucket.attempt_count;
  end if;
  if bucket.attempt_count > 10 then
    insert into public.linghao_passport_v4_auth_audit(event_type, result_code)
      values ('start_rate_limited', 'rate_limited');
    return pg_catalog.jsonb_build_object('status','rate_limited');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(family_id, 0));
  insert into public.linghao_passport_v4_browser_families
    (family_hash, status, absolute_expires_at)
  values (family_id, 'reserved', now_at + interval '24 hours')
  on conflict (family_hash) do nothing;
  select * into family from public.linghao_passport_v4_browser_families
    where family_hash = family_id for update;
  if family.status in ('revoked','expired') or family.absolute_expires_at <= now_at then
    raise exception 'family unavailable';
  end if;

  update public.linghao_passport_v4_authorization_transactions
    set status = 'replaced', verifier_envelope = null, consumed_at = now_at
    where family_hash = family_id and status = 'pending';
  expiry := now_at + interval '10 minutes';
  insert into public.linghao_passport_v4_authorization_transactions
    (transaction_hash, family_hash, state_hash, nonce_hash, verifier_envelope, status, expires_at)
  values (transaction_id, family_id, state_id, nonce_id, verifier, 'pending', expiry);
  update public.linghao_passport_v4_browser_families set last_seen_at = now_at
    where family_hash = family_id;
  insert into public.linghao_passport_v4_auth_audit
    (event_type, result_code, family_hash, transaction_hash)
  values ('start_reserved', 'reserved', family_id, transaction_id);
  return pg_catalog.jsonb_build_object('status','reserved','expiresAtMs',
    pg_catalog.floor(extract(epoch from expiry) * 1000)::bigint);
end
$function$;

create function public.aistory_linghao_passport_v4_cancel_start(request_payload jsonb)
returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog
as $function$
declare
  transaction_id text;
  family_id text;
begin
  perform public.aistory_linghao_passport_v4_assert_ready();
  if not public.aistory_linghao_passport_v4_exact_object(request_payload, array['transactionHash']) then
    raise exception 'invalid cancel payload';
  end if;
  transaction_id := request_payload->>'transactionHash';
  if transaction_id !~ '^[0-9a-f]{64}$' then raise exception 'invalid transaction'; end if;
  select t.family_hash into family_id from public.linghao_passport_v4_authorization_transactions t
    where t.transaction_hash = transaction_id;
  if family_id is null then return true; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(family_id, 0));
  perform 1 from public.linghao_passport_v4_browser_families where family_hash = family_id for update;
  update public.linghao_passport_v4_authorization_transactions
    set status = 'cancelled', verifier_envelope = null, consumed_at = pg_catalog.clock_timestamp()
    where transaction_hash = transaction_id and status = 'pending';
  if found then
    insert into public.linghao_passport_v4_auth_audit
      (event_type,result_code,family_hash,transaction_hash)
    values ('start_cancelled','cancelled',family_id,transaction_id);
  end if;
  return true;
end
$function$;

create function public.aistory_linghao_passport_v4_consume_callback(request_payload jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog
as $function$
declare
  now_at timestamptz := pg_catalog.clock_timestamp();
  transaction_id text;
  supplied_state text;
  family_id text;
  transaction_row public.linghao_passport_v4_authorization_transactions%rowtype;
  family public.linghao_passport_v4_browser_families%rowtype;
  verifier text;
begin
  perform public.aistory_linghao_passport_v4_assert_ready();
  if not public.aistory_linghao_passport_v4_exact_object(request_payload, array['transactionHash','stateHash']) then
    raise exception 'invalid callback payload';
  end if;
  transaction_id := request_payload->>'transactionHash';
  supplied_state := request_payload->>'stateHash';
  if transaction_id !~ '^[0-9a-f]{64}$' or supplied_state !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid callback values';
  end if;
  select t.family_hash into family_id from public.linghao_passport_v4_authorization_transactions t
    where t.transaction_hash = transaction_id;
  if family_id is null then
    return pg_catalog.jsonb_build_object('status','rejected','reason','missing');
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(family_id, 0));
  select * into family from public.linghao_passport_v4_browser_families
    where family_hash = family_id for update;
  select * into transaction_row from public.linghao_passport_v4_authorization_transactions
    where transaction_hash = transaction_id for update;

  if transaction_row.status = 'completed' then
    if transaction_row.state_hash = supplied_state and transaction_row.completion_envelope is not null then
      return pg_catalog.jsonb_build_object('status','completed','sessionResultEnvelope',transaction_row.completion_envelope);
    end if;
    return pg_catalog.jsonb_build_object('status','rejected','reason','terminal');
  end if;
  if transaction_row.status <> 'pending' then
    return pg_catalog.jsonb_build_object('status','rejected','reason','terminal');
  end if;

  verifier := transaction_row.verifier_envelope;
  update public.linghao_passport_v4_authorization_transactions
    set status = 'callback_consumed', consumed_at = now_at, verifier_envelope = null
    where transaction_hash = transaction_id;
  insert into public.linghao_passport_v4_replay_claims(purpose,digest,family_hash,retain_until)
    values ('transaction',transaction_id,family_id,now_at + interval '2 hours')
    on conflict do nothing;

  if transaction_row.state_hash <> supplied_state then
    update public.linghao_passport_v4_authorization_transactions set status = 'state_mismatch'
      where transaction_hash = transaction_id;
    insert into public.linghao_passport_v4_auth_audit
      (event_type,result_code,family_hash,transaction_hash)
    values ('callback_rejected','state_mismatch',family_id,transaction_id);
    return pg_catalog.jsonb_build_object('status','rejected','reason','state_mismatch');
  end if;
  if transaction_row.expires_at <= now_at then
    update public.linghao_passport_v4_authorization_transactions set status = 'expired'
      where transaction_hash = transaction_id;
    insert into public.linghao_passport_v4_auth_audit
      (event_type,result_code,family_hash,transaction_hash)
    values ('callback_rejected','expired',family_id,transaction_id);
    return pg_catalog.jsonb_build_object('status','rejected','reason','expired');
  end if;
  if family.status not in ('reserved','active') or family.absolute_expires_at <= now_at then
    update public.linghao_passport_v4_authorization_transactions set status = 'logout_revoked'
      where transaction_hash = transaction_id;
    insert into public.linghao_passport_v4_auth_audit
      (event_type,result_code,family_hash,transaction_hash)
    values ('callback_rejected','family_terminal',family_id,transaction_id);
    return pg_catalog.jsonb_build_object('status','rejected','reason','terminal');
  end if;
  insert into public.linghao_passport_v4_auth_audit
    (event_type,result_code,family_hash,transaction_hash)
  values ('callback_consumed','accepted',family_id,transaction_id);
  return pg_catalog.jsonb_build_object('status','accepted','familyHash',family_id,
    'transactionHash',transaction_id,'nonceHash',transaction_row.nonce_hash,
    'verifierEnvelope',verifier);
end
$function$;

create function public.aistory_linghao_passport_v4_commit_callback(request_payload jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog
as $function$
declare
  now_at timestamptz := pg_catalog.clock_timestamp();
  transaction_id text := request_payload->>'transactionHash';
  family_id text := request_payload->>'familyHash';
  principal_id text := request_payload->>'principalKey';
  session_id text := request_payload->>'sessionHash';
  completion_id text := request_payload->>'completionHash';
  result_envelope text := request_payload->>'sessionResultEnvelope';
  access_id text := request_payload->>'accessTokenFingerprint';
  access_value text := request_payload->>'accessTokenEnvelope';
  hint_envelope text := request_payload->>'idTokenHintEnvelope';
  refresh_id text := request_payload->>'refreshFingerprint';
  refresh_value text := request_payload->>'refreshEnvelope';
  provider_ms bigint;
  provider_expiry timestamptz;
  absolute_expiry timestamptz;
  idle_expiry timestamptz;
  family public.linghao_passport_v4_browser_families%rowtype;
  transaction_row public.linghao_passport_v4_authorization_transactions%rowtype;
  next_generation bigint;
  outbox_id text;
begin
  perform public.aistory_linghao_passport_v4_assert_ready();
  if not public.aistory_linghao_passport_v4_exact_object(request_payload,
    array['transactionHash','familyHash','principalKey','sessionHash','completionHash',
      'sessionResultEnvelope','accessTokenFingerprint','accessTokenEnvelope',
      'idTokenHintEnvelope','refreshFingerprint','refreshEnvelope','providerExpiresAtMs']) then
    raise exception 'invalid commit callback payload';
  end if;
  if transaction_id !~ '^[0-9a-f]{64}$' or family_id !~ '^[0-9a-f]{64}$'
    or principal_id !~ '^[0-9a-f]{64}$' or session_id !~ '^[0-9a-f]{64}$'
    or completion_id !~ '^[0-9a-f]{64}$'
    or pg_catalog.length(result_envelope) > 22000
    or result_envelope !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
    or access_id !~ '^[0-9a-f]{64}$' or pg_catalog.length(access_value) > 22000
    or access_value !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
    or (hint_envelope is not null and (pg_catalog.length(hint_envelope) > 22000
      or hint_envelope !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'))
    or ((refresh_id is null) <> (refresh_value is null))
    or (refresh_id is not null and (refresh_id !~ '^[0-9a-f]{64}$'
      or pg_catalog.length(refresh_value) > 22000
      or refresh_value !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'))
    or pg_catalog.jsonb_typeof(request_payload->'providerExpiresAtMs') <> 'number' then
    raise exception 'invalid commit callback values';
  end if;
  provider_ms := (request_payload->>'providerExpiresAtMs')::bigint;
  provider_expiry := pg_catalog.to_timestamp(provider_ms / 1000.0);
  if provider_expiry <= now_at or provider_expiry > now_at + interval '1 hour' then
    raise exception 'invalid provider expiry';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(family_id, 0));
  select * into family from public.linghao_passport_v4_browser_families
    where family_hash = family_id for update;
  select * into transaction_row from public.linghao_passport_v4_authorization_transactions
    where transaction_hash = transaction_id for update;
  if not found or transaction_row.family_hash <> family_id then
    return pg_catalog.jsonb_build_object('status','rejected');
  end if;
  if transaction_row.status = 'completed' then
    if transaction_row.completion_hash = completion_id then
      insert into public.linghao_passport_v4_auth_audit
        (event_type,result_code,family_hash,transaction_hash,session_hash)
      values ('session_replayed','exact_replay',family_id,transaction_id,transaction_row.completed_session_hash);
      return pg_catalog.jsonb_build_object('status','replayed',
        'sessionResultEnvelope',transaction_row.completion_envelope,
        'absoluteExpiresAtMs',pg_catalog.floor(extract(epoch from transaction_row.completion_expires_at) * 1000)::bigint);
    end if;
    return pg_catalog.jsonb_build_object('status','rejected');
  end if;
  if transaction_row.status <> 'callback_consumed' then
    return pg_catalog.jsonb_build_object('status','rejected');
  end if;
  if family.status not in ('reserved','active') or family.absolute_expires_at <= now_at then
    outbox_id := public.aistory_linghao_passport_v4_internal_hash('late_callback_access');
    insert into public.linghao_passport_v4_revocation_outbox
      (outbox_hash,family_hash,token_kind,token_fingerprint,token_envelope,status)
    values (outbox_id,family_id,'access_token',access_id,access_value,'pending')
    on conflict (token_fingerprint) do nothing;
    if refresh_id is not null then
      outbox_id := public.aistory_linghao_passport_v4_internal_hash('late_callback_refresh');
      insert into public.linghao_passport_v4_revocation_outbox
        (outbox_hash,family_hash,token_kind,token_fingerprint,token_envelope,status)
      values (outbox_id,family_id,'refresh_token',refresh_id,refresh_value,'pending')
      on conflict (token_fingerprint) do nothing;
    end if;
    update public.linghao_passport_v4_authorization_transactions
      set status='logout_revoked' where transaction_hash=transaction_id;
    insert into public.linghao_passport_v4_auth_audit
      (event_type,result_code,family_hash,transaction_hash)
    values ('callback_rejected','late_token_cleanup',family_id,transaction_id);
    return pg_catalog.jsonb_build_object('status','cleanup_required');
  end if;

  insert into public.linghao_passport_v4_principals
    (principal_key,registration_sha256,account_namespace,status,created_at,last_login_at)
  values (principal_id,
    '7d97d64ac570d66e996e89033ad5061fbed3330cf026d70201bbf0cbfd13bd05',
    'passport_v4_new_v1','active',now_at,now_at)
  on conflict (principal_key) do update set last_login_at = excluded.last_login_at
    where public.linghao_passport_v4_principals.registration_sha256 = excluded.registration_sha256
      and public.linghao_passport_v4_principals.account_namespace = excluded.account_namespace
      and public.linghao_passport_v4_principals.status = 'active';
  if not found then return pg_catalog.jsonb_build_object('status','rejected'); end if;

  if family.current_session_hash is not null then
    update public.linghao_passport_v4_sessions
      set status = 'superseded', terminal_at = now_at, terminal_reason = 'new_login',
        id_token_hint_envelope = null, refresh_fingerprint = null, refresh_envelope = null
      where session_hash = family.current_session_hash and status in ('active','refreshing');
  end if;
  next_generation := family.generation + 1;
  absolute_expiry := least(now_at + interval '1 hour', provider_expiry);
  idle_expiry := least(now_at + interval '15 minutes', absolute_expiry);
  insert into public.linghao_passport_v4_sessions
    (session_hash,family_hash,principal_key,generation,status,authenticated_at,last_seen_at,
     idle_expires_at,absolute_expires_at,provider_expires_at,id_token_hint_envelope,
     refresh_fingerprint,refresh_envelope)
  values (session_id,family_id,principal_id,next_generation,'active',now_at,now_at,
    idle_expiry,absolute_expiry,provider_expiry,hint_envelope,refresh_id,refresh_value);
  update public.linghao_passport_v4_browser_families
    set principal_key = principal_id, current_session_hash = session_id, status = 'active',
      generation = next_generation, last_seen_at = now_at
    where family_hash = family_id;
  update public.linghao_passport_v4_authorization_transactions
    set status = 'completed', completed_at = now_at, completion_hash = completion_id,
      completion_envelope = result_envelope, completed_session_hash = session_id,
      completion_expires_at = absolute_expiry
    where transaction_hash = transaction_id;
  outbox_id := public.aistory_linghao_passport_v4_internal_hash('discard_access_token');
  insert into public.linghao_passport_v4_revocation_outbox
    (outbox_hash,family_hash,token_kind,token_fingerprint,token_envelope,status)
  values (outbox_id,family_id,'access_token',access_id,access_value,'pending')
  on conflict (token_fingerprint) do nothing;
  insert into public.linghao_passport_v4_auth_audit
    (event_type,result_code,family_hash,transaction_hash,session_hash)
  values ('session_established','committed',family_id,transaction_id,session_id);
  return pg_catalog.jsonb_build_object('status','committed','sessionResultEnvelope',result_envelope,
    'absoluteExpiresAtMs',pg_catalog.floor(extract(epoch from absolute_expiry) * 1000)::bigint);
end
$function$;

create function public.aistory_linghao_passport_v4_read_session(request_payload jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog
as $function$
declare
  now_at timestamptz := pg_catalog.clock_timestamp();
  session_id text;
  family_id text;
  session_row public.linghao_passport_v4_sessions%rowtype;
  family public.linghao_passport_v4_browser_families%rowtype;
  next_idle timestamptz;
  visible_expiry timestamptz;
begin
  perform public.aistory_linghao_passport_v4_assert_ready();
  if not public.aistory_linghao_passport_v4_exact_object(request_payload,array['sessionHash']) then
    raise exception 'invalid read payload';
  end if;
  session_id := request_payload->>'sessionHash';
  if session_id !~ '^[0-9a-f]{64}$' then raise exception 'invalid session'; end if;
  select s.family_hash into family_id from public.linghao_passport_v4_sessions s where s.session_hash = session_id;
  if family_id is null then return pg_catalog.jsonb_build_object('status','invalid'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(family_id,0));
  select * into family from public.linghao_passport_v4_browser_families where family_hash = family_id for update;
  select * into session_row from public.linghao_passport_v4_sessions where session_hash = session_id for update;
  if family.status <> 'active' or family.current_session_hash <> session_id
    or session_row.status not in ('active','refreshing')
    or session_row.idle_expires_at <= now_at or session_row.absolute_expires_at <= now_at then
    return pg_catalog.jsonb_build_object('status','invalid');
  end if;
  if session_row.status = 'refreshing' then
    return pg_catalog.jsonb_build_object('status','refresh_required','familyHash',family_id);
  end if;
  if session_row.provider_expires_at <= now_at + interval '60 seconds' then
    if session_row.refresh_envelope is not null then
      return pg_catalog.jsonb_build_object('status','refresh_required','familyHash',family_id);
    end if;
    update public.linghao_passport_v4_sessions set status='expired',terminal_at=now_at,
      terminal_reason='provider_expired',id_token_hint_envelope=null
      where session_hash=session_id;
    update public.linghao_passport_v4_browser_families set current_session_hash=null
      where family_hash=family_id;
    insert into public.linghao_passport_v4_auth_audit
      (event_type,result_code,family_hash,session_hash)
    values ('session_expired','provider_expired',family_id,session_id);
    return pg_catalog.jsonb_build_object('status','invalid');
  end if;
  next_idle := least(now_at + interval '15 minutes',session_row.absolute_expires_at,session_row.provider_expires_at);
  update public.linghao_passport_v4_sessions set last_seen_at=now_at,idle_expires_at=next_idle where session_hash=session_id;
  update public.linghao_passport_v4_browser_families set last_seen_at=now_at where family_hash=family_id;
  visible_expiry := least(next_idle,session_row.absolute_expires_at,session_row.provider_expires_at);
  return pg_catalog.jsonb_build_object('status','authenticated','principalKey',session_row.principal_key,
    'familyHash',family_id,'sessionHash',session_id,'generation',session_row.generation,
    'authenticatedAtMs',pg_catalog.floor(extract(epoch from session_row.authenticated_at)*1000)::bigint,
    'expiresAtMs',pg_catalog.floor(extract(epoch from visible_expiry)*1000)::bigint);
end
$function$;

create function public.aistory_linghao_passport_v4_begin_refresh(request_payload jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog
as $function$
declare
  now_at timestamptz := pg_catalog.clock_timestamp();
  session_id text := request_payload->>'sessionHash';
  attempt_id text := request_payload->>'attemptHash';
  refresh_id text;
  family_id text;
  session_row public.linghao_passport_v4_sessions%rowtype;
  family public.linghao_passport_v4_browser_families%rowtype;
  inserted integer;
begin
  perform public.aistory_linghao_passport_v4_assert_ready();
  if not public.aistory_linghao_passport_v4_exact_object(request_payload,array['sessionHash','attemptHash'])
    or session_id !~ '^[0-9a-f]{64}$' or attempt_id !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid refresh claim payload';
  end if;
  select s.family_hash into family_id from public.linghao_passport_v4_sessions s where s.session_hash=session_id;
  if family_id is null then return pg_catalog.jsonb_build_object('status','rejected'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(family_id,0));
  select * into family from public.linghao_passport_v4_browser_families where family_hash=family_id for update;
  select * into session_row from public.linghao_passport_v4_sessions where session_hash=session_id for update;
  refresh_id := session_row.refresh_fingerprint;
  if family.status <> 'active' or family.current_session_hash <> session_id or session_row.status <> 'active'
    or refresh_id is null or session_row.refresh_envelope is null
    or session_row.idle_expires_at <= now_at or session_row.absolute_expires_at <= now_at then
    return pg_catalog.jsonb_build_object('status','rejected');
  end if;
  if exists (select 1 from public.linghao_passport_v4_refresh_attempts where attempt_hash=attempt_id) then
    return pg_catalog.jsonb_build_object('status','rejected');
  end if;
  insert into public.linghao_passport_v4_replay_claims(purpose,digest,family_hash,retain_until)
    values ('refresh_fingerprint',refresh_id,family_id,session_row.absolute_expires_at + interval '1 hour')
    on conflict do nothing;
  get diagnostics inserted = row_count;
  if inserted <> 1 then return pg_catalog.jsonb_build_object('status','rejected'); end if;
  insert into public.linghao_passport_v4_refresh_attempts
    (attempt_hash,family_hash,session_hash,expected_generation,old_refresh_fingerprint,
     used_refresh_envelope,status,claimed_at,deadline_at)
  values (attempt_id,family_id,session_id,session_row.generation,refresh_id,
    session_row.refresh_envelope,'claimed',now_at,now_at+interval '2 minutes');
  update public.linghao_passport_v4_sessions set status='refreshing',refresh_fingerprint=null,refresh_envelope=null
    where session_hash=session_id;
  insert into public.linghao_passport_v4_auth_audit
    (event_type,result_code,family_hash,session_hash,attempt_hash)
  values ('refresh_claimed','claimed',family_id,session_id,attempt_id);
  return pg_catalog.jsonb_build_object('status','claimed','familyHash',family_id,'sessionHash',session_id,
    'generation',session_row.generation,'refreshContextHash',refresh_id,
    'refreshEnvelope',session_row.refresh_envelope);
end
$function$;

create function public.aistory_linghao_passport_v4_commit_refresh(request_payload jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog
as $function$
declare
  now_at timestamptz := pg_catalog.clock_timestamp();
  attempt_id text := request_payload->>'attemptHash';
  completion_id text := request_payload->>'completionHash';
  replacement_id text := request_payload->>'replacementFingerprint';
  replacement_value text := request_payload->>'replacementEnvelope';
  access_id text := request_payload->>'accessTokenFingerprint';
  access_value text := request_payload->>'accessTokenEnvelope';
  hint_value text := request_payload->>'idTokenHintEnvelope';
  provider_ms bigint;
  provider_expiry timestamptz;
  attempt public.linghao_passport_v4_refresh_attempts%rowtype;
  family public.linghao_passport_v4_browser_families%rowtype;
  session_row public.linghao_passport_v4_sessions%rowtype;
  outbox_id text;
  cas_ok boolean;
begin
  perform public.aistory_linghao_passport_v4_assert_ready();
  if not public.aistory_linghao_passport_v4_exact_object(request_payload,
    array['attemptHash','completionHash','replacementFingerprint','replacementEnvelope',
      'accessTokenFingerprint','accessTokenEnvelope','idTokenHintEnvelope','providerExpiresAtMs'])
    or attempt_id !~ '^[0-9a-f]{64}$' or completion_id !~ '^[0-9a-f]{64}$'
    or replacement_id !~ '^[0-9a-f]{64}$'
    or pg_catalog.length(replacement_value) > 22000
    or replacement_value !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
    or access_id !~ '^[0-9a-f]{64}$' or pg_catalog.length(access_value) > 22000
    or access_value !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'
    or (hint_value is not null and (pg_catalog.length(hint_value) > 22000
      or hint_value !~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$'))
    or pg_catalog.jsonb_typeof(request_payload->'providerExpiresAtMs') <> 'number' then
    raise exception 'invalid refresh commit payload';
  end if;
  provider_ms := (request_payload->>'providerExpiresAtMs')::bigint;
  provider_expiry := pg_catalog.to_timestamp(provider_ms/1000.0);
  if provider_expiry <= now_at or provider_expiry > now_at + interval '1 hour' then
    raise exception 'invalid refresh provider expiry';
  end if;
  select * into attempt from public.linghao_passport_v4_refresh_attempts where attempt_hash=attempt_id;
  if not found then return pg_catalog.jsonb_build_object('status','rejected'); end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(attempt.family_hash,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(replacement_id,1));
  select * into family from public.linghao_passport_v4_browser_families where family_hash=attempt.family_hash for update;
  select * into session_row from public.linghao_passport_v4_sessions where session_hash=attempt.session_hash for update;
  select * into attempt from public.linghao_passport_v4_refresh_attempts where attempt_hash=attempt_id for update;
  if attempt.status='committed' and attempt.completion_hash=completion_id
    and attempt.replacement_refresh_fingerprint=replacement_id then
    return pg_catalog.jsonb_build_object('status','replayed');
  end if;
  if attempt.status='cleanup_required' and attempt.completion_hash=completion_id
    and attempt.replacement_refresh_fingerprint=replacement_id then
    return pg_catalog.jsonb_build_object('status','cleanup_required');
  end if;
  if attempt.status not in ('claimed','uncertain') then
    return pg_catalog.jsonb_build_object('status','rejected');
  end if;
  cas_ok := attempt.status='claimed' and family.status='active'
    and family.current_session_hash=attempt.session_hash
    and session_row.status='refreshing'
    and session_row.generation=attempt.expected_generation
    and replacement_id<>attempt.old_refresh_fingerprint
    and not exists (select 1 from public.linghao_passport_v4_replay_claims
      where purpose='refresh_fingerprint' and digest=replacement_id)
    and not exists (select 1 from public.linghao_passport_v4_sessions
      where refresh_fingerprint=replacement_id);
  if cas_ok then
    update public.linghao_passport_v4_sessions
      set status='active',generation=generation+1,last_seen_at=now_at,
        idle_expires_at=least(now_at+interval '15 minutes',absolute_expires_at,provider_expiry),
        provider_expires_at=provider_expiry,id_token_hint_envelope=hint_value,
        refresh_fingerprint=replacement_id,refresh_envelope=replacement_value
      where session_hash=attempt.session_hash;
    update public.linghao_passport_v4_browser_families
      set generation=generation+1,last_seen_at=now_at where family_hash=attempt.family_hash;
    update public.linghao_passport_v4_refresh_attempts
      set status='committed',used_refresh_envelope=null,replacement_refresh_fingerprint=replacement_id,
        replacement_refresh_envelope=null,completion_hash=completion_id,completed_at=now_at
      where attempt_hash=attempt_id;
    outbox_id := public.aistory_linghao_passport_v4_internal_hash('discard_refresh_access');
    insert into public.linghao_passport_v4_revocation_outbox
      (outbox_hash,family_hash,attempt_hash,token_kind,token_fingerprint,token_envelope,status)
    values (outbox_id,attempt.family_hash,attempt_id,'access_token',access_id,access_value,'pending')
    on conflict (token_fingerprint) do nothing;
    insert into public.linghao_passport_v4_auth_audit
      (event_type,result_code,family_hash,session_hash,attempt_hash)
    values ('refresh_committed','committed',attempt.family_hash,attempt.session_hash,attempt_id);
    return pg_catalog.jsonb_build_object('status','committed');
  end if;

  outbox_id := public.aistory_linghao_passport_v4_internal_hash('refresh_cleanup');
  insert into public.linghao_passport_v4_revocation_outbox
    (outbox_hash,family_hash,attempt_hash,token_kind,token_fingerprint,token_envelope,status)
  values (outbox_id,attempt.family_hash,attempt_id,'refresh_token',replacement_id,replacement_value,'pending')
  on conflict (token_fingerprint) do nothing;
  outbox_id := public.aistory_linghao_passport_v4_internal_hash('discard_failed_refresh_access');
  insert into public.linghao_passport_v4_revocation_outbox
    (outbox_hash,family_hash,attempt_hash,token_kind,token_fingerprint,token_envelope,status)
  values (outbox_id,attempt.family_hash,attempt_id,'access_token',access_id,access_value,'pending')
  on conflict (token_fingerprint) do nothing;
  update public.linghao_passport_v4_refresh_attempts
    set status='cleanup_required',used_refresh_envelope=null,replacement_refresh_fingerprint=replacement_id,
      replacement_refresh_envelope=replacement_value,completion_hash=completion_id,completed_at=now_at
    where attempt_hash=attempt_id;
  insert into public.linghao_passport_v4_auth_audit
    (event_type,result_code,family_hash,session_hash,attempt_hash)
  values ('refresh_cleanup_required','cas_rejected',attempt.family_hash,attempt.session_hash,attempt_id);
  return pg_catalog.jsonb_build_object('status','cleanup_required');
end
$function$;

create function public.aistory_linghao_passport_v4_fail_refresh(request_payload jsonb)
returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog
as $function$
declare
  now_at timestamptz := pg_catalog.clock_timestamp();
  attempt_id text := request_payload->>'attemptHash';
  attempt public.linghao_passport_v4_refresh_attempts%rowtype;
  outbox_id text;
begin
  perform public.aistory_linghao_passport_v4_assert_ready();
  if not public.aistory_linghao_passport_v4_exact_object(request_payload,array['attemptHash'])
    or attempt_id !~ '^[0-9a-f]{64}$' then raise exception 'invalid refresh failure payload'; end if;
  select * into attempt from public.linghao_passport_v4_refresh_attempts where attempt_hash=attempt_id;
  if not found then return true; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(attempt.family_hash,0));
  perform 1 from public.linghao_passport_v4_browser_families where family_hash=attempt.family_hash for update;
  select * into attempt from public.linghao_passport_v4_refresh_attempts where attempt_hash=attempt_id for update;
  if attempt.status <> 'claimed' then return true; end if;
  outbox_id := public.aistory_linghao_passport_v4_internal_hash('uncertain_old_refresh');
  insert into public.linghao_passport_v4_revocation_outbox
    (outbox_hash,family_hash,attempt_hash,token_kind,token_fingerprint,token_envelope,status)
  values (outbox_id,attempt.family_hash,attempt_id,'refresh_token',attempt.old_refresh_fingerprint,
    attempt.used_refresh_envelope,'pending') on conflict (token_fingerprint) do nothing;
  update public.linghao_passport_v4_refresh_attempts
    set status='uncertain',used_refresh_envelope=null,completed_at=now_at where attempt_hash=attempt_id;
  update public.linghao_passport_v4_sessions
    set status='refresh_uncertain',terminal_at=now_at,terminal_reason='refresh_unknown',
      id_token_hint_envelope=null,refresh_fingerprint=null,refresh_envelope=null
    where session_hash=attempt.session_hash and status='refreshing';
  update public.linghao_passport_v4_browser_families
    set status='revoked',revoked_at=now_at,revocation_code='refresh_uncertain',current_session_hash=null
    where family_hash=attempt.family_hash and status<>'revoked';
  insert into public.linghao_passport_v4_auth_audit
    (event_type,result_code,family_hash,session_hash,attempt_hash)
  values ('refresh_uncertain','provider_outcome_unknown',attempt.family_hash,attempt.session_hash,attempt_id);
  return true;
end
$function$;

create function public.aistory_linghao_passport_v4_begin_logout(request_payload jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog
as $function$
declare
  now_at timestamptz := pg_catalog.clock_timestamp();
  family_id text := request_payload->>'familyHash';
  session_id text := request_payload->>'sessionHash';
  receipt_id text := request_payload->>'receiptHash';
  state_id text := request_payload->>'stateHash';
  return_expected boolean;
  family public.linghao_passport_v4_browser_families%rowtype;
  session_row public.linghao_passport_v4_sessions%rowtype;
  attempt record;
  logout_row public.linghao_passport_v4_logout_results%rowtype;
  expiry timestamptz := now_at + interval '10 minutes';
  pending boolean;
  outbox_id text;
begin
  perform public.aistory_linghao_passport_v4_assert_ready();
  if not public.aistory_linghao_passport_v4_exact_object(request_payload,
    array['familyHash','sessionHash','receiptHash','stateHash','upstreamReturnExpected'])
    or family_id !~ '^[0-9a-f]{64}$' or session_id !~ '^[0-9a-f]{64}$'
    or receipt_id !~ '^[0-9a-f]{64}$' or state_id !~ '^[0-9a-f]{64}$'
    or pg_catalog.jsonb_typeof(request_payload->'upstreamReturnExpected') <> 'boolean' then
    raise exception 'invalid logout payload';
  end if;
  return_expected := (request_payload->>'upstreamReturnExpected')::boolean;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(family_id,0));
  select * into family from public.linghao_passport_v4_browser_families where family_hash=family_id for update;
  select * into session_row from public.linghao_passport_v4_sessions
    where session_hash=session_id and family_hash=family_id for update;
  if family.family_hash is null or session_row.session_hash is null then
    return pg_catalog.jsonb_build_object('status','missing','localLoggedOut',true,
      'revocationPending',false,'idTokenHintEnvelope',null);
  end if;
  select * into logout_row from public.linghao_passport_v4_logout_results
    where receipt_hash=receipt_id for update;
  if found then
    if logout_row.family_hash<>family_id or logout_row.session_hash<>session_id
      or logout_row.state_hash<>state_id or logout_row.upstream_return_expected<>return_expected then
      raise exception 'logout receipt collision';
    end if;
    select exists(select 1 from public.linghao_passport_v4_revocation_outbox
      where family_hash=family_id and status<>'confirmed') into pending;
    return pg_catalog.jsonb_build_object('status','revoked','localLoggedOut',true,
      'revocationPending',pending,'resultExpiresAtMs',
      pg_catalog.floor(extract(epoch from logout_row.expires_at)*1000)::bigint,
      'idTokenHintEnvelope',logout_row.id_token_hint_envelope);
  end if;

  if session_row.refresh_fingerprint is not null and session_row.refresh_envelope is not null then
    outbox_id := public.aistory_linghao_passport_v4_internal_hash('logout_refresh');
    insert into public.linghao_passport_v4_revocation_outbox
      (outbox_hash,family_hash,token_kind,token_fingerprint,token_envelope,status)
    values (outbox_id,family_id,'refresh_token',session_row.refresh_fingerprint,
      session_row.refresh_envelope,'pending') on conflict (token_fingerprint) do nothing;
  end if;
  for attempt in select * from public.linghao_passport_v4_refresh_attempts
    where family_hash=family_id and status='claimed' for update
  loop
    outbox_id := public.aistory_linghao_passport_v4_internal_hash('logout_inflight_refresh');
    insert into public.linghao_passport_v4_revocation_outbox
      (outbox_hash,family_hash,attempt_hash,token_kind,token_fingerprint,token_envelope,status)
    values (outbox_id,family_id,attempt.attempt_hash,'refresh_token',attempt.old_refresh_fingerprint,
      attempt.used_refresh_envelope,'pending') on conflict (token_fingerprint) do nothing;
    update public.linghao_passport_v4_refresh_attempts
      set status='uncertain',used_refresh_envelope=null,completed_at=now_at
      where attempt_hash=attempt.attempt_hash;
  end loop;
  update public.linghao_passport_v4_authorization_transactions
    set status='logout_revoked',verifier_envelope=null,consumed_at=coalesce(consumed_at,now_at)
    where family_hash=family_id and status in ('pending','callback_consumed');
  update public.linghao_passport_v4_sessions
    set status='revoked',terminal_at=coalesce(terminal_at,now_at),terminal_reason='user_logout',
      id_token_hint_envelope=null,refresh_fingerprint=null,refresh_envelope=null
    where family_hash=family_id and status in ('active','refreshing');
  update public.linghao_passport_v4_browser_families
    set status='revoked',revoked_at=coalesce(revoked_at,now_at),revocation_code='user_logout',
      current_session_hash=null,last_seen_at=now_at where family_hash=family_id;
  insert into public.linghao_passport_v4_logout_results
    (receipt_hash,state_hash,family_hash,session_hash,id_token_hint_envelope,
     upstream_return_expected,local_revoked_at,created_at,expires_at)
  values (receipt_id,state_id,family_id,session_id,session_row.id_token_hint_envelope,
    return_expected,now_at,now_at,expiry);
  insert into public.linghao_passport_v4_replay_claims(purpose,digest,family_hash,retain_until)
    values ('session',session_id,family_id,expiry+interval '1 hour') on conflict do nothing;
  select exists(select 1 from public.linghao_passport_v4_revocation_outbox
      where family_hash=family_id and status<>'confirmed')
    or exists(select 1 from public.linghao_passport_v4_refresh_attempts
      where family_hash=family_id and status in ('claimed','uncertain','cleanup_required')) into pending;
  insert into public.linghao_passport_v4_auth_audit
    (event_type,result_code,family_hash,session_hash)
  values ('logout_started','local_revoked',family_id,session_id);
  return pg_catalog.jsonb_build_object('status','revoked','localLoggedOut',true,
    'revocationPending',pending,'resultExpiresAtMs',
    pg_catalog.floor(extract(epoch from expiry)*1000)::bigint,
    'idTokenHintEnvelope',session_row.id_token_hint_envelope);
end
$function$;

create function public.aistory_linghao_passport_v4_claim_revocation(request_payload jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog
as $function$
declare
  now_at timestamptz := pg_catalog.clock_timestamp();
  claim_id text := request_payload->>'outboxClaimHash';
  work public.linghao_passport_v4_revocation_outbox%rowtype;
begin
  perform public.aistory_linghao_passport_v4_assert_ready();
  if not public.aistory_linghao_passport_v4_exact_object(request_payload,array['outboxClaimHash'])
    or claim_id !~ '^[0-9a-f]{64}$' then raise exception 'invalid revocation claim'; end if;
  select * into work from public.linghao_passport_v4_revocation_outbox
    where status='pending' or (status='claimed' and lease_expires_at<=now_at)
    order by created_at,outbox_hash for update skip locked limit 1;
  if not found then return pg_catalog.jsonb_build_object('status','empty'); end if;
  update public.linghao_passport_v4_revocation_outbox
    set status='claimed',claim_hash=claim_id,lease_expires_at=now_at+interval '30 seconds',
      attempt_count=attempt_count+1
    where outbox_hash=work.outbox_hash
    returning * into work;
  return pg_catalog.jsonb_build_object('status','claimed','outboxHash',work.outbox_hash,
    'tokenContextHash',work.token_fingerprint,'tokenKind',work.token_kind,
    'tokenEnvelope',work.token_envelope);
end
$function$;

create function public.aistory_linghao_passport_v4_complete_revocation(request_payload jsonb)
returns boolean
language plpgsql volatile security definer
set search_path = pg_catalog
as $function$
declare
  now_at timestamptz := pg_catalog.clock_timestamp();
  outbox_id text := request_payload->>'outboxHash';
  confirmed boolean;
  work public.linghao_passport_v4_revocation_outbox%rowtype;
begin
  perform public.aistory_linghao_passport_v4_assert_ready();
  if not public.aistory_linghao_passport_v4_exact_object(request_payload,array['outboxHash','confirmed'])
    or outbox_id !~ '^[0-9a-f]{64}$' or pg_catalog.jsonb_typeof(request_payload->'confirmed')<>'boolean' then
    raise exception 'invalid revocation completion';
  end if;
  confirmed := (request_payload->>'confirmed')::boolean;
  select * into work from public.linghao_passport_v4_revocation_outbox where outbox_hash=outbox_id for update;
  if not found then return false; end if;
  if work.status in ('confirmed','unconfirmed') then return true; end if;
  if work.status<>'claimed' then return false; end if;
  if confirmed then
    update public.linghao_passport_v4_revocation_outbox
      set status='confirmed',token_envelope=null,claim_hash=null,lease_expires_at=null,completed_at=now_at
      where outbox_hash=outbox_id;
    if work.attempt_hash is not null then
      update public.linghao_passport_v4_refresh_attempts
        set status='cleanup_confirmed',replacement_refresh_envelope=null
        where attempt_hash=work.attempt_hash and status='cleanup_required';
    end if;
  elsif work.attempt_count>=5 then
    update public.linghao_passport_v4_revocation_outbox
      set status='unconfirmed',token_envelope=null,claim_hash=null,lease_expires_at=null,completed_at=now_at
      where outbox_hash=outbox_id;
  else
    update public.linghao_passport_v4_revocation_outbox
      set status='pending',claim_hash=null,lease_expires_at=null where outbox_hash=outbox_id;
  end if;
  insert into public.linghao_passport_v4_auth_audit(event_type,result_code,family_hash,attempt_hash)
    values ('revocation_completed',case when confirmed then 'confirmed' else 'not_confirmed' end,
      work.family_hash,work.attempt_hash);
  return true;
end
$function$;

create function public.aistory_linghao_passport_v4_consume_logout_result(request_payload jsonb)
returns jsonb
language plpgsql volatile security definer
set search_path = pg_catalog
as $function$
declare
  now_at timestamptz := pg_catalog.clock_timestamp();
  receipt_id text := request_payload->>'receiptHash';
  supplied_state text := request_payload->>'stateHash';
  returned boolean;
  result_row public.linghao_passport_v4_logout_results%rowtype;
  revocation_confirmed boolean;
  return_confirmed boolean;
begin
  perform public.aistory_linghao_passport_v4_assert_ready();
  if not public.aistory_linghao_passport_v4_exact_object(request_payload,
    array['receiptHash','stateHash','upstreamReturnConfirmed'])
    or receipt_id !~ '^[0-9a-f]{64}$' or supplied_state !~ '^[0-9a-f]{64}$'
    or pg_catalog.jsonb_typeof(request_payload->'upstreamReturnConfirmed')<>'boolean' then
    raise exception 'invalid logout result payload';
  end if;
  returned := (request_payload->>'upstreamReturnConfirmed')::boolean;
  select * into result_row from public.linghao_passport_v4_logout_results
    where receipt_hash=receipt_id for update;
  if not found or result_row.consumed_at is not null then
    return pg_catalog.jsonb_build_object('status','invalid');
  end if;
  update public.linghao_passport_v4_logout_results set consumed_at=now_at,
    upstream_returned_at=case when returned then now_at else null end,
    id_token_hint_envelope=null where receipt_hash=receipt_id;
  insert into public.linghao_passport_v4_replay_claims(purpose,digest,family_hash,retain_until)
    values ('logout_receipt',receipt_id,result_row.family_hash,
      greatest(result_row.expires_at,now_at)+interval '1 hour') on conflict do nothing;
  if result_row.expires_at<=now_at or result_row.state_hash<>supplied_state then
    return pg_catalog.jsonb_build_object('status','invalid');
  end if;
  revocation_confirmed := not exists (
      select 1 from public.linghao_passport_v4_revocation_outbox
      where family_hash=result_row.family_hash and status<>'confirmed'
    ) and not exists (
      select 1 from public.linghao_passport_v4_refresh_attempts
      where family_hash=result_row.family_hash and status in ('claimed','uncertain','cleanup_required')
    );
  return_confirmed := returned and result_row.upstream_return_expected and revocation_confirmed;
  insert into public.linghao_passport_v4_auth_audit(event_type,result_code,family_hash,session_hash)
    values ('logout_result_consumed',case when revocation_confirmed then 'revocation_confirmed' else 'revocation_unconfirmed' end,
      result_row.family_hash,result_row.session_hash);
  return pg_catalog.jsonb_build_object('status','consumed','localLoggedOut',true,
    'revocationConfirmed',revocation_confirmed,'upstreamReturnConfirmed',return_confirmed);
end
$function$;

create function public.aistory_linghao_passport_v4_inspect_logout_result(request_payload jsonb)
returns jsonb
language plpgsql stable security definer
set search_path = pg_catalog
as $function$
declare
  receipt_id text := request_payload->>'receiptHash';
  result_row public.linghao_passport_v4_logout_results%rowtype;
  confirmed boolean;
begin
  perform public.aistory_linghao_passport_v4_assert_ready();
  if not public.aistory_linghao_passport_v4_exact_object(request_payload,array['receiptHash'])
    or receipt_id !~ '^[0-9a-f]{64}$' then raise exception 'invalid logout inspection'; end if;
  select * into result_row from public.linghao_passport_v4_logout_results where receipt_hash=receipt_id;
  if not found or result_row.consumed_at is not null or result_row.expires_at<=pg_catalog.clock_timestamp() then
    return pg_catalog.jsonb_build_object('status','invalid');
  end if;
  confirmed := not exists (
      select 1 from public.linghao_passport_v4_revocation_outbox
      where family_hash=result_row.family_hash and status<>'confirmed'
    ) and not exists (
      select 1 from public.linghao_passport_v4_refresh_attempts
      where family_hash=result_row.family_hash and status in ('claimed','uncertain','cleanup_required')
    );
  return pg_catalog.jsonb_build_object('status','ready','revocationConfirmed',confirmed);
end
$function$;

create function public.aistory_linghao_passport_v4_auth_posture()
returns text
language plpgsql stable security definer
set search_path = pg_catalog
as $function$
declare
  gate_version text;
  relation_name text;
  procedure_name text;
begin
  perform public.aistory_linghao_passport_v4_assert_service_role();
  select g.version into gate_version from public.linghao_passport_v4_auth_gates g where g.singleton=true;
  if gate_version is distinct from '20261119120000' then return null; end if;
  foreach relation_name in array array[
    'linghao_passport_v4_auth_gates','linghao_passport_v4_principals',
    'linghao_passport_v4_browser_families','linghao_passport_v4_authorization_transactions',
    'linghao_passport_v4_sessions','linghao_passport_v4_refresh_attempts',
    'linghao_passport_v4_replay_claims','linghao_passport_v4_revocation_outbox',
    'linghao_passport_v4_logout_results','linghao_passport_v4_start_rate_buckets',
    'linghao_passport_v4_auth_audit','linghao_passport_v4_catalog_manifest']
  loop
    if not exists (
      select 1 from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
      where n.nspname='public' and c.relname=relation_name and c.relkind='r'
        and c.relowner='postgres'::regrole and c.relrowsecurity and c.relforcerowsecurity
    ) or exists (select 1 from pg_catalog.pg_policy p
      where p.polrelid=pg_catalog.to_regclass('public.'||relation_name))
    or pg_catalog.has_table_privilege('anon','public.'||relation_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    or pg_catalog.has_table_privilege('authenticated','public.'||relation_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE')
    or pg_catalog.has_table_privilege('service_role','public.'||relation_name,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') then
      return null;
    end if;
  end loop;
  for procedure_name in select m.object_identity from public.linghao_passport_v4_catalog_manifest m loop
    if pg_catalog.to_regprocedure(procedure_name) is null or not exists (
      select 1 from public.linghao_passport_v4_catalog_manifest m
      where m.object_identity=procedure_name
        and m.definition_md5=pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(procedure_name)))
    ) then return null; end if;
  end loop;
  return gate_version;
end
$function$;

alter function public.aistory_linghao_passport_v4_exact_object(jsonb,text[]) owner to postgres;
alter function public.aistory_linghao_passport_v4_assert_service_role() owner to postgres;
alter function public.aistory_linghao_passport_v4_assert_ready() owner to postgres;
alter function public.aistory_linghao_passport_v4_internal_hash(text) owner to postgres;
alter function public.aistory_linghao_passport_v4_immutable_guard() owner to postgres;
alter function public.aistory_linghao_passport_v4_reserve_start(jsonb) owner to postgres;
alter function public.aistory_linghao_passport_v4_cancel_start(jsonb) owner to postgres;
alter function public.aistory_linghao_passport_v4_consume_callback(jsonb) owner to postgres;
alter function public.aistory_linghao_passport_v4_commit_callback(jsonb) owner to postgres;
alter function public.aistory_linghao_passport_v4_read_session(jsonb) owner to postgres;
alter function public.aistory_linghao_passport_v4_begin_refresh(jsonb) owner to postgres;
alter function public.aistory_linghao_passport_v4_commit_refresh(jsonb) owner to postgres;
alter function public.aistory_linghao_passport_v4_fail_refresh(jsonb) owner to postgres;
alter function public.aistory_linghao_passport_v4_begin_logout(jsonb) owner to postgres;
alter function public.aistory_linghao_passport_v4_claim_revocation(jsonb) owner to postgres;
alter function public.aistory_linghao_passport_v4_complete_revocation(jsonb) owner to postgres;
alter function public.aistory_linghao_passport_v4_consume_logout_result(jsonb) owner to postgres;
alter function public.aistory_linghao_passport_v4_inspect_logout_result(jsonb) owner to postgres;
alter function public.aistory_linghao_passport_v4_auth_posture() owner to postgres;

revoke all on table public.linghao_passport_v4_auth_gates,
  public.linghao_passport_v4_principals,
  public.linghao_passport_v4_browser_families,
  public.linghao_passport_v4_authorization_transactions,
  public.linghao_passport_v4_sessions,
  public.linghao_passport_v4_refresh_attempts,
  public.linghao_passport_v4_replay_claims,
  public.linghao_passport_v4_revocation_outbox,
  public.linghao_passport_v4_logout_results,
  public.linghao_passport_v4_start_rate_buckets,
  public.linghao_passport_v4_auth_audit,
  public.linghao_passport_v4_catalog_manifest
from public, anon, authenticated, service_role;
revoke all on sequence public.linghao_passport_v4_auth_audit_event_id_seq
from public, anon, authenticated, service_role;

revoke all on function public.aistory_linghao_passport_v4_exact_object(jsonb,text[]),
  public.aistory_linghao_passport_v4_assert_service_role(),
  public.aistory_linghao_passport_v4_assert_ready(),
  public.aistory_linghao_passport_v4_internal_hash(text),
  public.aistory_linghao_passport_v4_immutable_guard(),
  public.aistory_linghao_passport_v4_reserve_start(jsonb),
  public.aistory_linghao_passport_v4_cancel_start(jsonb),
  public.aistory_linghao_passport_v4_consume_callback(jsonb),
  public.aistory_linghao_passport_v4_commit_callback(jsonb),
  public.aistory_linghao_passport_v4_read_session(jsonb),
  public.aistory_linghao_passport_v4_begin_refresh(jsonb),
  public.aistory_linghao_passport_v4_commit_refresh(jsonb),
  public.aistory_linghao_passport_v4_fail_refresh(jsonb),
  public.aistory_linghao_passport_v4_begin_logout(jsonb),
  public.aistory_linghao_passport_v4_claim_revocation(jsonb),
  public.aistory_linghao_passport_v4_complete_revocation(jsonb),
  public.aistory_linghao_passport_v4_consume_logout_result(jsonb),
  public.aistory_linghao_passport_v4_inspect_logout_result(jsonb),
  public.aistory_linghao_passport_v4_auth_posture()
from public, anon, authenticated, service_role;

grant execute on function public.aistory_linghao_passport_v4_reserve_start(jsonb),
  public.aistory_linghao_passport_v4_cancel_start(jsonb),
  public.aistory_linghao_passport_v4_consume_callback(jsonb),
  public.aistory_linghao_passport_v4_commit_callback(jsonb),
  public.aistory_linghao_passport_v4_read_session(jsonb),
  public.aistory_linghao_passport_v4_begin_refresh(jsonb),
  public.aistory_linghao_passport_v4_commit_refresh(jsonb),
  public.aistory_linghao_passport_v4_fail_refresh(jsonb),
  public.aistory_linghao_passport_v4_begin_logout(jsonb),
  public.aistory_linghao_passport_v4_claim_revocation(jsonb),
  public.aistory_linghao_passport_v4_complete_revocation(jsonb),
  public.aistory_linghao_passport_v4_consume_logout_result(jsonb),
  public.aistory_linghao_passport_v4_inspect_logout_result(jsonb),
  public.aistory_linghao_passport_v4_auth_posture()
to service_role;

insert into public.linghao_passport_v4_catalog_manifest(object_identity,definition_md5)
select identity, pg_catalog.md5(pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(identity)))
from pg_catalog.unnest(array[
  'public.aistory_linghao_passport_v4_exact_object(jsonb,text[])',
  'public.aistory_linghao_passport_v4_assert_service_role()',
  'public.aistory_linghao_passport_v4_assert_ready()',
  'public.aistory_linghao_passport_v4_internal_hash(text)',
  'public.aistory_linghao_passport_v4_immutable_guard()',
  'public.aistory_linghao_passport_v4_reserve_start(jsonb)',
  'public.aistory_linghao_passport_v4_cancel_start(jsonb)',
  'public.aistory_linghao_passport_v4_consume_callback(jsonb)',
  'public.aistory_linghao_passport_v4_commit_callback(jsonb)',
  'public.aistory_linghao_passport_v4_read_session(jsonb)',
  'public.aistory_linghao_passport_v4_begin_refresh(jsonb)',
  'public.aistory_linghao_passport_v4_commit_refresh(jsonb)',
  'public.aistory_linghao_passport_v4_fail_refresh(jsonb)',
  'public.aistory_linghao_passport_v4_begin_logout(jsonb)',
  'public.aistory_linghao_passport_v4_claim_revocation(jsonb)',
  'public.aistory_linghao_passport_v4_complete_revocation(jsonb)',
  'public.aistory_linghao_passport_v4_consume_logout_result(jsonb)',
  'public.aistory_linghao_passport_v4_inspect_logout_result(jsonb)',
  'public.aistory_linghao_passport_v4_auth_posture()'
]) identity;

insert into public.linghao_passport_v4_auth_gates(singleton,gate_name,version)
values (true,'linghao_passport_v4_auth_state','20261119120000');

set local request.jwt.claim.role = 'service_role';
do $postflight$
begin
  if public.aistory_linghao_passport_v4_auth_posture() is distinct from '20261119120000' then
    raise exception 'linghao passport v4 gate postflight failed';
  end if;
end
$postflight$;

commit;
