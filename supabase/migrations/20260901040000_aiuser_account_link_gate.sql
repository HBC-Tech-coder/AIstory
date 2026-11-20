-- Independent, default-off account association. Never changes phone identities,
-- ledger balances, saves, membership, administrator gates or existing sessions.
set local search_path = pg_catalog;
set local check_function_bodies = on;

do $preflight$
begin
  if current_user <> 'postgres' or session_user <> 'postgres'
    or not exists(select 1 from pg_roles where oid='postgres'::regrole and (rolsuper or rolbypassrls))
    or public.aistory_database_gate_status() is distinct from '20260811193000'
    or exists(select 1 from public.aistory_schema_gates where gate_name='aiuser_account_link')
    or to_regclass('public.aiuser_account_links') is not null
    or to_regclass('public.aiuser_account_link_intents') is not null
    or to_regclass('public.aiuser_account_link_session_revocations') is not null
    or to_regclass('public.aiuser_account_link_audit') is not null
    or to_regclass('public.aiuser_account_link_catalog_manifest') is not null then
    raise exception 'ACCOUNT_LINK_GATE_UNAVAILABLE' using errcode='55000';
  end if;
end;
$preflight$;

create table public.aiuser_account_links (
  principal_hash text not null,
  phone_user_id uuid not null,
  tenant_id text not null default 'platform',
  linked_at timestamptz not null default clock_timestamp(),
  constraint aiuser_account_links_pkey primary key(principal_hash),
  constraint aiuser_account_links_phone_user_id_key unique(phone_user_id),
  constraint aiuser_account_links_phone_user_id_fkey foreign key(phone_user_id)
    references public.app_users(id) on delete restrict,
  constraint aiuser_account_links_shape_check check(
    principal_hash ~ '^[a-f0-9]{64}$' and tenant_id='platform')
);

-- Prepared intents are append-only. Consumption is the matching audit PK row,
-- inserted in the same transaction as the permanent mapping.
create table public.aiuser_account_link_intents (
  intent_hash text not null,
  principal_hash text not null,
  phone_user_id uuid not null,
  aiuser_session_hash text not null,
  phone_session_hash text not null,
  aiuser_verified_at_ms bigint not null,
  phone_verified_at_ms bigint not null,
  aiuser_expires_at_ms bigint not null,
  phone_expires_at_ms bigint not null,
  membership_generation bigint not null,
  intent_created_at_ms bigint not null,
  intent_expires_at_ms bigint not null,
  proof_hash text not null,
  registered_at timestamptz not null default clock_timestamp(),
  constraint aiuser_account_link_intents_pkey primary key(intent_hash),
  constraint aiuser_account_link_intents_phone_user_id_fkey foreign key(phone_user_id)
    references public.app_users(id) on delete restrict,
  constraint aiuser_account_link_intents_shape_check check(
    intent_hash ~ '^[a-f0-9]{64}$' and principal_hash ~ '^[a-f0-9]{64}$'
    and aiuser_session_hash ~ '^[a-f0-9]{64}$' and phone_session_hash ~ '^[a-f0-9]{64}$'
    and proof_hash ~ '^[a-f0-9]{64}$' and membership_generation>0
    and aiuser_verified_at_ms>=0 and phone_verified_at_ms>=0
    and aiuser_expires_at_ms>aiuser_verified_at_ms and phone_expires_at_ms>phone_verified_at_ms
    and intent_created_at_ms>=0 and intent_expires_at_ms>intent_created_at_ms)
);

-- Logout writes a durable session-level tombstone before acknowledging the
-- browser logout. Future prepare/confirm calls using that binding fail closed.
create table public.aiuser_account_link_session_revocations (
  session_kind text not null,
  session_hash text not null,
  principal_hash text,
  phone_user_id uuid,
  revoked_at timestamptz not null default clock_timestamp(),
  constraint aiuser_account_link_session_revocations_pkey primary key(session_kind,session_hash),
  constraint aiuser_account_link_session_revocations_phone_user_id_fkey foreign key(phone_user_id)
    references public.app_users(id) on delete restrict,
  constraint aiuser_account_link_session_revocations_shape_check check(
    session_kind in ('aiuser','phone') and session_hash ~ '^[a-f0-9]{64}$'
    and (principal_hash is null or principal_hash ~ '^[a-f0-9]{64}$')
    and ((session_kind='aiuser' and principal_hash is not null and phone_user_id is null)
      or (session_kind='phone' and principal_hash is null and phone_user_id is not null)))
);

