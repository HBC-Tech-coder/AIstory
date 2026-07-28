-- AIstory super-admin control plane P1.
--
-- The application remains stateless for story generation. These tables are
-- projections, immutable financial/audit records, configuration metadata, and
-- privacy-minimized analytics. Secrets are NEVER stored here: only references
-- to environment variables or an external secret manager are allowed.

create extension if not exists pgcrypto;

create table if not exists public.tenants (
  id text primary key,
  name text not null,
  status text not null default 'active'
    check (status in ('active', 'suspended', 'deleted')),
  created_at timestamptz not null default now()
);

insert into public.tenants (id, name)
values ('platform', 'AIstory Platform')
on conflict (id) do nothing;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users (id) on delete cascade,
  tenant_id text not null references public.tenants (id),
  channel_id text,
  display_name text not null default '',
  masked_contact text,
  status text not null default 'active'
    check (status in ('active', 'frozen', 'deleted')),
  user_type text not null default 'player'
    check (user_type in ('player', 'creator', 'partner', 'staff')),
  locale text,
  region text,
  tags text[] not null default '{}',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists public.user_roles (
  user_id uuid not null references auth.users (id) on delete cascade,
  tenant_id text not null references public.tenants (id),
  role text not null check (
    role in ('super_admin', 'ops', 'finance', 'moderator', 'support', 'analyst')
  ),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users (id),
  primary key (user_id, tenant_id, role)
);

create or replace function public.has_admin_role(
  allowed_roles text[] default array[
    'super_admin', 'ops', 'finance', 'moderator', 'support', 'analyst'
  ]
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles
    where user_id = auth.uid()
      and role = any(allowed_roles)
  );
$$;

revoke all on function public.has_admin_role(text[]) from public;
grant execute on function public.has_admin_role(text[]) to authenticated;

create table if not exists public.credit_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  currency text not null default 'credit' check (currency = 'credit'),
  balance_snapshot bigint not null default 0,
  snapshot_updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (tenant_id, user_id, currency)
);

create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.credit_accounts (id),
  tenant_id text not null references public.tenants (id),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (
    kind in (
      'initial_grant', 'purchase', 'reward', 'spend', 'refund',
      'manual_adjustment', 'creator_income', 'expiry'
    )
  ),
  amount bigint not null check (amount <> 0),
  reason text,
  idempotency_key text not null,
  actor_id uuid references auth.users (id),
  created_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create index if not exists credit_ledger_user_created_idx
  on public.credit_ledger (tenant_id, user_id, created_at desc);

-- Immutable ledger: only INSERT is granted by application policies. Any
-- correction is represented by another entry.

create table if not exists public.play_sessions (
  id text primary key,
  tenant_id text not null references public.tenants (id),
  channel_id text,
  user_id uuid references auth.users (id) on delete set null,
  story_id text,
  template_id text,
  story_version text,
  timeline_id text,
  branch_id text,
  device text,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  duration_ms bigint,
  completed boolean not null default false
);

create table if not exists public.gameplay_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  channel_id text,
  user_id uuid references auth.users (id) on delete set null,
  session_id text not null,
  story_id text,
  template_id text,
  story_version text,
  timeline_id text,
  branch_id text,
  decision_id text,
  choice_id text,
  scene_id text,
  beat_id text,
  event text not null,
  duration_ms bigint,
  device text,
  provider text,
  modality text,
  model text,
  cache_hit boolean,
  latency_ms bigint,
  estimated_cost numeric(18, 8),
  error_code text,
  created_at timestamptz not null default now()
);

create index if not exists gameplay_events_session_created_idx
  on public.gameplay_events (tenant_id, session_id, created_at);
create index if not exists gameplay_events_rollup_idx
  on public.gameplay_events (tenant_id, channel_id, event, created_at desc);

