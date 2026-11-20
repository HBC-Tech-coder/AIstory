-- Forward-only hardening for the production identity, billing, administrator
-- and anonymous-claim control plane.
--
-- This migration intentionally leaves public.stories and its authenticated
-- upsert RPC untouched. Browser roles receive no direct mutation privilege on
-- sensitive control-plane tables. All business mutations remain confined to
-- the allowlisted SECURITY DEFINER RPCs below.

do $$
declare
  required_relation text;
  required_function text;
begin
  foreach required_relation in array array[
    'public.app_users',
    'public.phone_identities',
    'public.phone_otp_challenges',
    'public.credit_accounts',
    'public.credit_ledger',
    'public.billing_policies',
    'public.user_roles',
    'public.admin_audit_logs',
    'public.anonymous_subject_bindings',
    'public.anonymous_subject_claims',
    'public.anonymous_story_claims',
    'public.anonymous_public_cache_claims',
    'public.user_experiment_assignments',
    'public.identity_audit_logs'
  ]
  loop
    if to_regclass(required_relation) is null then
      raise exception 'required production gate relation is missing';
    end if;
  end loop;

  foreach required_function in array array[
    'public.aistory_admin_apply_mutation(jsonb,jsonb)',
    'public.aistory_admin_adjust_credits(jsonb)',
    'public.aistory_reserve_credits(jsonb)',
    'public.aistory_append_billing_terminal(jsonb)',
    'public.aistory_verify_phone_register_and_claim(jsonb)'
  ]
  loop
    if to_regprocedure(required_function) is null then
      raise exception 'required production gate function is missing';
    end if;
  end loop;
end;
$$;

-- Defense in depth against a future accidental GRANT. SECURITY DEFINER RPCs
-- execute as their owner and remain able to perform their allowlisted writes;
-- direct browser/service-role table mutations are rejected.
create or replace function public.aistory_reject_direct_sensitive_write()
returns trigger
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
begin
  if current_user in ('anon', 'authenticated', 'service_role') then
    raise exception 'direct sensitive table mutation forbidden';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.aistory_reject_direct_sensitive_write()
from public, anon, authenticated, service_role;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'tenants',
    'profiles',
    'user_roles',
    'credit_accounts',
    'credit_ledger',
    'payment_provider_configs',
    'payment_orders',
    'payment_transactions',
    'refunds',
    'webhook_events',
    'platform_settings',
    'domain_bindings',
    'channel_apps',
    'integrations',
    'api_clients',
    'outbound_webhooks',
    'admin_audit_logs',
    'admin_bootstrap_allowlist',
    'platform_provider_configs',
    'billing_policies',
    'app_users',
    'phone_identities',
    'phone_otp_challenges',
    'aistory_schema_gates',
    'anonymous_subject_bindings',
    'anonymous_subject_claims',
    'anonymous_story_claims',
    'anonymous_public_cache_claims',
    'user_experiment_assignments',
    'identity_audit_logs'
  ]
  loop
    execute format(
      'drop trigger if exists aistory_reject_direct_sensitive_write on public.%I',
      table_name
    );
    execute format(
      'create trigger aistory_reject_direct_sensitive_write '
      'before insert or update or delete on public.%I '
      'for each row execute function public.aistory_reject_direct_sensitive_write()',
      table_name
    );
  end loop;
end;
$$;

-- Every control-plane table is explicitly RLS-enabled and forced. Existing
-- broad policies are removed below; the only browser-readable projection is
-- the authenticated subject's own role row, required by admin authentication.
do $$
declare
  table_name text;
  policy_name text;
begin
  foreach table_name in array array[
    'tenants',
    'profiles',
    'user_roles',
    'credit_accounts',
    'credit_ledger',
    'play_sessions',
    'gameplay_events',
    'payment_provider_configs',
    'payment_orders',
    'payment_transactions',
    'refunds',
    'webhook_events',
    'platform_settings',
    'domain_bindings',
    'channel_apps',
    'integrations',
    'api_clients',
    'outbound_webhooks',
    'admin_audit_logs',
    'admin_bootstrap_allowlist',
    'platform_provider_configs',
    'billing_policies',
    'app_users',
    'phone_identities',
    'phone_otp_challenges',
    'aistory_schema_gates',
    'anonymous_subject_bindings',
    'anonymous_subject_claims',
    'anonymous_story_claims',
    'anonymous_public_cache_claims',
    'user_experiment_assignments',
    'identity_audit_logs'
  ]
  loop
    execute format('alter table public.%I enable row level security', table_name);
    execute format('alter table public.%I force row level security', table_name);
    execute format(
      'revoke all privileges on table public.%I from public, anon, authenticated',
      table_name
    );
    for policy_name in
      select policyname
      from pg_catalog.pg_policies
      where schemaname = 'public' and tablename = table_name
    loop
      execute format(
        'drop policy %I on public.%I',
        policy_name,
        table_name
      );
    end loop;
  end loop;