create table public.aiuser_account_link_audit (
  intent_hash text not null,
  principal_hash text not null,
  phone_user_id uuid not null,
  proof_hash text not null,
  aiuser_session_hash text not null,
  phone_session_hash text not null,
  aiuser_verified_at_ms bigint not null,
  phone_verified_at_ms bigint not null,
  membership_generation bigint not null,
  outcome text not null,
  confirmed_at timestamptz not null default clock_timestamp(),
  constraint aiuser_account_link_audit_pkey primary key(intent_hash),
  constraint aiuser_account_link_audit_intent_hash_fkey foreign key(intent_hash)
    references public.aiuser_account_link_intents(intent_hash) on delete restrict,
  constraint aiuser_account_link_audit_principal_hash_fkey foreign key(principal_hash)
    references public.aiuser_account_links(principal_hash) on delete restrict,
  constraint aiuser_account_link_audit_phone_user_id_fkey foreign key(phone_user_id)
    references public.app_users(id) on delete restrict,
  constraint aiuser_account_link_audit_shape_check check(
    intent_hash ~ '^[a-f0-9]{64}$' and principal_hash ~ '^[a-f0-9]{64}$'
    and proof_hash ~ '^[a-f0-9]{64}$' and aiuser_session_hash ~ '^[a-f0-9]{64}$'
    and phone_session_hash ~ '^[a-f0-9]{64}$' and aiuser_verified_at_ms>=0
    and phone_verified_at_ms>=0 and membership_generation>0
    and outcome in ('linked','already_linked'))
);

-- Captures exact PG16-rendered constraint/default/function definitions at
-- installation. Posture compares current catalog projection to this immutable
-- manifest, so same-name weakened CHECK/default/function drift also fails.
create table public.aiuser_account_link_catalog_manifest (
  object_key text not null,
  definition_sha256 text not null,
  constraint aiuser_account_link_catalog_manifest_pkey primary key(object_key),
  constraint aiuser_account_link_catalog_manifest_shape_check check(
    object_key collate "C" ~ '^(constraint|default|function):[ -~]+$'
    and char_length(object_key)-strpos(object_key,':') between 1 and 300
    and definition_sha256 ~ '^[a-f0-9]{64}$')
);

alter table public.aiuser_account_links enable row level security;
alter table public.aiuser_account_links force row level security;
alter table public.aiuser_account_link_intents enable row level security;
alter table public.aiuser_account_link_intents force row level security;
alter table public.aiuser_account_link_session_revocations enable row level security;
alter table public.aiuser_account_link_session_revocations force row level security;
alter table public.aiuser_account_link_audit enable row level security;
alter table public.aiuser_account_link_audit force row level security;
alter table public.aiuser_account_link_catalog_manifest enable row level security;
alter table public.aiuser_account_link_catalog_manifest force row level security;
revoke all on public.aiuser_account_links,public.aiuser_account_link_intents,
  public.aiuser_account_link_session_revocations,public.aiuser_account_link_audit,
  public.aiuser_account_link_catalog_manifest from public,anon,authenticated,service_role;

create function public.aistory_aiuser_link_immutable() returns trigger
language plpgsql set search_path=pg_catalog as $$
begin raise exception 'ACCOUNT_LINK_IMMUTABLE' using errcode='42501'; end;
$$;
revoke all on function public.aistory_aiuser_link_immutable() from public,anon,authenticated,service_role;

create trigger aiuser_account_links_immutable before update or delete or truncate on public.aiuser_account_links
for each statement execute function public.aistory_aiuser_link_immutable();
create trigger aiuser_account_link_intents_immutable before update or delete or truncate on public.aiuser_account_link_intents
for each statement execute function public.aistory_aiuser_link_immutable();
create trigger aiuser_account_link_session_revocations_immutable before update or delete or truncate on public.aiuser_account_link_session_revocations
for each statement execute function public.aistory_aiuser_link_immutable();
create trigger aiuser_account_link_audit_immutable before update or delete or truncate on public.aiuser_account_link_audit
for each statement execute function public.aistory_aiuser_link_immutable();
create trigger aiuser_account_link_catalog_manifest_immutable before update or delete or truncate on public.aiuser_account_link_catalog_manifest
for each statement execute function public.aistory_aiuser_link_immutable();

