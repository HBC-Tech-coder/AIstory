-- AIstory hosted BYOK envelope-encryption vault gate.
--
-- Forward-only after the production identity/admin gate migrations. This does
-- not enable the feature, inject a KEK, migrate browser credentials, or grant
-- browser roles access to encrypted material.

create table if not exists public.hosted_byok_credentials (
  id uuid primary key,
  tenant_id text not null references public.tenants (id),
  owner_user_id uuid not null references public.app_users (id)
    on delete restrict,
  provider text not null check (
    provider in ('openai', 'openai_compatible', 'dashscope', 'runware', 'stepfun')
  ),
  capabilities text[] not null,
  default_for text[] not null default '{}',
  masked_label text not null check (length(masked_label) between 1 and 80),
  status text not null default 'active' check (
    status in ('active', 'revoked', 'deleted')
  ),
  envelope_version integer not null default 1 check (envelope_version = 1),
  ciphertext text,
  nonce text,
  tag text,
  wrapped_dek text,
  wrap_nonce text,
  wrap_tag text,
  kek_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  last_used_at timestamptz,
  unique (tenant_id, owner_user_id, id),
  check (
    status = 'deleted'
    or (
      ciphertext is not null
      and nonce is not null
      and tag is not null
      and wrapped_dek is not null
      and wrap_nonce is not null
      and wrap_tag is not null
      and kek_version is not null
    )
  ),
  check (
    capabilities <@ array['text', 'image', 'vision', 'tts', 'video']::text[]
    and cardinality(capabilities) between 1 and 5
  ),
  check (
    default_for <@ capabilities
  )
);

create index if not exists hosted_byok_owner_idx
  on public.hosted_byok_credentials (tenant_id, owner_user_id, updated_at desc);

create table if not exists public.hosted_byok_audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  actor_user_id uuid not null references public.app_users (id)
    on delete restrict,
  credential_id uuid not null,
  action text not null check (
    action in ('create', 'replace', 'delete', 'rotate')
  ),
  reason text not null check (length(reason) between 3 and 200),
  idempotency_key text not null,
  mutation_fingerprint text not null check (
    mutation_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  before_summary jsonb,
  after_summary jsonb not null,
  created_at timestamptz not null default now(),
  unique (tenant_id, actor_user_id, idempotency_key)
);

create index if not exists hosted_byok_audit_actor_idx
  on public.hosted_byok_audit_logs (tenant_id, actor_user_id, created_at desc);

create or replace function public.aistory_reject_hosted_byok_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception 'hosted credential audit is append-only';
end;
$$;

drop trigger if exists hosted_byok_audit_append_only
  on public.hosted_byok_audit_logs;
create trigger hosted_byok_audit_append_only
before update or delete on public.hosted_byok_audit_logs
for each row execute function public.aistory_reject_hosted_byok_audit_mutation();

create or replace function public.aistory_hosted_byok_summary(
  item public.hosted_byok_credentials
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'id', item.id,
    'provider', item.provider,
    'capabilities', to_jsonb(item.capabilities),
    'default_for', to_jsonb(item.default_for),
    'masked_label', item.masked_label,
    'status', item.status,
    'created_at', item.created_at,
    'updated_at', item.updated_at,
    'last_used_at', item.last_used_at
  );
$$;

