-- Production video-asset metadata gate (Gate14).
--
-- Gate13 remains immutable. This forward-only migration adds a service-role
-- only, tenant-scoped metadata repository for the private Aliyun OSS adapter.
-- Object bytes remain in the private bucket; browser roles receive neither
-- table access nor RPC execution rights.

do $$
declare
  v_installed_gate text;
begin
  select gate_record.version into v_installed_gate
  from public.aistory_schema_gates as gate_record
  where gate_record.gate_name = 'production_identity_billing';

  if v_installed_gate is distinct from '20260809113000' then
    raise exception 'video asset metadata gate requires gate13';
  end if;
  if not public.aistory_database_security_posture()
    or not public.aistory_admin_rpc_security_posture()
    or not public.aistory_phone_admin_security_posture()
    or not public.aistory_hosted_byok_security_posture() then
    raise exception 'video asset metadata prerequisite posture unavailable';
  end if;
end;
$$;

create table if not exists public.video_assets (
  tenant_id text not null references public.tenants (id),
  id text not null,
  content_hash text not null,
  content_type text not null,
  bytes bigint not null,
  storage_provider text not null default 'aliyun_oss',
  object_key text not null,
  etag text not null,
  duration_ms bigint not null,
  width integer not null,
  height integer not null,
  video_codec text not null,
  audio_codec text,
  has_audio boolean not null,
  status text not null default 'draft',
  release_policy text not null,
  project_id bigint not null,
  story_id text,
  node_id text,
  title text not null,
  subtitles jsonb not null default '[]'::jsonb,
  source text not null,
  generation jsonb,
  review_note text,
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint video_assets_pkey primary key (tenant_id, id),
  constraint video_assets_tenant_check check (
    tenant_id ~ '^[a-z0-9][a-z0-9_-]{0,62}$'
  ),
  constraint video_assets_id_check check (
    id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
  ),
  constraint video_assets_hash_check check (
    content_hash ~ '^[a-f0-9]{64}$'
  ),
  constraint video_assets_content_type_check check (
    content_type in ('video/mp4', 'video/webm')
  ),
  constraint video_assets_positive_dimensions_check check (
    bytes between 1 and 1073741824
    and duration_ms between 100 and 7200000
    and width between 64 and 7680
    and height between 64 and 7680
    and project_id between 1 and 9007199254740991
    and revision >= 1
  ),
  constraint video_assets_provider_check check (
    storage_provider = 'aliyun_oss'
  ),
  constraint video_assets_object_key_check check (
    object_key =
      'aistory/video-assets/v1/tenants/' || tenant_id
      || '/projects/' || project_id::text
      || '/sha256/' || left(content_hash, 2)
      || '/' || content_hash
      || case content_type
        when 'video/mp4' then '.mp4'
        else '.webm'
      end
  ),
  constraint video_assets_etag_check check (
    length(etag) between 1 and 200 and etag !~ '[[:cntrl:]]'
  ),
  constraint video_assets_probe_check check (
    (
      content_type = 'video/mp4'
      and video_codec = 'h264'
      and (audio_codec is null or audio_codec = 'aac')
    )
    or (
      content_type = 'video/webm'
      and video_codec in ('vp8', 'vp9', 'av1')
      and (audio_codec is null or audio_codec in ('opus', 'vorbis'))
    )
  ),
  constraint video_assets_audio_flag_check check (
    has_audio = (audio_codec is not null)
  ),
  constraint video_assets_status_check check (
    status in ('draft', 'review_pending', 'publishable', 'offline')
  ),
  constraint video_assets_release_policy_check check (
    release_policy in ('public', 'internal', 'enterprise')
  ),
  constraint video_assets_binding_check check (
    (
      story_id is null
      or (
        length(story_id) between 1 and 120
        and story_id !~ '[[:cntrl:]<>\\]'
        and position('..' in story_id) = 0
      )
    )
    and (
      node_id is null
      or (
        length(node_id) between 1 and 120
        and node_id !~ '[[:cntrl:]<>\\]'
        and position('..' in node_id) = 0
      )
    )
    and (
      status <> 'publishable'
      or (story_id is not null and node_id is not null)
    )
  ),
  constraint video_assets_title_check check (
    length(title) between 1 and 160
    and title !~ '[[:cntrl:]<>\\]'
    and position('..' in title) = 0
  ),
  constraint video_assets_review_note_check check (
    review_note is null
    or (
      length(review_note) between 1 and 500
      and review_note !~ '[[:cntrl:]<>\\]'
    )
  ),
  constraint video_assets_subtitles_check check (
    jsonb_typeof(subtitles) = 'array'
    and octet_length(subtitles::text) <= 524288
  ),
  constraint video_assets_generation_check check (
    generation is null
    or (
      jsonb_typeof(generation) = 'object'
      and octet_length(generation::text) <= 262144
    )
  ),
  constraint video_assets_source_check check (
    source in ('upload', 'generation_job')
  )
);

