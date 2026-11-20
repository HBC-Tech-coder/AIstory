-- Forward-only, default-off AIUser linked-phone billing resolver.
-- It reads the already committed one-to-one link mapping and an active phone
-- account only. It never links, grants credits, changes identity class, or
-- enables Hosted BYOK, cloud-progress or administrator behavior.
set local search_path = pg_catalog;
set local check_function_bodies = on;

do $preflight$
begin
  if current_user <> 'postgres' or session_user <> 'postgres'
    or not exists(select 1 from pg_roles where oid='postgres'::regrole and (rolsuper or rolbypassrls)) then
    raise exception 'LINKED_BILLING_GATE_UNAVAILABLE' using errcode='55000'; end if;
  if to_regclass('public.aistory_schema_gates') is null
    or to_regclass('public.app_users') is null
    or to_regclass('public.aiuser_account_links') is null then
    raise exception 'LINKED_BILLING_GATE_UNAVAILABLE' using errcode='55000'; end if;
  if to_regprocedure('public.aistory_database_gate_status()') is null then
    raise exception 'LINKED_BILLING_GATE_UNAVAILABLE' using errcode='55000'; end if;
  if public.aistory_database_gate_status() is distinct from '20260811193000' then
    raise exception 'LINKED_BILLING_GATE_UNAVAILABLE' using errcode='55000'; end if;
  if to_regprocedure('public.aistory_aiuser_link_posture()') is null then
    raise exception 'LINKED_BILLING_GATE_UNAVAILABLE' using errcode='55000'; end if;
  if public.aistory_aiuser_link_posture() is distinct from '20260901040000'
    or (select version from public.aistory_schema_gates where gate_name='aiuser_account_link') is distinct from '20260901040000' then
    raise exception 'LINKED_BILLING_GATE_UNAVAILABLE' using errcode='55000'; end if;
  if exists(select 1 from public.aistory_schema_gates where gate_name='aiuser_linked_billing')
    or to_regclass('public.aiuser_linked_billing_catalog_manifest') is not null
    or to_regprocedure('public.aistory_aiuser_linked_billing_resolve(text)') is not null
    or to_regprocedure('public.aistory_aiuser_linked_billing_posture()') is not null
    or to_regprocedure('public.aistory_aiuser_linked_billing_catalog()') is not null
    or to_regprocedure('public.aistory_aiuser_linked_billing_immutable()') is not null then
    raise exception 'LINKED_BILLING_GATE_UNAVAILABLE' using errcode='55000'; end if;
end;
$preflight$;

-- Immutable catalog commitment for the resolver's exact body and function ACL.
-- Mechanical posture below additionally checks security properties that are not
-- part of pg_get_functiondef (owner, volatility, security definer, EXECUTE ACL).
create table public.aiuser_linked_billing_catalog_manifest (
  object_key text not null,
  definition_sha256 text not null,
  constraint aiuser_linked_billing_catalog_manifest_pkey primary key(object_key),
  constraint aiuser_linked_billing_catalog_manifest_shape_check check(
    object_key collate "C" ~ '^(function|acl):[ -~]+$'
    and char_length(object_key)-strpos(object_key,':') between 1 and 300
    and definition_sha256 ~ '^[a-f0-9]{64}$')
);
alter table public.aiuser_linked_billing_catalog_manifest enable row level security;
alter table public.aiuser_linked_billing_catalog_manifest force row level security;
revoke all on public.aiuser_linked_billing_catalog_manifest from public,anon,authenticated,service_role;

create function public.aistory_aiuser_linked_billing_immutable() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin raise exception 'LINKED_BILLING_IMMUTABLE' using errcode='42501'; end;
$$;
revoke all on function public.aistory_aiuser_linked_billing_immutable() from public,anon,authenticated,service_role;
create trigger aiuser_linked_billing_catalog_manifest_immutable
before update or delete or truncate on public.aiuser_linked_billing_catalog_manifest
for each statement execute function public.aistory_aiuser_linked_billing_immutable();

-- Stub permits check_function_bodies=on while the resolver references posture.
-- The real definition replaces this function without changing its OID.
create function public.aistory_aiuser_linked_billing_posture() returns text
language plpgsql stable security definer set search_path=pg_catalog as $$begin return null; end;$$;