create table if not exists public.payment_provider_configs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  channel_id text,
  provider text not null,
  enabled boolean not null default false,
  sandbox boolean not null default true,
  status text not null default 'unconfigured',
  secret_reference text,
  webhook_path text,
  updated_at timestamptz not null default now(),
  unique nulls not distinct (tenant_id, channel_id, provider),
  check (secret_reference is null or secret_reference ~ '^(env|secret):')
);

create table if not exists public.payment_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  channel_id text,
  user_id uuid references auth.users (id) on delete set null,
  provider text not null,
  provider_order_id text,
  status text not null,
  amount_minor bigint not null check (amount_minor >= 0),
  currency text not null,
  credits bigint not null check (credits >= 0),
  idempotency_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, idempotency_key)
);

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  order_id uuid not null references public.payment_orders (id),
  provider_transaction_id text,
  status text not null,
  amount_minor bigint not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, provider_transaction_id)
);

create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  transaction_id uuid not null references public.payment_transactions (id),
  provider_refund_id text,
  status text not null,
  amount_minor bigint not null check (amount_minor > 0),
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  provider text not null,
  provider_event_id text not null,
  payload_hash text not null,
  status text not null default 'received',
  attempts integer not null default 0,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (tenant_id, provider, provider_event_id)
);

create table if not exists public.platform_settings (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  channel_id text,
  status text not null check (status in ('draft', 'published')),
  version integer not null,
  branding jsonb not null,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  unique nulls not distinct (tenant_id, channel_id, version)
);

create table if not exists public.domain_bindings (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  channel_id text,
  domain text not null,
  purpose text not null,
  verification_status text not null default 'pending',
  dns_status text not null default 'unknown',
  certificate_status text not null default 'unknown',
  infrastructure_applied boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (domain)
);

create table if not exists public.channel_apps (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  channel_id text not null,
  kind text not null check (
    kind in (
      'web', 'steam', 'wechat_miniprogram', 'wechat_minigame', 'ios', 'android'
    )
  ),
  name text not null,
  status text not null,
  version text,
  auth_methods text[] not null default '{}',
  payment_providers text[] not null default '{}',
  redirect_uris text[] not null default '{}',
  cors_origins text[] not null default '{}',
  scopes text[] not null default '{}',
  rate_limit_per_minute integer not null default 60,
  client_id text unique,
  client_secret_hash text,
  webhook_secret_reference text,
  model_daily_budget numeric(18, 4),
  content_policy text,
  updated_at timestamptz not null default now(),
  unique (tenant_id, channel_id)
);

create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  channel_id text,
  kind text not null,
  enabled boolean not null default false,
  config_metadata jsonb not null default '{}',
  secret_reference text,
  updated_at timestamptz not null default now(),
  check (secret_reference is null or secret_reference ~ '^(env|secret):')
);

create table if not exists public.api_clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  channel_id text,
  client_id text not null unique,
  secret_hash text not null,
  scopes text[] not null default '{}',
  redirect_uris text[] not null default '{}',
  cors_origins text[] not null default '{}',
  rate_limit_per_minute integer not null default 60,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table if not exists public.outbound_webhooks (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  channel_id text,
  endpoint_url text not null,
  event_types text[] not null default '{}',
  signing_secret_reference text not null,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  check (signing_secret_reference ~ '^(env|secret):')
);

create table if not exists public.admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  actor_id uuid references auth.users (id),
  actor_roles text[] not null default '{}',
  action text not null,
  target_type text not null,
  target_id text,
  before_summary jsonb,
  after_summary jsonb,
  reason text,
  request_id text not null,
  created_at timestamptz not null default now()
);

create index if not exists admin_audit_logs_created_idx
  on public.admin_audit_logs (tenant_id, created_at desc);

-- Bootstrap is deliberately allowlist-driven. Deployment staff must insert one
-- auth user into this table through the Supabase SQL console/service role. The
-- public application cannot create its own allowlist row.
create table if not exists public.admin_bootstrap_allowlist (
  user_id uuid primary key references auth.users (id) on delete cascade,
  email text,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  used_request_id text
);

