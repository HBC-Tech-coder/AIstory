-- AIstory administrator-issued credit-card gate v1.
-- Forward-only and default-off: applying this migration neither enables the
-- runtime nor creates a batch. Card numbers, PINs and activation tokens are
-- never persisted; only domain-separated server HMAC digests enter this gate.

do $$
begin
  if public.aistory_database_gate_status() is distinct from '20260811193000'
    or public.aistory_database_security_posture() is distinct from true
    or public.aistory_independent_admin_gate_status()
      is distinct from '20260828230000'
    or public.aistory_independent_admin_security_posture()
      is distinct from true then
    raise exception 'credit card prerequisite gate unavailable';
  end if;
end;
$$;

-- Founder decision: ordinary registration remains exactly 1,000 credits.
-- Existing production has no policy rows. A conflicting future policy must
-- fail migration/publish review rather than silently changing the grant.
alter table public.billing_policies
  drop constraint if exists billing_policies_initial_grant_1000;
alter table public.billing_policies
  add constraint billing_policies_initial_grant_1000
  check (initial_grant_credits = 1000) not valid;
alter table public.billing_policies
  validate constraint billing_policies_initial_grant_1000;

create table public.credit_card_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null check (tenant_id = 'platform'),
  public_batch_ref text not null unique check (
    public_batch_ref ~ '^ccb_[A-Za-z0-9_-]{24,96}$'
  ),
  principal_ref text not null check (
    principal_ref ~ '^iap_[a-f0-9]{32}$'
  ),
  denomination_credits bigint not null check (
    denomination_credits between 1 and 1000000
  ),
  quantity integer not null check (quantity between 1 and 100),
  state text not null check (
    state in ('pending_activation', 'active', 'disabled')
  ),
  policy_version text not null check (
    policy_version ~ '^credit-card-policy-v1\.[A-Za-z0-9_-]{1,48}$'
  ),
  policy_fingerprint text not null check (policy_fingerprint ~ '^[a-f0-9]{64}$'),
  key_id text not null check (key_id ~ '^cck_[A-Za-z0-9_-]{8,64}$'),
  key_binding_sha256 text not null check (key_binding_sha256 ~ '^[a-f0-9]{64}$'),
  activation_token_hash text check (activation_token_hash ~ '^[a-f0-9]{64}$'),
  idempotency_key text not null check (
    idempotency_key ~ '^ccr_[A-Za-z0-9_-]{24,96}$'
  ),
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  activated_at timestamptz,
  disabled_at timestamptz,
  check (expires_at > created_at and expires_at <= created_at + interval '365 days'),
  check (denomination_credits * quantity <= 10000000),
  check (
    (state = 'pending_activation' and activation_token_hash is not null
      and activated_at is null and disabled_at is null)
    or (state = 'active' and activation_token_hash is null
      and activated_at is not null and disabled_at is null)
    or (state = 'disabled' and activation_token_hash is null
      and disabled_at is not null)
  ),
  unique (principal_ref, idempotency_key)
);

create table public.credit_cards (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.credit_card_batches (id),
  key_id text not null check (key_id ~ '^cck_[A-Za-z0-9_-]{8,64}$'),
  locator_hash text not null check (locator_hash ~ '^[a-f0-9]{64}$'),
  verifier_hash text not null check (verifier_hash ~ '^[a-f0-9]{64}$'),
  state text not null default 'active' check (
    state in ('active', 'redeemed', 'disabled')
  ),
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 5),
  attempt_window_started_at timestamptz,
  locked_until timestamptz,
  redeemed_by_user uuid,
  redeemed_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null,
  unique (key_id, locator_hash),
  check (
    (state = 'active' and redeemed_by_user is null and redeemed_at is null
      and disabled_at is null)
    or (state = 'redeemed' and redeemed_by_user is not null
      and redeemed_at is not null and disabled_at is null)
    or (state = 'disabled' and redeemed_by_user is null
      and redeemed_at is null and disabled_at is not null)
  )
);

create table public.credit_card_redemptions (
  id bigint generated always as identity primary key,
  card_id uuid not null unique references public.credit_cards (id),
  batch_id uuid not null references public.credit_card_batches (id),
  user_id uuid not null,
  ledger_entry_id uuid not null unique references public.credit_ledger (id),
  idempotency_key text not null check (
    idempotency_key ~ '^ccr_[A-Za-z0-9_-]{24,96}$'
  ),
  request_fingerprint text not null check (request_fingerprint ~ '^[a-f0-9]{64}$'),
  credited_credits bigint not null check (credited_credits between 1 and 1000000),
  balance_after bigint not null,
  redeemed_at timestamptz not null,
  unique (user_id, idempotency_key)
);

create table public.credit_card_redemption_buckets (
  user_id uuid primary key,
  window_started_at timestamptz not null,
  failed_attempts integer not null default 0 check (failed_attempts between 0 and 10),
  locked_until timestamptz,
  updated_at timestamptz not null
);