-- Service-role-only resolver. The browser never calls this RPC, never supplies
-- the phone UUID and never receives the returned UUID.
create function public.aistory_aiuser_linked_billing_resolve(principal_hash text) returns uuid
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_phone_user_id uuid;
begin
  if current_setting('request.jwt.claim.role',true) is distinct from 'service_role'
    or public.aistory_aiuser_linked_billing_posture() is distinct from '20261115000000'
    or principal_hash is null or principal_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'LINKED_BILLING_UNAVAILABLE' using errcode='42501'; end if;
  select u.id into v_phone_user_id
    from public.aiuser_account_links l
    join public.app_users u on u.id=l.phone_user_id
    join public.phone_identities p on p.user_id=u.id
    where l.principal_hash=$1
      and l.tenant_id='platform'
      and u.tenant_id='platform'
      and u.identity_type='phone'
      and u.status='active';
  if v_phone_user_id is null then return null; end if;
  return v_phone_user_id;
end;
$$;

create function public.aistory_aiuser_linked_billing_catalog()
returns table(object_key text,definition_sha256 text)
language sql set search_path=pg_catalog as $$
  with billing_functions(oid) as (values
    ('public.aistory_aiuser_linked_billing_immutable()'::regprocedure),
    ('public.aistory_aiuser_linked_billing_posture()'::regprocedure),
    ('public.aistory_aiuser_linked_billing_resolve(text)'::regprocedure),
    ('public.aistory_aiuser_linked_billing_catalog()'::regprocedure))
  select 'function:'||p.oid::regprocedure::text,
    encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')
    from pg_proc p where p.oid in (select oid from billing_functions)
  union all
  select 'acl:'||p.oid::regprocedure::text,
    encode(sha256(convert_to(coalesce((
      select jsonb_agg(jsonb_build_array(a.grantee::text,a.privilege_type,a.is_grantable)
        order by a.grantee::text,a.privilege_type,a.is_grantable)
      from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a),'[]'::jsonb)::text,'UTF8')),'hex')
    from pg_proc p where p.oid in (select oid from billing_functions);
$$;
revoke all on function public.aistory_aiuser_linked_billing_catalog() from public,anon,authenticated,service_role;

