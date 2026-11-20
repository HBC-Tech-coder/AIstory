-- Production administrator identity and read-plane RPC gate.
--
-- Browser roles never read control-plane tables through this migration. The
-- authenticated Supabase session proves only the subject UUID; a server-side
-- service-role RPC resolves roles and projects a bounded, tenant-scoped admin
-- snapshot. Product account/billing reads use a smaller service RPC.

create or replace function public.aistory_admin_resolve_actor(
  actor_user_id uuid,
  actor_tenant text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  resolved_roles jsonb;
begin
  if actor_user_id is null
    or actor_tenant is null
    or length(actor_tenant) not between 1 and 80 then
    raise exception 'admin actor invalid';
  end if;

  select coalesce(jsonb_agg(role order by role), '[]'::jsonb)
  into resolved_roles
  from public.user_roles
  where user_id = actor_user_id and tenant_id = actor_tenant;

  if jsonb_array_length(resolved_roles) = 0 then
    return null;
  end if;

  return jsonb_build_object(
    'user_id', actor_user_id,
    'tenant_id', actor_tenant,
    'roles', resolved_roles
  );
end;
$$;

create or replace function public.aistory_admin_read_snapshot(
  actor_user_id uuid,
  actor_tenant text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  allowed_roles text[] := array[
    'super_admin', 'ops', 'finance', 'moderator', 'support', 'analyst'
  ];
begin
  if actor_user_id is null
    or actor_tenant is null
    or length(actor_tenant) not between 1 and 80
    or not exists (
      select 1
      from public.user_roles
      where user_id = actor_user_id
        and tenant_id = actor_tenant
        and role = any(allowed_roles)
    ) then
    raise exception 'admin read forbidden';
  end if;

  return jsonb_build_object(
    'users', (
      select coalesce(
        jsonb_agg(to_jsonb(item) order by item.created_at desc),
        '[]'::jsonb
      )
      from (
        select *
        from public.profiles
        where tenant_id = actor_tenant
        order by created_at desc
        limit 1000
      ) item
    ),
    'roles', (
      select coalesce(
        jsonb_agg(to_jsonb(item) order by item.created_at desc),
        '[]'::jsonb
      )
      from (
        select *
        from public.user_roles
        where tenant_id = actor_tenant
        order by created_at desc
        limit 2000
      ) item
    ),
    'accounts', (
      select coalesce(
        jsonb_agg(to_jsonb(item) order by item.created_at desc),
        '[]'::jsonb
      )
      from (
        select *
        from public.credit_accounts
        where tenant_id = actor_tenant
        order by created_at desc
        limit 1000
      ) item
    ),
    'ledger', (
      select coalesce(
        jsonb_agg(to_jsonb(item) order by item.created_at desc),
        '[]'::jsonb
      )
      from (
        select *
        from public.credit_ledger
        where tenant_id = actor_tenant
        order by created_at desc
        limit 5000
      ) item
    ),
    'events', (
      select coalesce(
        jsonb_agg(to_jsonb(item) order by item.created_at desc),
        '[]'::jsonb
      )
      from (
        select *
        from public.gameplay_events
        where tenant_id = actor_tenant
        order by created_at desc
        limit 5000
      ) item
    ),
    'settings', (
      select coalesce(
        jsonb_agg(to_jsonb(item) order by item.version desc),
        '[]'::jsonb
      )
      from (
        select *
        from public.platform_settings
        where tenant_id in ('platform', actor_tenant)
        order by version desc
        limit 200
      ) item
    ),
    'payment_configs', (
      select coalesce(
        jsonb_agg(to_jsonb(item) order by item.updated_at desc),
        '[]'::jsonb
      )
      from (
        select *
        from public.payment_provider_configs
        where tenant_id = actor_tenant
        order by updated_at desc
        limit 200
      ) item
    ),
    'provider_configs', (
      select coalesce(
        jsonb_agg(to_jsonb(item) order by item.updated_at desc),
        '[]'::jsonb
      )
      from (
        select *
        from public.platform_provider_configs
        where tenant_id = actor_tenant
        order by updated_at desc
        limit 200
      ) item
    ),
    'domains', (
      select coalesce(
        jsonb_agg(to_jsonb(item) order by item.updated_at desc),
        '[]'::jsonb
      )
      from (
        select *
        from public.domain_bindings
        where tenant_id = actor_tenant
        order by updated_at desc
        limit 500
      ) item
    ),
    'channel_apps', (
      select coalesce(
        jsonb_agg(to_jsonb(item) order by item.updated_at desc),
        '[]'::jsonb
      )
      from (
        select
          id, tenant_id, channel_id, kind, name, status, version,
          auth_methods, payment_providers, redirect_uris, cors_origins,
          scopes, rate_limit_per_minute, client_id,
          webhook_secret_reference, model_daily_budget, content_policy,
          updated_at
        from public.channel_apps
        where tenant_id = actor_tenant
        order by updated_at desc
        limit 500
      ) item
    ),
    'audit', (
      select coalesce(
        jsonb_agg(to_jsonb(item) order by item.created_at desc),
        '[]'::jsonb
      )
      from (
        select *
        from public.admin_audit_logs
        where tenant_id = actor_tenant
        order by created_at desc
        limit 2000
      ) item
    ),
    'billing_policies', (
      select coalesce(
        jsonb_agg(to_jsonb(item) order by item.updated_at desc),
        '[]'::jsonb
      )
      from (
        select *
        from public.billing_policies
        where tenant_id = actor_tenant
        order by updated_at desc
        limit 100
      ) item
    )
  );
end;
$$;

create or replace function public.aistory_service_read_dataset(
  target_tenant text,
  dataset text,
  subject_user_id uuid default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  result jsonb;
begin
  if target_tenant is null or length(target_tenant) not between 1 and 80 then
    raise exception 'service read invalid';
  end if;

  if dataset = 'user' then
    if subject_user_id is null then raise exception 'service read invalid'; end if;
    select coalesce(jsonb_agg(to_jsonb(item)), '[]'::jsonb)
    into result
    from (
      select * from public.profiles
      where tenant_id = target_tenant and user_id = subject_user_id
      limit 1
    ) item;
  elsif dataset = 'account' then
    if subject_user_id is null then raise exception 'service read invalid'; end if;
    select coalesce(jsonb_agg(to_jsonb(item)), '[]'::jsonb)
    into result
    from (
      select * from public.credit_accounts
      where tenant_id = target_tenant and user_id = subject_user_id
      limit 1
    ) item;
  elsif dataset = 'ledger' then
    if subject_user_id is null then raise exception 'service read invalid'; end if;
    select coalesce(
      jsonb_agg(to_jsonb(item) order by item.created_at desc),
      '[]'::jsonb
    )
    into result
    from (
      select * from public.credit_ledger
      where tenant_id = target_tenant and user_id = subject_user_id
      order by created_at desc
      limit 2000
    ) item;
  elsif dataset = 'settings' then
    select coalesce(
      jsonb_agg(to_jsonb(item) order by item.version desc),
      '[]'::jsonb
    )
    into result
    from (
      select * from public.platform_settings
      where tenant_id in ('platform', target_tenant)
      order by version desc
      limit 200
    ) item;
  elsif dataset = 'billing_policy' then
    select coalesce(
      jsonb_agg(to_jsonb(item) order by item.updated_at desc),
      '[]'::jsonb
    )
    into result
    from (
      select * from public.billing_policies
      where tenant_id = target_tenant
      order by updated_at desc
      limit 100
    ) item;
  else
    raise exception 'service dataset forbidden';
  end if;

  return result;
end;
$$;

-- Recreate bootstrap with deterministic replay semantics. A browser-authenticated
-- subject still needs both the deployment env allowlist and this one-shot DB row.
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
  existing_audit public.admin_audit_logs%rowtype;
begin
  if auth.uid() is null or auth.uid() <> bootstrap_user_id then
    raise exception 'bootstrap identity mismatch';
  end if;
  if length(bootstrap_request_id) not between 8 and 200 then
    raise exception 'bootstrap request invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(bootstrap_user_id::text, 0)
  );

  select * into allowed
  from public.admin_bootstrap_allowlist
  where user_id = bootstrap_user_id
  for update;
  if not found then raise exception 'bootstrap unavailable'; end if;

  select * into existing_audit
  from public.admin_audit_logs
  where tenant_id = 'platform' and request_id = bootstrap_request_id;
  if found then
    if existing_audit.action = 'admin.bootstrap'
      and existing_audit.actor_id = bootstrap_user_id
      and existing_audit.target_id = bootstrap_user_id::text
      and allowed.used_request_id = bootstrap_request_id
      and exists (
        select 1 from public.user_roles
        where user_id = bootstrap_user_id
          and tenant_id = 'platform'
          and role = 'super_admin'
      ) then
      return true;
    end if;
    raise exception 'bootstrap idempotency conflict';
  end if;

  if allowed.used_at is not null then raise exception 'bootstrap unavailable'; end if;
  if exists (
    select 1 from public.user_roles
    where tenant_id = 'platform'
      and role = 'super_admin'
      and user_id <> bootstrap_user_id
  ) then
    raise exception 'super admin already exists';
  end if;

  insert into public.user_roles (
    user_id, tenant_id, role, created_by
  ) values (
    bootstrap_user_id, 'platform', 'super_admin', bootstrap_user_id
  )
  on conflict (user_id, tenant_id, role) do nothing;

  update public.admin_bootstrap_allowlist
  set used_at = now(), used_request_id = bootstrap_request_id
  where user_id = bootstrap_user_id;

  insert into public.admin_audit_logs (
    tenant_id, actor_id, actor_roles, action, target_type,
    target_id, reason, request_id
  ) values (
    'platform', bootstrap_user_id, array['super_admin'],
    'admin.bootstrap', 'user_role', bootstrap_user_id::text,
    'one-time production bootstrap', bootstrap_request_id
  );
  return true;
end;
$$;

revoke all on function public.aistory_admin_resolve_actor(uuid, text)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_admin_read_snapshot(uuid, text)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_service_read_dataset(text, text, uuid)
from public, anon, authenticated, service_role;

grant execute on function public.aistory_admin_resolve_actor(uuid, text)
to service_role;
grant execute on function public.aistory_admin_read_snapshot(uuid, text)
to service_role;
grant execute on function public.aistory_service_read_dataset(text, text, uuid)
to service_role;

revoke all on function public.bootstrap_super_admin(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.bootstrap_super_admin(uuid, text)
to authenticated;

create or replace function public.aistory_admin_rpc_security_posture()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    public.aistory_database_security_posture()
    and not has_function_privilege(
      'anon', 'public.aistory_admin_resolve_actor(uuid,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.aistory_admin_resolve_actor(uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon', 'public.aistory_admin_read_snapshot(uuid,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.aistory_admin_read_snapshot(uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon',
      'public.aistory_service_read_dataset(text,text,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.aistory_service_read_dataset(text,text,uuid)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.aistory_admin_resolve_actor(uuid,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.aistory_admin_read_snapshot(uuid,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.aistory_service_read_dataset(text,text,uuid)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'anon', 'public.bootstrap_super_admin(uuid,text)', 'EXECUTE'
    )
    and has_function_privilege(
      'authenticated', 'public.bootstrap_super_admin(uuid,text)', 'EXECUTE'
    );
$$;

revoke all on function public.aistory_admin_rpc_security_posture()
from public, anon, authenticated, service_role;
grant execute on function public.aistory_admin_rpc_security_posture()
to service_role;

insert into public.aistory_schema_gates (gate_name, version)
values ('production_identity_billing', '20260731183000')
on conflict (gate_name) do update
set version = excluded.version,
    installed_at = now();