create or replace function public.aistory_hosted_byok_list(
  owner_user_id uuid,
  owner_tenant text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
begin
  if owner_user_id is null
    or owner_tenant is null
    or length(owner_tenant) not between 1 and 80
    or not exists (
      select 1 from public.app_users
      where id = owner_user_id
        and tenant_id = owner_tenant
        and status = 'active'
    ) then
    raise exception 'hosted credential identity unavailable';
  end if;
  return (
    select coalesce(
      jsonb_agg(public.aistory_hosted_byok_summary(item) order by item.updated_at desc),
      '[]'::jsonb
    )
    from public.hosted_byok_credentials item
    where item.owner_user_id = owner_user_id
      and item.tenant_id = owner_tenant
      and item.status <> 'deleted'
  );
end;
$$;

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
as $$
declare
  item public.hosted_byok_credentials%rowtype;
begin
  if owner_user_id is null
    or owner_tenant is null
    or credential_id is null
    or (requested_capability is not null and requested_capability not in (
      'text', 'image', 'vision', 'tts', 'video'
    ))
    or not exists (
      select 1 from public.app_users
      where id = owner_user_id
        and tenant_id = owner_tenant
        and status = 'active'
    ) then
    raise exception 'hosted credential identity unavailable';
  end if;
  select * into item
  from public.hosted_byok_credentials
  where id = credential_id
    and owner_user_id = aistory_hosted_byok_read_encrypted.owner_user_id
    and tenant_id = owner_tenant
    and status = 'active'
    and (
      requested_capability is null
      or requested_capability = any(capabilities)
    );
  if not found then return null; end if;
  return jsonb_build_object(
    'envelope_version', item.envelope_version,
    'credential_id', item.id,
    'owner_user_id', item.owner_user_id,
    'tenant_id', item.tenant_id,
    'provider', item.provider,
    'capabilities', to_jsonb(item.capabilities),
    'default_for', to_jsonb(item.default_for),
    'masked_label', item.masked_label,
    'ciphertext', item.ciphertext,
    'nonce', item.nonce,
    'tag', item.tag,
    'wrapped_dek', item.wrapped_dek,
    'wrap_nonce', item.wrap_nonce,
    'wrap_tag', item.wrap_tag,
    'kek_version', item.kek_version
  );
end;
$$;

create or replace function public.aistory_hosted_byok_apply_mutation(
  mutation jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor_user_id uuid;
  target_tenant text;
  target_id uuid;
  mutation_action text;
  request_key text;
  fingerprint text;
  mutation_reason text;
  requested_capabilities text[];
  requested_defaults text[];
  existing public.hosted_byok_credentials%rowtype;
  existing_found boolean := false;
  updated public.hosted_byok_credentials%rowtype;
  existing_audit public.hosted_byok_audit_logs%rowtype;
  before_value jsonb;
  after_value jsonb;
begin
  if mutation is null or jsonb_typeof(mutation) <> 'object' then
    raise exception 'hosted credential mutation invalid';
  end if;
  actor_user_id := nullif(mutation->>'actor_user_id', '')::uuid;
  target_tenant := mutation->>'tenant_id';
  target_id := nullif(mutation->>'credential_id', '')::uuid;
  mutation_action := mutation->>'action';
  request_key := mutation->>'idempotency_key';
  fingerprint := mutation->>'mutation_fingerprint';
  mutation_reason := mutation->>'reason';
  if actor_user_id is null
    or target_id is null
    or target_tenant is null
    or length(target_tenant) not between 1 and 80
    or mutation_action not in ('create', 'replace', 'delete', 'rotate')
    or request_key !~ '^[A-Za-z0-9][A-Za-z0-9:._-]{7,199}$'
    or fingerprint !~ '^[a-f0-9]{64}$'
    or mutation_reason is null
    or length(mutation_reason) not between 3 and 200
    or not exists (
      select 1 from public.app_users
      where id = actor_user_id
        and tenant_id = target_tenant
        and status = 'active'
    )
    or not exists (
      select 1
      from public.phone_identities phone_identity
      join public.app_users phone_user on phone_user.id = phone_identity.user_id
      where phone_identity.user_id = actor_user_id
        and phone_user.tenant_id = target_tenant
        and phone_user.status = 'active'
    ) then
    raise exception 'hosted credential mutation forbidden';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(target_tenant || ':' || actor_user_id::text, 0)
  );

  select * into existing_audit
  from public.hosted_byok_audit_logs
  where tenant_id = target_tenant
    and actor_user_id = aistory_hosted_byok_apply_mutation.actor_user_id
    and idempotency_key = request_key;
  if found then
    if existing_audit.action <> mutation_action
      or existing_audit.credential_id <> target_id
      or existing_audit.mutation_fingerprint <> fingerprint then
      raise exception 'hosted credential idempotency conflict';
    end if;
    return jsonb_build_object(
      'credential', existing_audit.after_summary,
      'replayed', true
    );
  end if;

  select * into existing
  from public.hosted_byok_credentials
  where id = target_id
  for update;
  existing_found := found;
  if existing_found then
    before_value := public.aistory_hosted_byok_summary(existing);
  end if;

  if mutation_action = 'delete' then
    if not existing_found
      or existing.owner_user_id <> actor_user_id
      or existing.tenant_id <> target_tenant
      or existing.status = 'deleted' then
      raise exception 'hosted credential unavailable';
    end if;
    update public.hosted_byok_credentials
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
    where id = target_id
    returning * into updated;
  else
    if jsonb_typeof(mutation->'capabilities') <> 'array'
      or jsonb_typeof(mutation->'default_for') <> 'array' then
      raise exception 'hosted credential capabilities invalid';
    end if;
    select array_agg(item.value order by item.value)
      into requested_capabilities
    from jsonb_array_elements_text(mutation->'capabilities') as item(value);
    select coalesce(array_agg(item.value order by item.value), '{}'::text[])
      into requested_defaults
    from jsonb_array_elements_text(mutation->'default_for') as item(value);
    if requested_capabilities is null
      or cardinality(requested_capabilities) not between 1 and 5
      or not (
        mutation ?& array[
          'provider', 'envelope_version', 'masked_label', 'ciphertext',
          'nonce', 'tag', 'wrapped_dek', 'wrap_nonce', 'wrap_tag',
          'kek_version'
        ]::text[]
      )
      or not requested_capabilities <@ array['text', 'image', 'vision', 'tts', 'video']::text[]
      or not requested_defaults <@ requested_capabilities
      or cardinality(requested_capabilities) <> (
        select count(distinct value)
        from unnest(requested_capabilities) value
      )
      or cardinality(requested_defaults) <> (
        select count(distinct value)
        from unnest(requested_defaults) value
      )
      or mutation->>'provider' not in (
        'openai', 'openai_compatible', 'dashscope', 'runware', 'stepfun'
      )
      or (mutation->>'envelope_version')::integer <> 1
      or length(mutation->>'masked_label') not between 1 and 80
      or length(mutation->>'ciphertext') not between 4 and 65536
      or length(mutation->>'nonce') not between 12 and 64
      or length(mutation->>'tag') not between 12 and 64
      or length(mutation->>'wrapped_dek') not between 12 and 512
      or length(mutation->>'wrap_nonce') not between 12 and 64
      or length(mutation->>'wrap_tag') not between 12 and 64
      or length(mutation->>'kek_version') not between 1 and 64
      or mutation->>'ciphertext' !~ '^[A-Za-z0-9+/]+={0,2}$'
      or mutation->>'nonce' !~ '^[A-Za-z0-9+/]+={0,2}$'
      or mutation->>'tag' !~ '^[A-Za-z0-9+/]+={0,2}$'
      or mutation->>'wrapped_dek' !~ '^[A-Za-z0-9+/]+={0,2}$'
      or mutation->>'wrap_nonce' !~ '^[A-Za-z0-9+/]+={0,2}$'
      or mutation->>'wrap_tag' !~ '^[A-Za-z0-9+/]+={0,2}$' then
      raise exception 'hosted credential envelope invalid';
    end if;

    update public.hosted_byok_credentials
    set default_for = array(
      select value from unnest(default_for) value
      where not value = any(requested_defaults)
    ), updated_at = now()
    where owner_user_id = actor_user_id
      and tenant_id = target_tenant
      and id <> target_id
      and status = 'active'
      and default_for && requested_defaults;

    if mutation_action = 'create' then
      if existing_found then raise exception 'hosted credential already exists'; end if;
      insert into public.hosted_byok_credentials (
        id, tenant_id, owner_user_id, provider, capabilities, default_for,
        masked_label, status, envelope_version, ciphertext, nonce, tag,
        wrapped_dek, wrap_nonce, wrap_tag, kek_version
      ) values (
        target_id, target_tenant, actor_user_id, mutation->>'provider',
        requested_capabilities, requested_defaults, mutation->>'masked_label',
        'active', 1, mutation->>'ciphertext', mutation->>'nonce', mutation->>'tag',
        mutation->>'wrapped_dek', mutation->>'wrap_nonce', mutation->>'wrap_tag',
        mutation->>'kek_version'
      ) returning * into updated;
    else
      if not existing_found
        or existing.owner_user_id <> actor_user_id
        or existing.tenant_id <> target_tenant
        or existing.status <> 'active'
        or existing.provider <> mutation->>'provider'
        or (
          mutation_action = 'rotate'
          and (
            existing.capabilities <> requested_capabilities
            or existing.default_for <> requested_defaults
          )
        ) then
        raise exception 'hosted credential unavailable';
      end if;
      update public.hosted_byok_credentials
      set capabilities = requested_capabilities,
          default_for = requested_defaults,
          masked_label = mutation->>'masked_label',
          envelope_version = 1,
          ciphertext = mutation->>'ciphertext',
          nonce = mutation->>'nonce',
          tag = mutation->>'tag',
          wrapped_dek = mutation->>'wrapped_dek',
          wrap_nonce = mutation->>'wrap_nonce',
          wrap_tag = mutation->>'wrap_tag',
          kek_version = mutation->>'kek_version',
          updated_at = now()
      where id = target_id
      returning * into updated;
    end if;
  end if;

  after_value := public.aistory_hosted_byok_summary(updated);
  insert into public.hosted_byok_audit_logs (
    tenant_id, actor_user_id, credential_id, action, reason,
    idempotency_key, mutation_fingerprint, before_summary, after_summary
  ) values (
    target_tenant, actor_user_id, target_id, mutation_action, mutation_reason,
    request_key, fingerprint, before_value, after_value
  );
  return jsonb_build_object('credential', after_value, 'replayed', false);
end;
$$;

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
as $$
begin
  if requested_capability not in ('text', 'image', 'vision', 'tts', 'video') then
    return false;
  end if;
  update public.hosted_byok_credentials
  set last_used_at = now()
  where id = credential_id
    and owner_user_id = aistory_hosted_byok_mark_used.owner_user_id
    and tenant_id = owner_tenant
    and status = 'active'
    and requested_capability = any(capabilities)
    and exists (
      select 1 from public.app_users
      where id = owner_user_id
        and tenant_id = owner_tenant
        and status = 'active'
    );
  return found;
end;
$$;

alter table public.hosted_byok_credentials enable row level security;
alter table public.hosted_byok_credentials force row level security;
alter table public.hosted_byok_audit_logs enable row level security;
alter table public.hosted_byok_audit_logs force row level security;

revoke all privileges on table public.hosted_byok_credentials
  from public, anon, authenticated, service_role;
revoke all privileges on table public.hosted_byok_audit_logs
  from public, anon, authenticated, service_role;

revoke all on function public.aistory_hosted_byok_summary(public.hosted_byok_credentials)
  from public, anon, authenticated, service_role;
revoke all on function public.aistory_hosted_byok_list(uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.aistory_hosted_byok_read_encrypted(uuid, text, uuid, text)
  from public, anon, authenticated, service_role;
revoke all on function public.aistory_hosted_byok_apply_mutation(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.aistory_hosted_byok_mark_used(uuid, text, uuid, text)
  from public, anon, authenticated, service_role;

grant execute on function public.aistory_hosted_byok_summary(public.hosted_byok_credentials)
  to service_role;
grant execute on function public.aistory_hosted_byok_list(uuid, text)
  to service_role;
grant execute on function public.aistory_hosted_byok_read_encrypted(uuid, text, uuid, text)
  to service_role;
grant execute on function public.aistory_hosted_byok_apply_mutation(jsonb)
  to service_role;
grant execute on function public.aistory_hosted_byok_mark_used(uuid, text, uuid, text)
  to service_role;

create or replace function public.aistory_hosted_byok_security_posture()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    not has_table_privilege('anon', 'public.hosted_byok_credentials', 'SELECT')
    and not has_table_privilege('authenticated', 'public.hosted_byok_credentials', 'SELECT')
    and not has_table_privilege('anon', 'public.hosted_byok_credentials', 'INSERT')
    and not has_table_privilege('authenticated', 'public.hosted_byok_credentials', 'INSERT')
    and not has_table_privilege('anon', 'public.hosted_byok_audit_logs', 'SELECT')
    and not has_table_privilege('authenticated', 'public.hosted_byok_audit_logs', 'SELECT')
    and (
      select relrowsecurity and relforcerowsecurity
      from pg_catalog.pg_class
      where oid = 'public.hosted_byok_credentials'::regclass
    )
    and (
      select relrowsecurity and relforcerowsecurity
      from pg_catalog.pg_class
      where oid = 'public.hosted_byok_audit_logs'::regclass
    )
    and not has_function_privilege(
      'anon', 'public.aistory_hosted_byok_apply_mutation(jsonb)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated', 'public.aistory_hosted_byok_apply_mutation(jsonb)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.aistory_hosted_byok_apply_mutation(jsonb)', 'EXECUTE'
    )
    and not has_function_privilege(
      'anon', 'public.aistory_hosted_byok_read_encrypted(uuid,text,uuid,text)', 'EXECUTE'
    )
    and not has_function_privilege(
      'authenticated',
      'public.aistory_hosted_byok_read_encrypted(uuid,text,uuid,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.aistory_hosted_byok_read_encrypted(uuid,text,uuid,text)',
      'EXECUTE'
    );
$$;

revoke all on function public.aistory_hosted_byok_security_posture()
  from public, anon, authenticated, service_role;
grant execute on function public.aistory_hosted_byok_security_posture()
  to service_role;

insert into public.aistory_schema_gates (gate_name, version)
values ('production_identity_billing', '20260801193000')
on conflict (gate_name) do update
set version = excluded.version,
    installed_at = now();
