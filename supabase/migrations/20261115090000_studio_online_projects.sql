-- AIstory Studio online projects (forward-only).
--
-- Adds owner-private durable storage for `/studio` online works, an explicitly
-- published safe snapshot, and service-role-only security-definer RPCs.
--
-- This migration is intentionally independent of the shared production
-- identity/billing gate. It registers its own schema-gate row and its own
-- security-posture function, so an applied Gate14 (or Gate15/Gate16) posture is
-- never treated as proof that this table exists, is forced-RLS, or has no
-- browser grants.
--
-- Apply once, in filename order, after 20260901040000_aiuser_account_link_gate.sql.
-- There is no reverse migration; the supported rollback is turning the exact
-- feature selector off (`AISTORY_STUDIO_PROJECTS_MODE` unset).

set local search_path = pg_catalog;
set local check_function_bodies = on;

-- A one-time forward migration must never adopt an ambiguous preexisting
-- relation, gate row, or overload whose grants may survive replacement.
do $studio_preflight$
begin
  if current_user <> 'postgres' or session_user <> 'postgres'
    or not exists(select 1 from pg_roles where oid='postgres'::regrole and (rolsuper or rolbypassrls))
    or to_regclass('public.aistory_schema_gates') is null
    or exists(select 1 from public.aistory_schema_gates where gate_name='studio_online_projects')
    or to_regclass('public.studio_projects') is not null
    or to_regclass('public.studio_project_catalog_manifest') is not null
    or exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
      where n.nspname='public' and p.proname in (
        'aistory_studio_projects_gate_status','aistory_studio_project_create',
        'aistory_studio_project_revise','aistory_studio_project_publish',
        'aistory_studio_project_set_visibility','aistory_studio_project_get_owner',
        'aistory_studio_project_list_owner','aistory_studio_project_get_public',
        'aistory_studio_project_security_posture','aistory_studio_project_catalog',
        'aistory_studio_catalog_immutable')) then
    raise exception 'STUDIO_PROJECT_GATE_PRESTATE_REJECTED' using errcode='55000';
  end if;
end;
$studio_preflight$;