create or replace function public.bootstrap_super_admin(
  bootstrap_user_id uuid,
  bootstrap_request_id text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  allowed public.admin_bootstrap_allowlist%rowtype;
begin
  if auth.uid() is null or auth.uid() <> bootstrap_user_id then
    raise exception 'bootstrap identity mismatch';
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

revoke all on function public.bootstrap_super_admin(uuid, text) from public;
grant execute on function public.bootstrap_super_admin(uuid, text) to authenticated;

-- RLS: browser users can see their own profile/roles/account/ledger. Aggregate
-- admin access is server-mediated. Service-role jobs handle writes and bypass
-- RLS; clients cannot mutate finance, configuration, or audit records.
alter table public.tenants enable row level security;
alter table public.profiles enable row level security;
alter table public.user_roles enable row level security;
alter table public.credit_accounts enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.play_sessions enable row level security;
alter table public.gameplay_events enable row level security;
alter table public.payment_provider_configs enable row level security;
alter table public.payment_orders enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.refunds enable row level security;
alter table public.webhook_events enable row level security;
alter table public.platform_settings enable row level security;
alter table public.domain_bindings enable row level security;
alter table public.channel_apps enable row level security;
alter table public.integrations enable row level security;
alter table public.api_clients enable row level security;
alter table public.outbound_webhooks enable row level security;
alter table public.admin_audit_logs enable row level security;
alter table public.admin_bootstrap_allowlist enable row level security;

drop policy if exists "profiles_select_own_or_admin" on public.profiles;
create policy "profiles_select_own_or_admin" on public.profiles
  for select using (auth.uid() = user_id or public.has_admin_role());

drop policy if exists "roles_select_own_or_admin" on public.user_roles;
create policy "roles_select_own_or_admin" on public.user_roles
  for select using (auth.uid() = user_id or public.has_admin_role());

drop policy if exists "credit_accounts_select_own_or_finance" on public.credit_accounts;
create policy "credit_accounts_select_own_or_finance" on public.credit_accounts
  for select using (
    auth.uid() = user_id
    or public.has_admin_role(array['super_admin', 'finance'])
  );

drop policy if exists "credit_ledger_select_own_or_finance" on public.credit_ledger;
create policy "credit_ledger_select_own_or_finance" on public.credit_ledger
  for select using (
    auth.uid() = user_id
    or public.has_admin_role(array['super_admin', 'finance'])
  );

drop policy if exists "play_sessions_select_admin" on public.play_sessions;
create policy "play_sessions_select_admin" on public.play_sessions
  for select using (public.has_admin_role());

drop policy if exists "gameplay_events_select_admin" on public.gameplay_events;
create policy "gameplay_events_select_admin" on public.gameplay_events
  for select using (public.has_admin_role());

drop policy if exists "payment_configs_select_admin" on public.payment_provider_configs;
create policy "payment_configs_select_admin" on public.payment_provider_configs
  for select using (public.has_admin_role(array['super_admin', 'finance']));

drop policy if exists "platform_settings_select_admin" on public.platform_settings;
create policy "platform_settings_select_admin" on public.platform_settings
  for select using (public.has_admin_role(array['super_admin', 'ops']));

drop policy if exists "domain_bindings_select_admin" on public.domain_bindings;
create policy "domain_bindings_select_admin" on public.domain_bindings
  for select using (public.has_admin_role(array['super_admin', 'ops']));

drop policy if exists "channel_apps_select_admin" on public.channel_apps;
create policy "channel_apps_select_admin" on public.channel_apps
  for select using (public.has_admin_role(array['super_admin', 'ops']));

drop policy if exists "audit_select_super_admin" on public.admin_audit_logs;
create policy "audit_select_super_admin" on public.admin_audit_logs
  for select using (public.has_admin_role(array['super_admin']));
