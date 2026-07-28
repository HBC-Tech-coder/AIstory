-- AIstory production identity + billing database gate.
--
-- This is a forward-only migration. It is safe after the existing admin and
-- phone-billing migrations and on a fresh install where all migrations run in
-- filename order. It does not enable production SMS or platform billing.

create extension if not exists pgcrypto;

-- Player/application identities are not required to be Supabase Auth users.
-- Administrator roles and audit actors remain bound to auth.users.
create table if not exists public.app_users (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  identity_type text not null check (
    identity_type in ('phone', 'supabase')
  ),
  auth_user_id uuid unique references auth.users (id) on delete set null,
  status text not null default 'active' check (
    status in ('active', 'frozen', 'deleted')
  ),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

-- Backfill every player UUID that was previously constrained to auth.users
-- before replacing those foreign keys.
insert into public.app_users (id, tenant_id, identity_type, auth_user_id, created_at)
select user_id, tenant_id, 'supabase', user_id, min(created_at)
from (
  select user_id, tenant_id, created_at from public.profiles
  union all
  select user_id, tenant_id, created_at from public.credit_accounts
  union all
  select user_id, tenant_id, created_at from public.credit_ledger
  union all
  select user_id, tenant_id, started_at as created_at
  from public.play_sessions where user_id is not null
  union all
  select user_id, tenant_id, created_at
  from public.gameplay_events where user_id is not null
  union all
  select user_id, tenant_id, created_at
  from public.payment_orders where user_id is not null
) existing_players
group by user_id, tenant_id
on conflict (id) do nothing;

alter table public.profiles
  drop constraint if exists profiles_user_id_fkey,
  drop constraint if exists profiles_user_id_app_user_fkey;
alter table public.profiles
  add constraint profiles_user_id_app_user_fkey
  foreign key (user_id) references public.app_users (id) on delete cascade
  not valid;
alter table public.profiles validate constraint profiles_user_id_app_user_fkey;

alter table public.credit_accounts
  drop constraint if exists credit_accounts_user_id_fkey,
  drop constraint if exists credit_accounts_user_id_app_user_fkey;
alter table public.credit_accounts
  add constraint credit_accounts_user_id_app_user_fkey
  foreign key (user_id) references public.app_users (id) on delete cascade
  not valid;
alter table public.credit_accounts
  validate constraint credit_accounts_user_id_app_user_fkey;

alter table public.credit_ledger
  drop constraint if exists credit_ledger_user_id_fkey,
  drop constraint if exists credit_ledger_user_id_app_user_fkey;
alter table public.credit_ledger
  add constraint credit_ledger_user_id_app_user_fkey
  foreign key (user_id) references public.app_users (id) on delete cascade
  not valid;
alter table public.credit_ledger
  validate constraint credit_ledger_user_id_app_user_fkey;

alter table public.play_sessions
  drop constraint if exists play_sessions_user_id_fkey,
  drop constraint if exists play_sessions_user_id_app_user_fkey;
alter table public.play_sessions
  add constraint play_sessions_user_id_app_user_fkey
  foreign key (user_id) references public.app_users (id) on delete set null
  not valid;
alter table public.play_sessions
  validate constraint play_sessions_user_id_app_user_fkey;

alter table public.gameplay_events
  drop constraint if exists gameplay_events_user_id_fkey,
  drop constraint if exists gameplay_events_user_id_app_user_fkey;
alter table public.gameplay_events
  add constraint gameplay_events_user_id_app_user_fkey
  foreign key (user_id) references public.app_users (id) on delete set null
  not valid;
alter table public.gameplay_events
  validate constraint gameplay_events_user_id_app_user_fkey;

alter table public.payment_orders
  drop constraint if exists payment_orders_user_id_fkey,
  drop constraint if exists payment_orders_user_id_app_user_fkey;
alter table public.payment_orders
  add constraint payment_orders_user_id_app_user_fkey
  foreign key (user_id) references public.app_users (id) on delete set null
  not valid;
alter table public.payment_orders
  validate constraint payment_orders_user_id_app_user_fkey;

create table if not exists public.phone_identities (
  phone_hash text primary key check (phone_hash ~ '^[a-f0-9]{64}$'),
  user_id uuid not null unique references public.app_users (id) on delete cascade,
  masked_phone text not null check (
    length(masked_phone) between 6 and 32
    and position('*' in masked_phone) > 0
  ),
  created_at timestamptz not null default now(),
  last_verified_at timestamptz
);

create table if not exists public.phone_otp_challenges (
  id uuid primary key,
  phone_hash text not null check (phone_hash ~ '^[a-f0-9]{64}$'),
  otp_hash text not null check (otp_hash ~ '^[a-f0-9]{64}$'),
  request_ip_hash text not null check (request_ip_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'pending' check (
    status in ('pending', 'sent', 'verified', 'consumed', 'invalidated')
  ),
  attempts integer not null default 0 check (attempts between 0 and 5),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  sent_at timestamptz,
  verified_at timestamptz,
  consumed_at timestamptz,
  invalidated_at timestamptz
);

create index if not exists phone_otp_challenges_phone_created_idx
  on public.phone_otp_challenges (phone_hash, created_at desc);
create index if not exists phone_otp_challenges_ip_created_idx
  on public.phone_otp_challenges (request_ip_hash, created_at desc);

alter table public.admin_audit_logs
  add column if not exists mutation_fingerprint text;
alter table public.admin_audit_logs
  drop constraint if exists admin_audit_mutation_fingerprint_check;
alter table public.admin_audit_logs
  add constraint admin_audit_mutation_fingerprint_check
  check (
    mutation_fingerprint is null
    or mutation_fingerprint ~ '^[a-f0-9]{64}$'
  ) not valid;
alter table public.admin_audit_logs
  validate constraint admin_audit_mutation_fingerprint_check;

-- One registration grant, one registration event and one registration audit
-- per application user, regardless of policy changes or concurrent retries.
create unique index if not exists credit_ledger_one_initial_grant_per_user
  on public.credit_ledger (tenant_id, user_id)
  where kind = 'initial_grant';
create unique index if not exists gameplay_events_one_registration_per_user
  on public.gameplay_events (tenant_id, user_id)
  where event = 'account_registered';
create unique index if not exists admin_audit_one_registration_per_user
  on public.admin_audit_logs (tenant_id, target_id)
  where action = 'account.registered';
create unique index if not exists admin_audit_request_id_unique
  on public.admin_audit_logs (tenant_id, request_id);
create unique index if not exists admin_audit_one_credit_adjustment_per_entry
  on public.admin_audit_logs ((after_summary->>'entryId'))
  where action = 'credit.manual_adjustment';

create unique index if not exists credit_ledger_one_reserve_per_operation
  on public.credit_ledger (tenant_id, billing_operation_id)
  where kind = 'reserve';
create unique index if not exists credit_ledger_one_terminal_per_operation
  on public.credit_ledger (tenant_id, billing_operation_id)
  where kind in ('settle', 'refund');

-- balance_snapshot is retained only for migration compatibility. Formal
-- balances are always derived from the immutable ledger.
alter table public.credit_accounts
  drop constraint if exists credit_accounts_balance_snapshot_zero;
alter table public.credit_accounts
  add constraint credit_accounts_balance_snapshot_zero
  check (balance_snapshot = 0) not valid;
alter table public.credit_accounts
  validate constraint credit_accounts_balance_snapshot_zero;

create or replace function public.aistory_reject_append_only_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception 'append-only record cannot be changed';
end;
$$;

revoke all on function public.aistory_reject_append_only_mutation() from public;

drop trigger if exists credit_ledger_append_only on public.credit_ledger;
create trigger credit_ledger_append_only
before update or delete on public.credit_ledger
for each row execute function public.aistory_reject_append_only_mutation();

drop trigger if exists admin_audit_logs_append_only on public.admin_audit_logs;
create trigger admin_audit_logs_append_only
before update or delete on public.admin_audit_logs
for each row execute function public.aistory_reject_append_only_mutation();

-- Deployment code checks this database-owned version before sending a real SMS
-- or reserving formal credits.
create table if not exists public.aistory_schema_gates (
  gate_name text primary key,
  version text not null,
  installed_at timestamptz not null default now()
);

insert into public.aistory_schema_gates (gate_name, version)
values ('production_identity_billing', '20260729093000')
on conflict (gate_name) do update
set version = excluded.version, installed_at = now();

create or replace function public.aistory_database_gate_status()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select version
  from public.aistory_schema_gates
  where gate_name = 'production_identity_billing';
$$;

create or replace function public.aistory_validate_phone_session(
  app_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.phone_identities identity_record
    join public.app_users app_user
      on app_user.id = identity_record.user_id
    where identity_record.user_id = app_user_id
      and app_user.identity_type = 'phone'
      and app_user.status = 'active'
  );
$$;

-- Multi-instance-safe pending challenge creation. Advisory locks serialize
-- phone and IP rate-limit decisions without retaining plaintext identifiers.
create or replace function public.aistory_create_phone_challenge(challenge jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  challenge_id uuid;
  challenge_phone_hash text;
  challenge_otp_hash text;
  challenge_ip_hash text;
  recent_phone_count integer;
  recent_ip_count integer;
  last_phone_request timestamptz;
begin
  challenge_id := (challenge->>'id')::uuid;
  challenge_phone_hash := challenge->>'phone_hash';
  challenge_otp_hash := challenge->>'otp_hash';
  challenge_ip_hash := challenge->>'request_ip_hash';

  if challenge_phone_hash !~ '^[a-f0-9]{64}$'
    or challenge_otp_hash !~ '^[a-f0-9]{64}$'
    or challenge_ip_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'invalid phone challenge';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(challenge_phone_hash, 1701));
  perform pg_advisory_xact_lock(hashtextextended(challenge_ip_hash, 1702));

  select count(*), max(created_at)
  into recent_phone_count, last_phone_request
  from public.phone_otp_challenges
  where phone_hash = challenge_phone_hash
    and created_at >= now() - interval '1 hour';

  select count(*) into recent_ip_count
  from public.phone_otp_challenges
  where request_ip_hash = challenge_ip_hash
    and created_at >= now() - interval '1 hour';

  if recent_phone_count >= 5
    or recent_ip_count >= 10
    or (
      last_phone_request is not null
      and last_phone_request > now() - interval '60 seconds'
    ) then
    raise exception 'SMS_RATE_LIMITED';
  end if;

  insert into public.phone_otp_challenges (
    id, phone_hash, otp_hash, request_ip_hash, status,
    attempts, created_at, expires_at
  ) values (
    challenge_id, challenge_phone_hash, challenge_otp_hash,
    challenge_ip_hash, 'pending', 0, now(), now() + interval '5 minutes'
  );

  return challenge_id;
end;
$$;

create or replace function public.aistory_mark_phone_challenge_sent(
  challenge_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.phone_otp_challenges
  set status = 'sent', sent_at = now()
  where id = challenge_id
    and status = 'pending'
    and expires_at > now();
  return found;
end;
$$;

create or replace function public.aistory_invalidate_phone_challenge(
  challenge_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  update public.phone_otp_challenges
  set status = 'invalidated', invalidated_at = now()
  where id = challenge_id
    and status in ('pending', 'sent');
  return found;
end;
$$;

-- OTP verification and account registration are one transaction. Invalid OTP
-- attempts return a generic status rather than raising so the attempt counter
-- is not rolled back.
create or replace function public.aistory_verify_phone_and_register(
  verification jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  locked_challenge public.phone_otp_challenges%rowtype;
  supplied_phone_hash text;
  supplied_otp_hash text;
  supplied_masked_phone text;
  supplied_locale text;
  app_user_id uuid;
  account_id uuid;
  policy_version text;
  grant_credits bigint;
  created_user boolean := false;
  grant_applied boolean := false;
  current_balance bigint;
  existing_user_status text;
begin
  supplied_phone_hash := verification->>'phone_hash';
  supplied_otp_hash := verification->>'otp_hash';
  supplied_masked_phone := verification->>'masked_phone';
  supplied_locale := coalesce(nullif(verification->>'locale', ''), 'zh-CN');

  if supplied_phone_hash !~ '^[a-f0-9]{64}$'
    or supplied_otp_hash !~ '^[a-f0-9]{64}$'
    or length(supplied_masked_phone) not between 6 and 32
    or position('*' in supplied_masked_phone) = 0
    or supplied_locale !~ '^[A-Za-z0-9-]{2,16}$' then
    return jsonb_build_object('status', 'invalid');
  end if;

  perform pg_advisory_xact_lock(hashtextextended(supplied_phone_hash, 1703));

  select * into locked_challenge
  from public.phone_otp_challenges
  where id = (verification->>'challenge_id')::uuid
    and phone_hash = supplied_phone_hash
  for update;

  if not found
    or locked_challenge.status <> 'sent'
    or locked_challenge.attempts >= 5 then
    return jsonb_build_object('status', 'invalid');
  end if;

  if locked_challenge.expires_at <= now() then
    update public.phone_otp_challenges
    set status = 'invalidated', invalidated_at = now()
    where id = locked_challenge.id;
    return jsonb_build_object('status', 'invalid');
  end if;

  update public.phone_otp_challenges
  set attempts = attempts + 1
  where id = locked_challenge.id;

  if locked_challenge.otp_hash <> supplied_otp_hash then
    if locked_challenge.attempts + 1 >= 5 then
      update public.phone_otp_challenges
      set status = 'invalidated', invalidated_at = now()
      where id = locked_challenge.id;
    end if;
    return jsonb_build_object('status', 'invalid');
  end if;

  update public.phone_otp_challenges
  set status = 'verified', verified_at = now()
  where id = locked_challenge.id;

  select user_id into app_user_id
  from public.phone_identities
  where phone_hash = supplied_phone_hash
  for update;

  if app_user_id is null then
    app_user_id := gen_random_uuid();
    created_user := true;
    insert into public.app_users (
      id, tenant_id, identity_type, status
    ) values (
      app_user_id, 'platform', 'phone', 'active'
    );
    insert into public.phone_identities (
      phone_hash, user_id, masked_phone, last_verified_at
    ) values (
      supplied_phone_hash, app_user_id, supplied_masked_phone, now()
    );
  else
    select status into existing_user_status
    from public.app_users
    where id = app_user_id
    for update;
    if existing_user_status is distinct from 'active' then
      update public.phone_otp_challenges
      set status = 'consumed', consumed_at = now()
      where id = locked_challenge.id
        and status = 'verified';
      return jsonb_build_object('status', 'invalid');
    end if;
    update public.phone_identities
    set masked_phone = supplied_masked_phone, last_verified_at = now()
    where phone_hash = supplied_phone_hash;
  end if;

  insert into public.profiles (
    user_id, tenant_id, display_name, masked_contact, status,
    user_type, locale, tags
  ) values (
    app_user_id, 'platform', 'AIstory 用户', supplied_masked_phone,
    'active', 'player', supplied_locale, '{}'
  )
  on conflict (user_id) do update
  set masked_contact = excluded.masked_contact,
      last_seen_at = now();

  insert into public.credit_accounts (
    tenant_id, user_id, currency, balance_snapshot
  ) values (
    'platform', app_user_id, 'credit', 0
  )
  on conflict (tenant_id, user_id, currency) do nothing;

  select id into account_id
  from public.credit_accounts
  where tenant_id = 'platform'
    and user_id = app_user_id
    and currency = 'credit'
  for update;

  select version, initial_grant_credits
  into policy_version, grant_credits
  from public.billing_policies
  where tenant_id = 'platform'
  order by updated_at desc, version desc
  limit 1;

  policy_version := coalesce(policy_version, 'registration-default-v1');
  grant_credits := coalesce(grant_credits, 1000);

  if not exists (
    select 1 from public.credit_ledger
    where tenant_id = 'platform'
      and user_id = app_user_id
      and kind = 'initial_grant'
  ) then
    insert into public.credit_ledger (
      account_id, tenant_id, user_id, kind, amount, reason,
      idempotency_key, price_policy_version
    ) values (
      account_id, 'platform', app_user_id, 'initial_grant',
      grant_credits, 'Registration initial grant',
      'initial_grant:' || app_user_id::text || ':v1', policy_version
    );
    grant_applied := true;
  end if;

  insert into public.gameplay_events (
    tenant_id, user_id, session_id, event, created_at
  ) values (
    'platform', app_user_id, 'registration:' || app_user_id::text,
    'account_registered', now()
  )
  on conflict do nothing;

  insert into public.admin_audit_logs (
    tenant_id, actor_id, actor_roles, action, target_type, target_id,
    after_summary, request_id
  ) values (
    'platform', null, '{}', 'account.registered', 'app_user',
    app_user_id::text,
    jsonb_build_object(
      'userId', app_user_id,
      'initialGrantApplied', grant_applied,
      'pricePolicyVersion', policy_version
    ),
    'registration:' || app_user_id::text
  )
  on conflict do nothing;

  update public.phone_otp_challenges
  set status = 'consumed', consumed_at = now()
  where id = locked_challenge.id
    and status = 'verified';

  select coalesce(sum(amount), 0) into current_balance
  from public.credit_ledger
  where tenant_id = 'platform' and user_id = app_user_id;

  return jsonb_build_object(
    'status', 'verified',
    'user_id', app_user_id,
    'masked_phone', supplied_masked_phone,
    'created', created_user,
    'initial_grant_applied', grant_applied,
    'balance', current_balance
  );
end;
$$;

-- Administrator grants require a real Supabase Auth actor with a finance role.
-- The ledger entry and matching audit record commit or roll back together.
create or replace function public.aistory_admin_adjust_credits(adjustment jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid;
  target_user_id uuid;
  target_tenant text;
  adjustment_amount bigint;
  adjustment_reason text;
  adjustment_key text;
  adjustment_request_id text;
  account_id uuid;
  existing_entry public.credit_ledger%rowtype;
  created_entry public.credit_ledger%rowtype;
  existing_audit public.admin_audit_logs%rowtype;
  balance_before bigint;
  adjustment_fingerprint text;
begin
  actor_user_id := (adjustment->>'actor_id')::uuid;
  target_user_id := (adjustment->>'user_id')::uuid;
  target_tenant := adjustment->>'tenant_id';
  adjustment_amount := (adjustment->>'amount')::bigint;
  adjustment_reason := btrim(adjustment->>'reason');
  adjustment_key := adjustment->>'idempotency_key';
  adjustment_request_id := adjustment->>'request_id';
  adjustment_fingerprint := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'actorId', actor_user_id,
          'tenantId', target_tenant,
          'userId', target_user_id,
          'amount', adjustment_amount,
          'reason', adjustment_reason,
          'idempotencyKey', adjustment_key
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  if target_tenant is null
    or adjustment_amount = 0
    or length(adjustment_reason) not between 3 and 500
    or adjustment_key !~ '^[A-Za-z0-9:_-]{8,160}$'
    or length(adjustment_request_id) not between 8 and 200 then
    raise exception 'invalid credit adjustment';
  end if;

  if not exists (
    select 1 from public.user_roles
    where user_id = actor_user_id
      and tenant_id = target_tenant
      and role in ('super_admin', 'finance')
  ) then
    raise exception 'credit adjustment forbidden';
  end if;

  if not exists (
    select 1 from public.app_users
    where id = target_user_id
      and tenant_id = target_tenant
  ) then
    raise exception 'target user unavailable';
  end if;

  insert into public.credit_accounts (
    tenant_id, user_id, currency, balance_snapshot
  ) values (
    target_tenant, target_user_id, 'credit', 0
  )
  on conflict (tenant_id, user_id, currency) do nothing;

  select id into account_id
  from public.credit_accounts
  where tenant_id = target_tenant
    and user_id = target_user_id
    and currency = 'credit'
  for update;

  select * into existing_entry
  from public.credit_ledger
  where tenant_id = target_tenant
    and idempotency_key = adjustment_key;
  if found then
    if existing_entry.user_id <> target_user_id
      or existing_entry.tenant_id <> target_tenant
      or existing_entry.amount <> adjustment_amount
      or coalesce(existing_entry.reason, '') <> adjustment_reason
      or existing_entry.actor_id is distinct from actor_user_id
      or existing_entry.kind <> 'manual_adjustment' then
      raise exception 'credit adjustment idempotency conflict';
    end if;
    select * into existing_audit
    from public.admin_audit_logs
    where action = 'credit.manual_adjustment'
      and after_summary->>'entryId' = existing_entry.id::text;
    if not found
      or existing_audit.mutation_fingerprint is distinct from
        adjustment_fingerprint then
      raise exception 'credit adjustment audit unavailable';
    end if;
    return jsonb_build_object(
      'entry_id', existing_entry.id,
      'balance_before',
        (existing_audit.before_summary->>'balance')::bigint,
      'balance_after',
        (existing_audit.after_summary->>'balance')::bigint,
      'replayed', true
    );
  end if;

  select coalesce(sum(amount), 0) into balance_before
  from public.credit_ledger
  where tenant_id = target_tenant and user_id = target_user_id;

  insert into public.credit_ledger (
    account_id, tenant_id, user_id, kind, amount, reason,
    idempotency_key, actor_id
  ) values (
    account_id, target_tenant, target_user_id, 'manual_adjustment',
    adjustment_amount, adjustment_reason, adjustment_key, actor_user_id
  )
  returning * into created_entry;

  insert into public.admin_audit_logs (
    tenant_id, actor_id, actor_roles, action, target_type, target_id,
    before_summary, after_summary, reason, request_id,
    mutation_fingerprint
  ) values (
    target_tenant, actor_user_id,
    array(
      select role from public.user_roles
      where user_id = actor_user_id and tenant_id = target_tenant
    ),
    'credit.manual_adjustment', 'credit_account', account_id::text,
    jsonb_build_object(
      'userId', target_user_id,
      'balance', balance_before
    ),
    jsonb_build_object(
      'userId', target_user_id,
      'amount', adjustment_amount,
      'entryId', created_entry.id,
      'balance', balance_before + adjustment_amount
    ),
    adjustment_reason, adjustment_request_id, adjustment_fingerprint
  );

  return jsonb_build_object(
    'entry_id', created_entry.id,
    'balance_before', balance_before,
    'balance_after', balance_before + adjustment_amount,
    'replayed', false
  );
end;
$$;

-- Every production administrator mutation below commits its business change
-- and audit record in one database transaction. The service role cannot call
-- arbitrary table INSERT/UPDATE as a substitute for this allowlisted RPC.
create or replace function public.aistory_admin_apply_mutation(
  mutation jsonb,
  audit jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  mutation_kind text := mutation->>'kind';
  payload jsonb := mutation->'payload';
  actor_user_id uuid := (audit->>'actor_id')::uuid;
  audit_tenant text := audit->>'tenant_id';
  audit_action text := audit->>'action';
  audit_target_type text := audit->>'target_type';
  audit_target_id text := audit->>'target_id';
  audit_request_id text := audit->>'request_id';
  required_roles text[];
  affected_rows integer;
  existing_action text;
  existing_target text;
  existing_fingerprint text;
  canonical_fingerprint text;
begin
  if payload is null
    or audit_tenant is null
    or length(audit_request_id) not between 8 and 200
    or length(audit_action) not between 3 and 120
    or length(audit_target_type) not between 3 and 120
    or coalesce(audit->'before_summary', '{}'::jsonb)::text
      ~* '"[^"]*(secret|token|password|key|contact)[^"]*"\s*:'
    or coalesce(audit->'after_summary', '{}'::jsonb)::text
      ~* '"[^"]*(secret|token|password|key|contact)[^"]*"\s*:' then
    raise exception 'invalid admin mutation';
  end if;

  canonical_fingerprint := encode(
    digest(
      convert_to(
        jsonb_build_object(
          'actorId', actor_user_id,
          'kind', mutation_kind,
          'payload', payload - array[
            'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'publishedAt'
          ]
        )::text,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );

  select action, target_id, mutation_fingerprint
  into existing_action, existing_target, existing_fingerprint
  from public.admin_audit_logs
  where tenant_id = audit_tenant and request_id = audit_request_id;
  if found then
    if existing_action = audit_action
      and existing_target is not distinct from audit_target_id
      and existing_fingerprint = canonical_fingerprint then
      return true;
    end if;
    raise exception 'admin mutation idempotency conflict';
  end if;

  required_roles := case mutation_kind
    when 'user.save' then array['super_admin', 'ops', 'moderator', 'support']
    when 'role.add' then array['super_admin']
    when 'billing_policy.save' then array['super_admin', 'finance']
    when 'settings.save' then array['super_admin', 'ops']
    when 'payment_config.save' then array['super_admin', 'finance']
    when 'provider_config.save' then array['super_admin', 'ops']
    when 'domain.save' then array['super_admin', 'ops']
    when 'channel_app.save' then array['super_admin', 'ops']
    else null
  end;
  if required_roles is null or not exists (
    select 1 from public.user_roles
    where user_id = actor_user_id
      and tenant_id = audit_tenant
      and role = any(required_roles)
  ) then
    raise exception 'admin mutation forbidden';
  end if;

  if mutation_kind = 'user.save' then
    if audit_action <> 'user.status_update'
      or audit_target_id <> payload->>'userId' then
      raise exception 'admin mutation audit mismatch';
    end if;
    update public.profiles
    set status = payload->>'status',
        tags = array(
          select jsonb_array_elements_text(
            coalesce(payload->'tags', '[]'::jsonb)
          )
        )
    where user_id = (payload->>'userId')::uuid
      and tenant_id = payload->>'tenantId';
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then raise exception 'target user unavailable'; end if;
    update public.app_users
    set status = payload->>'status'
    where id = (payload->>'userId')::uuid
      and tenant_id = payload->>'tenantId';
    get diagnostics affected_rows = row_count;
    if affected_rows <> 1 then raise exception 'app user unavailable'; end if;

  elsif mutation_kind = 'role.add' then
    if audit_action <> 'admin.role_add'
      or audit_target_id
        <> concat(
          payload->>'userId', ':', payload->>'tenantId', ':', payload->>'role'
        ) then
      raise exception 'admin mutation audit mismatch';
    end if;
    insert into public.user_roles (
      user_id, tenant_id, role, created_at, created_by
    ) values (
      (payload->>'userId')::uuid,
      payload->>'tenantId',
      payload->>'role',
      (payload->>'createdAt')::timestamptz,
      actor_user_id
    )
    on conflict (user_id, tenant_id, role) do nothing;

  elsif mutation_kind = 'billing_policy.save' then
    if audit_action <> 'billing.policy_save'
      or audit_target_id <> payload->>'version' then
      raise exception 'admin mutation audit mismatch';
    end if;
    insert into public.billing_policies (
      tenant_id, version, markup_basis_points, initial_grant_credits,
      provider_currency, provider_minor_unit_scale,
      credit_units_per_provider_minor, entries, updated_at, updated_by
    ) values (
      audit_tenant,
      payload->>'version',
      (payload->>'markupBasisPoints')::integer,
      (payload->>'initialGrantCredits')::bigint,
      payload->>'providerCurrency',
      (payload->>'providerMinorUnitScale')::integer,
      (payload->>'creditUnitsPerProviderMinor')::integer,
      coalesce(payload->'entries', '[]'::jsonb),
      (payload->>'updatedAt')::timestamptz,
      actor_user_id
    )
    on conflict (tenant_id, version) do update
    set markup_basis_points = excluded.markup_basis_points,
        initial_grant_credits = excluded.initial_grant_credits,
        provider_currency = excluded.provider_currency,
        provider_minor_unit_scale = excluded.provider_minor_unit_scale,
        credit_units_per_provider_minor =
          excluded.credit_units_per_provider_minor,
        entries = excluded.entries,
        updated_at = excluded.updated_at,
        updated_by = excluded.updated_by;

  elsif mutation_kind = 'settings.save' then
    if audit_action not in (
      'platform.branding_preview', 'platform.branding_publish'
    ) or audit_target_id <> payload->>'id' then
      raise exception 'admin mutation audit mismatch';
    end if;
    if payload->>'status' = 'published' then
      update public.platform_settings
      set status = 'draft'
      where tenant_id = payload->>'tenantId'
        and channel_id is not distinct from nullif(payload->>'channelId', '')
        and status = 'published'
        and id <> (payload->>'id')::uuid;
    end if;
    insert into public.platform_settings (
      id, tenant_id, channel_id, status, version, branding,
      created_by, created_at, published_at
    ) values (
      (payload->>'id')::uuid,
      payload->>'tenantId',
      nullif(payload->>'channelId', ''),
      payload->>'status',
      (payload->>'version')::integer,
      payload->'branding',
      actor_user_id,
      (payload->>'createdAt')::timestamptz,
      nullif(payload->>'publishedAt', '')::timestamptz
    )
    on conflict (id) do update
    set status = excluded.status,
        branding = excluded.branding,
        published_at = excluded.published_at;

  elsif mutation_kind = 'payment_config.save' then
    if audit_action <> 'payment.config_update'
      or audit_target_id <> payload->>'id' then
      raise exception 'admin mutation audit mismatch';
    end if;
    insert into public.payment_provider_configs (
      id, tenant_id, channel_id, provider, enabled, sandbox, status,
      secret_reference, webhook_path, updated_at
    ) values (
      (payload->>'id')::uuid,
      payload->>'tenantId',
      nullif(payload->>'channelId', ''),
      payload->>'provider',
      (payload->>'enabled')::boolean,
      (payload->>'sandbox')::boolean,
      payload->>'status',
      nullif(payload->>'secretReference', ''),
      nullif(payload->>'webhookPath', ''),
      (payload->>'updatedAt')::timestamptz
    )
    on conflict (id) do update
    set enabled = excluded.enabled,
        sandbox = excluded.sandbox,
        status = excluded.status,
        secret_reference = excluded.secret_reference,
        webhook_path = excluded.webhook_path,
        updated_at = excluded.updated_at;

  elsif mutation_kind = 'provider_config.save' then
    if audit_action <> 'platform.provider_config_update'
      or audit_target_id <> payload->>'id' then
      raise exception 'admin mutation audit mismatch';
    end if;
    insert into public.platform_provider_configs (
      id, tenant_id, modality, provider, base_url, model, capabilities,
      enabled, status, secret_reference, updated_at
    ) values (
      payload->>'id',
      payload->>'tenantId',
      payload->>'modality',
      payload->>'provider',
      payload->>'baseUrl',
      payload->>'model',
      coalesce(payload->'capabilities', '[]'::jsonb),
      (payload->>'enabled')::boolean,
      payload->>'status',
      nullif(payload->>'secretReference', ''),
      (payload->>'updatedAt')::timestamptz
    )
    on conflict (id) do update
    set provider = excluded.provider,
        base_url = excluded.base_url,
        model = excluded.model,
        capabilities = excluded.capabilities,
        enabled = excluded.enabled,
        status = excluded.status,
        secret_reference = excluded.secret_reference,
        updated_at = excluded.updated_at;

  elsif mutation_kind = 'domain.save' then
    if audit_action <> 'domain.binding_save'
      or audit_target_id <> payload->>'id' then
      raise exception 'admin mutation audit mismatch';
    end if;
    insert into public.domain_bindings (
      id, tenant_id, channel_id, domain, purpose, verification_status,
      dns_status, certificate_status, infrastructure_applied,
      created_at, updated_at
    ) values (
      (payload->>'id')::uuid,
      payload->>'tenantId',
      nullif(payload->>'channelId', ''),
      payload->>'domain',
      payload->>'purpose',
      payload->>'verificationStatus',
      payload->>'dnsStatus',
      payload->>'certificateStatus',
      (payload->>'infrastructureApplied')::boolean,
      (payload->>'createdAt')::timestamptz,
      (payload->>'updatedAt')::timestamptz
    )
    on conflict (id) do update
    set domain = excluded.domain,
        purpose = excluded.purpose,
        verification_status = excluded.verification_status,
        dns_status = excluded.dns_status,
        certificate_status = excluded.certificate_status,
        infrastructure_applied = excluded.infrastructure_applied,
        updated_at = excluded.updated_at;

  elsif mutation_kind = 'channel_app.save' then
    if audit_action <> 'channel.application_save'
      or audit_target_id <> payload->>'id' then
      raise exception 'admin mutation audit mismatch';
    end if;
    insert into public.channel_apps (
      id, tenant_id, channel_id, kind, name, status, version,
      auth_methods, payment_providers, redirect_uris, cors_origins, scopes,
      rate_limit_per_minute, client_id, client_secret_hash,
      webhook_secret_reference, model_daily_budget, content_policy, updated_at
    ) values (
      (payload->>'id')::uuid,
      payload->>'tenantId',
      payload->>'channelId',
      payload->>'kind',
      payload->>'name',
      payload->>'status',
      nullif(payload->>'version', ''),
      array(select jsonb_array_elements_text(coalesce(payload->'authMethods', '[]'::jsonb))),
      array(select jsonb_array_elements_text(coalesce(payload->'paymentProviders', '[]'::jsonb))),
      array(select jsonb_array_elements_text(coalesce(payload->'redirectUris', '[]'::jsonb))),
      array(select jsonb_array_elements_text(coalesce(payload->'corsOrigins', '[]'::jsonb))),
      array(select jsonb_array_elements_text(coalesce(payload->'scopes', '[]'::jsonb))),
      (payload->>'rateLimitPerMinute')::integer,
      nullif(payload->>'clientId', ''),
      nullif(payload->>'clientSecretHash', ''),
      nullif(payload->>'webhookSecretReference', ''),
      nullif(payload->>'modelDailyBudget', '')::numeric,
      nullif(payload->>'contentPolicy', ''),
      (payload->>'updatedAt')::timestamptz
    )
    on conflict (id) do update
    set name = excluded.name,
        status = excluded.status,
        version = excluded.version,
        auth_methods = excluded.auth_methods,
        payment_providers = excluded.payment_providers,
        redirect_uris = excluded.redirect_uris,
        cors_origins = excluded.cors_origins,
        scopes = excluded.scopes,
        rate_limit_per_minute = excluded.rate_limit_per_minute,
        client_id = excluded.client_id,
        client_secret_hash = excluded.client_secret_hash,
        webhook_secret_reference = excluded.webhook_secret_reference,
        model_daily_budget = excluded.model_daily_budget,
        content_policy = excluded.content_policy,
        updated_at = excluded.updated_at;
  end if;

  insert into public.admin_audit_logs (
    id, tenant_id, actor_id, actor_roles, action, target_type, target_id,
    before_summary, after_summary, reason, request_id, created_at,
    mutation_fingerprint
  ) values (
    (audit->>'id')::uuid,
    audit_tenant,
    actor_user_id,
    array(
      select role from public.user_roles
      where user_id = actor_user_id and tenant_id = audit_tenant
    ),
    audit_action,
    audit_target_type,
    audit_target_id,
    audit->'before_summary',
    audit->'after_summary',
    nullif(audit->>'reason', ''),
    audit_request_id,
    coalesce(nullif(audit->>'created_at', '')::timestamptz, now()),
    canonical_fingerprint
  );

  return true;
end;
$$;

-- Replace the earlier billing functions with stricter operation/account checks.
create or replace function public.aistory_reserve_credits(reservation jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  existing_id uuid;
  existing_reserve public.credit_ledger%rowtype;
  requested_amount bigint;
  current_balance bigint;
  requested_account uuid;
  requested_tenant text;
  requested_user uuid;
  requested_operation uuid;
  requested_key text;
begin
  requested_amount := (reservation->>'amount')::bigint;
  requested_account := (reservation->>'account_id')::uuid;
  requested_tenant := reservation->>'tenant_id';
  requested_user := (reservation->>'user_id')::uuid;
  requested_operation := (reservation->>'billing_operation_id')::uuid;
  requested_key := reservation->>'idempotency_key';

  if reservation->>'kind' <> 'reserve'
    or requested_amount >= 0
    or requested_key !~ '^[A-Za-z0-9:_-]{8,160}$'
    or requested_operation is null
    or nullif(reservation->>'reserved_credits', '')::bigint
      <> abs(requested_amount) then
    raise exception 'invalid credit reservation';
  end if;

  select * into existing_reserve
  from public.credit_ledger
  where tenant_id = requested_tenant
    and idempotency_key = requested_key;
  if found then
    if existing_reserve.user_id <> requested_user
      or existing_reserve.account_id <> requested_account
      or existing_reserve.amount <> requested_amount
      or existing_reserve.billing_operation_id <> requested_operation
      or existing_reserve.kind <> 'reserve' then
      raise exception 'credit reservation idempotency conflict';
    end if;
    return existing_reserve.id;
  end if;

  perform 1
  from public.credit_accounts
  where id = requested_account
    and tenant_id = requested_tenant
    and user_id = requested_user
  for update;
  if not found then
    raise exception 'credit account unavailable';
  end if;

  -- A concurrent request may have inserted while this transaction waited on
  -- the account lock. Recheck under the lock before calculating the balance.
  select * into existing_reserve
  from public.credit_ledger
  where tenant_id = requested_tenant
    and idempotency_key = requested_key;
  if found then
    if existing_reserve.user_id <> requested_user
      or existing_reserve.account_id <> requested_account
      or existing_reserve.amount <> requested_amount
      or existing_reserve.billing_operation_id <> requested_operation
      or existing_reserve.kind <> 'reserve' then
      raise exception 'credit reservation idempotency conflict';
    end if;
    return existing_reserve.id;
  end if;

  if not exists (
    select 1 from public.app_users
    where id = requested_user
      and tenant_id = requested_tenant
      and status = 'active'
  ) then
    raise exception 'credit user inactive or unavailable';
  end if;

  select coalesce(sum(amount), 0) into current_balance
  from public.credit_ledger
  where tenant_id = requested_tenant
    and user_id = requested_user;
  if current_balance + requested_amount < 0 then
    raise exception 'INSUFFICIENT_CREDITS';
  end if;

  insert into public.credit_ledger (
    id, account_id, tenant_id, user_id, kind, amount, reason,
    idempotency_key, actor_id, billing_operation_id, modality, provider,
    model, price_policy_version, cost_source, provider_currency,
    provider_cost_minor, provider_minor_unit_scale, reserved_credits,
    settled_credits, created_at
  ) values (
    (reservation->>'id')::uuid,
    requested_account,
    requested_tenant,
    requested_user,
    'reserve',
    requested_amount,
    reservation->>'reason',
    requested_key,
    nullif(reservation->>'actor_id', '')::uuid,
    requested_operation,
    reservation->>'modality',
    reservation->>'provider',
    reservation->>'model',
    reservation->>'price_policy_version',
    reservation->>'cost_source',
    reservation->>'provider_currency',
    nullif(reservation->>'provider_cost_minor', '')::bigint,
    nullif(reservation->>'provider_minor_unit_scale', '')::integer,
    nullif(reservation->>'reserved_credits', '')::bigint,
    nullif(reservation->>'settled_credits', '')::bigint,
    coalesce((reservation->>'created_at')::timestamptz, now())
  )
  returning id into existing_id;
  return existing_id;
end;
$$;

create or replace function public.aistory_append_billing_terminal(terminal jsonb)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  existing_id uuid;
  requested_account uuid;
  requested_tenant text;
  requested_user uuid;
  requested_operation uuid;
  requested_kind text;
  reserve_row public.credit_ledger%rowtype;
  requested_amount bigint;
  requested_reserved bigint;
  requested_settled bigint;
begin
  requested_account := (terminal->>'account_id')::uuid;
  requested_tenant := terminal->>'tenant_id';
  requested_user := (terminal->>'user_id')::uuid;
  requested_operation := (terminal->>'billing_operation_id')::uuid;
  requested_kind := terminal->>'kind';
  requested_amount := (terminal->>'amount')::bigint;
  requested_reserved := nullif(terminal->>'reserved_credits', '')::bigint;
  requested_settled := nullif(terminal->>'settled_credits', '')::bigint;

  if requested_kind not in ('settle', 'refund')
    or (terminal->>'idempotency_key') !~ '^[A-Za-z0-9:_-]{8,200}$'
    or requested_reserved is null
    or requested_settled is null
    or requested_reserved < 0
    or requested_settled < 0 then
    raise exception 'invalid billing terminal';
  end if;

  perform 1
  from public.credit_accounts
  where id = requested_account
    and tenant_id = requested_tenant
    and user_id = requested_user
  for update;
  if not found then
    raise exception 'credit account unavailable';
  end if;

  select * into reserve_row
  from public.credit_ledger
  where tenant_id = requested_tenant
    and user_id = requested_user
    and account_id = requested_account
    and billing_operation_id = requested_operation
    and kind = 'reserve'
  for share;
  if not found
    or requested_reserved <> abs(reserve_row.amount)
    or (
      requested_kind = 'refund'
      and (
        requested_amount <> requested_reserved
        or requested_settled <> 0
      )
    )
    or (
      requested_kind = 'settle'
      and requested_amount <> requested_reserved - requested_settled
    ) then
    raise exception 'billing reserve mismatch';
  end if;

  select id into existing_id
  from public.credit_ledger
  where tenant_id = requested_tenant
    and billing_operation_id = requested_operation
    and kind in ('settle', 'refund')
  limit 1;
  if existing_id is not null then
    return existing_id;
  end if;

  insert into public.credit_ledger (
    id, account_id, tenant_id, user_id, kind, amount, reason,
    idempotency_key, actor_id, billing_operation_id, modality, provider,
    model, price_policy_version, cost_source, provider_currency,
    provider_cost_minor, provider_minor_unit_scale, reserved_credits,
    settled_credits, created_at
  ) values (
    (terminal->>'id')::uuid,
    requested_account,
    requested_tenant,
    requested_user,
    requested_kind,
    requested_amount,
    terminal->>'reason',
    terminal->>'idempotency_key',
    nullif(terminal->>'actor_id', '')::uuid,
    requested_operation,
    terminal->>'modality',
    terminal->>'provider',
    terminal->>'model',
    terminal->>'price_policy_version',
    terminal->>'cost_source',
    terminal->>'provider_currency',
    nullif(terminal->>'provider_cost_minor', '')::bigint,
    nullif(terminal->>'provider_minor_unit_scale', '')::integer,
    requested_reserved,
    requested_settled,
    coalesce((terminal->>'created_at')::timestamptz, now())
  )
  returning id into existing_id;
  return existing_id;
end;
$$;

-- Bootstrap remains a double gate: Supabase Auth subject + deployment env in
-- the route, then the one-shot database allowlist and transaction below.
create or replace function public.bootstrap_super_admin(
  bootstrap_user_id uuid,
  bootstrap_request_id text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  allowed public.admin_bootstrap_allowlist%rowtype;
begin
  if auth.uid() is null or auth.uid() <> bootstrap_user_id then
    raise exception 'bootstrap identity mismatch';
  end if;
  if length(bootstrap_request_id) not between 8 and 200 then
    raise exception 'bootstrap request invalid';
  end if;

  select * into allowed
  from public.admin_bootstrap_allowlist
  where user_id = bootstrap_user_id
  for update;

  if not found or allowed.used_at is not null then
    raise exception 'bootstrap unavailable';
  end if;
  if exists (select 1 from public.user_roles where role = 'super_admin') then
    raise exception 'super admin already exists';
  end if;

  insert into public.user_roles (
    user_id, tenant_id, role, created_by
  ) values (
    bootstrap_user_id, 'platform', 'super_admin', bootstrap_user_id
  );
  update public.admin_bootstrap_allowlist
  set used_at = now(), used_request_id = bootstrap_request_id
  where user_id = bootstrap_user_id;
  insert into public.admin_audit_logs (
    tenant_id, actor_id, actor_roles, action, target_type,
    target_id, request_id
  ) values (
    'platform', bootstrap_user_id, array['super_admin'],
    'admin.bootstrap', 'user_role', bootstrap_user_id::text,
    bootstrap_request_id
  );
  return true;
end;
$$;

-- RLS is enabled on internal identity tables but not forced: these
-- security-definer functions execute as their migration owner. Browser roles
-- receive no table policy or grant; service_role can only invoke the RPCs.
alter table public.app_users enable row level security;
alter table public.phone_identities enable row level security;
alter table public.phone_otp_challenges enable row level security;
alter table public.aistory_schema_gates enable row level security;
-- Do not FORCE RLS on the internal identity tables: the allowlisted
-- security-definer owner must be able to execute the transactional RPCs.
-- Browser roles have no table grants or policies for phone/OTP data.

revoke all on public.app_users from public, anon, authenticated;
revoke insert, update, delete on public.app_users from service_role;
revoke all on public.phone_identities from public, anon, authenticated, service_role;
revoke all on public.phone_otp_challenges from public, anon, authenticated, service_role;
revoke all on public.aistory_schema_gates from public, anon, authenticated, service_role;

-- Existing Auth users may read their own application user shell. Phone users
-- access their account only through the server cookie/API.
grant select on public.app_users to authenticated;
drop policy if exists "app_users_select_own" on public.app_users;
create policy "app_users_select_own" on public.app_users
  for select using (auth.uid() = auth_user_id);

revoke insert, update, delete on public.credit_ledger
  from public, anon, authenticated, service_role;
revoke insert, update, delete on public.credit_accounts
  from public, anon, authenticated, service_role;
revoke insert, update, delete on public.admin_audit_logs
  from public, anon, authenticated, service_role;
revoke insert, update, delete on public.profiles
  from public, anon, authenticated, service_role;
revoke insert, update, delete on public.user_roles
  from public, anon, authenticated, service_role;
revoke insert, update, delete on public.billing_policies
  from public, anon, authenticated, service_role;
revoke insert, update, delete on public.platform_settings
  from public, anon, authenticated, service_role;
revoke insert, update, delete on public.payment_provider_configs
  from public, anon, authenticated, service_role;
revoke insert, update, delete on public.platform_provider_configs
  from public, anon, authenticated, service_role;
revoke insert, update, delete on public.domain_bindings
  from public, anon, authenticated, service_role;
revoke insert, update, delete on public.channel_apps
  from public, anon, authenticated, service_role;
grant select on public.credit_ledger to authenticated, service_role;
grant select on public.admin_audit_logs to service_role;

revoke all on function public.aistory_database_gate_status() from public;
revoke all on function public.aistory_validate_phone_session(uuid) from public;
revoke all on function public.aistory_create_phone_challenge(jsonb) from public;
revoke all on function public.aistory_mark_phone_challenge_sent(uuid) from public;
revoke all on function public.aistory_invalidate_phone_challenge(uuid) from public;
revoke all on function public.aistory_verify_phone_and_register(jsonb) from public;
revoke all on function public.aistory_admin_adjust_credits(jsonb) from public;
revoke all on function public.aistory_admin_apply_mutation(jsonb, jsonb) from public;
revoke all on function public.aistory_reserve_credits(jsonb) from public;
revoke all on function public.aistory_append_billing_terminal(jsonb) from public;

revoke all on function public.aistory_database_gate_status() from anon, authenticated;
revoke all on function public.aistory_validate_phone_session(uuid) from anon, authenticated;
revoke all on function public.aistory_create_phone_challenge(jsonb) from anon, authenticated;
revoke all on function public.aistory_mark_phone_challenge_sent(uuid) from anon, authenticated;
revoke all on function public.aistory_invalidate_phone_challenge(uuid) from anon, authenticated;
revoke all on function public.aistory_verify_phone_and_register(jsonb) from anon, authenticated;
revoke all on function public.aistory_admin_adjust_credits(jsonb) from anon, authenticated;
revoke all on function public.aistory_admin_apply_mutation(jsonb, jsonb) from anon, authenticated;
revoke all on function public.aistory_reserve_credits(jsonb) from anon, authenticated;
revoke all on function public.aistory_append_billing_terminal(jsonb) from anon, authenticated;

grant execute on function public.aistory_database_gate_status() to service_role;
grant execute on function public.aistory_validate_phone_session(uuid) to service_role;
grant execute on function public.aistory_create_phone_challenge(jsonb) to service_role;
grant execute on function public.aistory_mark_phone_challenge_sent(uuid) to service_role;
grant execute on function public.aistory_invalidate_phone_challenge(uuid) to service_role;
grant execute on function public.aistory_verify_phone_and_register(jsonb) to service_role;
grant execute on function public.aistory_admin_adjust_credits(jsonb) to service_role;
grant execute on function public.aistory_admin_apply_mutation(jsonb, jsonb) to service_role;
grant execute on function public.aistory_reserve_credits(jsonb) to service_role;
grant execute on function public.aistory_append_billing_terminal(jsonb) to service_role;

revoke all on function public.bootstrap_super_admin(uuid, text) from public;
grant execute on function public.bootstrap_super_admin(uuid, text) to authenticated;
