-- Forward-only hosted BYOK RPC runtime qualification hardening after gate
-- 20260801213000.
--
-- Gate10 and gate11 are already applied in staging and remain immutable.
-- Gate11 removed column/local ambiguity but used PL/pgSQL block labels as
-- expression qualifiers. PostgreSQL can parse those labels as relation names
-- inside embedded SQL, producing 42P01 at runtime. This migration keeps every
-- public signature unchanged, copies arguments into uniquely named locals at
-- function entry, qualifies every table column through an explicit alias, and
-- never uses a block label as a SQL expression qualifier.

create or replace function public.aistory_hosted_byok_list(
  owner_user_id uuid,
  owner_tenant text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
#variable_conflict error
declare
  v_owner_user_id uuid;
  v_owner_tenant text;
begin
  v_owner_user_id := $1;
  v_owner_tenant := $2;
  if v_owner_user_id is null
    or v_owner_tenant is null
    or length(v_owner_tenant) not between 1 and 80
    or not exists (
      select 1
      from public.app_users as app_user
      where app_user.id = v_owner_user_id
        and app_user.tenant_id = v_owner_tenant
        and app_user.status = 'active'
    ) then
    raise exception 'hosted credential identity unavailable';
  end if;
  return (
    select coalesce(
      jsonb_agg(
        public.aistory_hosted_byok_summary(credential)
        order by credential.updated_at desc
      ),
      '[]'::jsonb
    )
    from public.hosted_byok_credentials as credential
    where credential.owner_user_id = v_owner_user_id
      and credential.tenant_id = v_owner_tenant
      and credential.status <> 'deleted'
  );
end;
$function$;

create or replace function public.aistory_hosted_byok_read_encrypted(
  owner_user_id uuid,
  owner_tenant text,
  credential_id uuid,
  requested_capability text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $function$
#variable_conflict error
declare
  v_owner_user_id uuid;
  v_owner_tenant text;
  v_credential_id uuid;
  v_requested_capability text;
  v_item public.hosted_byok_credentials%rowtype;
begin
  v_owner_user_id := $1;
  v_owner_tenant := $2;
  v_credential_id := $3;
  v_requested_capability := $4;
  if v_owner_user_id is null
    or v_owner_tenant is null
    or v_credential_id is null
    or (
      v_requested_capability is not null
      and v_requested_capability not in (
        'text', 'image', 'vision', 'tts', 'video'
      )
    )
    or not exists (
      select 1
      from public.app_users as app_user
      where app_user.id = v_owner_user_id
        and app_user.tenant_id = v_owner_tenant
        and app_user.status = 'active'
    ) then
    raise exception 'hosted credential identity unavailable';
  end if;
  select credential.* into v_item
  from public.hosted_byok_credentials as credential
  where credential.id = v_credential_id
    and credential.owner_user_id = v_owner_user_id
    and credential.tenant_id = v_owner_tenant
    and credential.status = 'active'
    and (
      v_requested_capability is null
      or v_requested_capability = any(credential.capabilities)
    );
  if not found then return null; end if;
  return jsonb_build_object(
    'envelope_version', v_item.envelope_version,
    'credential_id', v_item.id,
    'owner_user_id', v_item.owner_user_id,
    'tenant_id', v_item.tenant_id,
    'provider', v_item.provider,
    'capabilities', to_jsonb(v_item.capabilities),
    'default_for', to_jsonb(v_item.default_for),
    'masked_label', v_item.masked_label,
    'ciphertext', v_item.ciphertext,
    'nonce', v_item.nonce,
    'tag', v_item.tag,
    'wrapped_dek', v_item.wrapped_dek,
    'wrap_nonce', v_item.wrap_nonce,
    'wrap_tag', v_item.wrap_tag,
    'kek_version', v_item.kek_version
  );
end;
$function$;

create or replace function public.aistory_hosted_byok_apply_mutation(
  mutation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
#variable_conflict error
declare
  v_mutation jsonb;
  v_actor_user_id uuid;
  v_target_tenant text;
  v_target_id uuid;
  v_mutation_action text;
  v_request_key text;
  v_fingerprint text;
  v_mutation_reason text;
  v_requested_capabilities text[];
  v_requested_defaults text[];
  v_existing public.hosted_byok_credentials%rowtype;
  v_existing_found boolean := false;
  v_updated public.hosted_byok_credentials%rowtype;
  v_existing_audit public.hosted_byok_audit_logs%rowtype;
  v_before_value jsonb;
  v_after_value jsonb;
begin
  v_mutation := $1;
  if v_mutation is null
    or jsonb_typeof(v_mutation) <> 'object' then
    raise exception 'hosted credential mutation invalid';
  end if;
  v_actor_user_id := nullif(v_mutation->>'actor_user_id', '')::uuid;
  v_target_tenant := v_mutation->>'tenant_id';
  v_target_id := nullif(v_mutation->>'credential_id', '')::uuid;
  v_mutation_action := v_mutation->>'action';
  v_request_key := v_mutation->>'idempotency_key';
  v_fingerprint := v_mutation->>'mutation_fingerprint';
  v_mutation_reason := v_mutation->>'reason';
  if v_actor_user_id is null
    or v_target_id is null
    or v_target_tenant is null
    or length(v_target_tenant) not between 1 and 80
    or v_mutation_action not in ('create', 'replace', 'delete', 'rotate')
    or v_request_key !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{7,199}$'
    or v_fingerprint !~ '^[a-f0-9]{64}$'
    or v_mutation_reason is null
    or length(v_mutation_reason) not between 3 and 200
    or not exists (
      select 1
      from public.app_users as app_user
      where app_user.id = v_actor_user_id
        and app_user.tenant_id = v_target_tenant
        and app_user.status = 'active'
    )
    or not exists (
      select 1
      from public.phone_identities as phone_identity
      join public.app_users as phone_user
        on phone_user.id = phone_identity.user_id
      where phone_identity.user_id = v_actor_user_id
        and phone_user.tenant_id = v_target_tenant
        and phone_user.status = 'active'
    ) then
    raise exception 'hosted credential mutation forbidden';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      v_target_tenant || ':' || v_actor_user_id::text,
      0
    )
  );

  select audit.* into v_existing_audit
  from public.hosted_byok_audit_logs as audit
  where audit.tenant_id = v_target_tenant
    and audit.actor_user_id = v_actor_user_id
    and audit.idempotency_key = v_request_key;
  if found then
    if v_existing_audit.action <> v_mutation_action
      or v_existing_audit.credential_id <> v_target_id
      or v_existing_audit.mutation_fingerprint <> v_fingerprint then
      raise exception 'hosted credential idempotency conflict';
    end if;
    return jsonb_build_object(
      'credential', v_existing_audit.after_summary,
      'replayed', true
    );
  end if;

  select credential.* into v_existing
  from public.hosted_byok_credentials as credential
  where credential.id = v_target_id
  for update;
  v_existing_found := found;
  if v_existing_found then
    v_before_value := public.aistory_hosted_byok_summary(v_existing);
  end if;

  if v_mutation_action = 'delete' then
    if not v_existing_found
      or v_existing.owner_user_id <> v_actor_user_id
      or v_existing.tenant_id <> v_target_tenant
      or v_existing.status = 'deleted' then
      raise exception 'hosted credential unavailable';
    end if;
    update public.hosted_byok_credentials as credential
    set status = 'deleted',
        default_for = '{}',
        ciphertext = null,
        nonce = null,
        tag = null,
        wrapped_dek = null,
        wrap_nonce = null,
        wrap_tag = null,
        kek_version = null,
        updated_at = now()
    where credential.id = v_target_id
    returning * into v_updated;
  else
    if jsonb_typeof(v_mutation->'capabilities') <> 'array'
      or jsonb_typeof(v_mutation->'default_for') <> 'array' then
      raise exception 'hosted credential capabilities invalid';
    end if;
    select array_agg(capability.value order by capability.value)
      into v_requested_capabilities
    from jsonb_array_elements_text(
      v_mutation->'capabilities'
    ) as capability(value);
    select coalesce(
      array_agg(default_capability.value order by default_capability.value),
      '{}'::text[]
    ) into v_requested_defaults
    from jsonb_array_elements_text(
      v_mutation->'default_for'
    ) as default_capability(value);
    if v_requested_capabilities is null
      or cardinality(v_requested_capabilities) not between 1 and 5
      or not (
        v_mutation ?& array[
          'provider', 'envelope_version', 'masked_label', 'ciphertext',
          'nonce', 'tag', 'wrapped_dek', 'wrap_nonce', 'wrap_tag',
          'kek_version'
        ]::text[]
      )
      or not v_requested_capabilities <@ array[
        'text', 'image', 'vision', 'tts', 'video'
      ]::text[]
      or not v_requested_defaults <@ v_requested_capabilities
      or cardinality(v_requested_capabilities) <> (
        select count(distinct requested_capability.value)
        from unnest(v_requested_capabilities) as requested_capability(value)
      )
      or cardinality(v_requested_defaults) <> (
        select count(distinct requested_default.value)
        from unnest(v_requested_defaults) as requested_default(value)
      )
      or v_mutation->>'provider' not in (
        'openai', 'openai_compatible', 'dashscope', 'runware', 'stepfun'
      )
      or (v_mutation->>'envelope_version')::integer <> 1
      or length(v_mutation->>'masked_label') not between 1 and 80
      or length(v_mutation->>'ciphertext') not between 4 and 65536
      or length(v_mutation->>'nonce') not between 12 and 64
      or length(v_mutation->>'tag') not between 12 and 64
      or length(v_mutation->>'wrapped_dek') not between 12 and 512
      or length(v_mutation->>'wrap_nonce') not between 12 and 64
      or length(v_mutation->>'wrap_tag') not between 12 and 64
      or length(v_mutation->>'kek_version') not between 1 and 64
      or v_mutation->>'ciphertext' !~ '^[A-Za-z0-9+/]+={0,2}$'
      or v_mutation->>'nonce' !~ '^[A-Za-z0-9+/]+={0,2}$'
      or v_mutation->>'tag' !~ '^[A-Za-z0-9+/]+={0,2}$'
      or v_mutation->>'wrapped_dek' !~ '^[A-Za-z0-9+/]+={0,2}$'
      or v_mutation->>'wrap_nonce' !~ '^[A-Za-z0-9+/]+={0,2}$'
      or v_mutation->>'wrap_tag' !~ '^[A-Za-z0-9+/]+={0,2}$' then
      raise exception 'hosted credential envelope invalid';
    end if;

    update public.hosted_byok_credentials as credential
    set default_for = array(
      select current_default.value
      from unnest(credential.default_for) as current_default(value)
      where not current_default.value = any(v_requested_defaults)
    ), updated_at = now()
    where credential.owner_user_id = v_actor_user_id
      and credential.tenant_id = v_target_tenant
      and credential.id <> v_target_id
      and credential.status = 'active'
      and credential.default_for && v_requested_defaults;

    if v_mutation_action = 'create' then
      if v_existing_found then
        raise exception 'hosted credential already exists';
      end if;
      insert into public.hosted_byok_credentials (
        id, tenant_id, owner_user_id, provider, capabilities, default_for,
        masked_label, status, envelope_version, ciphertext, nonce, tag,
        wrapped_dek, wrap_nonce, wrap_tag, kek_version
      ) values (
        v_target_id,
        v_target_tenant,
        v_actor_user_id,
        v_mutation->>'provider',
        v_requested_capabilities,
        v_requested_defaults,
        v_mutation->>'masked_label',
        'active',
        1,
        v_mutation->>'ciphertext',
        v_mutation->>'nonce',
        v_mutation->>'tag',
        v_mutation->>'wrapped_dek',
        v_mutation->>'wrap_nonce',
        v_mutation->>'wrap_tag',
        v_mutation->>'kek_version'
      ) returning * into v_updated;
    else
      if not v_existing_found
        or v_existing.owner_user_id <> v_actor_user_id
        or v_existing.tenant_id <> v_target_tenant
        or v_existing.status <> 'active'
        or v_existing.provider <> v_mutation->>'provider'
        or (
          v_mutation_action = 'rotate'
          and (
            v_existing.capabilities <> v_requested_capabilities
            or v_existing.default_for <> v_requested_defaults
          )
        ) then
        raise exception 'hosted credential unavailable';
      end if;
      update public.hosted_byok_credentials as credential
      set capabilities = v_requested_capabilities,
          default_for = v_requested_defaults,
          masked_label = v_mutation->>'masked_label',
          envelope_version = 1,
          ciphertext = v_mutation->>'ciphertext',
          nonce = v_mutation->>'nonce',
          tag = v_mutation->>'tag',
          wrapped_dek = v_mutation->>'wrapped_dek',
          wrap_nonce = v_mutation->>'wrap_nonce',
          wrap_tag = v_mutation->>'wrap_tag',
          kek_version = v_mutation->>'kek_version',
          updated_at = now()
      where credential.id = v_target_id
      returning * into v_updated;
    end if;
  end if;

  v_after_value := public.aistory_hosted_byok_summary(v_updated);
  insert into public.hosted_byok_audit_logs (
    tenant_id, actor_user_id, credential_id, action, reason,
    idempotency_key, mutation_fingerprint, before_summary, after_summary
  ) values (
    v_target_tenant,
    v_actor_user_id,
    v_target_id,
    v_mutation_action,
    v_mutation_reason,
    v_request_key,
    v_fingerprint,
    v_before_value,
    v_after_value
  );
  return jsonb_build_object(
    'credential', v_after_value, 'replayed', false
  );
end;
$function$;

create or replace function public.aistory_hosted_byok_mark_used(
  owner_user_id uuid,
  owner_tenant text,
  credential_id uuid,
  requested_capability text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
#variable_conflict error
declare
  v_owner_user_id uuid;
  v_owner_tenant text;
  v_credential_id uuid;
  v_requested_capability text;
begin
  v_owner_user_id := $1;
  v_owner_tenant := $2;
  v_credential_id := $3;
  v_requested_capability := $4;
  if v_requested_capability not in (
    'text', 'image', 'vision', 'tts', 'video'
  ) then
    return false;
  end if;
  update public.hosted_byok_credentials as credential
  set last_used_at = now()
  where credential.id = v_credential_id
    and credential.owner_user_id = v_owner_user_id
    and credential.tenant_id = v_owner_tenant
    and credential.status = 'active'
    and v_requested_capability = any(credential.capabilities)
    and exists (
      select 1
      from public.app_users as app_user
      where app_user.id = v_owner_user_id
        and app_user.tenant_id = v_owner_tenant
        and app_user.status = 'active'
    );
  return found;
end;
$function$;

revoke all on function public.aistory_hosted_byok_list(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.aistory_hosted_byok_read_encrypted(uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.aistory_hosted_byok_apply_mutation(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.aistory_hosted_byok_mark_used(uuid, text, uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.aistory_hosted_byok_list(uuid, text)
  to service_role;
grant execute on function public.aistory_hosted_byok_read_encrypted(uuid, text, uuid, text)
  to service_role;
grant execute on function public.aistory_hosted_byok_apply_mutation(jsonb)
  to service_role;
grant execute on function public.aistory_hosted_byok_mark_used(uuid, text, uuid, text)
  to service_role;

do $posture$
begin
  if not public.aistory_hosted_byok_security_posture() then
    raise exception 'hosted credential security posture unavailable';
  end if;
end;
$posture$;

insert into public.aistory_schema_gates (gate_name, version)
values ('production_identity_billing', '20260802113000')
on conflict (gate_name) do update
set version = excluded.version,
    installed_at = now();