create table public.credit_card_audit_events (
  id bigint generated always as identity primary key,
  event text not null check (event in (
    'batch_created', 'batch_activated', 'batch_disabled', 'card_disabled',
    'card_redeemed', 'redemption_rejected', 'redemption_rate_limited'
  )),
  principal_ref text check (
    principal_ref is null or principal_ref ~ '^iap_[a-f0-9]{32}$'
  ),
  user_id uuid,
  public_batch_ref text check (
    public_batch_ref is null
    or public_batch_ref ~ '^ccb_[A-Za-z0-9_-]{24,96}$'
  ),
  denomination_credits bigint check (
    denomination_credits is null
    or denomination_credits between 1 and 1000000
  ),
  quantity integer check (quantity is null or quantity between 1 and 100),
  safe_reason_code text check (
    safe_reason_code is null
    or safe_reason_code in ('invalid', 'locked', 'state', 'expired')
  ),
  occurred_at timestamptz not null
);

create index credit_card_batches_created_idx
  on public.credit_card_batches (created_at desc);
create index credit_cards_batch_idx on public.credit_cards (batch_id);
create index credit_card_redemptions_user_idx
  on public.credit_card_redemptions (user_id, redeemed_at desc);

alter table public.credit_card_batches enable row level security;
alter table public.credit_card_batches force row level security;
alter table public.credit_cards enable row level security;
alter table public.credit_cards force row level security;
alter table public.credit_card_redemptions enable row level security;
alter table public.credit_card_redemptions force row level security;
alter table public.credit_card_redemption_buckets enable row level security;
alter table public.credit_card_redemption_buckets force row level security;
alter table public.credit_card_audit_events enable row level security;
alter table public.credit_card_audit_events force row level security;

revoke all on table public.credit_card_batches from public, anon, authenticated, service_role;
revoke all on table public.credit_cards from public, anon, authenticated, service_role;
revoke all on table public.credit_card_redemptions from public, anon, authenticated, service_role;
revoke all on table public.credit_card_redemption_buckets from public, anon, authenticated, service_role;
revoke all on table public.credit_card_audit_events from public, anon, authenticated, service_role;
revoke all on sequence public.credit_card_redemptions_id_seq from public, anon, authenticated, service_role;
revoke all on sequence public.credit_card_audit_events_id_seq from public, anon, authenticated, service_role;

create trigger credit_card_redemptions_append_only
before update or delete on public.credit_card_redemptions
for each row execute function public.aistory_reject_append_only_mutation();
create trigger credit_card_redemptions_no_truncate
before truncate on public.credit_card_redemptions
for each statement execute function public.aistory_reject_append_only_mutation();
create trigger credit_card_audit_events_append_only
before update or delete on public.credit_card_audit_events
for each row execute function public.aistory_reject_append_only_mutation();
create trigger credit_card_audit_events_no_truncate
before truncate on public.credit_card_audit_events
for each statement execute function public.aistory_reject_append_only_mutation();

create function public.aistory_credit_card_exact_object(
  value jsonb,
  expected_keys text[]
)
returns boolean
language plpgsql
immutable
security definer
set search_path = pg_catalog, public
as $$
begin
  if value is null or jsonb_typeof(value) <> 'object' then return false; end if;
  return (select array_agg(key_name order by key_name)
          from jsonb_object_keys(value) as key_name)
    = (select array_agg(key_name order by key_name)
       from unnest(expected_keys) as key_name);
end;
$$;

create function public.aistory_credit_card_assert_service_role()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_role text := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role'
  );
begin
  if v_role is distinct from 'service_role' then
    raise exception 'credit card service role required';
  end if;
end;
$$;

create function public.aistory_credit_card_authorize_admin(
  authorization jsonb,
  occurred_at timestamptz
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_session jsonb;
begin
  perform public.aistory_credit_card_assert_service_role();
  if not public.aistory_credit_card_exact_object(
    authorization,
    array[
      'principal_ref', 'credential_binding_sha256',
      'credential_epoch_sha256', 'password_verifier_reference_sha256',
      'password_algorithm', 'password_parameters', 'session_hash', 'tenant_id'
    ]
  ) or authorization->>'tenant_id' <> 'platform' then
    raise exception 'credit card administrator authorization invalid';
  end if;
  v_session := public.aistory_independent_admin_verify_session(
    (authorization - 'tenant_id')
      || jsonb_build_object('occurred_at', occurred_at)
  );
  if v_session is null
    or v_session->>'active' <> 'true'
    or v_session->>'role' <> 'super_admin' then
    raise exception 'credit card administrator authorization invalid';
  end if;
  return authorization->>'principal_ref';
end;
$$;

create function public.aistory_credit_card_batch_summary(batch_uuid uuid)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'batch_id', batch_row.public_batch_ref,
    'denomination_credits', batch_row.denomination_credits,
    'quantity', batch_row.quantity,
    'redeemed_count', count(*) filter (where card_row.state = 'redeemed'),
    'remaining_count', count(*) filter (
      where card_row.state = 'active' and batch_row.expires_at > statement_timestamp()
    ),
    'disabled_count', count(*) filter (where card_row.state = 'disabled'),
    'expired_count', count(*) filter (
      where card_row.state = 'active' and batch_row.expires_at <= statement_timestamp()
    ),
    'state', batch_row.state,
    'created_at', batch_row.created_at,
    'expires_at', batch_row.expires_at,
    'activated_at', batch_row.activated_at,
    'disabled_at', batch_row.disabled_at
  )
  from public.credit_card_batches as batch_row
  join public.credit_cards as card_row on card_row.batch_id = batch_row.id
  where batch_row.id = batch_uuid
  group by batch_row.id;