create table if not exists public.video_asset_idempotency (
  tenant_id text not null,
  key text not null,
  fingerprint text not null,
  asset_id text not null,
  operation text not null,
  created_at timestamptz not null default now(),
  constraint video_asset_idempotency_pkey primary key (tenant_id, key),
  constraint video_asset_idempotency_asset_fkey foreign key (
    tenant_id, asset_id
  ) references public.video_assets (tenant_id, id) on delete restrict,
  constraint video_asset_idempotency_key_check check (
    length(key) between 16 and 160
    and key ~ '^[A-Za-z0-9:._-]+$'
  ),
  constraint video_asset_idempotency_fingerprint_check check (
    fingerprint ~ '^[a-f0-9]{64}$'
  ),
  constraint video_asset_idempotency_operation_check check (
    operation in ('upload', 'adopt', 'mutation')
  )
);

create index if not exists video_assets_tenant_created_idx
  on public.video_assets (tenant_id, created_at desc);
create index if not exists video_assets_tenant_status_idx
  on public.video_assets (tenant_id, status, updated_at desc);
create index if not exists video_assets_tenant_object_key_idx
  on public.video_assets (tenant_id, object_key);

alter table public.video_assets enable row level security;
alter table public.video_assets force row level security;
alter table public.video_asset_idempotency enable row level security;
alter table public.video_asset_idempotency force row level security;

revoke all on table public.video_assets
from public, anon, authenticated, service_role;
revoke all on table public.video_asset_idempotency
from public, anon, authenticated, service_role;

drop trigger if exists video_asset_idempotency_append_only
on public.video_asset_idempotency;
create trigger video_asset_idempotency_append_only
before update or delete on public.video_asset_idempotency
for each row execute function public.aistory_reject_append_only_mutation();

create or replace function public.aistory_video_asset_assert_service_role()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_claims text;
  v_role text;
begin
  v_claims := nullif(
    pg_catalog.current_setting('request.jwt.claims', true),
    ''
  );
  v_role := coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.role', true), ''),
    case when v_claims is null then null else v_claims::jsonb->>'role' end,
    ''
  );
  if v_role <> 'service_role' then
    raise exception 'video asset service role required';
  end if;
end;
$$;

create or replace function public.aistory_video_asset_to_json(
  v_asset public.video_assets
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', v_asset.id,
    'tenantId', v_asset.tenant_id,
    'contentHash', v_asset.content_hash,
    'contentType', v_asset.content_type,
    'bytes', v_asset.bytes,
    'storage', jsonb_strip_nulls(jsonb_build_object(
      'kind', 'object',
      'provider', v_asset.storage_provider,
      'objectKey', v_asset.object_key,
      'etag', v_asset.etag
    )),
    'durationMs', v_asset.duration_ms,
    'width', v_asset.width,
    'height', v_asset.height,
    'videoCodec', v_asset.video_codec,
    'audioCodec', v_asset.audio_codec,
    'hasAudio', v_asset.has_audio,
    'status', v_asset.status,
    'releasePolicy', v_asset.release_policy,
    'projectId', v_asset.project_id,
    'storyId', v_asset.story_id,
    'nodeId', v_asset.node_id,
    'title', v_asset.title,
    'subtitles', v_asset.subtitles,
    'source', v_asset.source,
    'generation', v_asset.generation,
    'createdAt', v_asset.created_at,
    'updatedAt', v_asset.updated_at,
    'reviewNote', v_asset.review_note,
    'revision', v_asset.revision
  ));