create function public.aistory_aiuser_link_validate_payload(request_payload jsonb) returns jsonb
language plpgsql set search_path=pg_catalog as $$
declare v_ai jsonb; v_phone jsonb; v_intent jsonb; v_item record; v_number numeric;
begin
  if jsonb_typeof(request_payload) is distinct from 'object' or octet_length(request_payload::text)>4096
    or (select array_agg(k order by k) from jsonb_object_keys(request_payload) k) is distinct from array['aiuser','confirmation','intent','phone','schema']
    or request_payload->'schema' is distinct from '"aistory.aiuser-account-link-proof.v1"'::jsonb
    or request_payload->'confirmation' is distinct from '{"confirmLink":true}'::jsonb then
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  v_ai:=request_payload->'aiuser'; v_phone:=request_payload->'phone'; v_intent:=request_payload->'intent';
  if jsonb_typeof(v_ai) is distinct from 'object' or jsonb_typeof(v_phone) is distinct from 'object'
    or jsonb_typeof(v_intent) is distinct from 'object'
    or (select array_agg(k order by k) from jsonb_object_keys(v_ai) k) is distinct from array['authenticatedAt','expiresAt','membershipGeneration','principalKey','sessionBinding']
    or (select array_agg(k order by k) from jsonb_object_keys(v_phone) k) is distinct from array['active','authenticatedAt','expiresAt','sessionBinding','userId']
    or (select array_agg(k order by k) from jsonb_object_keys(v_intent) k) is distinct from array['aiuserSessionBinding','consumed','createdAt','expiresAt','id','phoneSessionBinding','phoneUserId','principalKey']
    or v_phone->'active' is distinct from 'true'::jsonb or v_intent->'consumed' is distinct from 'false'::jsonb then
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  for v_item in select key,value from jsonb_each(v_ai) union all select key,value from jsonb_each(v_phone)
    union all select key,value from jsonb_each(v_intent) loop
    if v_item.key in ('authenticatedAt','expiresAt','membershipGeneration','createdAt') then
      if jsonb_typeof(v_item.value) is distinct from 'number' then
        raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
      v_number:=(v_item.value#>>'{}')::numeric;
      if v_number<0 or v_number>9007199254740991 or trunc(v_number)<>v_number then
        raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
    elsif v_item.key not in ('active','consumed') then
      if jsonb_typeof(v_item.value) is distinct from 'string' then
        raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
      if v_item.key in ('phoneUserId','userId') then
        if (v_item.value#>>'{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
          raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
      elsif (v_item.value#>>'{}') !~ '^[a-f0-9]{64}$' then
        raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
    end if;
  end loop;
  if v_ai->'principalKey' is distinct from v_intent->'principalKey'
    or v_phone->'userId' is distinct from v_intent->'phoneUserId'
    or v_ai->'sessionBinding' is distinct from v_intent->'aiuserSessionBinding'
    or v_phone->'sessionBinding' is distinct from v_intent->'phoneSessionBinding'
    or (v_ai->>'membershipGeneration')::bigint<1 then
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  return request_payload;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023';
end;
$$;
revoke all on function public.aistory_aiuser_link_validate_payload(jsonb) from public,anon,authenticated,service_role;

-- Stub permits check_function_bodies=on while the operational functions below
-- reference posture. It is replaced before any grant or manifest capture.
create function public.aistory_aiuser_link_posture() returns text
language plpgsql security definer set search_path=pg_catalog as $$begin return null; end;$$;

create function public.aistory_aiuser_link_is_linked(principal_hash text) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
begin
  if current_setting('request.jwt.claim.role',true) is distinct from 'service_role'
    or public.aistory_aiuser_link_posture() is distinct from '20260901040000'
    or principal_hash is null or principal_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'ACCOUNT_LINK_UNAVAILABLE' using errcode='42501'; end if;
  return exists(select 1 from public.aiuser_account_links l where l.principal_hash=$1);
end;
$$;

create function public.aistory_aiuser_link_prepare(request_payload jsonb) returns text
language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_ai jsonb; v_phone jsonb; v_intent jsonb; v_principal text; v_phone_id uuid;
  v_intent_hash text; v_proof_hash text; v_now bigint; v_at bigint; v_pt bigint; v_it bigint;
  v_ae bigint; v_pe bigint; v_ie bigint; v_user public.app_users%rowtype;
  v_by_ai public.aiuser_account_links%rowtype; v_by_phone public.aiuser_account_links%rowtype;
  v_prepared public.aiuser_account_link_intents%rowtype;
begin
  if current_setting('request.jwt.claim.role',true) is distinct from 'service_role'
    or public.aistory_aiuser_link_posture() is distinct from '20260901040000' then
    raise exception 'ACCOUNT_LINK_UNAVAILABLE' using errcode='42501'; end if;
  request_payload:=public.aistory_aiuser_link_validate_payload(request_payload);
  v_ai:=request_payload->'aiuser'; v_phone:=request_payload->'phone'; v_intent:=request_payload->'intent';
  v_principal:=v_ai->>'principalKey'; v_phone_id:=(v_phone->>'userId')::uuid;
  v_at:=(v_ai->>'authenticatedAt')::bigint; v_pt:=(v_phone->>'authenticatedAt')::bigint;
  v_it:=(v_intent->>'createdAt')::bigint; v_ae:=(v_ai->>'expiresAt')::bigint;
  v_pe:=(v_phone->>'expiresAt')::bigint; v_ie:=(v_intent->>'expiresAt')::bigint;
  v_intent_hash:=encode(sha256(convert_to('aistory.aiuser.link-intent.v1'||chr(10)||(v_intent->>'id'),'UTF8')),'hex');
  v_proof_hash:=encode(sha256(convert_to('aistory.aiuser.link-proof.v1'||chr(10)||request_payload::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(20260901,40000);
  if exists(select 1 from public.aiuser_account_link_session_revocations r
    where (r.session_kind='aiuser' and r.session_hash=v_ai->>'sessionBinding')
      or (r.session_kind='phone' and r.session_hash=v_phone->>'sessionBinding')) then
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  select * into v_prepared from public.aiuser_account_link_intents i where i.intent_hash=v_intent_hash for update;
  if v_prepared.intent_hash is not null then
    if v_prepared.principal_hash=v_principal and v_prepared.phone_user_id=v_phone_id
      and v_prepared.aiuser_session_hash=v_ai->>'sessionBinding'
      and v_prepared.phone_session_hash=v_phone->>'sessionBinding'
      and v_prepared.aiuser_verified_at_ms=v_at and v_prepared.phone_verified_at_ms=v_pt
      and v_prepared.aiuser_expires_at_ms=v_ae and v_prepared.phone_expires_at_ms=v_pe
      and v_prepared.membership_generation=(v_ai->>'membershipGeneration')::bigint
      and v_prepared.intent_created_at_ms=v_it and v_prepared.intent_expires_at_ms=v_ie
      and v_prepared.proof_hash=v_proof_hash
      and not exists(select 1 from public.aiuser_account_link_audit a where a.intent_hash=v_intent_hash) then
      return 'prepared'; end if;
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023';
  end if;
  perform 1 from public.phone_identities p where p.user_id=v_phone_id for update;
  if not found then raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  select * into v_user from public.app_users u where u.id=v_phone_id for update;
  v_now:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if v_user.id is null or v_user.tenant_id<>'platform' or v_user.identity_type<>'phone' or v_user.status<>'active'
    or v_at>v_now or v_pt>v_now or v_now-v_at>300000 or v_now-v_pt>300000
    or v_ae<=v_now or v_pe<=v_now or v_ae<=v_at or v_pe<=v_pt
    or v_ae-v_at>900000 or v_pe-v_pt>604800000
    or v_it>v_now or v_it<v_at or v_it<v_pt or v_ie<=v_now or v_ie<=v_it or v_ie-v_it>60000
    or (select count(*) from public.aiuser_account_link_intents i
      where (i.principal_hash=v_principal or i.phone_user_id=v_phone_id)
        and i.registered_at>clock_timestamp()-interval '1 day')>=10 then
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  select * into v_by_ai from public.aiuser_account_links l where l.principal_hash=v_principal;
  select * into v_by_phone from public.aiuser_account_links l where l.phone_user_id=v_phone_id;
  if not ((v_by_ai.principal_hash is null and v_by_phone.principal_hash is null)
    or (v_by_ai.principal_hash=v_principal and v_by_ai.phone_user_id=v_phone_id
      and v_by_phone.principal_hash=v_principal and v_by_phone.phone_user_id=v_phone_id)) then
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  insert into public.aiuser_account_link_intents(intent_hash,principal_hash,phone_user_id,
    aiuser_session_hash,phone_session_hash,aiuser_verified_at_ms,phone_verified_at_ms,
    aiuser_expires_at_ms,phone_expires_at_ms,membership_generation,intent_created_at_ms,
    intent_expires_at_ms,proof_hash)
  values(v_intent_hash,v_principal,v_phone_id,v_ai->>'sessionBinding',v_phone->>'sessionBinding',
    v_at,v_pt,v_ae,v_pe,(v_ai->>'membershipGeneration')::bigint,v_it,v_ie,v_proof_hash);
  return 'prepared';
end;
$$;

create function public.aistory_aiuser_link_confirm(request_payload jsonb) returns text
language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_ai jsonb; v_phone jsonb; v_intent jsonb; v_principal text; v_phone_id uuid;
  v_intent_hash text; v_proof_hash text; v_now bigint; v_at bigint; v_pt bigint; v_it bigint;
  v_ae bigint; v_pe bigint; v_ie bigint; v_user public.app_users%rowtype;
  v_by_ai public.aiuser_account_links%rowtype; v_by_phone public.aiuser_account_links%rowtype;
  v_prepared public.aiuser_account_link_intents%rowtype; v_consumed public.aiuser_account_link_audit%rowtype;
  v_outcome text;
begin
  if current_setting('request.jwt.claim.role',true) is distinct from 'service_role'
    or public.aistory_aiuser_link_posture() is distinct from '20260901040000' then
    raise exception 'ACCOUNT_LINK_UNAVAILABLE' using errcode='42501'; end if;
  request_payload:=public.aistory_aiuser_link_validate_payload(request_payload);
  v_ai:=request_payload->'aiuser'; v_phone:=request_payload->'phone'; v_intent:=request_payload->'intent';
  v_principal:=v_ai->>'principalKey'; v_phone_id:=(v_phone->>'userId')::uuid;
  v_at:=(v_ai->>'authenticatedAt')::bigint; v_pt:=(v_phone->>'authenticatedAt')::bigint;
  v_it:=(v_intent->>'createdAt')::bigint; v_ae:=(v_ai->>'expiresAt')::bigint;
  v_pe:=(v_phone->>'expiresAt')::bigint; v_ie:=(v_intent->>'expiresAt')::bigint;
  v_intent_hash:=encode(sha256(convert_to('aistory.aiuser.link-intent.v1'||chr(10)||(v_intent->>'id'),'UTF8')),'hex');
  v_proof_hash:=encode(sha256(convert_to('aistory.aiuser.link-proof.v1'||chr(10)||request_payload::text,'UTF8')),'hex');
  perform pg_advisory_xact_lock(20260901,40000);
  select * into v_prepared from public.aiuser_account_link_intents i where i.intent_hash=v_intent_hash for update;
  if v_prepared.intent_hash is null or v_prepared.principal_hash<>v_principal or v_prepared.phone_user_id<>v_phone_id
    or v_prepared.aiuser_session_hash<>v_ai->>'sessionBinding'
    or v_prepared.phone_session_hash<>v_phone->>'sessionBinding'
    or v_prepared.aiuser_verified_at_ms<>v_at or v_prepared.phone_verified_at_ms<>v_pt
    or v_prepared.aiuser_expires_at_ms<>v_ae or v_prepared.phone_expires_at_ms<>v_pe
    or v_prepared.membership_generation<>(v_ai->>'membershipGeneration')::bigint
    or v_prepared.intent_created_at_ms<>v_it or v_prepared.intent_expires_at_ms<>v_ie
    or v_prepared.proof_hash<>v_proof_hash then
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  -- A logout that linearized after an earlier confirm supersedes even the
  -- read-only response-loss replay. No confirm may report success after the
  -- logout barrier has been acknowledged for either exact session binding.
  if exists(select 1 from public.aiuser_account_link_session_revocations r
    where (r.session_kind='aiuser' and r.session_hash=v_ai->>'sessionBinding')
      or (r.session_kind='phone' and r.session_hash=v_phone->>'sessionBinding')) then
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  select * into v_consumed from public.aiuser_account_link_audit a where a.intent_hash=v_intent_hash;
  if v_consumed.intent_hash is not null then
    if v_consumed.principal_hash=v_principal and v_consumed.phone_user_id=v_phone_id
      and v_consumed.proof_hash=v_proof_hash and v_consumed.aiuser_session_hash=v_ai->>'sessionBinding'
      and v_consumed.phone_session_hash=v_phone->>'sessionBinding'
      and v_consumed.aiuser_verified_at_ms=v_at and v_consumed.phone_verified_at_ms=v_pt
      and v_consumed.membership_generation=(v_ai->>'membershipGeneration')::bigint
      and v_consumed.outcome in ('linked','already_linked')
      and exists(select 1 from public.aiuser_account_links l
        where l.principal_hash=v_principal and l.phone_user_id=v_phone_id) then
      return v_consumed.outcome; end if;
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023';
  end if;
  perform 1 from public.phone_identities p where p.user_id=v_phone_id for update;
  if not found then raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  select * into v_user from public.app_users u where u.id=v_phone_id for update;
  v_now:=floor(extract(epoch from clock_timestamp())*1000)::bigint;
  if v_user.id is null or v_user.tenant_id<>'platform' or v_user.identity_type<>'phone' or v_user.status<>'active'
    or v_at>v_now or v_pt>v_now or v_now-v_at>300000 or v_now-v_pt>300000
    or v_ae<=v_now or v_pe<=v_now or v_ae<=v_at or v_pe<=v_pt
    or v_ae-v_at>900000 or v_pe-v_pt>604800000
    or v_it>v_now or v_it<v_at or v_it<v_pt or v_ie<=v_now or v_ie<=v_it or v_ie-v_it>60000 then
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  select * into v_by_ai from public.aiuser_account_links l where l.principal_hash=v_principal;
  select * into v_by_phone from public.aiuser_account_links l where l.phone_user_id=v_phone_id;
  if v_by_ai.principal_hash is null and v_by_phone.principal_hash is null then
    v_outcome:='linked';
    insert into public.aiuser_account_links(principal_hash,phone_user_id) values(v_principal,v_phone_id);
  elsif v_by_ai.principal_hash=v_principal and v_by_ai.phone_user_id=v_phone_id
    and v_by_phone.principal_hash=v_principal and v_by_phone.phone_user_id=v_phone_id then
    v_outcome:='already_linked';
  else raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  insert into public.aiuser_account_link_audit(intent_hash,principal_hash,phone_user_id,proof_hash,
    aiuser_session_hash,phone_session_hash,aiuser_verified_at_ms,phone_verified_at_ms,membership_generation,outcome)
  values(v_intent_hash,v_principal,v_phone_id,v_proof_hash,v_ai->>'sessionBinding',v_phone->>'sessionBinding',
    v_at,v_pt,(v_ai->>'membershipGeneration')::bigint,v_outcome);
  return v_outcome;
end;
$$;

create function public.aistory_aiuser_link_revoke_sessions(request_payload jsonb) returns boolean
language plpgsql security definer set search_path=pg_catalog as $$
declare v_ai jsonb; v_phone jsonb; v_principal text; v_phone_id uuid; v_session text;
begin
  if current_setting('request.jwt.claim.role',true) is distinct from 'service_role'
    or public.aistory_aiuser_link_posture() is distinct from '20260901040000' then
    raise exception 'ACCOUNT_LINK_UNAVAILABLE' using errcode='42501'; end if;
  if jsonb_typeof(request_payload) is distinct from 'object' then
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  if (select array_agg(k order by k) from jsonb_object_keys(request_payload) k)
      is distinct from array['aiuser','phone'] then
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  -- JSON null is a value, not SQL NULL. Normalize the two optional branches
  -- before enforcing the exact one-or-both revocation shape.
  v_ai:=nullif(request_payload->'aiuser','null'::jsonb);
  v_phone:=nullif(request_payload->'phone','null'::jsonb);
  if v_ai is null and v_phone is null then
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  if v_ai is not null and (jsonb_typeof(v_ai) is distinct from 'object'
      or (select array_agg(k order by k) from jsonb_object_keys(v_ai) k) is distinct from array['principalKey','sessionBinding']
      or jsonb_typeof(v_ai->'principalKey') is distinct from 'string'
      or jsonb_typeof(v_ai->'sessionBinding') is distinct from 'string'
      or (v_ai->>'principalKey') !~ '^[a-f0-9]{64}$' or (v_ai->>'sessionBinding') !~ '^[a-f0-9]{64}$') then
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  if v_phone is not null and (jsonb_typeof(v_phone) is distinct from 'object'
      or (select array_agg(k order by k) from jsonb_object_keys(v_phone) k) is distinct from array['sessionBinding','userId']
      or jsonb_typeof(v_phone->'userId') is distinct from 'string'
      or jsonb_typeof(v_phone->'sessionBinding') is distinct from 'string'
      or (v_phone->>'userId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or (v_phone->>'sessionBinding') !~ '^[a-f0-9]{64}$') then
    raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(20260901,40000);
  if v_ai is not null then
    v_principal:=v_ai->>'principalKey'; v_session:=v_ai->>'sessionBinding';
    insert into public.aiuser_account_link_session_revocations(session_kind,session_hash,principal_hash)
      values('aiuser',v_session,v_principal) on conflict do nothing;
    if not exists(select 1 from public.aiuser_account_link_session_revocations r
      where r.session_kind='aiuser' and r.session_hash=v_session and r.principal_hash=v_principal and r.phone_user_id is null) then
      raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  end if;
  if v_phone is not null then
    v_phone_id:=(v_phone->>'userId')::uuid; v_session:=v_phone->>'sessionBinding';
    insert into public.aiuser_account_link_session_revocations(session_kind,session_hash,phone_user_id)
      values('phone',v_session,v_phone_id) on conflict do nothing;
    if not exists(select 1 from public.aiuser_account_link_session_revocations r
      where r.session_kind='phone' and r.session_hash=v_session and r.principal_hash is null and r.phone_user_id=v_phone_id) then
      raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023'; end if;
  end if;
  return true;
exception when invalid_text_representation then
  raise exception 'ACCOUNT_LINK_REJECTED' using errcode='22023';
end;
$$;

-- All referenced functions now exist. The catalog projection reads live PG16
-- definitions; posture is replaced below without changing its OID.
create function public.aistory_aiuser_link_catalog()
returns table(object_key text,definition_sha256 text)
language sql set search_path=pg_catalog as $$
  with link_tables(oid) as (values
    ('public.aiuser_account_links'::regclass),('public.aiuser_account_link_intents'::regclass),
    ('public.aiuser_account_link_session_revocations'::regclass),('public.aiuser_account_link_audit'::regclass),
    ('public.aiuser_account_link_catalog_manifest'::regclass)),
  link_functions(oid) as (values
    ('public.aistory_aiuser_link_immutable()'::regprocedure),
    ('public.aistory_aiuser_link_validate_payload(jsonb)'::regprocedure),
    ('public.aistory_aiuser_link_posture()'::regprocedure),
    ('public.aistory_aiuser_link_is_linked(text)'::regprocedure),
    ('public.aistory_aiuser_link_prepare(jsonb)'::regprocedure),
    ('public.aistory_aiuser_link_confirm(jsonb)'::regprocedure),
    ('public.aistory_aiuser_link_revoke_sessions(jsonb)'::regprocedure),
    ('public.aistory_aiuser_link_catalog()'::regprocedure))
  select 'constraint:'||c.conrelid::regclass::text||':'||c.conname,
    encode(sha256(convert_to(pg_get_constraintdef(c.oid,true),'UTF8')),'hex')
    from pg_constraint c where c.conrelid in (select oid from link_tables)
  union all
  select 'default:'||a.attrelid::regclass::text||':'||a.attname,
    encode(sha256(convert_to(pg_get_expr(d.adbin,d.adrelid,true),'UTF8')),'hex')
    from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid in (select oid from link_tables) and a.attnum>0 and not a.attisdropped
  union all
  select 'function:'||p.oid::regprocedure::text,
    encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')
    from pg_proc p where p.oid in (select oid from link_functions);
$$;
revoke all on function public.aistory_aiuser_link_catalog() from public,anon,authenticated,service_role;

create or replace function public.aistory_aiuser_link_posture() returns text
language plpgsql security definer set search_path=pg_catalog as $$
declare v_table oid; v_function oid; v_columns text[];
begin
  if current_setting('request.jwt.claim.role',true) is distinct from 'service_role' and session_user <> 'postgres' then return null; end if;
  if not exists(select 1 from pg_roles where oid='postgres'::regrole and (rolsuper or rolbypassrls))
    or (select version from public.aistory_schema_gates where gate_name='aiuser_account_link') is distinct from '20260901040000'
    or public.aistory_database_gate_status() is distinct from '20260811193000' then return null; end if;
  foreach v_table in array array['public.aiuser_account_links'::regclass,'public.aiuser_account_link_intents'::regclass,
    'public.aiuser_account_link_session_revocations'::regclass,'public.aiuser_account_link_audit'::regclass,
    'public.aiuser_account_link_catalog_manifest'::regclass] loop
    if not exists(select 1 from pg_class where oid=v_table and relkind='r' and relpersistence='p'
      and relrowsecurity and relforcerowsecurity and relowner='postgres'::regrole)
      or exists(select 1 from pg_policy where polrelid=v_table)
      or exists(select 1 from pg_rewrite where ev_class=v_table)
      or exists(select 1 from pg_class c, lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        where c.oid=v_table and a.grantee <> 'postgres'::regrole)
      or exists(select 1 from pg_attribute a, lateral aclexplode(a.attacl) x
        where a.attrelid=v_table and x.grantee <> 'postgres'::regrole)
      or (select count(*) from pg_trigger where tgrelid=v_table and not tgisinternal)<>1
      or not exists(select 1 from pg_trigger where tgrelid=v_table and not tgisinternal and tgenabled='O'
        and tgfoid='public.aistory_aiuser_link_immutable()'::regprocedure and tgtype=58) then return null; end if;
    select array_agg(attname::text||':'||format_type(atttypid,atttypmod)||':'||attnotnull::text order by attnum)
      into v_columns from pg_attribute where attrelid=v_table and attnum>0 and not attisdropped;
    if v_table='public.aiuser_account_links'::regclass and v_columns is distinct from
      array['principal_hash:text:true','phone_user_id:uuid:true','tenant_id:text:true','linked_at:timestamp with time zone:true'] then return null;
    elsif v_table='public.aiuser_account_link_intents'::regclass and v_columns is distinct from
      array['intent_hash:text:true','principal_hash:text:true','phone_user_id:uuid:true','aiuser_session_hash:text:true',
        'phone_session_hash:text:true','aiuser_verified_at_ms:bigint:true','phone_verified_at_ms:bigint:true',
        'aiuser_expires_at_ms:bigint:true','phone_expires_at_ms:bigint:true','membership_generation:bigint:true',
        'intent_created_at_ms:bigint:true','intent_expires_at_ms:bigint:true','proof_hash:text:true','registered_at:timestamp with time zone:true'] then return null;
    elsif v_table='public.aiuser_account_link_session_revocations'::regclass and v_columns is distinct from
      array['session_kind:text:true','session_hash:text:true','principal_hash:text:false','phone_user_id:uuid:false','revoked_at:timestamp with time zone:true'] then return null;
    elsif v_table='public.aiuser_account_link_audit'::regclass and v_columns is distinct from
      array['intent_hash:text:true','principal_hash:text:true','phone_user_id:uuid:true','proof_hash:text:true',
        'aiuser_session_hash:text:true','phone_session_hash:text:true','aiuser_verified_at_ms:bigint:true',
        'phone_verified_at_ms:bigint:true','membership_generation:bigint:true','outcome:text:true','confirmed_at:timestamp with time zone:true'] then return null;
    elsif v_table='public.aiuser_account_link_catalog_manifest'::regclass and v_columns is distinct from
      array['object_key:text:true','definition_sha256:text:true'] then return null;
    end if;
  end loop;
  foreach v_function in array array['public.aistory_aiuser_link_posture()'::regprocedure,
    'public.aistory_aiuser_link_is_linked(text)'::regprocedure,'public.aistory_aiuser_link_prepare(jsonb)'::regprocedure,
    'public.aistory_aiuser_link_confirm(jsonb)'::regprocedure,'public.aistory_aiuser_link_revoke_sessions(jsonb)'::regprocedure,
    'public.aistory_aiuser_link_immutable()'::regprocedure,'public.aistory_aiuser_link_validate_payload(jsonb)'::regprocedure,
    'public.aistory_aiuser_link_catalog()'::regprocedure] loop
    if not exists(select 1 from pg_proc where oid=v_function and proowner='postgres'::regrole
      and proconfig=array['search_path=pg_catalog'] and not proleakproof
      and prosecdef=(v_function in ('public.aistory_aiuser_link_posture()'::regprocedure,
        'public.aistory_aiuser_link_is_linked(text)'::regprocedure,'public.aistory_aiuser_link_prepare(jsonb)'::regprocedure,
        'public.aistory_aiuser_link_confirm(jsonb)'::regprocedure,'public.aistory_aiuser_link_revoke_sessions(jsonb)'::regprocedure)))
      or exists(select 1 from pg_proc p, lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where p.oid=v_function and a.grantee not in ('postgres'::regrole,'service_role'::regrole)) then return null; end if;
    if v_function in ('public.aistory_aiuser_link_posture()'::regprocedure,
      'public.aistory_aiuser_link_is_linked(text)'::regprocedure,'public.aistory_aiuser_link_prepare(jsonb)'::regprocedure,
      'public.aistory_aiuser_link_confirm(jsonb)'::regprocedure,'public.aistory_aiuser_link_revoke_sessions(jsonb)'::regprocedure) then
      if not has_function_privilege('service_role',v_function,'EXECUTE') then return null; end if;
    elsif has_function_privilege('service_role',v_function,'EXECUTE') then return null; end if;
  end loop;
  if exists(
    (select object_key,definition_sha256 from public.aistory_aiuser_link_catalog()
      except select object_key,definition_sha256 from public.aiuser_account_link_catalog_manifest)
    union all
    (select object_key,definition_sha256 from public.aiuser_account_link_catalog_manifest
      except select object_key,definition_sha256 from public.aistory_aiuser_link_catalog())
  ) then return null; end if;
  return '20260901040000';
exception when others then return null;
end;
$$;

revoke all on function public.aistory_aiuser_link_posture(),public.aistory_aiuser_link_is_linked(text),
  public.aistory_aiuser_link_prepare(jsonb),public.aistory_aiuser_link_confirm(jsonb),
  public.aistory_aiuser_link_revoke_sessions(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.aistory_aiuser_link_posture(),public.aistory_aiuser_link_is_linked(text),
  public.aistory_aiuser_link_prepare(jsonb),public.aistory_aiuser_link_confirm(jsonb),
  public.aistory_aiuser_link_revoke_sessions(jsonb) to service_role;

insert into public.aiuser_account_link_catalog_manifest(object_key,definition_sha256)
select object_key,definition_sha256 from public.aistory_aiuser_link_catalog();
insert into public.aistory_schema_gates(gate_name,version) values('aiuser_account_link','20260901040000');

do $postflight$
begin
  if public.aistory_aiuser_link_posture() is distinct from '20260901040000' then
    raise exception 'ACCOUNT_LINK_POSTURE_FAILED' using errcode='55000'; end if;
end;
$postflight$;
