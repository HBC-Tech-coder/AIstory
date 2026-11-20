-- Forward-only adjunct to terminal Gate16. No identity, credential, or role is
-- initialized by apply. The applied Gate15/Gate16 migration files are unchanged.
do $$
begin
  if session_user is distinct from pg_get_userbyid((select datdba from pg_database where datname=current_database()))
    or current_user is distinct from session_user
    or public.aistory_independent_admin_gate_status() is distinct from '20260829063000'
    or public.aistory_independent_admin_security_posture() is distinct from true
    or exists(select 1 from public.independent_admin_principals where singleton_slot=1)
    or to_regclass('public.independent_admin_password_state') is not null then
    raise exception 'independent administrator first change prerequisite unavailable';
  end if;
end;
$$;

create table public.independent_admin_password_state (
  principal_ref text primary key references public.independent_admin_principals(principal_ref),
  root_binding_sha256 text not null unique check(root_binding_sha256 ~ '^[a-f0-9]{64}$'),
  current_binding jsonb not null,
  password_state jsonb not null,
  revision integer not null check(revision in (1,2)),
  must_change_password boolean not null,
  attempt_count integer not null default 0 check(attempt_count between 0 and 5),
  window_started_at timestamptz not null default clock_timestamp(),
  ticket_hash text check(ticket_hash ~ '^[a-f0-9]{64}$'),
  ticket_session_hash text check(ticket_session_hash ~ '^[a-f0-9]{64}$'),
  ticket_expires_at timestamptz,
  check ((revision=1 and must_change_password) or (revision=2 and not must_change_password)),
  check ((ticket_hash is null) = (ticket_expires_at is null)),
  check ((ticket_hash is null) = (ticket_session_hash is null))
);
create table public.independent_admin_password_families (
  family_hash text primary key references public.independent_admin_session_families(family_hash),
  principal_ref text not null references public.independent_admin_password_state(principal_ref),
  revision integer not null check(revision in (1,2)),
  must_change_password boolean not null,
  check ((revision=1 and must_change_password) or (revision=2 and not must_change_password))
);
create table public.independent_admin_password_audit (
  sequence bigint generated always as identity primary key,
  principal_ref text not null references public.independent_admin_principals(principal_ref),
  event text not null check(event in ('temporary_bootstrap','password_change_attempt','password_change_rate_limited','password_change_succeeded','restricted_access_denied')),
  occurred_at timestamptz not null default clock_timestamp()
);
alter table public.independent_admin_password_state enable row level security;
alter table public.independent_admin_password_state force row level security;
alter table public.independent_admin_password_families enable row level security;
alter table public.independent_admin_password_families force row level security;
alter table public.independent_admin_password_audit enable row level security;
alter table public.independent_admin_password_audit force row level security;
revoke all on public.independent_admin_password_state, public.independent_admin_password_families,
  public.independent_admin_password_audit from public,anon,authenticated,service_role;
revoke all on sequence public.independent_admin_password_audit_sequence_seq from public,anon,authenticated,service_role;
create trigger independent_admin_password_audit_immutable before update or delete or truncate
  on public.independent_admin_password_audit for each statement
  execute function public.aistory_independent_admin_reject_audit_mutation();

-- Retain reviewed implementations as private helpers, never service RPCs.
-- Wrappers keep the public signatures/volatility/GRANT expected by Gate16.
alter function public.aistory_independent_admin_initialize(jsonb) rename to aistory_iap_fc_base_initialize;
alter function public.aistory_independent_admin_rotate_credential(jsonb) rename to aistory_iap_fc_base_rotate_credential;
alter function public.aistory_independent_admin_commit_login(jsonb) rename to aistory_iap_fc_base_commit_login;
alter function public.aistory_independent_admin_verify_session(jsonb) rename to aistory_iap_fc_base_verify_session;
alter function public.aistory_independent_admin_rotate_session(jsonb) rename to aistory_iap_fc_base_rotate_session;
alter function public.aistory_independent_admin_read_snapshot(jsonb) rename to aistory_iap_fc_base_read_snapshot;
revoke all on function public.aistory_iap_fc_base_initialize(jsonb),public.aistory_iap_fc_base_rotate_credential(jsonb),
  public.aistory_iap_fc_base_commit_login(jsonb),public.aistory_iap_fc_base_verify_session(jsonb),
  public.aistory_iap_fc_base_rotate_session(jsonb),public.aistory_iap_fc_base_read_snapshot(jsonb)
  from public,anon,authenticated,service_role;

