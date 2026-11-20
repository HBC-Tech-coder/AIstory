-- Independent administrator principal production gate v1, PostgreSQL 16.
--
-- Supersedes the never-applied 20260828230000 candidate. Release packages
-- MUST omit that migration path; its immutable archive remains evidence only.
-- This full migration is applied directly to the Gate14 baseline and refuses
-- any prior independent-admin gate row or partial object set.
--
-- This feature gate is deliberately separate from production_identity_billing
-- Gate14. It never maps a principal to auth.users, app_users, phone identities,
-- legacy administrator roles, or the existing administrator audit actor FK.
-- Password material, username material, signing keys and credential paths stay
-- in a root-only runtime credential file; this database stores references and
-- immutable authentication/audit state only.

do $$
begin
  if not exists (
    select 1
    from public.aistory_schema_gates as gate_row
    where gate_row.gate_name = 'production_identity_billing'
      and gate_row.version = '20260811193000'
  ) then
    raise exception 'independent administrator prerequisite unavailable';
  end if;
  if exists (
    select 1
    from public.aistory_schema_gates as gate_row
    where gate_row.gate_name = 'independent_admin_principal'
  ) or to_regclass('public.independent_admin_principals') is not null
    or to_regclass('public.independent_admin_login_buckets') is not null
    or to_regclass('public.independent_admin_session_families') is not null
    or to_regclass('public.independent_admin_sessions') is not null
    or to_regclass('public.independent_admin_auth_audit') is not null
    or to_regclass(
      'public.independent_admin_auth_audit_sequence_seq'
    ) is not null
    or exists (
      select 1
      from pg_catalog.pg_proc as procedure_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      where namespace_row.nspname = 'public'
        and procedure_row.proname like 'aistory\_independent\_admin\_%'
          escape '\'
    ) then
    raise exception 'independent administrator superseded or partial gate present';
  end if;
end;
$$;

create table public.independent_admin_principals (
  singleton_slot smallint primary key default 1
    check (singleton_slot = 1),
  principal_ref text not null unique
    check (principal_ref ~ '^iap_[a-f0-9]{32}$'),
  tenant_id text not null default 'platform'
    check (tenant_id = 'platform'),
  role text not null default 'super_admin'
    check (role = 'super_admin'),
  status text not null default 'active'
    check (status in ('active', 'locked', 'revoked')),
  credential_binding_sha256 text not null
    check (credential_binding_sha256 ~ '^[a-f0-9]{64}$'),
  credential_epoch_sha256 text not null
    check (credential_epoch_sha256 ~ '^[a-f0-9]{64}$'),
  password_verifier_reference_sha256 text not null
    check (password_verifier_reference_sha256 ~ '^[a-f0-9]{64}$'),
  password_algorithm text not null
    check (password_algorithm = 'scrypt-v1'),
  password_parameters jsonb not null,
  init_request_id text not null unique
    check (init_request_id ~ '^ipr_[A-Za-z0-9_-]{32,96}$'),
  last_rotation_request_id text,
  prior_credential_binding_sha256 text,
  credential_revision bigint not null default 1
    check (credential_revision >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    jsonb_typeof(password_parameters) = 'object'
    and password_parameters = jsonb_build_object(
      'N', 131072,
      'r', 8,
      'p', 1,
      'keyLength', 64,
      'maxmem', 268435456
    )
  ),
  check (
    (last_rotation_request_id is null
      and prior_credential_binding_sha256 is null)
    or (
      last_rotation_request_id ~ '^ipr_[A-Za-z0-9_-]{32,96}$'
      and prior_credential_binding_sha256 ~ '^[a-f0-9]{64}$'
    )
  )
);