$$;

create function public.aistory_credit_card_gate_status()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select gate_row.version
  from public.aistory_schema_gates as gate_row
  where gate_row.gate_name = 'credit_card_program';
$$;

create function public.aistory_credit_card_key_binding_status(
  supplied_key_binding_sha256 text
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select supplied_key_binding_sha256 ~ '^[a-f0-9]{64}$'
    and not exists (
      select 1 from public.credit_card_batches as batch_row
      where batch_row.state in ('pending_activation', 'active')
        and batch_row.key_binding_sha256 <> supplied_key_binding_sha256
    );
$$;

create function public.aistory_credit_card_admin_read(request jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_occurred_at timestamptz;
begin
  perform public.aistory_credit_card_assert_service_role();
  if not public.aistory_credit_card_exact_object(
    request, array['authorization', 'occurred_at']
  ) then raise exception 'credit card read invalid'; end if;
  begin v_occurred_at := (request->>'occurred_at')::timestamptz;
  exception when others then raise exception 'credit card read invalid'; end;
  perform public.aistory_credit_card_authorize_admin(
    request->'authorization', v_occurred_at
  );
  return coalesce((
    select jsonb_agg(
      public.aistory_credit_card_batch_summary(batch_row.id)
      order by batch_row.created_at desc
    )
    from public.credit_card_batches as batch_row
  ), '[]'::jsonb);
end;
$$;

create function public.aistory_credit_card_admin_create_batch(request jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_principal text;
  v_created_at timestamptz;
  v_expires_at timestamptz;
  v_batch public.credit_card_batches%rowtype;
  v_card jsonb;
  v_quantity integer;
  v_denomination bigint;
begin
  perform public.aistory_credit_card_assert_service_role();
  if not public.aistory_credit_card_exact_object(request, array[
    'authorization', 'batch_id', 'denomination_credits', 'quantity',
    'created_at', 'expires_at', 'policy_version', 'policy_fingerprint',
    'key_id', 'key_binding_sha256', 'activation_token_hash',
    'idempotency_key', 'request_fingerprint', 'cards'
  ]) then raise exception 'credit card create invalid'; end if;
  begin
    v_created_at := (request->>'created_at')::timestamptz;
    v_expires_at := (request->>'expires_at')::timestamptz;
    v_quantity := (request->>'quantity')::integer;
    v_denomination := (request->>'denomination_credits')::bigint;
  exception when others then raise exception 'credit card create invalid'; end;
  v_principal := public.aistory_credit_card_authorize_admin(
    request->'authorization', v_created_at
  );
  if request->>'batch_id' !~ '^ccb_[A-Za-z0-9_-]{24,96}$'
    or request->>'policy_version' !~ '^credit-card-policy-v1\.[A-Za-z0-9_-]{1,48}$'
    or request->>'policy_fingerprint' !~ '^[a-f0-9]{64}$'
    or request->>'key_id' !~ '^cck_[A-Za-z0-9_-]{8,64}$'
    or request->>'key_binding_sha256' !~ '^[a-f0-9]{64}$'
    or request->>'activation_token_hash' !~ '^[a-f0-9]{64}$'
    or request->>'idempotency_key' !~ '^ccr_[A-Za-z0-9_-]{24,96}$'
    or request->>'request_fingerprint' !~ '^[a-f0-9]{64}$'
    or v_quantity not between 1 and 100
    or v_denomination not between 1 and 1000000
    or v_denomination * v_quantity > 10000000
    or v_expires_at <= v_created_at
    or v_expires_at > v_created_at + interval '365 days'
    or abs(extract(epoch from (clock_timestamp() - v_created_at))) > 60
    or jsonb_typeof(request->'cards') <> 'array'
    or jsonb_array_length(request->'cards') <> v_quantity then
    raise exception 'credit card create invalid';
  end if;
  -- Serialize the program key binding and per-principal issuance rate inside
  -- the same transaction as insertion; the earlier runtime posture check is
  -- intentionally not the authority for either invariant.
  perform pg_advisory_xact_lock(hashtextextended(
    'aistory:credit-card:program-key-binding:v1', 0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    'aistory:credit-card:principal-issue-rate:v1:' || v_principal, 0
  ));
  perform pg_advisory_xact_lock(hashtextextended(
    v_principal || ':' || request->>'idempotency_key', 0
  ));
  select * into v_batch from public.credit_card_batches as batch_row
  where batch_row.principal_ref = v_principal
    and batch_row.idempotency_key = request->>'idempotency_key';
  if found then
    if v_batch.request_fingerprint <> request->>'request_fingerprint'
      or v_batch.denomination_credits <> v_denomination
      or v_batch.quantity <> v_quantity
      or v_batch.policy_fingerprint <> request->>'policy_fingerprint' then
      raise exception 'credit card create conflict';
    end if;
    return jsonb_build_object(
      'batch', public.aistory_credit_card_batch_summary(v_batch.id),
      'replayed', true
    );
  end if;
  if exists (
    select 1 from public.credit_card_batches as binding_row
    where binding_row.state in ('pending_activation','active')
      and binding_row.key_binding_sha256 <> request->>'key_binding_sha256'
  ) then raise exception 'credit card key binding conflict'; end if;
  if (select count(*) from public.credit_card_batches as recent
      where recent.principal_ref = v_principal
        and recent.created_at > v_created_at - interval '1 hour') >= 5 then
    raise exception 'credit card create rate limited';
  end if;
  if exists (
    select 1 from jsonb_array_elements(request->'cards') as item
    where not public.aistory_credit_card_exact_object(
      item, array['locator_hash', 'verifier_hash']
    ) or item->>'locator_hash' !~ '^[a-f0-9]{64}$'
      or item->>'verifier_hash' !~ '^[a-f0-9]{64}$'
  ) or (
    select count(distinct item->>'locator_hash')
    from jsonb_array_elements(request->'cards') as item
  ) <> v_quantity then raise exception 'credit card create invalid'; end if;
  insert into public.credit_card_batches (
    tenant_id, public_batch_ref, principal_ref, denomination_credits,
    quantity, state, policy_version, policy_fingerprint, key_id,
    key_binding_sha256, activation_token_hash, idempotency_key,
    request_fingerprint, created_at, expires_at
  ) values (
    'platform', request->>'batch_id', v_principal, v_denomination,
    v_quantity, 'pending_activation', request->>'policy_version',
    request->>'policy_fingerprint', request->>'key_id',
    request->>'key_binding_sha256', request->>'activation_token_hash',
    request->>'idempotency_key', request->>'request_fingerprint',
    v_created_at, v_expires_at
  ) returning * into v_batch;
  for v_card in select value from jsonb_array_elements(request->'cards') loop
    insert into public.credit_cards (
      batch_id, key_id, locator_hash, verifier_hash, created_at
    ) values (
      v_batch.id, request->>'key_id', v_card->>'locator_hash',
      v_card->>'verifier_hash', v_created_at
    );
  end loop;
  insert into public.credit_card_audit_events (
    event, principal_ref, public_batch_ref, denomination_credits,
    quantity, occurred_at
  ) values (
    'batch_created', v_principal, v_batch.public_batch_ref,
    v_denomination, v_quantity, v_created_at
  );
  return jsonb_build_object(
    'batch', public.aistory_credit_card_batch_summary(v_batch.id),
    'replayed', false
  );
end;
$$;

create function public.aistory_credit_card_admin_mutate(request jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_action text;
  v_occurred_at timestamptz;
  v_principal text;
  v_batch public.credit_card_batches%rowtype;
  v_card public.credit_cards%rowtype;
begin
  perform public.aistory_credit_card_assert_service_role();
  v_action := request->>'action';
  begin v_occurred_at := (request->>'occurred_at')::timestamptz;
  exception when others then raise exception 'credit card mutation invalid'; end;
  v_principal := public.aistory_credit_card_authorize_admin(
    request->'authorization', v_occurred_at
  );
  if v_action in ('activate', 'disable_batch') then
    if not public.aistory_credit_card_exact_object(
      request,
      case when v_action = 'activate'
        then array['action','authorization','batch_id','activation_token_hash','occurred_at']
        else array['action','authorization','batch_id','occurred_at'] end
    ) then raise exception 'credit card mutation invalid'; end if;
    select * into v_batch from public.credit_card_batches as batch_row
    where batch_row.public_batch_ref = request->>'batch_id' for update;
    if not found then raise exception 'credit card mutation unavailable'; end if;
    if v_action = 'activate' then
      if v_batch.state = 'active' then
        return public.aistory_credit_card_batch_summary(v_batch.id);
      end if;
      if v_batch.state <> 'pending_activation'
        or v_batch.expires_at <= v_occurred_at
        or v_batch.activation_token_hash is distinct from request->>'activation_token_hash'
        or request->>'activation_token_hash' !~ '^[a-f0-9]{64}$' then
        raise exception 'credit card mutation unavailable';
      end if;
      update public.credit_card_batches set
        state = 'active', activation_token_hash = null,
        activated_at = v_occurred_at
      where id = v_batch.id;
      insert into public.credit_card_audit_events (
        event, principal_ref, public_batch_ref, occurred_at
      ) values ('batch_activated', v_principal, v_batch.public_batch_ref, v_occurred_at);
    else
      if v_batch.state <> 'disabled' then
        update public.credit_card_batches set
          state = 'disabled', activation_token_hash = null,
          disabled_at = v_occurred_at
        where id = v_batch.id;
        update public.credit_cards set state = 'disabled', disabled_at = v_occurred_at
        where batch_id = v_batch.id and state = 'active';
        insert into public.credit_card_audit_events (
          event, principal_ref, public_batch_ref, occurred_at
        ) values ('batch_disabled', v_principal, v_batch.public_batch_ref, v_occurred_at);
      end if;
    end if;
    return public.aistory_credit_card_batch_summary(v_batch.id);
  elsif v_action = 'disable_card' then
    if not public.aistory_credit_card_exact_object(
      request, array['action','authorization','key_id','locator_hash','occurred_at']
    ) or request->>'key_id' !~ '^cck_[A-Za-z0-9_-]{8,64}$'
      or request->>'locator_hash' !~ '^[a-f0-9]{64}$' then
      raise exception 'credit card mutation invalid';
    end if;
    select card_row.* into v_card from public.credit_cards as card_row
    where card_row.key_id = request->>'key_id'
      and card_row.locator_hash = request->>'locator_hash';
    if not found then raise exception 'credit card mutation unavailable'; end if;
    select * into strict v_batch from public.credit_card_batches as batch_row
    where batch_row.id = v_card.batch_id for update;
    select * into strict v_card from public.credit_cards as card_row
    where card_row.id = v_card.id for update;
    if v_card.state = 'redeemed' then raise exception 'credit card mutation unavailable'; end if;
    if v_card.state = 'active' then
      update public.credit_cards set state = 'disabled', disabled_at = v_occurred_at
      where id = v_card.id;
      insert into public.credit_card_audit_events (
        event, principal_ref, public_batch_ref, occurred_at
      ) values ('card_disabled', v_principal, v_batch.public_batch_ref, v_occurred_at);
    end if;
    return public.aistory_credit_card_batch_summary(v_batch.id);
  end if;
  raise exception 'credit card mutation invalid';
end;
$$;

create function public.aistory_credit_card_redeem(request jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user uuid;
  v_now timestamptz;
  v_bucket public.credit_card_redemption_buckets%rowtype;
  v_card public.credit_cards%rowtype;
  v_batch public.credit_card_batches%rowtype;
  v_account uuid;
  v_balance bigint;
  v_ledger uuid;
  v_existing public.credit_card_redemptions%rowtype;
begin
  perform public.aistory_credit_card_assert_service_role();
  if not public.aistory_credit_card_exact_object(request, array[
    'user_id','key_id','key_binding_sha256','locator_hash','verifier_hash',
    'idempotency_key','request_fingerprint','occurred_at'
  ]) then raise exception 'credit card redemption invalid'; end if;
  begin
    v_user := (request->>'user_id')::uuid;
    v_now := (request->>'occurred_at')::timestamptz;
  exception when others then raise exception 'credit card redemption invalid'; end;
  if request->>'key_id' !~ '^cck_[A-Za-z0-9_-]{8,64}$'
    or request->>'key_binding_sha256' !~ '^[a-f0-9]{64}$'
    or request->>'locator_hash' !~ '^[a-f0-9]{64}$'
    or request->>'verifier_hash' !~ '^[a-f0-9]{64}$'
    or request->>'idempotency_key' !~ '^ccr_[A-Za-z0-9_-]{24,96}$'
    or request->>'request_fingerprint' !~ '^[a-f0-9]{64}$'
    or abs(extract(epoch from (clock_timestamp() - v_now))) > 60
    or not exists (
      select 1 from public.app_users as user_row
      where user_row.id = v_user and user_row.tenant_id = 'platform'
        and user_row.identity_type = 'phone' and user_row.status = 'active'
    ) or not exists (
      select 1 from public.phone_identities as phone_row
      where phone_row.user_id = v_user
    ) then raise exception 'credit card redemption invalid'; end if;

  insert into public.credit_card_redemption_buckets (
    user_id, window_started_at, failed_attempts, updated_at
  ) values (v_user, v_now, 0, v_now)
  on conflict (user_id) do nothing;
  select * into strict v_bucket from public.credit_card_redemption_buckets
  where user_id = v_user for update;
  if v_bucket.window_started_at <= v_now - interval '15 minutes' then
    update public.credit_card_redemption_buckets set
      window_started_at = v_now, failed_attempts = 0,
      locked_until = null, updated_at = v_now where user_id = v_user;
    v_bucket.failed_attempts := 0; v_bucket.locked_until := null;
  end if;
  if v_bucket.locked_until is not null and v_bucket.locked_until > v_now then
    insert into public.credit_card_audit_events (
      event, user_id, safe_reason_code, occurred_at
    ) values ('redemption_rate_limited', v_user, 'locked', v_now);
    return jsonb_build_object(
      'status','rate_limited',
      'retry_after_seconds', greatest(1, least(900,
        ceil(extract(epoch from (v_bucket.locked_until - v_now)))::integer))
    );
  end if;
  select * into v_existing from public.credit_card_redemptions as redemption
  where redemption.user_id = v_user
    and redemption.idempotency_key = request->>'idempotency_key';
  if found then
    if v_existing.request_fingerprint <> request->>'request_fingerprint' then
      update public.credit_card_redemption_buckets set
        failed_attempts = least(10, failed_attempts + 1),
        locked_until = case when failed_attempts + 1 >= 10
          then v_now + interval '15 minutes' else locked_until end,
        updated_at = v_now where user_id = v_user;
      return jsonb_build_object('status','unavailable');
    end if;
    return jsonb_build_object(
      'status','redeemed', 'credited_credits',v_existing.credited_credits,
      'balance_after',v_existing.balance_after,
      'redeemed_at',v_existing.redeemed_at,'replayed',true
    );
  end if;
  select * into v_card from public.credit_cards as card_row
  where card_row.key_id = request->>'key_id'
    and card_row.locator_hash = request->>'locator_hash';
  if not found then
    update public.credit_card_redemption_buckets set
      failed_attempts = least(10, failed_attempts + 1),
      locked_until = case when failed_attempts + 1 >= 10
        then v_now + interval '15 minutes' else locked_until end,
      updated_at = v_now where user_id = v_user;
    insert into public.credit_card_audit_events (
      event,user_id,safe_reason_code,occurred_at
    ) values ('redemption_rejected',v_user,'invalid',v_now);
    return jsonb_build_object('status','unavailable');
  end if;
  select * into strict v_batch from public.credit_card_batches as batch_row
  where batch_row.id = v_card.batch_id for update;
  select * into strict v_card from public.credit_cards as card_row
  where card_row.id = v_card.id for update;
  if v_batch.state <> 'active' or v_card.state <> 'active'
    or v_batch.expires_at <= v_now
    or v_batch.key_binding_sha256 <> request->>'key_binding_sha256'
    or (v_card.locked_until is not null and v_card.locked_until > v_now) then
    update public.credit_card_redemption_buckets set
      failed_attempts = least(10, failed_attempts + 1),
      locked_until = case when failed_attempts + 1 >= 10
        then v_now + interval '15 minutes' else locked_until end,
      updated_at = v_now
    where user_id = v_user;
    insert into public.credit_card_audit_events (
      event,user_id,public_batch_ref,safe_reason_code,occurred_at
    ) values ('redemption_rejected',v_user,v_batch.public_batch_ref,
      case when v_batch.expires_at <= v_now then 'expired' else 'state' end,v_now);
    return jsonb_build_object('status','unavailable');
  end if;
  if v_card.attempt_window_started_at is null
    or v_card.attempt_window_started_at <= v_now - interval '15 minutes' then
    update public.credit_cards set failed_attempts = 0,
      attempt_window_started_at = v_now, locked_until = null
    where id = v_card.id;
    v_card.failed_attempts := 0; v_card.locked_until := null;
  end if;
  if v_card.verifier_hash <> request->>'verifier_hash' then
    update public.credit_cards set
      failed_attempts = least(5, failed_attempts + 1),
      locked_until = case when failed_attempts + 1 >= 5
        then v_now + interval '15 minutes' else locked_until end
    where id = v_card.id;
    update public.credit_card_redemption_buckets set
      failed_attempts = least(10, failed_attempts + 1),
      locked_until = case when failed_attempts + 1 >= 10
        then v_now + interval '15 minutes' else locked_until end,
      updated_at = v_now where user_id = v_user;
    insert into public.credit_card_audit_events (
      event,user_id,public_batch_ref,safe_reason_code,occurred_at
    ) values ('redemption_rejected',v_user,v_batch.public_batch_ref,'invalid',v_now);
    return jsonb_build_object('status','unavailable');
  end if;
  select account_row.id into v_account from public.credit_accounts as account_row
  where account_row.tenant_id = 'platform' and account_row.user_id = v_user
    and account_row.currency = 'credit' for update;
  if not found then raise exception 'credit card account unavailable'; end if;
  select coalesce(sum(ledger.amount),0) into v_balance
  from public.credit_ledger as ledger
  where ledger.tenant_id = 'platform' and ledger.user_id = v_user;
  insert into public.credit_ledger (
    account_id,tenant_id,user_id,kind,amount,reason,idempotency_key,
    price_policy_version
  ) values (
    v_account,'platform',v_user,'reward',v_batch.denomination_credits,
    'Credit card redemption','credit-card:' || v_card.id::text,
    v_batch.policy_version
  ) returning id into v_ledger;
  v_balance := v_balance + v_batch.denomination_credits;
  update public.credit_cards set state='redeemed',redeemed_by_user=v_user,
    redeemed_at=v_now,failed_attempts=0,locked_until=null
  where id=v_card.id;
  insert into public.credit_card_redemptions (
    card_id,batch_id,user_id,ledger_entry_id,idempotency_key,
    request_fingerprint,credited_credits,balance_after,redeemed_at
  ) values (
    v_card.id,v_batch.id,v_user,v_ledger,request->>'idempotency_key',
    request->>'request_fingerprint',v_batch.denomination_credits,v_balance,v_now
  );
  update public.credit_card_redemption_buckets set
    failed_attempts=0,window_started_at=v_now,locked_until=null,updated_at=v_now
  where user_id=v_user;
  insert into public.credit_card_audit_events (
    event,user_id,public_batch_ref,denomination_credits,quantity,occurred_at
  ) values (
    'card_redeemed',v_user,v_batch.public_batch_ref,
    v_batch.denomination_credits,1,v_now
  );
  return jsonb_build_object(
    'status','redeemed','credited_credits',v_batch.denomination_credits,
    'balance_after',v_balance,'redeemed_at',v_now,'replayed',false
  );
end;
$$;

insert into public.aistory_schema_gates (gate_name, version)
values ('credit_card_program', '20260828234500')
on conflict (gate_name) do update
set version = excluded.version, installed_at = now();

create function public.aistory_credit_card_security_posture()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.aistory_credit_card_gate_status() = '20260828234500'
    and public.aistory_database_security_posture()
    and public.aistory_independent_admin_security_posture()
    and (
      select count(*) = 5
        and bool_and(relation.relrowsecurity and relation.relforcerowsecurity)
      from pg_catalog.pg_class as relation
      where relation.oid = any(array[
        'public.credit_card_batches'::regclass,
        'public.credit_cards'::regclass,
        'public.credit_card_redemptions'::regclass,
        'public.credit_card_redemption_buckets'::regclass,
        'public.credit_card_audit_events'::regclass
      ])
    )
    and (
      select bool_and(
        not has_table_privilege(
          'anon', guarded.table_name,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
        and not has_table_privilege(
          'authenticated', guarded.table_name,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
        and not has_table_privilege(
          'service_role', guarded.table_name,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
      )
      from unnest(array[
        'public.credit_card_batches',
        'public.credit_cards',
        'public.credit_card_redemptions',
        'public.credit_card_redemption_buckets',
        'public.credit_card_audit_events'
      ]) as guarded(table_name)
    )
    and (
      select bool_and(
        not has_sequence_privilege('anon', guarded.sequence_name,
          'USAGE,SELECT,UPDATE')
        and not has_sequence_privilege('authenticated', guarded.sequence_name,
          'USAGE,SELECT,UPDATE')
        and not has_sequence_privilege('service_role', guarded.sequence_name,
          'USAGE,SELECT,UPDATE')
      )
      from unnest(array[
        'public.credit_card_redemptions_id_seq',
        'public.credit_card_audit_events_id_seq'
      ]) as guarded(sequence_name)
    )
    and (
      select count(*) = 11
        and bool_and(
          procedure_row.prosecdef
          and coalesce(procedure_row.proconfig, '{}'::text[])
            @> array['search_path=pg_catalog, public']
          and procedure_row.provolatile = case
            when procedure_row.oid =
              'public.aistory_credit_card_exact_object(jsonb,text[])'::regprocedure::oid
              then 'i'::"char"
            when procedure_row.oid = any(array[
              'public.aistory_credit_card_assert_service_role()'::regprocedure::oid,
              'public.aistory_credit_card_batch_summary(uuid)'::regprocedure::oid,
              'public.aistory_credit_card_gate_status()'::regprocedure::oid,
              'public.aistory_credit_card_key_binding_status(text)'::regprocedure::oid,
              'public.aistory_credit_card_security_posture()'::regprocedure::oid
            ]) then 's'::"char"
            else 'v'::"char"
          end
        )
      from pg_catalog.pg_proc as procedure_row
      where procedure_row.oid = any(array[
        'public.aistory_credit_card_exact_object(jsonb,text[])'::regprocedure::oid,
        'public.aistory_credit_card_assert_service_role()'::regprocedure::oid,
        'public.aistory_credit_card_authorize_admin(jsonb,timestamptz)'::regprocedure::oid,
        'public.aistory_credit_card_batch_summary(uuid)'::regprocedure::oid,
        'public.aistory_credit_card_gate_status()'::regprocedure::oid,
        'public.aistory_credit_card_key_binding_status(text)'::regprocedure::oid,
        'public.aistory_credit_card_admin_read(jsonb)'::regprocedure::oid,
        'public.aistory_credit_card_admin_create_batch(jsonb)'::regprocedure::oid,
        'public.aistory_credit_card_admin_mutate(jsonb)'::regprocedure::oid,
        'public.aistory_credit_card_redeem(jsonb)'::regprocedure::oid,
        'public.aistory_credit_card_security_posture()'::regprocedure::oid
      ])
    )
    and (
      select bool_and(
        not has_function_privilege('anon', guarded.rpc_oid, 'EXECUTE')
        and not has_function_privilege('authenticated', guarded.rpc_oid, 'EXECUTE')
        and has_function_privilege('service_role', guarded.rpc_oid, 'EXECUTE')
      )
      from unnest(array[
        'public.aistory_credit_card_gate_status()'::regprocedure::oid,
        'public.aistory_credit_card_key_binding_status(text)'::regprocedure::oid,
        'public.aistory_credit_card_admin_read(jsonb)'::regprocedure::oid,
        'public.aistory_credit_card_admin_create_batch(jsonb)'::regprocedure::oid,
        'public.aistory_credit_card_admin_mutate(jsonb)'::regprocedure::oid,
        'public.aistory_credit_card_redeem(jsonb)'::regprocedure::oid,
        'public.aistory_credit_card_security_posture()'::regprocedure::oid
      ]) as guarded(rpc_oid)
    )
    and (
      select bool_and(
        not has_function_privilege('anon', guarded.helper_oid, 'EXECUTE')
        and not has_function_privilege('authenticated', guarded.helper_oid, 'EXECUTE')
        and not has_function_privilege('service_role', guarded.helper_oid, 'EXECUTE')
      )
      from unnest(array[
        'public.aistory_credit_card_exact_object(jsonb,text[])'::regprocedure::oid,
        'public.aistory_credit_card_assert_service_role()'::regprocedure::oid,
        'public.aistory_credit_card_authorize_admin(jsonb,timestamptz)'::regprocedure::oid,
        'public.aistory_credit_card_batch_summary(uuid)'::regprocedure::oid
      ]) as guarded(helper_oid)
    )
    and (
      select count(*) = 4
        and bool_and(
          trigger_row.tgenabled = 'O'
          and not trigger_row.tgisinternal
          and trigger_row.tgfoid =
            'public.aistory_reject_append_only_mutation()'::regprocedure::oid
          and trigger_row.tgtype = case
            when trigger_row.tgname like '%_no_truncate' then 34
            else 27
          end
        )
      from pg_catalog.pg_trigger as trigger_row
      where (trigger_row.tgrelid, trigger_row.tgname) in (
        ('public.credit_card_redemptions'::regclass,
          'credit_card_redemptions_append_only'),
        ('public.credit_card_redemptions'::regclass,
          'credit_card_redemptions_no_truncate'),
        ('public.credit_card_audit_events'::regclass,
          'credit_card_audit_events_append_only'),
        ('public.credit_card_audit_events'::regclass,
          'credit_card_audit_events_no_truncate')
      )
    )
    and exists (
      select 1 from pg_catalog.pg_constraint as constraint_row
      where constraint_row.conrelid='public.billing_policies'::regclass
        and constraint_row.conname='billing_policies_initial_grant_1000'
        and constraint_row.convalidated
        and regexp_replace(
          pg_catalog.pg_get_expr(
            constraint_row.conbin,
            constraint_row.conrelid,
            true
          ),
          '\s+', '', 'g'
        ) in (
          'initial_grant_credits=1000',
          '(initial_grant_credits=1000)'
        )
    );
$$;

revoke all on function public.aistory_credit_card_exact_object(jsonb,text[]) from public,anon,authenticated,service_role;
revoke all on function public.aistory_credit_card_assert_service_role() from public,anon,authenticated,service_role;
revoke all on function public.aistory_credit_card_authorize_admin(jsonb,timestamptz) from public,anon,authenticated,service_role;
revoke all on function public.aistory_credit_card_batch_summary(uuid) from public,anon,authenticated,service_role;
revoke all on function public.aistory_credit_card_gate_status() from public,anon,authenticated,service_role;
revoke all on function public.aistory_credit_card_key_binding_status(text) from public,anon,authenticated,service_role;
revoke all on function public.aistory_credit_card_admin_read(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.aistory_credit_card_admin_create_batch(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.aistory_credit_card_admin_mutate(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.aistory_credit_card_redeem(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.aistory_credit_card_security_posture() from public,anon,authenticated,service_role;

grant execute on function public.aistory_credit_card_gate_status() to service_role;
grant execute on function public.aistory_credit_card_key_binding_status(text) to service_role;
grant execute on function public.aistory_credit_card_admin_read(jsonb) to service_role;
grant execute on function public.aistory_credit_card_admin_create_batch(jsonb) to service_role;
grant execute on function public.aistory_credit_card_admin_mutate(jsonb) to service_role;
grant execute on function public.aistory_credit_card_redeem(jsonb) to service_role;
grant execute on function public.aistory_credit_card_security_posture() to service_role;