create function public.aistory_iap_fc_base64url(candidate_text text, expected_bytes integer)
returns boolean language plpgsql immutable security definer set search_path=pg_catalog,public as $$
declare v_bytes bytea;
begin
  if candidate_text is null or candidate_text !~ '^[A-Za-z0-9_-]+$' then return false; end if;
  v_bytes:=decode(translate(candidate_text,'-_','+/')||repeat('=',(4-length(candidate_text)%4)%4),'base64');
  return octet_length(v_bytes)=expected_bytes and
    rtrim(translate(replace(encode(v_bytes,'base64'),E'\n',''),'+/','-_'),'=')=candidate_text;
exception when others then return false;
end; $$;

create function public.aistory_iap_fc_assert_password(request_payload jsonb, binding_payload jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.aistory_independent_admin_assert_binding(binding_payload);
  if (jsonb_typeof(binding_payload->'principal_ref')='string' and binding_payload->>'principal_ref' ~ '^iap_[a-f0-9]{32}$'
    and jsonb_typeof(binding_payload->'credential_binding_sha256')='string' and binding_payload->>'credential_binding_sha256' ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(binding_payload->'credential_epoch_sha256')='string' and binding_payload->>'credential_epoch_sha256' ~ '^[a-f0-9]{64}$'
    and jsonb_typeof(binding_payload->'password_verifier_reference_sha256')='string' and binding_payload->>'password_verifier_reference_sha256' ~ '^[a-f0-9]{64}$'
    and binding_payload->'password_algorithm'='"scrypt-v1"'::jsonb
    and binding_payload->'password_parameters'=jsonb_build_object('N',131072,'r',8,'p',1,'keyLength',64,'maxmem',268435456)) is distinct from true
    or public.aistory_independent_admin_exact_object(request_payload,array['credentialEpoch','passwordVerifier']) is distinct from true
    or public.aistory_independent_admin_exact_object(request_payload->'passwordVerifier',
      array['algorithm','saltBase64url','digestBase64url','N','r','p','keyLength','maxmem']) is distinct from true
    or (jsonb_typeof(request_payload->'credentialEpoch')='string'
      and public.aistory_iap_fc_base64url(request_payload->>'credentialEpoch',16)) is distinct from true
    or (jsonb_typeof(request_payload->'passwordVerifier'->'saltBase64url')='string'
      and public.aistory_iap_fc_base64url(request_payload->'passwordVerifier'->>'saltBase64url',32)) is distinct from true
    or (jsonb_typeof(request_payload->'passwordVerifier'->'digestBase64url')='string'
      and public.aistory_iap_fc_base64url(request_payload->'passwordVerifier'->>'digestBase64url',64)) is distinct from true
    or (request_payload->'passwordVerifier'->>'algorithm') is distinct from 'scrypt-v1'
    or ((request_payload->'passwordVerifier') - 'algorithm' - 'saltBase64url' - 'digestBase64url')
      is distinct from jsonb_build_object('N',131072,'r',8,'p',1,'keyLength',64,'maxmem',268435456)
    or encode(public.digest(convert_to(request_payload->>'credentialEpoch','UTF8'),'sha256'),'hex')
      is distinct from binding_payload->>'credential_epoch_sha256'
    or encode(public.digest(convert_to(request_payload->'passwordVerifier'->>'digestBase64url','UTF8'),'sha256'),'hex')
      is distinct from binding_payload->>'password_verifier_reference_sha256' then
    raise exception 'independent administrator password state invalid';
  end if;
end;
$$;

create function public.aistory_iap_fc_assert_state(binding_payload jsonb)
returns void language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  perform public.aistory_independent_admin_assert_binding(binding_payload);
  if public.aistory_independent_admin_gate_status() is distinct from '20260829063000'
    or not exists(select 1 from public.aistory_schema_gates where gate_name='independent_admin_first_password_change' and version='20260831113000')
    or not exists(select 1 from public.independent_admin_password_state s
      join public.independent_admin_principals p using(principal_ref)
      where s.current_binding=binding_payload and p.singleton_slot=1 and p.status='active'
        and p.credential_binding_sha256=binding_payload->>'credential_binding_sha256'
        and p.credential_epoch_sha256=binding_payload->>'credential_epoch_sha256') then
    raise exception 'independent administrator password state unavailable';
  end if;
end;
$$;

-- NULL is unavailable; false is a fully changed, ordinary session. No caller
-- supplied stage/role/revision boolean is ever accepted.
create function public.aistory_iap_fc_session_stage(request_payload jsonb)
returns boolean language sql stable security definer set search_path=pg_catalog,public as $$
  select ps.must_change_password from public.independent_admin_sessions s
  join public.independent_admin_session_families f using(family_hash)
  join public.independent_admin_password_families pf using(family_hash)
  join public.independent_admin_password_state ps on ps.principal_ref=pf.principal_ref
  join public.independent_admin_principals p on p.principal_ref=ps.principal_ref
  where s.session_hash=request_payload->>'session_hash' and s.state='active' and s.expires_at>clock_timestamp()
    and f.revoked_at is null and f.absolute_expires_at>clock_timestamp()
    and f.principal_ref=ps.principal_ref and p.singleton_slot=1 and p.status='active'
    and pf.revision=ps.revision and pf.must_change_password=ps.must_change_password
    and ps.current_binding->>'credential_binding_sha256'=f.credential_binding_sha256
    and p.credential_binding_sha256=f.credential_binding_sha256
    and ps.current_binding=request_payload-'session_hash'-'occurred_at'-'tenant_id';
$$;

create function public.aistory_independent_admin_initialize(registration jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin raise exception 'independent administrator protected temporary bootstrap required'; end;
$$;
create function public.aistory_independent_admin_rotate_credential(rotation jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
begin raise exception 'independent administrator password change required'; end;
$$;

create function public.aistory_iap_first_change_bootstrap(request_payload jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_registration jsonb; v_binding jsonb;
begin
  perform public.aistory_independent_admin_assert_service_role();
  perform pg_advisory_xact_lock(hashtextextended('aistory:independent-admin:singleton:v1',0));
  if public.aistory_independent_admin_exact_object(request_payload,array['registration','password_state']) is distinct from true then
    raise exception 'independent administrator bootstrap invalid'; end if;
  v_registration:=request_payload->'registration'; v_binding:=v_registration-'request_id';
  perform public.aistory_iap_fc_assert_password(request_payload->'password_state',v_binding);
  if exists(select 1 from public.independent_admin_principals where singleton_slot=1)
    or exists(select 1 from public.independent_admin_password_state) then
    raise exception 'independent administrator bootstrap already consumed'; end if;
  perform public.aistory_iap_fc_base_initialize(v_registration);
  insert into public.independent_admin_password_state(principal_ref,root_binding_sha256,current_binding,password_state,revision,must_change_password)
    values(v_binding->>'principal_ref',v_binding->>'credential_binding_sha256',v_binding,request_payload->'password_state',1,true);
  insert into public.independent_admin_password_audit(principal_ref,event) values(v_binding->>'principal_ref','temporary_bootstrap');
  return true;
end;
$$;

create function public.aistory_iap_first_change_read_credential(request_payload jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare v_state public.independent_admin_password_state%rowtype;
begin
  perform public.aistory_independent_admin_assert_service_role();
  if public.aistory_independent_admin_exact_object(request_payload,array['principal_ref','root_binding_sha256']) is distinct from true then
    raise exception 'independent administrator credential unavailable'; end if;
  select s.* into strict v_state from public.independent_admin_password_state s
    where s.principal_ref=request_payload->>'principal_ref' and s.root_binding_sha256=request_payload->>'root_binding_sha256';
  perform public.aistory_iap_fc_assert_state(v_state.current_binding);
  return jsonb_build_object('password_state',v_state.password_state,'must_change_password',v_state.must_change_password,
    'revision',v_state.revision,'binding',v_state.current_binding);
end;
$$;

create function public.aistory_independent_admin_commit_login(login jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_binding jsonb; v_state public.independent_admin_password_state%rowtype;
begin
  perform public.aistory_independent_admin_assert_service_role();
  perform pg_advisory_xact_lock(hashtextextended('aistory:independent-admin:singleton:v1',0));
  v_binding:=login-'family_hash'-'session_hash'-'bucket_hashes'-'occurred_at'-'expires_at';
  perform public.aistory_iap_fc_assert_state(v_binding);
  select s.* into strict v_state from public.independent_admin_password_state s where s.current_binding=v_binding for update;
  perform public.aistory_iap_fc_base_commit_login(login);
  insert into public.independent_admin_password_families(family_hash,principal_ref,revision,must_change_password)
    values(login->>'family_hash',v_state.principal_ref,v_state.revision,v_state.must_change_password);
  return true;
end;
$$;

create function public.aistory_iap_first_change_verify_session(request_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_stage boolean;
begin
  perform public.aistory_independent_admin_assert_service_role();
  perform pg_advisory_xact_lock(hashtextextended('aistory:independent-admin:singleton:v1',0));
  perform public.aistory_iap_fc_assert_state(request_payload-'session_hash'-'occurred_at');
  if public.aistory_iap_fc_base_verify_session(request_payload) is null then return null; end if;
  v_stage:=public.aistory_iap_fc_session_stage(request_payload);
  if v_stage is null then return null; end if;
  return jsonb_build_object('active',true,'must_change_password',v_stage);
end;
$$;
create function public.aistory_independent_admin_verify_session(session jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_result jsonb;
begin
  v_result:=public.aistory_iap_first_change_verify_session(session);
  if v_result->'must_change_password' is distinct from 'false'::jsonb then return null; end if;
  return jsonb_build_object('active',true,'role','super_admin');
end;
$$;
create function public.aistory_independent_admin_rotate_session(rotation jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.aistory_independent_admin_assert_service_role();
  perform pg_advisory_xact_lock(hashtextextended('aistory:independent-admin:singleton:v1',0));
  if public.aistory_iap_fc_session_stage((rotation-'current_session_hash'-'next_session_hash'-'next_expires_at')
      ||jsonb_build_object('session_hash',rotation->>'current_session_hash')) is distinct from false then
    raise exception 'independent administrator rotation unavailable'; end if;
  return public.aistory_iap_fc_base_rotate_session(rotation);
end;
$$;
create function public.aistory_independent_admin_read_snapshot(request_payload jsonb)
returns jsonb language plpgsql stable security definer set search_path=pg_catalog,public as $$
begin
  perform public.aistory_independent_admin_assert_service_role();
  if public.aistory_iap_fc_session_stage(request_payload) is distinct from false then
    raise exception 'independent administrator read forbidden'; end if;
  return public.aistory_iap_fc_base_read_snapshot(request_payload);
end;
$$;

create function public.aistory_iap_first_change_access_denied(request_payload jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  perform public.aistory_independent_admin_assert_service_role();
  perform public.aistory_iap_fc_assert_state(request_payload-'session_hash');
  if public.aistory_iap_fc_session_stage(request_payload) is distinct from true then
    raise exception 'independent administrator restricted state unavailable'; end if;
  insert into public.independent_admin_password_audit(principal_ref,event) values(request_payload->>'principal_ref','restricted_access_denied');
  return true;
end; $$;

create function public.aistory_iap_first_change_reserve(request_payload jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_binding jsonb; v_state public.independent_admin_password_state%rowtype; v_now timestamptz:=clock_timestamp();
begin
  perform public.aistory_independent_admin_assert_service_role();
  perform pg_advisory_xact_lock(hashtextextended('aistory:independent-admin:singleton:v1',0));
  v_binding:=request_payload-'session_hash'-'ticket_hash';
  perform public.aistory_iap_fc_assert_state(v_binding);
  if (jsonb_typeof(request_payload->'ticket_hash')='string' and request_payload->>'ticket_hash' ~ '^[a-f0-9]{64}$') is distinct from true
    or public.aistory_iap_fc_session_stage(request_payload-'ticket_hash') is distinct from true then
    raise exception 'independent administrator change unavailable'; end if;
  select s.* into strict v_state from public.independent_admin_password_state s where s.current_binding=v_binding for update;
  if v_state.window_started_at<=v_now-interval '15 minutes' then
    v_state.attempt_count:=0; v_state.window_started_at:=v_now;
  end if;
  if v_state.attempt_count>=5 then
    insert into public.independent_admin_password_audit(principal_ref,event) values(v_state.principal_ref,'password_change_rate_limited');
    return jsonb_build_object('allowed',false);
  end if;
  update public.independent_admin_password_state set attempt_count=v_state.attempt_count+1,
    window_started_at=v_state.window_started_at,ticket_hash=request_payload->>'ticket_hash',
    ticket_session_hash=request_payload->>'session_hash',ticket_expires_at=v_now+interval '60 seconds'
    where principal_ref=v_state.principal_ref;
  insert into public.independent_admin_password_audit(principal_ref,event) values(v_state.principal_ref,'password_change_attempt');
  return jsonb_build_object('allowed',true);
end;
$$;

create function public.aistory_iap_first_change_complete(request_payload jsonb)
returns boolean language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_state public.independent_admin_password_state%rowtype; v_next jsonb;
begin
  perform public.aistory_independent_admin_assert_service_role();
  perform pg_advisory_xact_lock(hashtextextended('aistory:independent-admin:singleton:v1',0));
  if public.aistory_independent_admin_exact_object(request_payload,array['current_binding','session_hash','ticket_hash',
    'next_binding','password_state','request_id']) is distinct from true then
    raise exception 'independent administrator change invalid'; end if;
  perform public.aistory_iap_fc_assert_state(request_payload->'current_binding');
  select s.* into strict v_state from public.independent_admin_password_state s
    where s.current_binding=request_payload->'current_binding' for update;
  if not v_state.must_change_password or v_state.revision<>1
    or v_state.ticket_hash is distinct from request_payload->>'ticket_hash'
    or v_state.ticket_session_hash is distinct from request_payload->>'session_hash'
    or v_state.ticket_expires_at is null or v_state.ticket_expires_at<=clock_timestamp()
    or public.aistory_iap_fc_session_stage(v_state.current_binding||jsonb_build_object('session_hash',request_payload->>'session_hash')) is distinct from true then
    raise exception 'independent administrator change unavailable'; end if;
  v_next:=request_payload->'next_binding';
  perform public.aistory_iap_fc_assert_password(request_payload->'password_state',v_next);
  if v_next->>'principal_ref' is distinct from v_state.principal_ref
    or v_next->>'credential_binding_sha256'=v_state.current_binding->>'credential_binding_sha256'
    or v_next->>'credential_epoch_sha256'=v_state.current_binding->>'credential_epoch_sha256'
    or v_next->>'password_verifier_reference_sha256'=v_state.current_binding->>'password_verifier_reference_sha256' then
    raise exception 'independent administrator change invalid'; end if;
  -- Current-password KDF was verified in the trusted server; the exact verifier
  -- binding and one-use rate ticket CAS prevent stale/concurrent proof reuse.
  perform public.aistory_iap_fc_base_rotate_credential(jsonb_build_object(
    'current_credential_binding_sha256',v_state.current_binding->>'credential_binding_sha256',
    'next',v_next,'request_id',request_payload->>'request_id'));
  update public.independent_admin_password_state set current_binding=v_next,password_state=request_payload->'password_state',
    revision=2,must_change_password=false,ticket_hash=null,ticket_session_hash=null,ticket_expires_at=null where principal_ref=v_state.principal_ref;
  -- FORCE LOGOUT. No new family/session or authority is created by rotation.
  -- Only a later fresh login with the new verifier may create a console family.
  insert into public.independent_admin_password_audit(principal_ref,event) values(v_state.principal_ref,'password_change_succeeded');
  return true;
end;
$$;

revoke all on function public.aistory_iap_fc_base64url(text,integer),public.aistory_iap_fc_assert_password(jsonb,jsonb),public.aistory_iap_fc_assert_state(jsonb),
  public.aistory_iap_fc_session_stage(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.aistory_independent_admin_initialize(jsonb),public.aistory_independent_admin_rotate_credential(jsonb),
  public.aistory_independent_admin_commit_login(jsonb),public.aistory_independent_admin_verify_session(jsonb),
  public.aistory_independent_admin_rotate_session(jsonb),public.aistory_independent_admin_read_snapshot(jsonb),
  public.aistory_iap_first_change_bootstrap(jsonb),public.aistory_iap_first_change_read_credential(jsonb),
  public.aistory_iap_first_change_verify_session(jsonb),public.aistory_iap_first_change_reserve(jsonb),
  public.aistory_iap_first_change_complete(jsonb),public.aistory_iap_first_change_access_denied(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.aistory_independent_admin_initialize(jsonb),public.aistory_independent_admin_rotate_credential(jsonb),
  public.aistory_independent_admin_commit_login(jsonb),public.aistory_independent_admin_verify_session(jsonb),
  public.aistory_independent_admin_rotate_session(jsonb),public.aistory_independent_admin_read_snapshot(jsonb),
  public.aistory_iap_first_change_bootstrap(jsonb),public.aistory_iap_first_change_read_credential(jsonb),
  public.aistory_iap_first_change_verify_session(jsonb),public.aistory_iap_first_change_reserve(jsonb),
  public.aistory_iap_first_change_complete(jsonb),public.aistory_iap_first_change_access_denied(jsonb) to service_role;

insert into public.aistory_schema_gates(gate_name,version) values('independent_admin_first_password_change','20260831113000');

create function public.aistory_iap_first_change_posture()
returns text language sql stable security definer set search_path=pg_catalog,public as $$
 select case when public.aistory_independent_admin_gate_status()='20260829063000'
   and public.aistory_independent_admin_security_posture()
   and exists(select 1 from public.aistory_schema_gates where gate_name='independent_admin_first_password_change' and version='20260831113000')
   and (select count(*)=3 and bool_and(c.relrowsecurity and c.relforcerowsecurity and c.relowner=(select datdba from pg_database where datname=current_database()))
     from pg_class c where c.oid=any(array['public.independent_admin_password_state'::regclass,'public.independent_admin_password_families'::regclass,'public.independent_admin_password_audit'::regclass]))
   and not exists(select 1 from unnest(array['public.independent_admin_password_state','public.independent_admin_password_families','public.independent_admin_password_audit']) t(n)
     cross join unnest(array['anon','authenticated','service_role']) r(n) where has_table_privilege(r.n,t.n,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
   and not exists(select 1 from unnest(array['anon','authenticated','service_role']) r(n)
     where has_sequence_privilege(r.n,'public.independent_admin_password_audit_sequence_seq','USAGE,SELECT,UPDATE'))
   and (select count(*)=1 and bool_and(t.tgenabled='O' and t.tgtype=58
     and t.tgfoid='public.aistory_independent_admin_reject_audit_mutation()'::regprocedure)
     from pg_trigger t where t.tgrelid='public.independent_admin_password_audit'::regclass and not t.tgisinternal)
   and not exists(select 1 from pg_policy p where p.polrelid=any(array['public.independent_admin_password_state'::regclass,
     'public.independent_admin_password_families'::regclass,'public.independent_admin_password_audit'::regclass]))
   and (select count(*)=7 and bool_and(has_function_privilege('service_role',p.oid,'EXECUTE')
       and p.provolatile=case when p.oid=any(array['public.aistory_iap_first_change_read_credential(jsonb)'::regprocedure,
         'public.aistory_iap_first_change_posture()'::regprocedure]) then 's'::"char" else 'v'::"char" end)
     from pg_proc p where p.oid=any(array['public.aistory_iap_first_change_bootstrap(jsonb)'::regprocedure,
       'public.aistory_iap_first_change_read_credential(jsonb)'::regprocedure,'public.aistory_iap_first_change_verify_session(jsonb)'::regprocedure,
       'public.aistory_iap_first_change_reserve(jsonb)'::regprocedure,'public.aistory_iap_first_change_complete(jsonb)'::regprocedure,
       'public.aistory_iap_first_change_access_denied(jsonb)'::regprocedure,
       'public.aistory_iap_first_change_posture()'::regprocedure]))
   and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
     where n.nspname='public' and p.proname like 'aistory_iap_%' and (
       not p.prosecdef or p.proowner<>(select datdba from pg_database where datname=current_database())
       or not coalesce(p.proconfig,'{}'::text[]) @> array['search_path=pg_catalog, public']
       or has_function_privilege('anon',p.oid,'EXECUTE') or has_function_privilege('authenticated',p.oid,'EXECUTE')
       or (p.proname like 'aistory_iap_fc_%' and has_function_privilege('service_role',p.oid,'EXECUTE'))))
   then '20260831113000' else null end;
$$;
revoke all on function public.aistory_iap_first_change_posture() from public,anon,authenticated,service_role;
grant execute on function public.aistory_iap_first_change_posture() to service_role;
do $$ begin
 if public.aistory_iap_first_change_posture() is distinct from '20260831113000' then
   raise exception 'independent administrator first change posture unavailable'; end if;
end; $$;