create table public.independent_admin_login_buckets (
  bucket_hash text primary key
    check (bucket_hash ~ '^[a-f0-9]{64}$'),
  window_started_at timestamptz not null,
  attempt_count integer not null check (attempt_count between 0 and 100),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

create table public.independent_admin_session_families (
  family_hash text primary key
    check (family_hash ~ '^[a-f0-9]{64}$'),
  principal_ref text not null references public.independent_admin_principals(
    principal_ref
  ) on delete restrict,
  credential_binding_sha256 text not null
    check (credential_binding_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  absolute_expires_at timestamptz not null,
  revoked_at timestamptz,
  revocation_code text,
  check (absolute_expires_at > created_at),
  check (
    (revoked_at is null and revocation_code is null)
    or (
      revoked_at is not null
      and revocation_code in (
        'logout', 'replaced', 'credential_rotated',
        'replay_detected', 'break_glass'
      )
    )
  )
);

create unique index independent_admin_one_active_family
  on public.independent_admin_session_families (principal_ref)
  where revoked_at is null;

create table public.independent_admin_sessions (
  session_hash text primary key
    check (session_hash ~ '^[a-f0-9]{64}$'),
  family_hash text not null references public.independent_admin_session_families(
    family_hash
  ) on delete restrict,
  rotation_ordinal integer not null default 0
    check (rotation_ordinal between 0 and 4096),
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  state text not null default 'active'
    check (state in ('active', 'rotated', 'revoked', 'expired')),
  replacement_session_hash text,
  terminal_at timestamptz,
  check (expires_at > issued_at),
  check (
    (state = 'active'
      and replacement_session_hash is null
      and terminal_at is null)
    or (
      state = 'rotated'
      and replacement_session_hash ~ '^[a-f0-9]{64}$'
      and terminal_at is not null
    )
    or (
      state in ('revoked', 'expired')
      and replacement_session_hash is null
      and terminal_at is not null
    )
  )
);

create unique index independent_admin_one_active_session
  on public.independent_admin_sessions (family_hash)
  where state = 'active';

create table public.independent_admin_auth_audit (
  sequence bigint generated always as identity primary key,
  principal_ref text,
  event text not null check (event in (
    'initialized', 'origin_rejected', 'invalid_credentials', 'rate_limited',
    'login_succeeded', 'session_rotated', 'session_replay_rejected',
    'logout', 'credential_rotated', 'break_glass_revoked'
  )),
  family_hash text,
  request_id text,
  occurred_at timestamptz not null default now(),
  check (principal_ref is null or principal_ref ~ '^iap_[a-f0-9]{32}$'),
  check (family_hash is null or family_hash ~ '^[a-f0-9]{64}$'),
  check (request_id is null or request_id ~ '^ipr_[A-Za-z0-9_-]{32,96}$')
);

alter table public.independent_admin_principals
  enable row level security;
alter table public.independent_admin_principals
  force row level security;
alter table public.independent_admin_login_buckets
  enable row level security;
alter table public.independent_admin_login_buckets
  force row level security;
alter table public.independent_admin_session_families
  enable row level security;
alter table public.independent_admin_session_families
  force row level security;
alter table public.independent_admin_sessions
  enable row level security;
alter table public.independent_admin_sessions
  force row level security;
alter table public.independent_admin_auth_audit
  enable row level security;
alter table public.independent_admin_auth_audit
  force row level security;

revoke all on table public.independent_admin_principals
from public, anon, authenticated, service_role;
revoke all on table public.independent_admin_login_buckets
from public, anon, authenticated, service_role;
revoke all on table public.independent_admin_session_families
from public, anon, authenticated, service_role;
revoke all on table public.independent_admin_sessions
from public, anon, authenticated, service_role;
revoke all on table public.independent_admin_auth_audit
from public, anon, authenticated, service_role;
revoke all on sequence public.independent_admin_auth_audit_sequence_seq
from public, anon, authenticated, service_role;

create function public.aistory_independent_admin_exact_object(
  candidate jsonb,
  expected_keys text[]
)
returns boolean
language sql
immutable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_typeof(candidate) = 'object'
    and (
      select coalesce(array_agg(item.key order by item.key), '{}'::text[])
      from jsonb_object_keys(candidate) as item(key)
    ) = (
      select array_agg(item.key order by item.key)
      from unnest(expected_keys) as item(key)
    );
$$;

create function public.aistory_independent_admin_assert_service_role()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'independent administrator unavailable';
  end if;
end;
$$;

create function public.aistory_independent_admin_assert_binding(
  candidate jsonb
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if not public.aistory_independent_admin_exact_object(
    candidate,
    array[
      'principal_ref', 'credential_binding_sha256',
      'credential_epoch_sha256', 'password_verifier_reference_sha256',
      'password_algorithm', 'password_parameters'
    ]
  )
    or candidate->>'principal_ref' !~ '^iap_[a-f0-9]{32}$'
    or candidate->>'credential_binding_sha256' !~ '^[a-f0-9]{64}$'
    or candidate->>'credential_epoch_sha256' !~ '^[a-f0-9]{64}$'
    or candidate->>'password_verifier_reference_sha256'
      !~ '^[a-f0-9]{64}$'
    or candidate->>'password_algorithm' <> 'scrypt-v1'
    or candidate->'password_parameters' <> jsonb_build_object(
      'N', 131072,
      'r', 8,
      'p', 1,
      'keyLength', 64,
      'maxmem', 268435456
    ) then
    raise exception 'independent administrator binding invalid';
  end if;
end;
$$;

create function public.aistory_independent_admin_reject_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception 'independent administrator audit is append-only';
end;
$$;

create trigger independent_admin_auth_audit_append_only
before update or delete on public.independent_admin_auth_audit
for each row execute function
  public.aistory_independent_admin_reject_audit_mutation();

create trigger independent_admin_auth_audit_no_truncate
before truncate on public.independent_admin_auth_audit
for each statement execute function
  public.aistory_independent_admin_reject_audit_mutation();

create function public.aistory_independent_admin_initialize(
  registration jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_existing public.independent_admin_principals%rowtype;
  v_binding jsonb;
  v_request_id text;
begin
  perform public.aistory_independent_admin_assert_service_role();
  if not public.aistory_independent_admin_exact_object(
    registration,
    array[
      'principal_ref', 'credential_binding_sha256',
      'credential_epoch_sha256', 'password_verifier_reference_sha256',
      'password_algorithm', 'password_parameters', 'request_id'
    ]
  ) then
    raise exception 'independent administrator registration invalid';
  end if;
  v_binding := registration - 'request_id';
  perform public.aistory_independent_admin_assert_binding(v_binding);
  v_request_id := registration->>'request_id';
  if v_request_id !~ '^ipr_[A-Za-z0-9_-]{32,96}$' then
    raise exception 'independent administrator registration invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('aistory:independent-admin:singleton:v1', 0)
  );
  select principal_row.* into v_existing
  from public.independent_admin_principals as principal_row
  where principal_row.singleton_slot = 1
  for update;
  if found then
    if v_existing.principal_ref = registration->>'principal_ref'
      and v_existing.credential_binding_sha256
        = registration->>'credential_binding_sha256'
      and v_existing.credential_epoch_sha256
        = registration->>'credential_epoch_sha256'
      and v_existing.password_verifier_reference_sha256
        = registration->>'password_verifier_reference_sha256'
      and v_existing.init_request_id = v_request_id then
      return jsonb_build_object('initialized', true, 'replayed', true);
    end if;
    raise exception 'independent administrator already initialized';
  end if;

  insert into public.independent_admin_principals (
    principal_ref, credential_binding_sha256, credential_epoch_sha256,
    password_verifier_reference_sha256, password_algorithm,
    password_parameters, init_request_id
  ) values (
    registration->>'principal_ref',
    registration->>'credential_binding_sha256',
    registration->>'credential_epoch_sha256',
    registration->>'password_verifier_reference_sha256',
    registration->>'password_algorithm',
    registration->'password_parameters',
    v_request_id
  );
  insert into public.independent_admin_auth_audit (
    principal_ref, event, request_id
  ) values (
    registration->>'principal_ref', 'initialized', v_request_id
  );
  return jsonb_build_object('initialized', true, 'replayed', false);
end;
$$;

create function public.aistory_independent_admin_rotate_credential(
  rotation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_principal public.independent_admin_principals%rowtype;
  v_next jsonb;
  v_request_id text;
  v_current_binding text;
  v_now timestamptz := clock_timestamp();
begin
  perform public.aistory_independent_admin_assert_service_role();
  if not public.aistory_independent_admin_exact_object(
    rotation,
    array['current_credential_binding_sha256', 'next', 'request_id']
  ) then
    raise exception 'independent administrator rotation invalid';
  end if;
  v_current_binding := rotation->>'current_credential_binding_sha256';
  v_next := rotation->'next';
  v_request_id := rotation->>'request_id';
  perform public.aistory_independent_admin_assert_binding(v_next);
  if v_current_binding !~ '^[a-f0-9]{64}$'
    or v_request_id !~ '^ipr_[A-Za-z0-9_-]{32,96}$' then
    raise exception 'independent administrator rotation invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('aistory:independent-admin:singleton:v1', 0)
  );
  select principal_row.* into strict v_principal
  from public.independent_admin_principals as principal_row
  where principal_row.singleton_slot = 1
  for update;
  if v_principal.credential_binding_sha256
      = v_next->>'credential_binding_sha256'
    and v_principal.prior_credential_binding_sha256 = v_current_binding
    and v_principal.last_rotation_request_id = v_request_id then
    return jsonb_build_object('rotated', true, 'replayed', true);
  end if;
  if v_principal.status = 'revoked'
    or v_principal.credential_binding_sha256 <> v_current_binding
    or v_principal.principal_ref <> v_next->>'principal_ref'
    or v_next->>'credential_binding_sha256' = v_current_binding then
    raise exception 'independent administrator rotation unavailable';
  end if;

  update public.independent_admin_session_families as family_row
  set revoked_at = v_now,
      revocation_code = 'credential_rotated'
  where family_row.principal_ref = v_principal.principal_ref
    and family_row.revoked_at is null;
  update public.independent_admin_sessions as session_row
  set state = 'revoked', terminal_at = v_now
  from public.independent_admin_session_families as family_row
  where session_row.family_hash = family_row.family_hash
    and family_row.principal_ref = v_principal.principal_ref
    and session_row.state = 'active';
  update public.independent_admin_principals as principal_row
  set credential_binding_sha256 = v_next->>'credential_binding_sha256',
      credential_epoch_sha256 = v_next->>'credential_epoch_sha256',
      password_verifier_reference_sha256 =
        v_next->>'password_verifier_reference_sha256',
      password_algorithm = v_next->>'password_algorithm',
      password_parameters = v_next->'password_parameters',
      prior_credential_binding_sha256 = v_current_binding,
      last_rotation_request_id = v_request_id,
      credential_revision = principal_row.credential_revision + 1,
      status = 'active',
      updated_at = v_now
  where principal_row.singleton_slot = 1;
  insert into public.independent_admin_auth_audit (
    principal_ref, event, request_id, occurred_at
  ) values (
    v_principal.principal_ref, 'credential_rotated', v_request_id, v_now
  );
  return jsonb_build_object('rotated', true, 'replayed', false);
end;
$$;

create function public.aistory_independent_admin_reserve_login(
  attempt jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_binding jsonb;
  v_global_hash text;
  v_subject_hash text;
  v_occurred_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_retry integer := 0;
  v_bucket record;
  v_newly_locked_hashes text[] := array[]::text[];
  v_missing_buckets integer := 0;
  v_total_buckets integer := 0;
begin
  perform public.aistory_independent_admin_assert_service_role();
  if not public.aistory_independent_admin_exact_object(
    attempt,
    array[
      'principal_ref', 'credential_binding_sha256',
      'credential_epoch_sha256', 'password_verifier_reference_sha256',
      'password_algorithm', 'password_parameters', 'global_bucket_hash',
      'subject_bucket_hash', 'occurred_at'
    ]
  ) then
    raise exception 'independent administrator attempt invalid';
  end if;
  v_binding := attempt
    - 'global_bucket_hash' - 'subject_bucket_hash' - 'occurred_at';
  perform public.aistory_independent_admin_assert_binding(v_binding);
  v_global_hash := attempt->>'global_bucket_hash';
  v_subject_hash := attempt->>'subject_bucket_hash';
  begin
    v_occurred_at := (attempt->>'occurred_at')::timestamptz;
  exception when others then
    raise exception 'independent administrator attempt invalid';
  end;
  if v_global_hash !~ '^[a-f0-9]{64}$'
    or v_subject_hash !~ '^[a-f0-9]{64}$'
    or v_global_hash = v_subject_hash
    or abs(extract(epoch from (v_now - v_occurred_at))) > 60
    or not exists (
      select 1
      from public.independent_admin_principals as principal_row
      where principal_row.singleton_slot = 1
        and principal_row.principal_ref = attempt->>'principal_ref'
        and principal_row.credential_binding_sha256
          = attempt->>'credential_binding_sha256'
        and principal_row.credential_epoch_sha256
          = attempt->>'credential_epoch_sha256'
        and principal_row.status = 'active'
    ) then
    raise exception 'independent administrator attempt unavailable';
  end if;

  -- Bound adversarial username/IP cardinality before creating bucket rows.
  -- The lock is local to this small administrator-only table and all stale
  -- rows are at least one full rate window old before removal.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'aistory:independent-admin:login-bucket-capacity:v1',
      0
    )
  );
  delete from public.independent_admin_login_buckets as stale_row
  where stale_row.updated_at <= v_now - interval '15 minutes'
    and (stale_row.locked_until is null or stale_row.locked_until <= v_now);
  select count(*) into v_missing_buckets
  from unnest(array[v_global_hash, v_subject_hash]) as requested(bucket_hash)
  where not exists (
    select 1
    from public.independent_admin_login_buckets as stored
    where stored.bucket_hash = requested.bucket_hash
  );
  select count(*) into v_total_buckets
  from public.independent_admin_login_buckets;
  if v_total_buckets + v_missing_buckets > 4096 then
    return jsonb_build_object('allowed', false, 'retry_after_seconds', 60);
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(requested_bucket.bucket_hash, 0)
  )
  from unnest(array[v_global_hash, v_subject_hash])
    as requested_bucket(bucket_hash)
  order by requested_bucket.bucket_hash;

  for v_bucket in
    select requested.bucket_hash,
      case when requested.bucket_hash = v_global_hash then 100 else 5 end
        as maximum_attempts,
      stored.window_started_at,
      stored.attempt_count,
      stored.locked_until
    from unnest(array[v_global_hash, v_subject_hash])
      as requested(bucket_hash)
    left join public.independent_admin_login_buckets as stored
      on stored.bucket_hash = requested.bucket_hash
  loop
    if v_bucket.locked_until is not null
      and v_bucket.locked_until > v_now then
      v_retry := greatest(
        v_retry,
        ceil(extract(epoch from (v_bucket.locked_until - v_now)))::integer
      );
    elsif v_bucket.window_started_at is not null
      and v_bucket.window_started_at > v_now - interval '15 minutes'
      and v_bucket.attempt_count >= v_bucket.maximum_attempts then
      v_retry := greatest(
        v_retry,
        greatest(1, ceil(extract(epoch from (
          v_bucket.window_started_at + interval '15 minutes' - v_now
        )))::integer)
      );
      v_newly_locked_hashes := array_append(
        v_newly_locked_hashes,
        v_bucket.bucket_hash
      );
    end if;
  end loop;
  if v_retry > 0 then
    if cardinality(v_newly_locked_hashes) > 0 then
      update public.independent_admin_login_buckets as bucket_row
      set locked_until = bucket_row.window_started_at + interval '15 minutes',
          updated_at = v_now
      where bucket_row.bucket_hash = any(v_newly_locked_hashes)
        and bucket_row.locked_until is null;
      insert into public.independent_admin_auth_audit (
        principal_ref, event, occurred_at
      ) values (
        attempt->>'principal_ref', 'rate_limited', v_now
      );
    end if;
    return jsonb_build_object(
      'allowed', false,
      'retry_after_seconds', least(v_retry, 900)
    );
  end if;

  insert into public.independent_admin_login_buckets (
    bucket_hash, window_started_at, attempt_count, updated_at
  ) values
    (v_global_hash, v_now, 1, v_now),
    (v_subject_hash, v_now, 1, v_now)
  on conflict (bucket_hash) do update
  set window_started_at = case
        when independent_admin_login_buckets.window_started_at
          <= v_now - interval '15 minutes' then v_now
        else independent_admin_login_buckets.window_started_at
      end,
      attempt_count = case
        when independent_admin_login_buckets.window_started_at
          <= v_now - interval '15 minutes' then 1
        else independent_admin_login_buckets.attempt_count + 1
      end,
      locked_until = null,
      updated_at = v_now;
  return jsonb_build_object('allowed', true, 'retry_after_seconds', 0);
end;
$$;

create function public.aistory_independent_admin_commit_login(
  login jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_binding jsonb;
  v_family_hash text;
  v_session_hash text;
  v_bucket_hashes jsonb;
  v_occurred_at timestamptz;
  v_expires_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_replaced integer;
begin
  perform public.aistory_independent_admin_assert_service_role();
  if not public.aistory_independent_admin_exact_object(
    login,
    array[
      'principal_ref', 'credential_binding_sha256',
      'credential_epoch_sha256', 'password_verifier_reference_sha256',
      'password_algorithm', 'password_parameters', 'family_hash',
      'session_hash', 'bucket_hashes', 'occurred_at', 'expires_at'
    ]
  ) then
    raise exception 'independent administrator login invalid';
  end if;
  v_binding := login - 'family_hash' - 'session_hash' - 'bucket_hashes'
    - 'occurred_at' - 'expires_at';
  perform public.aistory_independent_admin_assert_binding(v_binding);
  v_family_hash := login->>'family_hash';
  v_session_hash := login->>'session_hash';
  v_bucket_hashes := login->'bucket_hashes';
  begin
    v_occurred_at := (login->>'occurred_at')::timestamptz;
    v_expires_at := (login->>'expires_at')::timestamptz;
  exception when others then
    raise exception 'independent administrator login invalid';
  end;
  if v_family_hash !~ '^[a-f0-9]{64}$'
    or v_session_hash !~ '^[a-f0-9]{64}$'
    or jsonb_typeof(v_bucket_hashes) <> 'array'
    or jsonb_array_length(v_bucket_hashes) <> 2
    or (
      select count(distinct item.value) <> 2
        or bool_or(item.value !~ '^[a-f0-9]{64}$')
      from jsonb_array_elements_text(v_bucket_hashes) as item(value)
    )
    or abs(extract(epoch from (v_now - v_occurred_at))) > 60
    or v_expires_at <= v_now
    or v_expires_at > v_now + interval '16 minutes' then
    raise exception 'independent administrator login invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(login->>'principal_ref', 0)
  );
  if not exists (
    select 1
    from public.independent_admin_principals as principal_row
    where principal_row.singleton_slot = 1
      and principal_row.principal_ref = login->>'principal_ref'
      and principal_row.credential_binding_sha256
        = login->>'credential_binding_sha256'
      and principal_row.credential_epoch_sha256
        = login->>'credential_epoch_sha256'
      and principal_row.status = 'active'
  ) then
    raise exception 'independent administrator login unavailable';
  end if;

  update public.independent_admin_session_families as family_row
  set revoked_at = v_now, revocation_code = 'replaced'
  where family_row.principal_ref = login->>'principal_ref'
    and family_row.revoked_at is null;
  get diagnostics v_replaced = row_count;
  update public.independent_admin_sessions as session_row
  set state = 'revoked', terminal_at = v_now
  from public.independent_admin_session_families as family_row
  where session_row.family_hash = family_row.family_hash
    and family_row.principal_ref = login->>'principal_ref'
    and family_row.revocation_code = 'replaced'
    and family_row.revoked_at = v_now
    and session_row.state = 'active';

  insert into public.independent_admin_session_families (
    family_hash, principal_ref, credential_binding_sha256,
    created_at, absolute_expires_at
  ) values (
    v_family_hash, login->>'principal_ref',
    login->>'credential_binding_sha256', v_now, v_expires_at
  );
  insert into public.independent_admin_sessions (
    session_hash, family_hash, issued_at, expires_at
  ) values (
    v_session_hash, v_family_hash, v_now, v_expires_at
  );
  delete from public.independent_admin_login_buckets as bucket_row
  where bucket_row.bucket_hash in (
    select item.value
    from jsonb_array_elements_text(v_bucket_hashes) as item(value)
  );
  if v_replaced > 0 then
    insert into public.independent_admin_auth_audit (
      principal_ref, event, family_hash, occurred_at
    ) values (
      login->>'principal_ref', 'session_rotated', v_family_hash, v_now
    );
  end if;
  insert into public.independent_admin_auth_audit (
    principal_ref, event, family_hash, occurred_at
  ) values (
    login->>'principal_ref', 'login_succeeded', v_family_hash, v_now
  );
  return true;
end;
$$;

create function public.aistory_independent_admin_verify_session(
  session jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_binding jsonb;
  v_session_hash text;
  v_occurred_at timestamptz;
  v_now timestamptz := clock_timestamp();
  v_session public.independent_admin_sessions%rowtype;
  v_family public.independent_admin_session_families%rowtype;
begin
  perform public.aistory_independent_admin_assert_service_role();
  if not public.aistory_independent_admin_exact_object(
    session,
    array[
      'principal_ref', 'credential_binding_sha256',
      'credential_epoch_sha256', 'password_verifier_reference_sha256',
      'password_algorithm', 'password_parameters', 'session_hash',
      'occurred_at'
    ]
  ) then
    raise exception 'independent administrator session invalid';
  end if;
  v_binding := session - 'session_hash' - 'occurred_at';
  perform public.aistory_independent_admin_assert_binding(v_binding);
  v_session_hash := session->>'session_hash';
  begin
    v_occurred_at := (session->>'occurred_at')::timestamptz;
  exception when others then
    raise exception 'independent administrator session invalid';
  end;
  if v_session_hash !~ '^[a-f0-9]{64}$'
    or abs(extract(epoch from (v_now - v_occurred_at))) > 60 then
    raise exception 'independent administrator session invalid';
  end if;
  if not exists (
    select 1
    from public.independent_admin_principals as principal_row
    where principal_row.singleton_slot = 1
      and principal_row.principal_ref = session->>'principal_ref'
      and principal_row.credential_binding_sha256
        = session->>'credential_binding_sha256'
      and principal_row.credential_epoch_sha256
        = session->>'credential_epoch_sha256'
      and principal_row.status = 'active'
  ) then
    return null;
  end if;
  select session_row.* into v_session
  from public.independent_admin_sessions as session_row
  where session_row.session_hash = v_session_hash;
  if not found then return null; end if;
  select family_row.* into strict v_family
  from public.independent_admin_session_families as family_row
  where family_row.family_hash = v_session.family_hash
  for update;
  select session_row.* into v_session
  from public.independent_admin_sessions as session_row
  where session_row.session_hash = v_session_hash
    and session_row.family_hash = v_family.family_hash
  for update;
  if not found then return null; end if;
  if v_family.principal_ref <> session->>'principal_ref'
    or v_family.credential_binding_sha256
      <> session->>'credential_binding_sha256'
    or v_family.revoked_at is not null
    or v_family.absolute_expires_at <= v_now then
    return null;
  end if;
  if v_session.state = 'rotated' then
    update public.independent_admin_session_families as family_row
    set revoked_at = v_now, revocation_code = 'replay_detected'
    where family_row.family_hash = v_family.family_hash
      and family_row.revoked_at is null;
    update public.independent_admin_sessions as session_row
    set state = 'revoked', replacement_session_hash = null,
        terminal_at = v_now
    where session_row.family_hash = v_family.family_hash
      and session_row.state = 'active';
    insert into public.independent_admin_auth_audit (
      principal_ref, event, family_hash, occurred_at
    ) values (
      v_family.principal_ref, 'session_replay_rejected',
      v_family.family_hash, v_now
    );
    return null;
  end if;
  if v_session.state <> 'active' or v_session.expires_at <= v_now then
    return null;
  end if;
  return jsonb_build_object('active', true, 'role', 'super_admin');
end;
$$;

create function public.aistory_independent_admin_rotate_session(
  rotation jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_binding jsonb;
  v_current public.independent_admin_sessions%rowtype;
  v_family public.independent_admin_session_families%rowtype;
  v_now timestamptz := clock_timestamp();
  v_occurred_at timestamptz;
  v_next_hash text;
  v_next_expires_at timestamptz;
begin
  perform public.aistory_independent_admin_assert_service_role();
  if not public.aistory_independent_admin_exact_object(
    rotation,
    array[
      'principal_ref', 'credential_binding_sha256',
      'credential_epoch_sha256', 'password_verifier_reference_sha256',
      'password_algorithm', 'password_parameters', 'current_session_hash',
      'next_session_hash', 'occurred_at', 'next_expires_at'
    ]
  ) then
    raise exception 'independent administrator rotation invalid';
  end if;
  v_binding := rotation - 'current_session_hash' - 'next_session_hash'
    - 'occurred_at' - 'next_expires_at';
  perform public.aistory_independent_admin_assert_binding(v_binding);
  v_next_hash := rotation->>'next_session_hash';
  begin
    v_occurred_at := (rotation->>'occurred_at')::timestamptz;
    v_next_expires_at := (rotation->>'next_expires_at')::timestamptz;
  exception when others then
    raise exception 'independent administrator rotation invalid';
  end;
  if rotation->>'current_session_hash' !~ '^[a-f0-9]{64}$'
    or v_next_hash !~ '^[a-f0-9]{64}$'
    or v_next_hash = rotation->>'current_session_hash'
    or abs(extract(epoch from (v_now - v_occurred_at))) > 60
    or v_next_expires_at <= v_now
    or v_next_expires_at > v_now + interval '16 minutes' then
    raise exception 'independent administrator rotation invalid';
  end if;
  select session_row.* into v_current
  from public.independent_admin_sessions as session_row
  where session_row.session_hash = rotation->>'current_session_hash';
  if not found then
    raise exception 'independent administrator session unavailable';
  end if;
  select family_row.* into strict v_family
  from public.independent_admin_session_families as family_row
  where family_row.family_hash = v_current.family_hash
  for update;
  select session_row.* into v_current
  from public.independent_admin_sessions as session_row
  where session_row.session_hash = rotation->>'current_session_hash'
    and session_row.family_hash = v_family.family_hash
  for update;
  if not found then
    raise exception 'independent administrator session unavailable';
  end if;
  if v_family.principal_ref <> rotation->>'principal_ref'
    or v_family.credential_binding_sha256
      <> rotation->>'credential_binding_sha256'
    or v_family.revoked_at is not null
    or v_next_expires_at > v_family.absolute_expires_at
    or not exists (
      select 1
      from public.independent_admin_principals as principal_row
      where principal_row.principal_ref = v_family.principal_ref
        and principal_row.credential_binding_sha256
          = v_family.credential_binding_sha256
        and principal_row.status = 'active'
    ) then
    raise exception 'independent administrator session unavailable';
  end if;
  if v_current.state = 'rotated' then
    if v_current.replacement_session_hash = v_next_hash
      and v_current.expires_at = v_next_expires_at
      and exists (
        select 1
        from public.independent_admin_sessions as replacement_row
        where replacement_row.session_hash = v_next_hash
          and replacement_row.family_hash = v_current.family_hash
          and replacement_row.state = 'active'
          and replacement_row.expires_at = v_next_expires_at
      ) then
      return true;
    end if;
    raise exception 'independent administrator session unavailable';
  end if;
  if v_current.state <> 'active' or v_current.expires_at <= v_now
    or v_current.expires_at <> v_next_expires_at then
    raise exception 'independent administrator session unavailable';
  end if;
  update public.independent_admin_sessions as session_row
  set state = 'rotated', replacement_session_hash = v_next_hash,
      terminal_at = v_now
  where session_row.session_hash = v_current.session_hash;
  insert into public.independent_admin_sessions (
    session_hash, family_hash, rotation_ordinal, issued_at, expires_at
  ) values (
    v_next_hash, v_family.family_hash, v_current.rotation_ordinal + 1,
    v_now, v_next_expires_at
  );
  insert into public.independent_admin_auth_audit (
    principal_ref, event, family_hash, occurred_at
  ) values (
    v_family.principal_ref, 'session_rotated', v_family.family_hash, v_now
  );
  return true;
end;
$$;

create function public.aistory_independent_admin_revoke_session(
  session jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_binding jsonb;
  v_current public.independent_admin_sessions%rowtype;
  v_family public.independent_admin_session_families%rowtype;
  v_now timestamptz := clock_timestamp();
  v_occurred_at timestamptz;
begin
  perform public.aistory_independent_admin_assert_service_role();
  if not public.aistory_independent_admin_exact_object(
    session,
    array[
      'principal_ref', 'credential_binding_sha256',
      'credential_epoch_sha256', 'password_verifier_reference_sha256',
      'password_algorithm', 'password_parameters', 'session_hash',
      'occurred_at'
    ]
  ) then
    raise exception 'independent administrator session invalid';
  end if;
  v_binding := session - 'session_hash' - 'occurred_at';
  perform public.aistory_independent_admin_assert_binding(v_binding);
  begin
    v_occurred_at := (session->>'occurred_at')::timestamptz;
  exception when others then
    raise exception 'independent administrator session invalid';
  end;
  if session->>'session_hash' !~ '^[a-f0-9]{64}$'
    or abs(extract(epoch from (v_now - v_occurred_at))) > 60 then
    raise exception 'independent administrator session invalid';
  end if;
  select session_row.* into v_current
  from public.independent_admin_sessions as session_row
  where session_row.session_hash = session->>'session_hash';
  if not found then return false; end if;
  select family_row.* into strict v_family
  from public.independent_admin_session_families as family_row
  where family_row.family_hash = v_current.family_hash
  for update;
  select session_row.* into v_current
  from public.independent_admin_sessions as session_row
  where session_row.session_hash = session->>'session_hash'
    and session_row.family_hash = v_family.family_hash
  for update;
  if not found then return false; end if;
  if v_family.principal_ref <> session->>'principal_ref'
    or v_family.credential_binding_sha256
      <> session->>'credential_binding_sha256' then
    return false;
  end if;
  if v_family.revoked_at is not null then return false; end if;
  update public.independent_admin_session_families as family_row
  set revoked_at = v_now, revocation_code = 'logout'
  where family_row.family_hash = v_family.family_hash;
  update public.independent_admin_sessions as session_row
  set state = 'revoked', replacement_session_hash = null, terminal_at = v_now
  where session_row.family_hash = v_family.family_hash
    and session_row.state in ('active', 'rotated');
  insert into public.independent_admin_auth_audit (
    principal_ref, event, family_hash, occurred_at
  ) values (
    v_family.principal_ref, 'logout', v_family.family_hash, v_now
  );
  return true;
end;
$$;

create function public.aistory_independent_admin_append_security_event(
  security_event jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_binding jsonb;
  v_event text;
  v_occurred_at timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  perform public.aistory_independent_admin_assert_service_role();
  if not public.aistory_independent_admin_exact_object(
    security_event,
    array[
      'principal_ref', 'credential_binding_sha256',
      'credential_epoch_sha256', 'password_verifier_reference_sha256',
      'password_algorithm', 'password_parameters', 'event', 'occurred_at'
    ]
  ) then
    raise exception 'independent administrator event invalid';
  end if;
  v_binding := security_event - 'event' - 'occurred_at';
  perform public.aistory_independent_admin_assert_binding(v_binding);
  v_event := security_event->>'event';
  begin
    v_occurred_at := (security_event->>'occurred_at')::timestamptz;
  exception when others then
    raise exception 'independent administrator event invalid';
  end;
  if v_event not in ('origin_rejected', 'invalid_credentials')
    or abs(extract(epoch from (v_now - v_occurred_at))) > 60
    or not exists (
      select 1
      from public.independent_admin_principals as principal_row
      where principal_row.principal_ref = security_event->>'principal_ref'
        and principal_row.credential_binding_sha256
          = security_event->>'credential_binding_sha256'
    ) then
    raise exception 'independent administrator event unavailable';
  end if;
  insert into public.independent_admin_auth_audit (
    principal_ref, event
  ) values (
    security_event->>'principal_ref', v_event
  );
  return true;
end;
$$;

create function public.aistory_independent_admin_project_snapshot(
  target_tenant text
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'users', (
      select coalesce(jsonb_agg(to_jsonb(item) order by item.created_at desc), '[]'::jsonb)
      from (
        select
          'usr_' || substr(encode(digest(
            'aistory:independent-admin:user-ref:v1:' || profile_row.user_id::text,
            'sha256'
          ), 'hex'), 1, 32) as user_id,
          profile_row.tenant_id,
          null::text as channel_id,
          ''::text as display_name,
          profile_row.masked_contact,
          profile_row.status,
          profile_row.user_type,
          profile_row.locale,
          null::text as region,
          array[]::text[] as tags,
          profile_row.created_at,
          profile_row.last_seen_at
        from public.profiles as profile_row
        where profile_row.tenant_id = target_tenant
        order by profile_row.created_at desc
        limit 1000
      ) item
    ),
    'roles', '[]'::jsonb,
    'accounts', '[]'::jsonb,
    'ledger', '[]'::jsonb,
    'events', '[]'::jsonb,
    'settings', '[]'::jsonb,
    'payment_configs', '[]'::jsonb,
    'provider_configs', '[]'::jsonb,
    'domains', '[]'::jsonb,
    'channel_apps', '[]'::jsonb,
    'audit', '[]'::jsonb,
    'billing_policies', '[]'::jsonb
  );
$$;

create function public.aistory_independent_admin_read_snapshot(
  request_payload jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_binding jsonb;
  v_session public.independent_admin_sessions%rowtype;
  v_family public.independent_admin_session_families%rowtype;
begin
  perform public.aistory_independent_admin_assert_service_role();
  if not public.aistory_independent_admin_exact_object(
    request_payload,
    array[
      'principal_ref', 'credential_binding_sha256',
      'credential_epoch_sha256', 'password_verifier_reference_sha256',
      'password_algorithm', 'password_parameters', 'session_hash',
      'tenant_id'
    ]
  ) then
    raise exception 'independent administrator read invalid';
  end if;
  v_binding := request_payload - 'session_hash' - 'tenant_id';
  perform public.aistory_independent_admin_assert_binding(v_binding);
  if request_payload->>'tenant_id' <> 'platform' then
    raise exception 'independent administrator read invalid';
  end if;
  select session_row.* into v_session
  from public.independent_admin_sessions as session_row
  where session_row.session_hash = request_payload->>'session_hash'
    and session_row.state = 'active'
    and session_row.expires_at > clock_timestamp();
  if not found then raise exception 'independent administrator read forbidden'; end if;
  select family_row.* into strict v_family
  from public.independent_admin_session_families as family_row
  where family_row.family_hash = v_session.family_hash;
  if v_family.principal_ref <> request_payload->>'principal_ref'
    or v_family.credential_binding_sha256
      <> request_payload->>'credential_binding_sha256'
    or v_family.revoked_at is not null
    or v_family.absolute_expires_at <= clock_timestamp()
    or not exists (
      select 1
      from public.independent_admin_principals as principal_row
      where principal_row.principal_ref = v_family.principal_ref
        and principal_row.credential_binding_sha256
          = v_family.credential_binding_sha256
        and principal_row.credential_epoch_sha256
          = request_payload->>'credential_epoch_sha256'
        and principal_row.status = 'active'
        and principal_row.role = 'super_admin'
    ) then
    raise exception 'independent administrator read forbidden';
  end if;
  return public.aistory_independent_admin_project_snapshot('platform');
end;
$$;

create function public.aistory_independent_admin_gate_status()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select gate_row.version
  from public.aistory_schema_gates as gate_row
  where gate_row.gate_name = 'independent_admin_principal';
$$;

revoke all on function public.aistory_independent_admin_exact_object(jsonb, text[])
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_assert_service_role()
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_assert_binding(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_reject_audit_mutation()
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_project_snapshot(text)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_initialize(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_rotate_credential(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_reserve_login(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_commit_login(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_verify_session(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_rotate_session(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_revoke_session(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_append_security_event(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_read_snapshot(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_gate_status()
from public, anon, authenticated, service_role;

grant execute on function public.aistory_independent_admin_initialize(jsonb)
to service_role;
grant execute on function public.aistory_independent_admin_rotate_credential(jsonb)
to service_role;
grant execute on function public.aistory_independent_admin_reserve_login(jsonb)
to service_role;
grant execute on function public.aistory_independent_admin_commit_login(jsonb)
to service_role;
grant execute on function public.aistory_independent_admin_verify_session(jsonb)
to service_role;
grant execute on function public.aistory_independent_admin_rotate_session(jsonb)
to service_role;
grant execute on function public.aistory_independent_admin_revoke_session(jsonb)
to service_role;
grant execute on function public.aistory_independent_admin_append_security_event(jsonb)
to service_role;
grant execute on function public.aistory_independent_admin_read_snapshot(jsonb)
to service_role;
grant execute on function public.aistory_independent_admin_gate_status()
to service_role;

create function public.aistory_independent_admin_security_posture()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.aistory_database_security_posture()
    and public.aistory_admin_rpc_security_posture()
    and (
      select count(*) = 5
        and bool_and(class_row.relrowsecurity and class_row.relforcerowsecurity)
      from pg_catalog.pg_class as class_row
      where class_row.oid = any(array[
        'public.independent_admin_principals'::regclass,
        'public.independent_admin_login_buckets'::regclass,
        'public.independent_admin_session_families'::regclass,
        'public.independent_admin_sessions'::regclass,
        'public.independent_admin_auth_audit'::regclass
      ])
    )
    and (
      select bool_and(
        not has_table_privilege(
          'anon', table_name,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
        and not has_table_privilege(
          'authenticated', table_name,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
        and not has_table_privilege(
          'service_role', table_name,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
      )
      from unnest(array[
        'public.independent_admin_principals',
        'public.independent_admin_login_buckets',
        'public.independent_admin_session_families',
        'public.independent_admin_sessions',
        'public.independent_admin_auth_audit'
      ]) as guarded(table_name)
    )
    and (
      select not has_sequence_privilege(
          'anon',
          'public.independent_admin_auth_audit_sequence_seq',
          'USAGE,SELECT,UPDATE'
        )
        and not has_sequence_privilege(
          'authenticated',
          'public.independent_admin_auth_audit_sequence_seq',
          'USAGE,SELECT,UPDATE'
        )
        and not has_sequence_privilege(
          'service_role',
          'public.independent_admin_auth_audit_sequence_seq',
          'USAGE,SELECT,UPDATE'
        )
    )
    and (
      select count(*) = 15
        and bool_and(
          procedure_row.prosecdef
          and coalesce(procedure_row.proconfig, '{}'::text[])
            @> array['search_path=pg_catalog, public']
          and procedure_row.provolatile = case
            when procedure_row.oid =
              'public.aistory_independent_admin_exact_object(jsonb,text[])'::regprocedure::oid
              then 'i'::"char"
            when procedure_row.oid = any(array[
              'public.aistory_independent_admin_read_snapshot(jsonb)'::regprocedure::oid,
              'public.aistory_independent_admin_gate_status()'::regprocedure::oid,
              'public.aistory_independent_admin_project_snapshot(text)'::regprocedure::oid
            ]) then 's'::"char"
            else 'v'::"char"
          end
        )
      from pg_catalog.pg_proc as procedure_row
      where procedure_row.oid = any(array[
        'public.aistory_independent_admin_exact_object(jsonb,text[])'::regprocedure::oid,
        'public.aistory_independent_admin_assert_service_role()'::regprocedure::oid,
        'public.aistory_independent_admin_assert_binding(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_reject_audit_mutation()'::regprocedure::oid,
        'public.aistory_independent_admin_initialize(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_rotate_credential(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_reserve_login(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_commit_login(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_verify_session(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_rotate_session(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_revoke_session(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_append_security_event(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_read_snapshot(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_gate_status()'::regprocedure::oid,
        'public.aistory_independent_admin_project_snapshot(text)'::regprocedure::oid
      ])
    )
    and not exists (
      select 1
      from pg_catalog.pg_proc as procedure_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      cross join lateral unnest(
        coalesce(procedure_row.proargnames, '{}'::text[])
      ) as argument_row(argument_name)
      join pg_catalog.pg_get_keywords() as keyword_row
        on keyword_row.word = lower(argument_row.argument_name)
       and keyword_row.catcode in ('R', 'T')
      where namespace_row.nspname = 'public'
        and procedure_row.proname like 'aistory\_independent\_admin\_%'
          escape '\'
    )
    and (
      select procedure_row.proargnames = array['request_payload']::text[]
      from pg_catalog.pg_proc as procedure_row
      where procedure_row.oid =
        'public.aistory_independent_admin_read_snapshot(jsonb)'::regprocedure::oid
    )
    and (
      select bool_and(
        not has_function_privilege('anon', guarded.rpc_oid, 'EXECUTE')
        and not has_function_privilege('authenticated', guarded.rpc_oid, 'EXECUTE')
        and has_function_privilege('service_role', guarded.rpc_oid, 'EXECUTE')
      )
      from unnest(array[
        'public.aistory_independent_admin_initialize(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_rotate_credential(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_reserve_login(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_commit_login(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_verify_session(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_rotate_session(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_revoke_session(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_append_security_event(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_read_snapshot(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_gate_status()'::regprocedure::oid
      ]) as guarded(rpc_oid)
    )
    and (
      select bool_and(
        not has_function_privilege('anon', guarded.helper_oid, 'EXECUTE')
        and not has_function_privilege(
          'authenticated', guarded.helper_oid, 'EXECUTE'
        )
        and not has_function_privilege(
          'service_role', guarded.helper_oid, 'EXECUTE'
        )
      )
      from unnest(array[
        'public.aistory_independent_admin_exact_object(jsonb,text[])'::regprocedure::oid,
        'public.aistory_independent_admin_assert_service_role()'::regprocedure::oid,
        'public.aistory_independent_admin_assert_binding(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_reject_audit_mutation()'::regprocedure::oid,
        'public.aistory_independent_admin_project_snapshot(text)'::regprocedure::oid
      ]) as guarded(helper_oid)
    )
    and exists (
      select 1
      from pg_catalog.pg_proc as procedure_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      where namespace_row.nspname = 'public'
        and procedure_row.proname =
          'aistory_independent_admin_security_posture'
        and procedure_row.pronargs = 0
        and procedure_row.prosecdef
        and procedure_row.provolatile = 's'::"char"
        and coalesce(procedure_row.proconfig, '{}'::text[])
          @> array['search_path=pg_catalog, public']
        and not has_function_privilege(
          'anon', procedure_row.oid, 'EXECUTE'
        )
        and not has_function_privilege(
          'authenticated', procedure_row.oid, 'EXECUTE'
        )
        and has_function_privilege(
          'service_role', procedure_row.oid, 'EXECUTE'
        )
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger_row
      where trigger_row.tgrelid =
          'public.independent_admin_auth_audit'::regclass
        and trigger_row.tgname = 'independent_admin_auth_audit_append_only'
        and trigger_row.tgenabled = 'O'
        and not trigger_row.tgisinternal
        and trigger_row.tgfoid =
          'public.aistory_independent_admin_reject_audit_mutation()'::regprocedure::oid
        and trigger_row.tgtype = 27
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger_row
      where trigger_row.tgrelid =
          'public.independent_admin_auth_audit'::regclass
        and trigger_row.tgname = 'independent_admin_auth_audit_no_truncate'
        and trigger_row.tgenabled = 'O'
        and not trigger_row.tgisinternal
        and trigger_row.tgfoid =
          'public.aistory_independent_admin_reject_audit_mutation()'::regprocedure::oid
        and trigger_row.tgtype = 34
    );
$$;

revoke all on function public.aistory_independent_admin_security_posture()
from public, anon, authenticated, service_role;
grant execute on function public.aistory_independent_admin_security_posture()
to service_role;

insert into public.aistory_schema_gates (gate_name, version)
values ('independent_admin_principal', '20260828233000');

do $$
begin
  if not public.aistory_independent_admin_security_posture() then
    raise exception 'independent administrator security posture unavailable';
  end if;
end;
$$;