create or replace function public.aistory_aiuser_linked_billing_posture() returns text
language plpgsql stable security definer set search_path=pg_catalog as $$
declare v_table oid; v_function oid; v_columns text[];
begin
  if current_setting('request.jwt.claim.role',true) is distinct from 'service_role' and session_user <> 'postgres' then return null; end if;
  if not exists(select 1 from pg_roles where oid='postgres'::regrole and (rolsuper or rolbypassrls))
    or public.aistory_aiuser_link_posture() is distinct from '20260901040000'
    or public.aistory_database_gate_status() is distinct from '20260811193000'
    or (select version from public.aistory_schema_gates where gate_name='aiuser_linked_billing') is distinct from '20261115000000' then return null; end if;
  v_table:='public.aiuser_linked_billing_catalog_manifest'::regclass;
  if not exists(select 1 from pg_class where oid=v_table and relkind='r' and relpersistence='p'
      and relrowsecurity and relforcerowsecurity and relowner='postgres'::regrole)
    or exists(select 1 from pg_policy where polrelid=v_table)
    or exists(select 1 from pg_rewrite where ev_class=v_table)
    or exists(select 1 from pg_class c, lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
      where c.oid=v_table and a.grantee <> 'postgres'::regrole)
    or exists(select 1 from pg_attribute a, lateral aclexplode(a.attacl) x
      where a.attrelid=v_table and x.grantee <> 'postgres'::regrole)
    or (select count(*) from pg_trigger where tgrelid=v_table and not tgisinternal) <> 1
    or not exists(select 1 from pg_trigger where tgrelid=v_table and not tgisinternal and tgenabled='O'
      and tgfoid='public.aistory_aiuser_linked_billing_immutable()'::regprocedure and tgtype=58) then return null; end if;
  select array_agg(attname::text||':'||format_type(atttypid,atttypmod)||':'||attnotnull::text order by attnum)
    into v_columns from pg_attribute where attrelid=v_table and attnum>0 and not attisdropped;
  if v_columns is distinct from array['object_key:text:true','definition_sha256:text:true'] then return null; end if;
  if (select count(*) from pg_proc where pronamespace='public'::regnamespace
      and proname in ('aistory_aiuser_linked_billing_resolve','aistory_aiuser_linked_billing_posture',
        'aistory_aiuser_linked_billing_catalog','aistory_aiuser_linked_billing_immutable')) <> 4 then return null; end if;
  foreach v_function in array array['public.aistory_aiuser_linked_billing_immutable()'::regprocedure,
    'public.aistory_aiuser_linked_billing_posture()'::regprocedure,
    'public.aistory_aiuser_linked_billing_resolve(text)'::regprocedure,
    'public.aistory_aiuser_linked_billing_catalog()'::regprocedure] loop
    if not exists(select 1 from pg_proc where oid=v_function and proowner='postgres'::regrole
      and proconfig=array['search_path=pg_catalog'] and not proleakproof
      and prosecdef=(v_function in ('public.aistory_aiuser_linked_billing_posture()'::regprocedure,
        'public.aistory_aiuser_linked_billing_resolve(text)'::regprocedure))
      and ((v_function in ('public.aistory_aiuser_linked_billing_posture()'::regprocedure,
          'public.aistory_aiuser_linked_billing_resolve(text)'::regprocedure)) and provolatile='s'
        or (v_function not in ('public.aistory_aiuser_linked_billing_posture()'::regprocedure,
          'public.aistory_aiuser_linked_billing_resolve(text)'::regprocedure)) and provolatile='v'))
      or exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where p.oid=v_function and a.grantee not in ('postgres'::regrole,'service_role'::regrole)) then return null; end if;
    if v_function in ('public.aistory_aiuser_linked_billing_posture()'::regprocedure,
      'public.aistory_aiuser_linked_billing_resolve(text)'::regprocedure) then
      if not has_function_privilege('service_role',v_function,'EXECUTE') then return null; end if;
    elsif has_function_privilege('service_role',v_function,'EXECUTE') then return null; end if;
  end loop;
  if not exists(select 1 from pg_proc where oid='public.aistory_aiuser_linked_billing_resolve(text)'::regprocedure
      and pronargs=1 and proargtypes[0]='text'::regtype and prorettype='uuid'::regtype and not proretset and prokind='f')
    or not exists(select 1 from pg_proc where oid='public.aistory_aiuser_linked_billing_posture()'::regprocedure
      and pronargs=0 and prorettype='text'::regtype and prokind='f')
    or not exists(select 1 from pg_proc where oid='public.aistory_aiuser_linked_billing_catalog()'::regprocedure
      and pronargs=0 and proretset and prokind='f')
    or not exists(select 1 from pg_proc where oid='public.aistory_aiuser_linked_billing_immutable()'::regprocedure
      and pronargs=0 and prorettype='trigger'::regtype and prokind='f') then return null; end if;
  if exists(
    (select object_key,definition_sha256 from public.aistory_aiuser_linked_billing_catalog()
      except select object_key,definition_sha256 from public.aiuser_linked_billing_catalog_manifest)
    union all
    (select object_key,definition_sha256 from public.aiuser_linked_billing_catalog_manifest
      except select object_key,definition_sha256 from public.aistory_aiuser_linked_billing_catalog())
  ) then return null; end if;
  return '20261115000000';
exception when others then return null;
end;
$$;

revoke all on function public.aistory_aiuser_linked_billing_posture(),
  public.aistory_aiuser_linked_billing_resolve(text) from public,anon,authenticated,service_role;
grant execute on function public.aistory_aiuser_linked_billing_posture(),
  public.aistory_aiuser_linked_billing_resolve(text) to service_role;

insert into public.aiuser_linked_billing_catalog_manifest(object_key,definition_sha256)
select object_key,definition_sha256 from public.aistory_aiuser_linked_billing_catalog();
insert into public.aistory_schema_gates(gate_name,version) values('aiuser_linked_billing','20261115000000');

do $postflight$
begin
  if public.aistory_aiuser_linked_billing_posture() is distinct from '20261115000000'
    or public.aistory_aiuser_link_posture() is distinct from '20260901040000'
    or public.aistory_database_gate_status() is distinct from '20260811193000' then
    raise exception 'LINKED_BILLING_POSTURE_FAILED' using errcode='55000'; end if;
end;
$postflight$;