end;
$$;

create policy user_roles_select_own
on public.user_roles
for select
to authenticated
using (
  auth.uid() is not null
  and user_id = auth.uid()
);

grant select on table public.user_roles to authenticated;

-- These reads are used only by server-side repositories. Browser roles have
-- no direct access, and direct writes to these tables remain RPC-only.
grant select on table
  public.tenants,
  public.profiles,
  public.user_roles,
  public.credit_accounts,
  public.credit_ledger,
  public.play_sessions,
  public.gameplay_events,
  public.payment_provider_configs,
  public.payment_orders,
  public.payment_transactions,
  public.refunds,
  public.webhook_events,
  public.platform_settings,
  public.domain_bindings,
  public.channel_apps,
  public.integrations,
  public.api_clients,
  public.outbound_webhooks,
  public.admin_audit_logs,
  public.admin_bootstrap_allowlist,
  public.platform_provider_configs,
  public.billing_policies
to service_role;

revoke insert, update, delete on table
  public.tenants,
  public.profiles,
  public.user_roles,
  public.credit_accounts,
  public.credit_ledger,
  public.payment_provider_configs,
  public.payment_orders,
  public.payment_transactions,
  public.refunds,
  public.webhook_events,
  public.platform_settings,
  public.domain_bindings,
  public.channel_apps,
  public.integrations,
  public.api_clients,
  public.outbound_webhooks,
  public.admin_audit_logs,
  public.admin_bootstrap_allowlist,
  public.platform_provider_configs,
  public.billing_policies,
  public.app_users,
  public.phone_identities,
  public.phone_otp_challenges,
  public.aistory_schema_gates,
  public.anonymous_subject_bindings,
  public.anonymous_subject_claims,
  public.anonymous_story_claims,
  public.anonymous_public_cache_claims,
  public.user_experiment_assignments,
  public.identity_audit_logs
from service_role;

-- New objects created by this migration owner start fail-closed. Product-owned
-- public story policies/functions are deliberately not changed here.
alter default privileges in schema public
revoke all on tables from public, anon, authenticated;
alter default privileges in schema public
revoke execute on functions from public, anon, authenticated;

-- The old helper used a mutable search_path and is no longer exposed directly.
alter function public.has_admin_role(text[])
set search_path = pg_catalog, public;
revoke all on function public.has_admin_role(text[])
from public, anon, authenticated, service_role;

-- Wrap the previous allowlisted mutation implementation with an explicit
-- actor/tenant boundary. The legacy implementation remains server-internal
-- and still performs the mutation plus append-only audit in one transaction.
alter function public.aistory_admin_apply_mutation(jsonb, jsonb)
rename to aistory_admin_apply_mutation_v1_legacy;
alter function public.aistory_admin_apply_mutation_v1_legacy(jsonb, jsonb)
set search_path = pg_catalog, public;
revoke all on function
public.aistory_admin_apply_mutation_v1_legacy(jsonb, jsonb)
from public, anon, authenticated, service_role;

