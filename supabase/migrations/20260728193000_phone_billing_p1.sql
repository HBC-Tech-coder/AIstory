-- AIstory phone-account billing P1. The application remains local-only until
-- production SMS, pricing and Supabase deployment are explicitly configured.

alter table public.credit_ledger
  drop constraint if exists credit_ledger_kind_check;
alter table public.credit_ledger
  add constraint credit_ledger_kind_check check (
    kind in (
      'initial_grant', 'purchase', 'reward', 'reserve', 'settle', 'spend',
      'refund', 'manual_adjustment', 'creator_income', 'expiry'
    )
  );

-- A zero-value settle row is intentional when the final catalog/provider cost
-- exactly equals the reservation. It records a terminal, append-only outcome.
alter table public.credit_ledger
  drop constraint if exists credit_ledger_amount_check;
alter table public.credit_ledger
  add constraint credit_ledger_amount_check check (
    amount <> 0 or kind = 'settle'
  );

alter table public.credit_ledger
  add column if not exists billing_operation_id uuid,
  add column if not exists modality text,
  add column if not exists provider text,
  add column if not exists model text,
  add column if not exists price_policy_version text,
  add column if not exists cost_source text check (
    cost_source in ('provider_settlement', 'price_catalog')
  ),
  add column if not exists provider_currency text,
  add column if not exists provider_cost_minor bigint,
  add column if not exists provider_minor_unit_scale integer,
  add column if not exists reserved_credits bigint,
  add column if not exists settled_credits bigint;

create index if not exists credit_ledger_billing_operation_idx
  on public.credit_ledger (tenant_id, billing_operation_id);

create table if not exists public.billing_policies (
  tenant_id text not null references public.tenants (id),
  version text not null,
  markup_basis_points integer not null default 20000 check (
    markup_basis_points between 10000 and 100000
  ),
  initial_grant_credits bigint not null default 1000 check (
    initial_grant_credits >= 0
  ),
  provider_currency text not null default 'CNY',
  provider_minor_unit_scale integer not null default 2 check (
    provider_minor_unit_scale between 0 and 6
  ),
  credit_units_per_provider_minor integer not null default 1 check (
    credit_units_per_provider_minor between 1 and 1000000
  ),
  entries jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id),
  primary key (tenant_id, version)
);

alter table public.billing_policies enable row level security;

drop policy if exists "billing_policies_select_finance" on public.billing_policies;
create policy "billing_policies_select_finance" on public.billing_policies
  for select using (
    public.has_admin_role(array['super_admin', 'finance'])
  );

create or replace function public.aistory_reserve_credits(reservation jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_id uuid;
  requested_amount bigint;
  current_balance bigint;
  requested_account uuid;
  requested_tenant text;
  requested_user uuid;
begin
  requested_amount := (reservation->>'amount')::bigint;
  requested_account := (reservation->>'account_id')::uuid;
  requested_tenant := reservation->>'tenant_id';
  requested_user := (reservation->>'user_id')::uuid;

  if reservation->>'kind' <> 'reserve' or requested_amount >= 0 then
    raise exception 'invalid credit reservation';
  end if;

  select id into existing_id
  from public.credit_ledger
  where tenant_id = requested_tenant
    and idempotency_key = reservation->>'idempotency_key';
  if existing_id is not null then
    return existing_id;
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
    reservation->>'idempotency_key',
    nullif(reservation->>'actor_id', '')::uuid,
    nullif(reservation->>'billing_operation_id', '')::uuid,
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

revoke all on function public.aistory_reserve_credits(jsonb) from public;
revoke all on function public.aistory_reserve_credits(jsonb) from anon;
revoke all on function public.aistory_reserve_credits(jsonb) from authenticated;
grant execute on function public.aistory_reserve_credits(jsonb) to service_role;

-- Settle and refund are mutually exclusive terminal outcomes. The account row
-- lock makes the decision atomic even when provider callbacks race.
create or replace function public.aistory_append_billing_terminal(terminal jsonb)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_id uuid;
  requested_account uuid;
  requested_tenant text;
  requested_user uuid;
  requested_operation uuid;
  requested_kind text;
begin
  requested_account := (terminal->>'account_id')::uuid;
  requested_tenant := terminal->>'tenant_id';
  requested_user := (terminal->>'user_id')::uuid;
  requested_operation := (terminal->>'billing_operation_id')::uuid;
  requested_kind := terminal->>'kind';

  if requested_kind not in ('settle', 'refund') then
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

  select id into existing_id
  from public.credit_ledger
  where tenant_id = requested_tenant
    and user_id = requested_user
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
    (terminal->>'amount')::bigint,
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
    nullif(terminal->>'reserved_credits', '')::bigint,
    nullif(terminal->>'settled_credits', '')::bigint,
    coalesce((terminal->>'created_at')::timestamptz, now())
  )
  returning id into existing_id;
  return existing_id;
end;
$$;

revoke all on function public.aistory_append_billing_terminal(jsonb) from public;
revoke all on function public.aistory_append_billing_terminal(jsonb) from anon;
revoke all on function public.aistory_append_billing_terminal(jsonb) from authenticated;
grant execute on function public.aistory_append_billing_terminal(jsonb) to service_role;