$$;

create or replace function public.aistory_video_asset_idempotency_to_json(
  v_record public.video_asset_idempotency
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_build_object(
    'key', v_record.key,
    'fingerprint', v_record.fingerprint,
    'assetId', v_record.asset_id,
    'operation', v_record.operation,
    'createdAt', v_record.created_at
  );
$$;

create or replace function public.aistory_video_asset_audit_summary(
  v_asset public.video_assets
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'id', v_asset.id,
    'contentHash', v_asset.content_hash,
    'status', v_asset.status,
    'releasePolicy', v_asset.release_policy,
    'projectId', v_asset.project_id,
    'storyId', v_asset.story_id,
    'nodeId', v_asset.node_id,
    'title', v_asset.title
  ));
$$;

revoke all on function public.aistory_video_asset_assert_service_role()
from public, anon, authenticated, service_role;
revoke all on function public.aistory_video_asset_to_json(public.video_assets)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_video_asset_idempotency_to_json(
  public.video_asset_idempotency
) from public, anon, authenticated, service_role;
revoke all on function public.aistory_video_asset_audit_summary(
  public.video_assets
) from public, anon, authenticated, service_role;

create or replace function public.aistory_video_asset_list(
  requested_tenant_id text,
  requested_limit integer default 500
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_tenant_id text := requested_tenant_id;
  v_limit integer := greatest(1, least(coalesce(requested_limit, 500), 500));
begin
  perform public.aistory_video_asset_assert_service_role();
  return coalesce((
    select jsonb_agg(asset_record.asset_json order by asset_record.created_at desc)
    from (
      select
        public.aistory_video_asset_to_json(asset_row) as asset_json,
        asset_row.created_at
      from public.video_assets as asset_row
      where asset_row.tenant_id = v_tenant_id
      order by asset_row.created_at desc
      limit v_limit
    ) as asset_record
  ), '[]'::jsonb);
end;
$$;

create or replace function public.aistory_video_asset_get(
  requested_tenant_id text,
  requested_asset_id text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_asset public.video_assets%rowtype;
begin
  perform public.aistory_video_asset_assert_service_role();
  select asset_row.* into v_asset
  from public.video_assets as asset_row
  where asset_row.tenant_id = requested_tenant_id
    and asset_row.id = requested_asset_id;
  if not found then return null; end if;
  return public.aistory_video_asset_to_json(v_asset);
end;
$$;

create or replace function public.aistory_video_asset_find_idempotency(
  requested_tenant_id text,
  requested_key text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_record public.video_asset_idempotency%rowtype;
begin
  perform public.aistory_video_asset_assert_service_role();
  select idempotency_row.* into v_record
  from public.video_asset_idempotency as idempotency_row
  where idempotency_row.tenant_id = requested_tenant_id
    and idempotency_row.key = requested_key;
  if not found then return null; end if;
  return public.aistory_video_asset_idempotency_to_json(v_record);
end;
$$;

create or replace function public.aistory_video_asset_has_object_reference(
  requested_tenant_id text,
  requested_object_key text
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
begin
  perform public.aistory_video_asset_assert_service_role();
  return exists (
    select 1
    from public.video_assets as asset_row
    where asset_row.tenant_id = requested_tenant_id
      and asset_row.object_key = requested_object_key
  );
end;
$$;

create or replace function public.aistory_video_asset_create(
  request_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_payload jsonb := request_payload;
  v_asset_json jsonb := v_payload->'asset';
  v_idem_json jsonb := v_payload->'idempotency';
  v_audit_json jsonb := v_payload->'audit';
  v_tenant_id text := v_payload->>'tenantId';
  v_asset_id text := v_asset_json->>'id';
  v_key text := v_idem_json->>'key';
  v_fingerprint text := v_idem_json->>'fingerprint';
  v_operation text := v_idem_json->>'operation';
  v_actor_id uuid;
  v_actor_roles text[];
  v_request_id text := v_audit_json->>'requestId';
  v_reason text := v_audit_json->>'reason';
  v_action text := v_audit_json->>'action';
  v_existing_idem public.video_asset_idempotency%rowtype;
  v_existing_asset public.video_assets%rowtype;
  v_created_asset public.video_assets%rowtype;
begin
  perform public.aistory_video_asset_assert_service_role();
  if v_payload is null
    or jsonb_typeof(v_asset_json) <> 'object'
    or jsonb_typeof(v_idem_json) <> 'object'
    or jsonb_typeof(v_audit_json) <> 'object'
    or v_tenant_id is null
    or v_asset_id is null
    or v_key is null
    or v_fingerprint is null
    or v_operation is null
    or v_request_id is null
    or v_reason is null
    or v_action is null
    or v_tenant_id is distinct from v_asset_json->>'tenantId'
    or v_asset_id is distinct from v_idem_json->>'assetId'
    or length(v_key) not between 16 and 160
    or v_key !~ '^[A-Za-z0-9:._-]+$'
    or v_fingerprint !~ '^[a-f0-9]{64}$'
    or v_operation not in ('upload', 'adopt')
    or length(v_request_id) not between 16 and 200
    or length(v_reason) not between 1 and 500 then
    raise exception 'video asset create request invalid';
  end if;
  if (v_operation = 'upload' and v_action <> 'video_asset.upload')
    or (v_operation = 'adopt' and v_action <> 'video_asset.adopt_generation')
    or (v_operation = 'upload' and v_asset_json->>'source' <> 'upload')
    or (v_operation = 'adopt' and v_asset_json->>'source' <> 'generation_job') then
    raise exception 'video asset create operation invalid';
  end if;

  begin
    v_actor_id := (v_audit_json->>'actorId')::uuid;
  exception when others then
    raise exception 'video asset administrator unavailable';
  end;
  select array_agg(role_row.role order by role_row.role) into v_actor_roles
  from public.user_roles as role_row
  join public.app_users as app_user
    on app_user.id = role_row.user_id
   and app_user.tenant_id = role_row.tenant_id
  where role_row.user_id = v_actor_id
    and role_row.tenant_id = v_tenant_id
    and role_row.role in ('super_admin', 'ops', 'moderator')
    and app_user.status = 'active';
  if coalesce(cardinality(v_actor_roles), 0) = 0 then
    raise exception 'video asset administrator unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_tenant_id || ':' || v_key, 0)
  );
  select idempotency_row.* into v_existing_idem
  from public.video_asset_idempotency as idempotency_row
  where idempotency_row.tenant_id = v_tenant_id
    and idempotency_row.key = v_key;
  if found then
    if v_existing_idem.fingerprint <> v_fingerprint
      or v_existing_idem.operation <> v_operation then
      raise exception 'video asset idempotency conflict';
    end if;
    select asset_row.* into strict v_existing_asset
    from public.video_assets as asset_row
    where asset_row.tenant_id = v_tenant_id
      and asset_row.id = v_existing_idem.asset_id;
    return jsonb_build_object(
      'asset', public.aistory_video_asset_to_json(v_existing_asset),
      'created', false
    );
  end if;

  insert into public.video_assets (
    tenant_id, id, content_hash, content_type, bytes,
    storage_provider, object_key, etag,
    duration_ms, width, height, video_codec, audio_codec, has_audio,
    status, release_policy, project_id, story_id, node_id, title,
    subtitles, source, generation, review_note
  ) values (
    v_tenant_id,
    v_asset_id,
    v_asset_json->>'contentHash',
    v_asset_json->>'contentType',
    (v_asset_json->>'bytes')::bigint,
    v_asset_json->'storage'->>'provider',
    v_asset_json->'storage'->>'objectKey',
    v_asset_json->'storage'->>'etag',
    (v_asset_json->>'durationMs')::bigint,
    (v_asset_json->>'width')::integer,
    (v_asset_json->>'height')::integer,
    v_asset_json->>'videoCodec',
    nullif(v_asset_json->>'audioCodec', ''),
    (v_asset_json->>'hasAudio')::boolean,
    v_asset_json->>'status',
    v_asset_json->>'releasePolicy',
    (v_asset_json->>'projectId')::bigint,
    nullif(v_asset_json->>'storyId', ''),
    nullif(v_asset_json->>'nodeId', ''),
    v_asset_json->>'title',
    coalesce(v_asset_json->'subtitles', '[]'::jsonb),
    v_asset_json->>'source',
    v_asset_json->'generation',
    nullif(v_asset_json->>'reviewNote', '')
  ) returning * into v_created_asset;

  if v_created_asset.status <> 'draft'
    or v_asset_json->'storage'->>'kind' <> 'object' then
    raise exception 'video asset create state invalid';
  end if;

  insert into public.video_asset_idempotency (
    tenant_id, key, fingerprint, asset_id, operation
  ) values (
    v_tenant_id, v_key, v_fingerprint, v_asset_id, v_operation
  );

  insert into public.admin_audit_logs (
    tenant_id, actor_id, actor_roles, action, target_type,
    target_id, before_summary, after_summary, reason, request_id,
    mutation_fingerprint
  ) values (
    v_tenant_id, v_actor_id, v_actor_roles, v_action, 'video_asset',
    v_asset_id, null,
    public.aistory_video_asset_audit_summary(v_created_asset),
    v_reason, v_request_id, v_fingerprint
  );

  return jsonb_build_object(
    'asset', public.aistory_video_asset_to_json(v_created_asset),
    'created', true
  );
end;
$$;

create or replace function public.aistory_video_asset_mutate(
  request_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_payload jsonb := request_payload;
  v_next_json jsonb := v_payload->'next';
  v_idem_json jsonb := v_payload->'idempotency';
  v_audit_json jsonb := v_payload->'audit';
  v_tenant_id text := v_payload->>'tenantId';
  v_asset_id text := v_payload->>'assetId';
  v_expected_revision bigint;
  v_key text := v_idem_json->>'key';
  v_fingerprint text := v_idem_json->>'fingerprint';
  v_actor_id uuid;
  v_actor_roles text[];
  v_action text := v_audit_json->>'action';
  v_reason text := v_audit_json->>'reason';
  v_request_id text := v_audit_json->>'requestId';
  v_existing_idem public.video_asset_idempotency%rowtype;
  v_current public.video_assets%rowtype;
  v_changed public.video_assets%rowtype;
begin
  perform public.aistory_video_asset_assert_service_role();
  begin
    v_expected_revision := (v_payload->>'expectedRevision')::bigint;
    v_actor_id := (v_audit_json->>'actorId')::uuid;
  exception when others then
    raise exception 'video asset mutation request invalid';
  end;
  if jsonb_typeof(v_next_json) <> 'object'
    or jsonb_typeof(v_idem_json) <> 'object'
    or jsonb_typeof(v_audit_json) <> 'object'
    or v_tenant_id is null
    or v_asset_id is null
    or v_expected_revision is null
    or v_expected_revision < 1
    or v_key is null
    or v_fingerprint is null
    or v_action is null
    or v_reason is null
    or v_request_id is null
    or v_next_json->>'tenantId' is distinct from v_tenant_id
    or v_next_json->>'id' is distinct from v_asset_id
    or v_idem_json->>'assetId' is distinct from v_asset_id
    or v_idem_json->>'operation' is distinct from 'mutation'
    or length(v_key) not between 16 and 160
    or v_key !~ '^[A-Za-z0-9:._-]+$'
    or v_fingerprint !~ '^[a-f0-9]{64}$'
    or v_action not in (
      'video_asset.bind', 'video_asset.submit_review',
      'video_asset.approve', 'video_asset.offline',
      'video_asset.restore_draft'
    )
    or length(v_reason) not between 1 and 500
    or length(v_request_id) not between 16 and 200 then
    raise exception 'video asset mutation request invalid';
  end if;

  select array_agg(role_row.role order by role_row.role) into v_actor_roles
  from public.user_roles as role_row
  join public.app_users as app_user
    on app_user.id = role_row.user_id
   and app_user.tenant_id = role_row.tenant_id
  where role_row.user_id = v_actor_id
    and role_row.tenant_id = v_tenant_id
    and role_row.role in ('super_admin', 'ops', 'moderator')
    and app_user.status = 'active';
  if coalesce(cardinality(v_actor_roles), 0) = 0 then
    raise exception 'video asset administrator unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_tenant_id || ':' || v_key, 0)
  );
  select idempotency_row.* into v_existing_idem
  from public.video_asset_idempotency as idempotency_row
  where idempotency_row.tenant_id = v_tenant_id
    and idempotency_row.key = v_key;
  if found then
    if v_existing_idem.fingerprint <> v_fingerprint
      or v_existing_idem.asset_id <> v_asset_id
      or v_existing_idem.operation <> 'mutation' then
      raise exception 'video asset idempotency conflict';
    end if;
    select asset_row.* into strict v_current
    from public.video_assets as asset_row
    where asset_row.tenant_id = v_tenant_id
      and asset_row.id = v_asset_id;
    return jsonb_build_object(
      'asset', public.aistory_video_asset_to_json(v_current),
      'changed', false
    );
  end if;

  select asset_row.* into v_current
  from public.video_assets as asset_row
  where asset_row.tenant_id = v_tenant_id
    and asset_row.id = v_asset_id
  for update;
  if not found or v_current.revision <> v_expected_revision then
    raise exception 'video asset mutation conflict';
  end if;

  if v_next_json->>'contentHash' is distinct from v_current.content_hash
    or v_next_json->>'contentType' is distinct from v_current.content_type
    or (v_next_json->>'bytes')::bigint is distinct from v_current.bytes
    or v_next_json->'storage'->>'provider' is distinct from v_current.storage_provider
    or v_next_json->'storage'->>'objectKey' is distinct from v_current.object_key
    or v_next_json->'storage'->>'etag' is distinct from v_current.etag
    or (v_next_json->>'projectId')::bigint is distinct from v_current.project_id
    or (v_next_json->>'durationMs')::bigint is distinct from v_current.duration_ms
    or (v_next_json->>'width')::integer is distinct from v_current.width
    or (v_next_json->>'height')::integer is distinct from v_current.height
    or v_next_json->>'videoCodec' is distinct from v_current.video_codec
    or nullif(v_next_json->>'audioCodec', '') is distinct from v_current.audio_codec
    or (v_next_json->>'hasAudio')::boolean is distinct from v_current.has_audio
    or v_next_json->'subtitles' is distinct from v_current.subtitles
    or v_next_json->>'source' is distinct from v_current.source
    or v_next_json->'generation' is distinct from v_current.generation then
    raise exception 'video asset immutable metadata changed';
  end if;

  if v_action = 'video_asset.bind' then
    if v_current.status <> 'draft' or v_next_json->>'status' <> 'draft' then
      raise exception 'video asset bind state invalid';
    end if;
  elsif v_action = 'video_asset.submit_review' then
    if v_current.status <> 'draft'
      or v_next_json->>'status' <> 'review_pending' then
      raise exception 'video asset review state invalid';
    end if;
  elsif v_action = 'video_asset.approve' then
    if v_current.status <> 'review_pending'
      or v_next_json->>'status' <> 'publishable'
      or nullif(v_next_json->>'storyId', '') is null
      or nullif(v_next_json->>'nodeId', '') is null then
      raise exception 'video asset approval state invalid';
    end if;
  elsif v_action = 'video_asset.offline' then
    if v_current.status <> 'publishable'
      or v_next_json->>'status' <> 'offline' then
      raise exception 'video asset offline state invalid';
    end if;
  elsif v_action = 'video_asset.restore_draft' then
    if v_current.status <> 'offline'
      or v_next_json->>'status' <> 'draft' then
      raise exception 'video asset restore state invalid';
    end if;
  end if;

  if v_action <> 'video_asset.bind' and (
    nullif(v_next_json->>'storyId', '') is distinct from v_current.story_id
    or nullif(v_next_json->>'nodeId', '') is distinct from v_current.node_id
    or v_next_json->>'releasePolicy' is distinct from v_current.release_policy
    or v_next_json->>'title' is distinct from v_current.title
  ) then
    raise exception 'video asset reviewed projection changed';
  end if;

  update public.video_assets as asset_row
  set status = v_next_json->>'status',
      release_policy = v_next_json->>'releasePolicy',
      story_id = nullif(v_next_json->>'storyId', ''),
      node_id = nullif(v_next_json->>'nodeId', ''),
      title = v_next_json->>'title',
      review_note = v_reason,
      revision = asset_row.revision + 1,
      updated_at = now()
  where asset_row.tenant_id = v_tenant_id
    and asset_row.id = v_asset_id
    and asset_row.revision = v_expected_revision
  returning * into v_changed;
  if not found then raise exception 'video asset mutation conflict'; end if;

  insert into public.video_asset_idempotency (
    tenant_id, key, fingerprint, asset_id, operation
  ) values (
    v_tenant_id, v_key, v_fingerprint, v_asset_id, 'mutation'
  );

  insert into public.admin_audit_logs (
    tenant_id, actor_id, actor_roles, action, target_type,
    target_id, before_summary, after_summary, reason, request_id,
    mutation_fingerprint
  ) values (
    v_tenant_id, v_actor_id, v_actor_roles, v_action, 'video_asset',
    v_asset_id,
    public.aistory_video_asset_audit_summary(v_current),
    public.aistory_video_asset_audit_summary(v_changed),
    v_reason, v_request_id, v_fingerprint
  );

  return jsonb_build_object(
    'asset', public.aistory_video_asset_to_json(v_changed),
    'changed', true
  );
end;
$$;

revoke all on function public.aistory_video_asset_list(text, integer)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_video_asset_get(text, text)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_video_asset_find_idempotency(text, text)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_video_asset_has_object_reference(text, text)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_video_asset_create(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_video_asset_mutate(jsonb)
from public, anon, authenticated, service_role;

grant execute on function public.aistory_video_asset_list(text, integer)
to service_role;
grant execute on function public.aistory_video_asset_get(text, text)
to service_role;
grant execute on function public.aistory_video_asset_find_idempotency(text, text)
to service_role;
grant execute on function public.aistory_video_asset_has_object_reference(text, text)
to service_role;
grant execute on function public.aistory_video_asset_create(jsonb)
to service_role;
grant execute on function public.aistory_video_asset_mutate(jsonb)
to service_role;

create or replace function public.aistory_video_asset_security_posture()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select
    public.aistory_database_security_posture()
    and public.aistory_admin_rpc_security_posture()
    and public.aistory_phone_admin_security_posture()
    and public.aistory_hosted_byok_security_posture()
    and (
      select bool_and(class_record.relrowsecurity and class_record.relforcerowsecurity)
      from pg_catalog.pg_class as class_record
      where class_record.oid = any(array[
        'public.video_assets'::regclass,
        'public.video_asset_idempotency'::regclass
      ])
    )
    and not has_table_privilege(
      'anon', 'public.video_assets', 'SELECT,INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'authenticated', 'public.video_assets', 'SELECT,INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'service_role', 'public.video_assets', 'SELECT,INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'anon', 'public.video_asset_idempotency', 'SELECT,INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'authenticated', 'public.video_asset_idempotency', 'SELECT,INSERT,UPDATE,DELETE'
    )
    and not has_table_privilege(
      'service_role', 'public.video_asset_idempotency', 'SELECT,INSERT,UPDATE,DELETE'
    )
    and (
      select bool_and(
        not has_function_privilege('anon', denied_rpc.rpc_oid::oid, 'EXECUTE')
        and not has_function_privilege(
          'authenticated', denied_rpc.rpc_oid::oid, 'EXECUTE'
        )
      )
      from unnest(array[
        'public.aistory_video_asset_list(text,integer)'::regprocedure::oid,
        'public.aistory_video_asset_get(text,text)'::regprocedure::oid,
        'public.aistory_video_asset_find_idempotency(text,text)'::regprocedure::oid,
        'public.aistory_video_asset_has_object_reference(text,text)'::regprocedure::oid,
        'public.aistory_video_asset_create(jsonb)'::regprocedure::oid,
        'public.aistory_video_asset_mutate(jsonb)'::regprocedure::oid,
        'public.aistory_video_asset_security_posture()'::regprocedure::oid
      ]) as denied_rpc(rpc_oid)
    )
    and has_function_privilege(
      'service_role', 'public.aistory_video_asset_list(text,integer)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.aistory_video_asset_get(text,text)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.aistory_video_asset_find_idempotency(text,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role',
      'public.aistory_video_asset_has_object_reference(text,text)',
      'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.aistory_video_asset_create(jsonb)', 'EXECUTE'
    )
    and has_function_privilege(
      'service_role', 'public.aistory_video_asset_mutate(jsonb)', 'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.aistory_video_asset_assert_service_role()',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.aistory_video_asset_to_json(public.video_assets)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.aistory_video_asset_idempotency_to_json(public.video_asset_idempotency)',
      'EXECUTE'
    )
    and not has_function_privilege(
      'service_role',
      'public.aistory_video_asset_audit_summary(public.video_assets)',
      'EXECUTE'
    )
    and (
      select count(*) = 7
        and bool_and(
          procedure_record.prosecdef
          and coalesce(procedure_record.proconfig, '{}'::text[])
            @> array['search_path=pg_catalog, public']
        )
      from pg_catalog.pg_proc as procedure_record
      where procedure_record.oid = any(array[
        'public.aistory_video_asset_list(text,integer)'::regprocedure::oid,
        'public.aistory_video_asset_get(text,text)'::regprocedure::oid,
        'public.aistory_video_asset_find_idempotency(text,text)'::regprocedure::oid,
        'public.aistory_video_asset_has_object_reference(text,text)'::regprocedure::oid,
        'public.aistory_video_asset_create(jsonb)'::regprocedure::oid,
        'public.aistory_video_asset_mutate(jsonb)'::regprocedure::oid,
        'public.aistory_video_asset_security_posture()'::regprocedure::oid
      ])
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger_record
      where trigger_record.tgrelid = 'public.video_asset_idempotency'::regclass
        and trigger_record.tgname = 'video_asset_idempotency_append_only'
        and trigger_record.tgenabled <> 'D'
        and not trigger_record.tgisinternal
        and trigger_record.tgtype = 27
        and trigger_record.tgfoid =
          'public.aistory_reject_append_only_mutation()'::regprocedure::oid
    )
    and (
      select count(*) = 13
        and bool_and(
          case constraint_record.conname
            when 'video_assets_object_key_check' then constraint_record.contype = 'c'
            when 'video_assets_provider_check' then constraint_record.contype = 'c'
            when 'video_assets_probe_check' then constraint_record.contype = 'c'
            when 'video_assets_audio_flag_check' then constraint_record.contype = 'c'
            when 'video_assets_status_check' then constraint_record.contype = 'c'
            when 'video_assets_binding_check' then constraint_record.contype = 'c'
            when 'video_assets_source_check' then constraint_record.contype = 'c'
            when 'video_assets_pkey' then constraint_record.contype = 'p'
            when 'video_asset_idempotency_pkey' then constraint_record.contype = 'p'
            when 'video_asset_idempotency_asset_fkey' then constraint_record.contype = 'f'
            when 'video_asset_idempotency_key_check' then constraint_record.contype = 'c'
            when 'video_asset_idempotency_fingerprint_check' then constraint_record.contype = 'c'
            when 'video_asset_idempotency_operation_check' then constraint_record.contype = 'c'
            else false
          end
        )
      from pg_catalog.pg_constraint as constraint_record
      where constraint_record.conrelid = any(array[
        'public.video_assets'::regclass,
        'public.video_asset_idempotency'::regclass
      ])
        and constraint_record.conname = any(array[
          'video_assets_object_key_check',
          'video_assets_provider_check',
          'video_assets_probe_check',
          'video_assets_audio_flag_check',
          'video_assets_status_check',
          'video_assets_binding_check',
          'video_assets_source_check',
          'video_assets_pkey',
          'video_asset_idempotency_pkey',
          'video_asset_idempotency_asset_fkey',
          'video_asset_idempotency_key_check',
          'video_asset_idempotency_fingerprint_check',
          'video_asset_idempotency_operation_check'
        ])
        and constraint_record.convalidated
    );
$$;

revoke all on function public.aistory_video_asset_security_posture()
from public, anon, authenticated, service_role;
grant execute on function public.aistory_video_asset_security_posture()
to service_role;

do $$
begin
  if not public.aistory_video_asset_security_posture() then
    raise exception 'video asset metadata security posture unavailable';
  end if;
end;
$$;

insert into public.aistory_schema_gates (gate_name, version)
values ('production_identity_billing', '20260811193000')
on conflict (gate_name) do update
set version = excluded.version,
    installed_at = now();