create function public.aistory_admin_apply_mutation(
  mutation jsonb,
  audit jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  payload jsonb := mutation->'payload';
  actor_user_id uuid;
  audit_tenant text := nullif(audit->>'tenant_id', '');
  payload_tenant text := nullif(payload->>'tenantId', '');
begin
  if jsonb_typeof(mutation) <> 'object'
    or jsonb_typeof(payload) <> 'object'
    or jsonb_typeof(audit) <> 'object'
    or audit_tenant is null
    or payload_tenant is null
    or payload_tenant <> audit_tenant then
    raise exception 'admin mutation tenant mismatch';
  end if;

  begin
    actor_user_id := (audit->>'actor_id')::uuid;
  exception when others then
    raise exception 'admin mutation forbidden';
  end;

  if not exists (
    select 1
    from public.user_roles
    where user_id = actor_user_id
      and tenant_id = audit_tenant
      and role in (
        'super_admin', 'ops', 'finance', 'moderator', 'support', 'analyst'
      )
  ) then
    raise exception 'admin mutation forbidden';
  end if;

  return public.aistory_admin_apply_mutation_v1_legacy(mutation, audit);
end;
$$;

-- Reassert a minimal RPC surface. PUBLIC privileges are inherited, so every
-- allowlisted function is first revoked from all browser/service roles.
revoke all on function public.aistory_database_gate_status()
from public, anon, authenticated, service_role;
revoke all on function public.aistory_validate_phone_session(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_create_phone_challenge(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_mark_phone_challenge_sent(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_invalidate_phone_challenge(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_verify_phone_and_register(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_verify_phone_register_and_claim(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_get_anonymous_claim_receipt(text, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_admin_adjust_credits(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_admin_apply_mutation(jsonb, jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_reserve_credits(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_append_billing_terminal(jsonb)
from public, anon, authenticated, service_role;

grant execute on function public.aistory_database_gate_status()
to service_role;
grant execute on function public.aistory_validate_phone_session(uuid)
to service_role;
grant execute on function public.aistory_create_phone_challenge(jsonb)
to service_role;
grant execute on function public.aistory_mark_phone_challenge_sent(uuid)
to service_role;
grant execute on function public.aistory_invalidate_phone_challenge(uuid)
to service_role;
grant execute on function public.aistory_verify_phone_and_register(jsonb)
to service_role;
grant execute on function public.aistory_verify_phone_register_and_claim(jsonb)
to service_role;
grant execute on function
public.aistory_get_anonymous_claim_receipt(text, uuid)
to service_role;
grant execute on function public.aistory_admin_adjust_credits(jsonb)
to service_role;
grant execute on function public.aistory_admin_apply_mutation(jsonb, jsonb)
to service_role;
grant execute on function public.aistory_reserve_credits(jsonb)
to service_role;
grant execute on function public.aistory_append_billing_terminal(jsonb)
to service_role;

revoke all on function public.bootstrap_super_admin(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.bootstrap_super_admin(uuid, text)
to authenticated;

-- The application checks both the version and this database-owned posture.
-- A version string alone cannot certify that GRANT/RLS state is safe.
create or replace function public.aistory_database_security_posture()
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  table_name text;
  row_security_enabled boolean;
  row_security_forced boolean;
begin
  foreach table_name in array array[
    'tenants',
    'profiles',
    'user_roles',
    'credit_accounts',
    'credit_ledger',
    'play_sessions',
    'gameplay_events',
    'payment_provider_configs',
    'payment_orders',
    'payment_transactions',
    'refunds',
    'webhook_events',
    'platform_settings',
    'domain_bindings',
    'channel_apps',
    'integrations',
    'api_clients',
    'outbound_webhooks',
    'admin_audit_logs',
    'admin_bootstrap_allowlist',
    'platform_provider_configs',
    'billing_policies',
    'app_users',
    'phone_identities',
    'phone_otp_challenges',
    'aistory_schema_gates',
    'anonymous_subject_bindings',
    'anonymous_subject_claims',
    'anonymous_story_claims',
    'anonymous_public_cache_claims',
    'user_experiment_assignments',
    'identity_audit_logs'
  ]
  loop
    select c.relrowsecurity, c.relforcerowsecurity
    into row_security_enabled, row_security_forced
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = table_name;
    if not found
      or not row_security_enabled
      or not row_security_forced then
      return false;
    end if;
  end loop;

  foreach table_name in array array[
    'tenants',
    'profiles',
    'credit_accounts',
    'credit_ledger',
    'play_sessions',
    'gameplay_events',
    'payment_provider_configs',
    'payment_orders',
    'payment_transactions',
    'refunds',
    'webhook_events',
    'platform_settings',
    'domain_bindings',
    'channel_apps',
    'integrations',
    'api_clients',
    'outbound_webhooks',
    'admin_audit_logs',
    'admin_bootstrap_allowlist',
    'platform_provider_configs',
    'billing_policies',
    'app_users',
    'phone_identities',
    'phone_otp_challenges',
    'aistory_schema_gates',
    'anonymous_subject_bindings',
    'anonymous_subject_claims',
    'anonymous_story_claims',
    'anonymous_public_cache_claims',
    'user_experiment_assignments',
    'identity_audit_logs'
  ]
  loop
    if has_table_privilege('anon', format('public.%I', table_name), 'SELECT')
      or has_table_privilege(
        'authenticated', format('public.%I', table_name), 'SELECT'
      )
      or has_table_privilege('anon', format('public.%I', table_name), 'INSERT')
      or has_table_privilege(
        'authenticated', format('public.%I', table_name), 'INSERT'
      )
      or has_table_privilege('anon', format('public.%I', table_name), 'UPDATE')
      or has_table_privilege(
        'authenticated', format('public.%I', table_name), 'UPDATE'
      )
      or has_table_privilege('anon', format('public.%I', table_name), 'DELETE')
      or has_table_privilege(
        'authenticated', format('public.%I', table_name), 'DELETE'
      ) then
      return false;
    end if;
  end loop;

  if has_table_privilege('anon', 'public.user_roles', 'SELECT')
    or not has_table_privilege(
      'authenticated', 'public.user_roles', 'SELECT'
    )
    or has_table_privilege('anon', 'public.user_roles', 'INSERT')
    or has_table_privilege('authenticated', 'public.user_roles', 'INSERT')
    or has_table_privilege('anon', 'public.user_roles', 'UPDATE')
    or has_table_privilege('authenticated', 'public.user_roles', 'UPDATE')
    or has_table_privilege('anon', 'public.user_roles', 'DELETE')
    or has_table_privilege('authenticated', 'public.user_roles', 'DELETE') then
    return false;
  end if;

  foreach table_name in array array[
    'tenants',
    'profiles',
    'user_roles',
    'credit_accounts',
    'credit_ledger',
    'payment_provider_configs',
    'payment_orders',
    'payment_transactions',
    'refunds',
    'webhook_events',
    'platform_settings',
    'domain_bindings',
    'channel_apps',
    'integrations',
    'api_clients',
    'outbound_webhooks',
    'admin_audit_logs',
    'admin_bootstrap_allowlist',
    'platform_provider_configs',
    'billing_policies',
    'app_users',
    'phone_identities',
    'phone_otp_challenges',
    'aistory_schema_gates',
    'anonymous_subject_bindings',
    'anonymous_subject_claims',
    'anonymous_story_claims',
    'anonymous_public_cache_claims',
    'user_experiment_assignments',
    'identity_audit_logs'
  ]
  loop
    if has_table_privilege(
      'service_role', format('public.%I', table_name), 'INSERT'
    )
      or has_table_privilege(
        'service_role', format('public.%I', table_name), 'UPDATE'
      )
      or has_table_privilege(
        'service_role', format('public.%I', table_name), 'DELETE'
      ) then
      return false;
    end if;
  end loop;

  if has_function_privilege(
      'anon', 'public.aistory_admin_adjust_credits(jsonb)', 'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.aistory_admin_adjust_credits(jsonb)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.aistory_admin_apply_mutation(jsonb,jsonb)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.aistory_admin_apply_mutation(jsonb,jsonb)',
      'EXECUTE'
    )
    or has_function_privilege(
      'anon',
      'public.aistory_verify_phone_register_and_claim(jsonb)',
      'EXECUTE'
    )
    or has_function_privilege(
      'authenticated',
      'public.aistory_verify_phone_register_and_claim(jsonb)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.aistory_admin_adjust_credits(jsonb)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.aistory_admin_apply_mutation(jsonb,jsonb)',
      'EXECUTE'
    )
    or not has_function_privilege(
      'service_role',
      'public.aistory_verify_phone_register_and_claim(jsonb)',
      'EXECUTE'
    ) then
    return false;
  end if;

  return true;
end;
$$;

revoke all on function public.aistory_database_security_posture()
from public, anon, authenticated, service_role;
grant execute on function public.aistory_database_security_posture()
to service_role;

-- Advance the database-owned gate only after every hardening statement and
-- posture function above has completed successfully.
insert into public.aistory_schema_gates (gate_name, version)
values ('production_identity_billing', '20260731120000')
on conflict (gate_name) do update
set version = excluded.version,
    installed_at = now();
