-- Phone-session production administrator identity gate.
--
-- Gate12 remains immutable. This forward-only gate lets a stable, verified
-- phone application UUID hold administrator roles without weakening the
-- existing Supabase Auth path. Browser roles still cannot read or mutate the
-- administrator control plane. The first phone super-admin remains a double
-- gate: a deployment environment UUID allowlist plus a one-shot database row.

do $$
declare
  installed_gate text;
begin
  select version into installed_gate
  from public.aistory_schema_gates
  where gate_name = 'production_identity_billing';
  if installed_gate is distinct from '20260802113000' then
    raise exception 'phone admin gate requires gate12';
  end if;
  if not public.aistory_database_security_posture()
    or not public.aistory_admin_rpc_security_posture()
    or not public.aistory_hosted_byok_security_posture() then
    raise exception 'phone admin prerequisite posture unavailable';
  end if;
end;
$$;

-- Every existing Supabase administrator/audit actor must have a matching
-- application identity before the administrator foreign keys move away from
-- auth.users. Gate1 already backfilled ordinary Supabase players; this covers
-- admin-only identities as well.
insert into public.app_users (
  id, tenant_id, identity_type, auth_user_id, status
)
select distinct actor_id, 'platform', 'supabase', actor_id, 'active'
from (
  select user_id as actor_id from public.user_roles
  union
  select created_by as actor_id from public.user_roles
  union
  select actor_id from public.admin_audit_logs
  union
  select user_id as actor_id from public.admin_bootstrap_allowlist
) actor
join auth.users auth_user on auth_user.id = actor.actor_id
where actor.actor_id is not null
on conflict (id) do nothing;

alter table public.user_roles
  drop constraint if exists user_roles_user_id_fkey,
  drop constraint if exists user_roles_user_id_app_user_fkey,
  drop constraint if exists user_roles_created_by_fkey,
  drop constraint if exists user_roles_created_by_app_user_fkey;
alter table public.user_roles
  add constraint user_roles_user_id_app_user_fkey
  foreign key (user_id) references public.app_users (id) on delete cascade
  not valid,
  add constraint user_roles_created_by_app_user_fkey
  foreign key (created_by) references public.app_users (id) on delete set null
  not valid;
alter table public.user_roles
  validate constraint user_roles_user_id_app_user_fkey;
alter table public.user_roles
  validate constraint user_roles_created_by_app_user_fkey;

alter table public.admin_audit_logs
  drop constraint if exists admin_audit_logs_actor_id_fkey,
  drop constraint if exists admin_audit_logs_actor_id_app_user_fkey;
alter table public.admin_audit_logs
  add constraint admin_audit_logs_actor_id_app_user_fkey
  foreign key (actor_id) references public.app_users (id) on delete set null
  not valid;
alter table public.admin_audit_logs
  validate constraint admin_audit_logs_actor_id_app_user_fkey;

alter table public.admin_bootstrap_allowlist
  drop constraint if exists admin_bootstrap_allowlist_user_id_fkey,
  drop constraint if exists admin_bootstrap_allowlist_user_id_app_user_fkey;
alter table public.admin_bootstrap_allowlist
  add constraint admin_bootstrap_allowlist_user_id_app_user_fkey
  foreign key (user_id) references public.app_users (id) on delete cascade
  not valid;
alter table public.admin_bootstrap_allowlist
  validate constraint admin_bootstrap_allowlist_user_id_app_user_fkey;

create or replace function public.aistory_bootstrap_phone_super_admin(
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
  jwt_claims text;
  jwt_role text;
begin
  jwt_claims := nullif(
    pg_catalog.current_setting('request.jwt.claims', true),
    ''
  );
  jwt_role := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    case when jwt_claims is null then null
      else jwt_claims::jsonb->>'role'
    end,
    ''
  );
  if jwt_role <> 'service_role' then
    raise exception 'phone bootstrap service role required';
  end if;
  if bootstrap_user_id is null
    or length(bootstrap_request_id) not between 16 and 200 then
    raise exception 'phone bootstrap request invalid';
  end if;
  if not exists (
    select 1
    from public.app_users app_user
    join public.phone_identities phone_identity
      on phone_identity.user_id = app_user.id
    where app_user.id = bootstrap_user_id
      and app_user.tenant_id = 'platform'
      and app_user.identity_type = 'phone'
      and app_user.status = 'active'
  ) then
    raise exception 'phone bootstrap identity unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(bootstrap_user_id::text, 0)
  );

  select * into allowed
  from public.admin_bootstrap_allowlist
  where user_id = bootstrap_user_id
  for update;
  if not found then raise exception 'phone bootstrap unavailable'; end if;

  select * into existing_audit
  from public.admin_audit_logs
  where tenant_id = 'platform' and request_id = bootstrap_request_id;
  if found then
    if existing_audit.action = 'admin.bootstrap.phone'
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
    raise exception 'phone bootstrap idempotency conflict';
  end if;

  if allowed.used_at is not null then
    raise exception 'phone bootstrap unavailable';
  end if;
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
    'admin.bootstrap.phone', 'user_role', bootstrap_user_id::text,
    'one-time production phone bootstrap', bootstrap_request_id
  );
  return true;
end;
$$;

revoke all on function public.aistory_bootstrap_phone_super_admin(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.aistory_bootstrap_phone_super_admin(uuid, text)
to service_role;

create or replace function public.aistory_phone_admin_security_posture()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    public.aistory_database_security_posture()
    and public.aistory_admin_rpc_security_posture()
    and not has_function_privilege(
      'anon',
      'public.aistory_bootstrap_phone_super_admin(uuid,text)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.aistory_bootstrap_phone_super_admin(uuid,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.aistory_bootstrap_phone_super_admin(uuid,text)',
      'EXECUTE'
    )
    and not has_table_privilege(
      'authenticated', 'public.user_roles', 'INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'authenticated',
      'public.admin_bootstrap_allowlist',
      'INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'service_role',
      'public.admin_bootstrap_allowlist',
      'INSERT,UPDATE,DELETE'
    )
    and (
      select count(*) = 4
      from pg_catalog.pg_constraint constraint_record
      where constraint_record.conname = any(array[
        'user_roles_user_id_app_user_fkey',
        'user_roles_created_by_app_user_fkey',
        'admin_audit_logs_actor_id_app_user_fkey',
        'admin_bootstrap_allowlist_user_id_app_user_fkey'
      ])
        and constraint_record.confrelid = 'public.app_users'::regclass
        and constraint_record.contype = 'f'
        and constraint_record.convalidated
    );
$$;

revoke all on function public.aistory_phone_admin_security_posture()
from public, anon, authenticated, service_role;
grant execute on function public.aistory_phone_admin_security_posture()
to service_role;

insert into public.aistory_schema_gates (gate_name, version)
values ('production_identity_billing', '20260809113000')
on conflict (gate_name) do update
set version = excluded.version,
    installed_at = now();