-- Owner-private authoring row.
--
-- `visibility` deliberately defaults to 'hidden' and an unpublished row cannot
-- carry a published pointer. The explicit publish RPC is the only place where
-- the "public by default" product rule is applied.
create table public.studio_projects (
  id uuid primary key default gen_random_uuid(),
  owner_key text not null check (owner_key ~ '^[a-f0-9]{64}$'),
  draft jsonb not null,
  draft_hash text not null check (draft_hash ~ '^[a-f0-9]{64}$'),
  title text not null check (char_length(title) between 1 and 200),
  scene_count integer not null check (scene_count between 1 and 100),
  visibility text not null default 'hidden' check (visibility in ('hidden', 'public')),
  published_snapshot jsonb,
  published_hash text check (published_hash is null or published_hash ~ '^[a-f0-9]{64}$'),
  published_revision integer check (
    published_revision is null
    or published_revision between 1 and 1000000000
  ),
  published_at timestamptz,
  revision integer not null default 1 check (revision between 1 and 1000000000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint studio_projects_publish_consistency check (
    (
      published_snapshot is null
      and published_hash is null
      and published_revision is null
      and published_at is null
      and visibility = 'hidden'
    )
    or (
      published_snapshot is not null
      and published_hash is not null
      and published_revision is not null
      and published_at is not null
    )
  )
);

create index studio_projects_owner_order_idx
  on public.studio_projects (owner_key, created_at desc, id);

insert into public.aistory_schema_gates (gate_name, version)
values ('studio_online_projects', '20261115090000')
;

-- Database-owned gate version. The application compares this exact value and
-- never trusts the environment pin on its own.
create function public.aistory_studio_projects_gate_status()
returns text
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select version
  from public.aistory_schema_gates
  where gate_name = 'studio_online_projects';
$$;

-- Create: owner + private draft, hidden and unpublished by construction.
create function public.aistory_studio_project_create(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_owner text;
  v_draft jsonb;
  v_hash text;
  v_title text;
  v_scenes integer;
  v_count integer;
  v_row public.studio_projects;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'STUDIO_INVALID_PAYLOAD' using errcode = '22023';
  end if;

  v_owner := payload ->> 'owner_key';
  if v_owner is null or v_owner !~ '^[a-f0-9]{64}$' then
    raise exception 'STUDIO_INVALID_OWNER' using errcode = '22023';
  end if;

  v_draft := payload -> 'draft';
  if v_draft is null or jsonb_typeof(v_draft) <> 'object' then
    raise exception 'STUDIO_INVALID_DRAFT' using errcode = '22023';
  end if;

  v_hash := payload ->> 'draft_hash';
  if v_hash is null or v_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'STUDIO_INVALID_DRAFT' using errcode = '22023';
  end if;

  v_title := v_draft ->> 'title';
  if v_title is null or char_length(v_title) < 1 or char_length(v_title) > 200 then
    raise exception 'STUDIO_INVALID_TITLE' using errcode = '22023';
  end if;

  if jsonb_typeof(v_draft -> 'scenes') is distinct from 'array' then
    raise exception 'STUDIO_INVALID_SCENES' using errcode = '22023';
  end if;

  v_scenes := jsonb_array_length(v_draft -> 'scenes');
  if v_scenes < 1 or v_scenes > 100 then
    raise exception 'STUDIO_INVALID_SCENES' using errcode = '22023';
  end if;

  -- Serialize the per-owner capacity decision across instances.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('studio-projects:' || v_owner, 0)
  );

  select count(*) into v_count
  from public.studio_projects
  where owner_key = v_owner;

  if v_count >= 100 then
    return jsonb_build_object('outcome', 'limit_reached');
  end if;

  insert into public.studio_projects (
    owner_key, draft, draft_hash, title, scene_count, revision
  ) values (
    v_owner, v_draft, v_hash, v_title, v_scenes, 1
  )
  returning * into v_row;

  return jsonb_build_object(
    'outcome', 'created',
    'project', jsonb_build_object(
      'id', v_row.id,
      'revision', v_row.revision,
      'draft', v_row.draft,
      'visibility', v_row.visibility,
      'published', false,
      'published_revision', null,
      'created_at', to_char(v_row.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updated_at', to_char(v_row.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'published_at', null
    )
  );
end;
$$;

-- Revise: atomic owner + exact revision predicate. A wrong owner is reported as
-- not_found, so ownership can never be probed from this RPC.
create function public.aistory_studio_project_revise(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_owner text;
  v_id uuid;
  v_expected bigint;
  v_draft jsonb;
  v_hash text;
  v_title text;
  v_scenes integer;
  v_current integer;
  v_row public.studio_projects;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'STUDIO_INVALID_PAYLOAD' using errcode = '22023';
  end if;

  v_owner := payload ->> 'owner_key';
  if v_owner is null or v_owner !~ '^[a-f0-9]{64}$' then
    raise exception 'STUDIO_INVALID_OWNER' using errcode = '22023';
  end if;

  begin
    v_id := (payload ->> 'project_id')::uuid;
  exception when others then
    raise exception 'STUDIO_INVALID_ID' using errcode = '22023';
  end;

  begin
    v_expected := (payload ->> 'expected_revision')::bigint;
  exception when others then
    raise exception 'STUDIO_INVALID_REVISION' using errcode = '22023';
  end;

  if v_expected is null or v_expected < 1 then
    raise exception 'STUDIO_INVALID_REVISION' using errcode = '22023';
  end if;

  v_draft := payload -> 'draft';
  if v_draft is null or jsonb_typeof(v_draft) <> 'object' then
    raise exception 'STUDIO_INVALID_DRAFT' using errcode = '22023';
  end if;

  v_hash := payload ->> 'draft_hash';
  if v_hash is null or v_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'STUDIO_INVALID_DRAFT' using errcode = '22023';
  end if;

  v_title := v_draft ->> 'title';
  if v_title is null or char_length(v_title) < 1 or char_length(v_title) > 200 then
    raise exception 'STUDIO_INVALID_TITLE' using errcode = '22023';
  end if;

  if jsonb_typeof(v_draft -> 'scenes') is distinct from 'array' then
    raise exception 'STUDIO_INVALID_SCENES' using errcode = '22023';
  end if;

  v_scenes := jsonb_array_length(v_draft -> 'scenes');
  if v_scenes < 1 or v_scenes > 100 then
    raise exception 'STUDIO_INVALID_SCENES' using errcode = '22023';
  end if;

  update public.studio_projects
     set draft = v_draft,
         draft_hash = v_hash,
         title = v_title,
         scene_count = v_scenes,
         revision = revision + 1,
         updated_at = now()
   where id = v_id
     and owner_key = v_owner
     and revision = v_expected
  returning * into v_row;

  if found then
    return jsonb_build_object(
      'outcome', 'updated',
      'project', jsonb_build_object(
        'id', v_row.id,
        'revision', v_row.revision,
        'draft', v_row.draft,
        'visibility', v_row.visibility,
        'published', v_row.published_snapshot is not null,
        'published_revision', v_row.published_revision,
        'created_at', to_char(v_row.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updated_at', to_char(v_row.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'published_at', case
          when v_row.published_at is null then null
          else to_char(v_row.published_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        end
      )
    );
  end if;

  select revision into v_current
  from public.studio_projects
  where id = v_id and owner_key = v_owner;

  if v_current is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  return jsonb_build_object('outcome', 'conflict');
end;
$$;

-- Publish: the only place that stores a published snapshot and applies the
-- "public by default" rule. Replaces the previous snapshot atomically.
create function public.aistory_studio_project_publish(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_owner text;
  v_id uuid;
  v_expected bigint;
  v_visibility text;
  v_published jsonb;
  v_hash text;
  v_current integer;
  v_row public.studio_projects;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'STUDIO_INVALID_PAYLOAD' using errcode = '22023';
  end if;

  v_owner := payload ->> 'owner_key';
  if v_owner is null or v_owner !~ '^[a-f0-9]{64}$' then
    raise exception 'STUDIO_INVALID_OWNER' using errcode = '22023';
  end if;

  begin
    v_id := (payload ->> 'project_id')::uuid;
  exception when others then
    raise exception 'STUDIO_INVALID_ID' using errcode = '22023';
  end;

  begin
    v_expected := (payload ->> 'expected_revision')::bigint;
  exception when others then
    raise exception 'STUDIO_INVALID_REVISION' using errcode = '22023';
  end;

  if v_expected is null or v_expected < 1 then
    raise exception 'STUDIO_INVALID_REVISION' using errcode = '22023';
  end if;

  v_visibility := payload ->> 'visibility';
  if v_visibility is null or v_visibility not in ('public', 'hidden') then
    raise exception 'STUDIO_INVALID_VISIBILITY' using errcode = '22023';
  end if;

  v_published := payload -> 'published';
  if v_published is null or jsonb_typeof(v_published) <> 'object' then
    raise exception 'STUDIO_INVALID_PUBLISHED' using errcode = '22023';
  end if;

  v_hash := payload ->> 'published_hash';
  if v_hash is null or v_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'STUDIO_INVALID_PUBLISHED' using errcode = '22023';
  end if;

  update public.studio_projects
     set published_snapshot = v_published,
         published_hash = v_hash,
         published_revision = revision + 1,
         published_at = now(),
         visibility = v_visibility,
         revision = revision + 1,
         updated_at = now()
   where id = v_id
     and owner_key = v_owner
     and revision = v_expected
  returning * into v_row;

  if found then
    return jsonb_build_object(
      'outcome', 'published',
      'project', jsonb_build_object(
        'id', v_row.id,
        'revision', v_row.revision,
        'draft', v_row.draft,
        'visibility', v_row.visibility,
        'published', true,
        'published_revision', v_row.published_revision,
        'created_at', to_char(v_row.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updated_at', to_char(v_row.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'published_at', to_char(v_row.published_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    );
  end if;

  select revision into v_current
  from public.studio_projects
  where id = v_id and owner_key = v_owner;

  if v_current is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  return jsonb_build_object('outcome', 'conflict');
end;
$$;

-- Visibility toggle for an already published work.
create function public.aistory_studio_project_set_visibility(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_owner text;
  v_id uuid;
  v_expected bigint;
  v_visibility text;
  v_current integer;
  v_published boolean;
  v_row public.studio_projects;
begin
  if payload is null or jsonb_typeof(payload) <> 'object' then
    raise exception 'STUDIO_INVALID_PAYLOAD' using errcode = '22023';
  end if;

  v_owner := payload ->> 'owner_key';
  if v_owner is null or v_owner !~ '^[a-f0-9]{64}$' then
    raise exception 'STUDIO_INVALID_OWNER' using errcode = '22023';
  end if;

  begin
    v_id := (payload ->> 'project_id')::uuid;
  exception when others then
    raise exception 'STUDIO_INVALID_ID' using errcode = '22023';
  end;

  begin
    v_expected := (payload ->> 'expected_revision')::bigint;
  exception when others then
    raise exception 'STUDIO_INVALID_REVISION' using errcode = '22023';
  end;

  if v_expected is null or v_expected < 1 then
    raise exception 'STUDIO_INVALID_REVISION' using errcode = '22023';
  end if;

  v_visibility := payload ->> 'visibility';
  if v_visibility is null or v_visibility not in ('public', 'hidden') then
    raise exception 'STUDIO_INVALID_VISIBILITY' using errcode = '22023';
  end if;

  update public.studio_projects
     set visibility = v_visibility,
         revision = revision + 1,
         updated_at = now()
   where id = v_id
     and owner_key = v_owner
     and revision = v_expected
     and published_snapshot is not null
  returning * into v_row;

  if found then
    return jsonb_build_object(
      'outcome', 'updated',
      'project', jsonb_build_object(
        'id', v_row.id,
        'revision', v_row.revision,
        'draft', v_row.draft,
        'visibility', v_row.visibility,
        'published', true,
        'published_revision', v_row.published_revision,
        'created_at', to_char(v_row.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updated_at', to_char(v_row.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'published_at', to_char(v_row.published_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    );
  end if;

  select revision, published_snapshot is not null into v_current, v_published
  from public.studio_projects
  where id = v_id and owner_key = v_owner;

  if v_current is null then
    return jsonb_build_object('outcome', 'not_found');
  end if;

  if v_current <> v_expected then
    return jsonb_build_object('outcome', 'conflict');
  end if;

  return jsonb_build_object('outcome', 'not_published');
end;
$$;

-- Owner read: exact owner scope, never a cross-owner lookup.
create function public.aistory_studio_project_get_owner(
  owner_key text,
  project_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.studio_projects;
  v_owner text;
begin
  if owner_key is null or owner_key !~ '^[a-f0-9]{64}$' then
    raise exception 'STUDIO_INVALID_OWNER' using errcode = '22023';
  end if;
  v_owner := owner_key;

  select * into v_row
  from public.studio_projects as project
  where project.id = project_id and project.owner_key = v_owner;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'revision', v_row.revision,
    'draft', v_row.draft,
    'visibility', v_row.visibility,
    'published', v_row.published_snapshot is not null,
    'published_revision', v_row.published_revision,
    'created_at', to_char(v_row.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updated_at', to_char(v_row.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'published_at', case
      when v_row.published_at is null then null
      else to_char(v_row.published_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    end
  );
end;
$$;

-- Owner list: deterministic newest-first page with a bounded page size.
create function public.aistory_studio_project_list_owner(
  owner_key text,
  page_offset integer,
  page_limit integer
)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_items jsonb;
  v_more boolean;
  v_owner text;
begin
  if owner_key is null or owner_key !~ '^[a-f0-9]{64}$' then
    raise exception 'STUDIO_INVALID_OWNER' using errcode = '22023';
  end if;
  v_owner := owner_key;

  if page_offset is null or page_offset < 0 or page_offset > 1000000 then
    raise exception 'STUDIO_INVALID_PAGE' using errcode = '22023';
  end if;

  if page_limit is null or page_limit < 1 or page_limit > 50 then
    raise exception 'STUDIO_INVALID_PAGE' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(item order by sort_created_at desc, sort_id), '[]'::jsonb)
  into v_items
  from (
    select
      row_value.created_at as sort_created_at,
      row_value.id as sort_id,
      jsonb_build_object(
        'id', row_value.id,
        'revision', row_value.revision,
        'draft', row_value.draft,
        'visibility', row_value.visibility,
        'published', row_value.published_snapshot is not null,
        'published_revision', row_value.published_revision,
        'created_at', to_char(row_value.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updated_at', to_char(row_value.updated_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'published_at', case
          when row_value.published_at is null then null
          else to_char(row_value.published_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        end
      ) as item
    from public.studio_projects row_value
    where row_value.owner_key = v_owner
    order by row_value.created_at desc, row_value.id
    offset page_offset
    limit page_limit
  ) page;

  select exists (
    select 1
    from public.studio_projects row_value
    where row_value.owner_key = v_owner
    order by row_value.created_at desc, row_value.id
    offset (page_offset + page_limit)
    limit 1
  ) into v_more;

  return jsonb_build_object('items', v_items, 'has_more', v_more);
end;
$$;

-- Public read: the published safe snapshot only, and only while public.
-- A hidden or unknown id returns null; the two states are indistinguishable.
create function public.aistory_studio_project_get_public(project_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare
  v_row public.studio_projects;
begin
  if project_id is null then
    return null;
  end if;

  select * into v_row
  from public.studio_projects
  where id = project_id
    and visibility = 'public'
    and published_snapshot is not null;

  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_row.id,
    'revision', v_row.published_revision,
    'published_at', to_char(v_row.published_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'title', v_row.published_snapshot ->> 'title',
    'synopsis', v_row.published_snapshot -> 'synopsis',
    'scenes', v_row.published_snapshot -> 'scenes'
  );
end;
$$;

-- Independent posture gate for this table and these RPCs. The application calls
-- this before every first use per worker; a false result is an honest 503.
create function public.aistory_studio_project_security_posture()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  with required_functions(name) as (
    values
      ('aistory_studio_projects_gate_status'),
      ('aistory_studio_project_create'),
      ('aistory_studio_project_revise'),
      ('aistory_studio_project_publish'),
      ('aistory_studio_project_set_visibility'),
      ('aistory_studio_project_get_owner'),
      ('aistory_studio_project_list_owner'),
      ('aistory_studio_project_get_public'),
      ('aistory_studio_project_security_posture')
  ),
  table_posture as (
    select
      c.relrowsecurity,
      c.relforcerowsecurity,
      c.relacl,
      c.relowner
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname = 'studio_projects'
      and c.relkind = 'r'
  )
  select
    coalesce((select count(*) = 1 from table_posture), false)
    and coalesce(
      (select relrowsecurity and relforcerowsecurity from table_posture),
      false
    )
    and not exists (
      select 1
      from pg_catalog.pg_policies p
      where p.schemaname = 'public' and p.tablename = 'studio_projects'
    )
    and not exists (
      select 1
      from table_posture t
      cross join lateral pg_catalog.aclexplode(
        coalesce(t.relacl, pg_catalog.acldefault('r', t.relowner))
      ) a
      where a.grantee = 0
        or a.grantee in (
          select r.oid from pg_catalog.pg_roles r
          where r.rolname in ('anon', 'authenticated', 'service_role')
        )
    )
    and exists (
      select 1
      from table_posture t
      join pg_catalog.pg_roles r on r.oid = t.relowner
      where r.rolsuper or r.rolbypassrls
    )
    and not exists (
      select 1
      from required_functions f
      where not exists (
        select 1
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname = f.name
          and p.prosecdef
          and p.proconfig is not null
      )
    )
    and not exists (
      select 1
      from pg_catalog.pg_proc p
      join pg_catalog.pg_namespace n on n.oid = p.pronamespace
      join required_functions f on f.name = p.proname
      cross join lateral pg_catalog.aclexplode(
        coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
      ) a
      where n.nspname = 'public'
        and (
          a.grantee = 0
          or a.grantee in (
            select r.oid from pg_catalog.pg_roles r
            where r.rolname in ('anon', 'authenticated')
          )
        )
    )
    and not exists (
      select 1
      from required_functions f
      where not exists (
        select 1
        from pg_catalog.pg_proc p
        join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        cross join lateral pg_catalog.aclexplode(
          coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
        ) a
        join pg_catalog.pg_roles r on r.oid = a.grantee
        where n.nspname = 'public'
          and p.proname = f.name
          and r.rolname = 'service_role'
          and a.privilege_type = 'EXECUTE'
      )
    );
$$;

-- Owner-only storage: forced RLS with no policy, and no direct grant for any
-- browser or service role. Only the security-definer RPCs touch this table.
alter table public.studio_projects enable row level security;
alter table public.studio_projects force row level security;

revoke all on public.studio_projects from public, anon, authenticated, service_role;

revoke all on function public.aistory_studio_projects_gate_status() from public;
revoke all on function public.aistory_studio_project_create(jsonb) from public;
revoke all on function public.aistory_studio_project_revise(jsonb) from public;
revoke all on function public.aistory_studio_project_publish(jsonb) from public;
revoke all on function public.aistory_studio_project_set_visibility(jsonb) from public;
revoke all on function public.aistory_studio_project_get_owner(text, uuid) from public;
revoke all on function public.aistory_studio_project_list_owner(text, integer, integer) from public;
revoke all on function public.aistory_studio_project_get_public(uuid) from public;
revoke all on function public.aistory_studio_project_security_posture() from public;

revoke all on function public.aistory_studio_projects_gate_status() from anon, authenticated;
revoke all on function public.aistory_studio_project_create(jsonb) from anon, authenticated;
revoke all on function public.aistory_studio_project_revise(jsonb) from anon, authenticated;
revoke all on function public.aistory_studio_project_publish(jsonb) from anon, authenticated;
revoke all on function public.aistory_studio_project_set_visibility(jsonb) from anon, authenticated;
revoke all on function public.aistory_studio_project_get_owner(text, uuid) from anon, authenticated;
revoke all on function public.aistory_studio_project_list_owner(text, integer, integer) from anon, authenticated;
revoke all on function public.aistory_studio_project_get_public(uuid) from anon, authenticated;
revoke all on function public.aistory_studio_project_security_posture() from anon, authenticated;

grant execute on function public.aistory_studio_projects_gate_status() to service_role;
grant execute on function public.aistory_studio_project_create(jsonb) to service_role;
grant execute on function public.aistory_studio_project_revise(jsonb) to service_role;
grant execute on function public.aistory_studio_project_publish(jsonb) to service_role;
grant execute on function public.aistory_studio_project_set_visibility(jsonb) to service_role;
grant execute on function public.aistory_studio_project_get_owner(text, uuid) to service_role;
grant execute on function public.aistory_studio_project_list_owner(text, integer, integer) to service_role;
grant execute on function public.aistory_studio_project_get_public(uuid) to service_role;
grant execute on function public.aistory_studio_project_security_posture() to service_role;

-- Immutable owner-only commitment over the installed catalog. The posture
-- function below compares live PG16 definitions with this first-install record.
create table public.studio_project_catalog_manifest (
  object_key text not null primary key,
  definition_sha256 text not null check (definition_sha256 ~ '^[a-f0-9]{64}$')
);
alter table public.studio_project_catalog_manifest enable row level security;
alter table public.studio_project_catalog_manifest force row level security;
revoke all on public.studio_project_catalog_manifest from public, anon, authenticated, service_role;

create function public.aistory_studio_catalog_immutable()
returns trigger language plpgsql set search_path=pg_catalog as $$
begin
  raise exception 'STUDIO_CATALOG_IMMUTABLE' using errcode='55000';
end;
$$;
revoke all on function public.aistory_studio_catalog_immutable() from public, anon, authenticated, service_role;
create trigger studio_project_catalog_immutable
  before update or delete or truncate on public.studio_project_catalog_manifest
  for each statement execute function public.aistory_studio_catalog_immutable();

create function public.aistory_studio_project_catalog()
returns table(object_key text,definition_sha256 text)
language sql set search_path=pg_catalog as $$
  with studio_tables(oid) as (values
    ('public.studio_projects'::regclass),
    ('public.studio_project_catalog_manifest'::regclass)),
  studio_functions(oid) as (values
    ('public.aistory_studio_projects_gate_status()'::regprocedure),
    ('public.aistory_studio_project_create(jsonb)'::regprocedure),
    ('public.aistory_studio_project_revise(jsonb)'::regprocedure),
    ('public.aistory_studio_project_publish(jsonb)'::regprocedure),
    ('public.aistory_studio_project_set_visibility(jsonb)'::regprocedure),
    ('public.aistory_studio_project_get_owner(text,uuid)'::regprocedure),
    ('public.aistory_studio_project_list_owner(text,integer,integer)'::regprocedure),
    ('public.aistory_studio_project_get_public(uuid)'::regprocedure),
    ('public.aistory_studio_project_security_posture()'::regprocedure),
    ('public.aistory_studio_catalog_immutable()'::regprocedure),
    ('public.aistory_studio_project_catalog()'::regprocedure))
  select 'constraint:'||c.conrelid::regclass::text||':'||c.conname,
    encode(sha256(convert_to(pg_get_constraintdef(c.oid,true),'UTF8')),'hex')
    from pg_constraint c where c.conrelid in (select oid from studio_tables)
  union all
  select 'default:'||a.attrelid::regclass::text||':'||a.attname,
    encode(sha256(convert_to(pg_get_expr(d.adbin,d.adrelid,true),'UTF8')),'hex')
    from pg_attribute a join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid in (select oid from studio_tables) and a.attnum>0 and not a.attisdropped
  union all
  select 'function:'||p.oid::regprocedure::text,
    encode(sha256(convert_to(pg_get_functiondef(p.oid),'UTF8')),'hex')
    from pg_proc p where p.oid in (select oid from studio_functions)
  union all
  select 'index:'||i.indexrelid::regclass::text,
    encode(sha256(convert_to(pg_get_indexdef(i.indexrelid),'UTF8')),'hex')
    from pg_index i where i.indrelid in (select oid from studio_tables)
  union all
  select 'trigger:'||t.tgrelid::regclass::text||':'||t.tgname,
    encode(sha256(convert_to(pg_get_triggerdef(t.oid,true),'UTF8')),'hex')
    from pg_trigger t where t.tgrelid in (select oid from studio_tables) and not t.tgisinternal;
$$;
revoke all on function public.aistory_studio_project_catalog() from public, anon, authenticated, service_role;

-- Replace the bootstrap posture body while retaining its now-exact grant. The
-- manifest is inserted only after this final definition exists.
create or replace function public.aistory_studio_project_security_posture()
returns boolean language plpgsql stable security definer set search_path=pg_catalog as $$
declare
  v_table oid;
  v_function oid;
  v_columns text[];
begin
  if current_setting('request.jwt.claim.role',true) is distinct from 'service_role'
    and session_user <> 'postgres' then return false; end if;
  if current_user <> 'postgres'
    or (select version from public.aistory_schema_gates where gate_name='studio_online_projects')
      is distinct from '20261115090000' then return false; end if;

  foreach v_table in array array[
    'public.studio_projects'::regclass,
    'public.studio_project_catalog_manifest'::regclass] loop
    if not exists(select 1 from pg_class where oid=v_table and relkind='r'
      and relpersistence='p' and relrowsecurity and relforcerowsecurity
      and relowner='postgres'::regrole)
      or exists(select 1 from pg_policy where polrelid=v_table)
      or exists(select 1 from pg_rewrite where ev_class=v_table)
      or exists(select 1 from pg_class c,
        lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        where c.oid=v_table and a.grantee <> 'postgres'::regrole)
      or exists(select 1 from pg_attribute a, lateral aclexplode(a.attacl) x
        where a.attrelid=v_table and x.grantee <> 'postgres'::regrole)
      then return false; end if;
    select array_agg(attname::text||':'||format_type(atttypid,atttypmod)||':'||attnotnull::text order by attnum)
      into v_columns from pg_attribute where attrelid=v_table and attnum>0 and not attisdropped;
    if v_table='public.studio_projects'::regclass and v_columns is distinct from
      array['id:uuid:true','owner_key:text:true','draft:jsonb:true','draft_hash:text:true',
        'title:text:true','scene_count:integer:true','visibility:text:true',
        'published_snapshot:jsonb:false','published_hash:text:false',
        'published_revision:integer:false','published_at:timestamp with time zone:false',
        'revision:integer:true','created_at:timestamp with time zone:true',
        'updated_at:timestamp with time zone:true'] then return false;
    elsif v_table='public.studio_project_catalog_manifest'::regclass and v_columns is distinct from
      array['object_key:text:true','definition_sha256:text:true'] then return false;
    end if;
  end loop;

  if exists(select 1 from pg_trigger where tgrelid='public.studio_projects'::regclass and not tgisinternal)
    or (select count(*) from pg_trigger where tgrelid='public.studio_project_catalog_manifest'::regclass
      and not tgisinternal)<>1
    or not exists(select 1 from pg_trigger where tgrelid='public.studio_project_catalog_manifest'::regclass
      and not tgisinternal and tgname='studio_project_catalog_immutable'
      and tgenabled='O' and tgfoid='public.aistory_studio_catalog_immutable()'::regprocedure
      and tgtype=58) then return false; end if;

  foreach v_function in array array[
    'public.aistory_studio_projects_gate_status()'::regprocedure,
    'public.aistory_studio_project_create(jsonb)'::regprocedure,
    'public.aistory_studio_project_revise(jsonb)'::regprocedure,
    'public.aistory_studio_project_publish(jsonb)'::regprocedure,
    'public.aistory_studio_project_set_visibility(jsonb)'::regprocedure,
    'public.aistory_studio_project_get_owner(text,uuid)'::regprocedure,
    'public.aistory_studio_project_list_owner(text,integer,integer)'::regprocedure,
    'public.aistory_studio_project_get_public(uuid)'::regprocedure,
    'public.aistory_studio_project_security_posture()'::regprocedure,
    'public.aistory_studio_catalog_immutable()'::regprocedure,
    'public.aistory_studio_project_catalog()'::regprocedure] loop
    if not exists(select 1 from pg_proc where oid=v_function and proowner='postgres'::regrole
      and not proleakproof
      and prosecdef=(v_function not in (
        'public.aistory_studio_catalog_immutable()'::regprocedure,
        'public.aistory_studio_project_catalog()'::regprocedure))
      and proconfig=(case when v_function in (
        'public.aistory_studio_catalog_immutable()'::regprocedure,
        'public.aistory_studio_project_catalog()'::regprocedure,
        'public.aistory_studio_project_security_posture()'::regprocedure)
        then array['search_path=pg_catalog']
        else array['search_path=pg_catalog, public'] end))
      or exists(select 1 from pg_proc p,
        lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        where p.oid=v_function and a.grantee not in ('postgres'::regrole,'service_role'::regrole))
      then return false; end if;
    if v_function in (
      'public.aistory_studio_catalog_immutable()'::regprocedure,
      'public.aistory_studio_project_catalog()'::regprocedure) then
      if has_function_privilege('service_role',v_function,'EXECUTE') then return false; end if;
    elsif not has_function_privilege('service_role',v_function,'EXECUTE') then return false;
    end if;
  end loop;

  if exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in (
      'aistory_studio_projects_gate_status','aistory_studio_project_create',
      'aistory_studio_project_revise','aistory_studio_project_publish',
      'aistory_studio_project_set_visibility','aistory_studio_project_get_owner',
      'aistory_studio_project_list_owner','aistory_studio_project_get_public',
      'aistory_studio_project_security_posture','aistory_studio_project_catalog',
      'aistory_studio_catalog_immutable')
    group by p.proname having count(*)<>1) then return false; end if;

  if exists(
    (select object_key,definition_sha256 from public.aistory_studio_project_catalog()
      except select object_key,definition_sha256 from public.studio_project_catalog_manifest)
    union all
    (select object_key,definition_sha256 from public.studio_project_catalog_manifest
      except select object_key,definition_sha256 from public.aistory_studio_project_catalog())
  ) then return false; end if;
  return true;
exception when others then return false;
end;
$$;

insert into public.studio_project_catalog_manifest(object_key,definition_sha256)
select object_key,definition_sha256 from public.aistory_studio_project_catalog();

do $studio_postflight$
begin
  if public.aistory_studio_project_security_posture() is distinct from true then
    raise exception 'STUDIO_PROJECT_POSTURE_FAILED' using errcode='55000';
  end if;
end;
$studio_postflight$;
