-- AIstory anonymous browser subject -> stable phone account claim gate.
--
-- Forward-only. This migration does not enable SMS, billing, or production
-- identity by itself. Apply only after the production identity/billing gate;
-- the application verifies this exact database-owned version before use.

create extension if not exists pgcrypto;

do $$
begin
  if to_regclass('public.app_users') is null
    or to_regclass('public.phone_identities') is null
    or to_regprocedure('public.aistory_verify_phone_and_register(jsonb)') is null
  then
    raise exception 'production identity billing gate prerequisite is missing';
  end if;
end;
$$;

create table if not exists public.anonymous_subject_bindings (
  tenant_id text not null references public.tenants (id),
  anonymous_subject_hash text primary key check (
    anonymous_subject_hash ~ '^[a-f0-9]{64}$'
  ),
  user_id uuid not null references public.app_users (id) on delete cascade,
  bound_at timestamptz not null default now(),
  unique (anonymous_subject_hash, user_id)
);

create table if not exists public.anonymous_subject_claims (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  anonymous_subject_hash text not null check (
    anonymous_subject_hash ~ '^[a-f0-9]{64}$'
  ),
  user_id uuid not null references public.app_users (id) on delete cascade,
  idempotency_key text not null unique check (
    length(idempotency_key) between 16 and 160
  ),
  request_fingerprint text not null check (
    request_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  manifest_version text not null check (
    manifest_version = 'aistory-anonymous-claim-v1'
  ),
  status text not null check (status in ('claimed', 'empty')),
  submitted_story_count integer not null check (
    submitted_story_count between 0 and 50
  ),
  inherited_story_count integer not null check (
    inherited_story_count between 0 and 50
  ),
  inherited_checkpoint_count integer not null check (
    inherited_checkpoint_count between 0 and 25600
  ),
  inherited_cache_reference_count integer not null check (
    inherited_cache_reference_count between 0 and 100
  ),
  inherited_assignment_count integer not null check (
    inherited_assignment_count between 0 and 32
  ),
  skipped_count integer not null check (skipped_count between 0 and 182),
  result_summary jsonb not null,
  claimed_at timestamptz not null default now(),
  foreign key (anonymous_subject_hash, user_id)
    references public.anonymous_subject_bindings (
      anonymous_subject_hash, user_id
    ) on delete restrict deferrable initially deferred
);

create table if not exists public.anonymous_story_claims (
  claim_id uuid not null references public.anonymous_subject_claims (id)
    on delete restrict deferrable initially deferred,
  user_id uuid not null references public.app_users (id) on delete cascade,
  story_record_id text not null check (length(story_record_id) between 1 and 160),
  story_id text not null check (length(story_id) between 1 and 160),
  story_version text not null check (length(story_version) between 1 and 160),
  current_node_id text not null check (length(current_node_id) between 1 and 160),
  current_beat_id text not null check (length(current_beat_id) between 1 and 160),
  timeline_revision text not null check (
    timeline_revision ~ '^[a-f0-9]{64}$'
  ),
  branch_count integer not null check (branch_count between 0 and 128),
  selected_choice_count integer not null check (
    selected_choice_count between 0 and 256
  ),
  checkpoint_count integer not null check (checkpoint_count between 0 and 512),
  local_revision integer not null check (local_revision between 1 and 1000000),
  client_updated_at_ms bigint not null check (client_updated_at_ms >= 0),
  claimed_at timestamptz not null default now(),
  primary key (claim_id, story_record_id)
);

create table if not exists public.anonymous_public_cache_claims (
  claim_id uuid not null references public.anonymous_subject_claims (id)
    on delete restrict deferrable initially deferred,
  user_id uuid not null references public.app_users (id) on delete cascade,
  story_id text not null check (length(story_id) between 1 and 160),
  story_version text not null check (length(story_version) between 1 and 160),
  resource_key text not null check (
    length(resource_key) between 1 and 240
    and left(resource_key, 1) = '/'
    and position('..' in resource_key) = 0
  ),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  claimed_at timestamptz not null default now(),
  primary key (claim_id, resource_key, content_hash)
);

create table if not exists public.user_experiment_assignments (
  tenant_id text not null references public.tenants (id),
  user_id uuid not null references public.app_users (id) on delete cascade,
  experiment_key text not null check (length(experiment_key) between 1 and 160),
  experiment_version text not null check (
    length(experiment_version) between 1 and 160
  ),
  variant_key text not null check (length(variant_key) between 1 and 160),
  source_claim_id uuid references public.anonymous_subject_claims (id)
    on delete restrict deferrable initially deferred,
  assigned_at timestamptz not null default now(),
  primary key (tenant_id, user_id, experiment_key, experiment_version)
);

create table if not exists public.identity_audit_logs (
  id uuid primary key default gen_random_uuid(),
  tenant_id text not null references public.tenants (id),
  actor_app_user_id uuid not null references public.app_users (id)
    on delete restrict,
  action text not null,
  target_type text not null,
  target_id text not null,
  reason text not null,
  idempotency_key text not null unique,
  subject_fingerprint text not null check (
    subject_fingerprint ~ '^[a-f0-9]{12}$'
  ),
  summary jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists anonymous_subject_claims_user_idx
  on public.anonymous_subject_claims (user_id, claimed_at desc);
create index if not exists anonymous_subject_claims_subject_idx
  on public.anonymous_subject_claims (
    anonymous_subject_hash, claimed_at desc
  );
create index if not exists anonymous_story_claims_user_idx
  on public.anonymous_story_claims (user_id, claimed_at desc);
create index if not exists anonymous_public_cache_claims_user_idx
  on public.anonymous_public_cache_claims (user_id, claimed_at desc);
create index if not exists identity_audit_logs_actor_idx
  on public.identity_audit_logs (actor_app_user_id, created_at desc);

create or replace function public.aistory_reject_identity_claim_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception 'identity claim records are append-only';
end;
$$;

revoke all on function public.aistory_reject_identity_claim_mutation()
  from public;

drop trigger if exists anonymous_subject_claims_append_only
  on public.anonymous_subject_claims;
create trigger anonymous_subject_claims_append_only
before update or delete on public.anonymous_subject_claims
for each row execute function public.aistory_reject_identity_claim_mutation();

drop trigger if exists anonymous_subject_bindings_append_only
  on public.anonymous_subject_bindings;
create trigger anonymous_subject_bindings_append_only
before update or delete on public.anonymous_subject_bindings
for each row execute function public.aistory_reject_identity_claim_mutation();

drop trigger if exists anonymous_story_claims_append_only
  on public.anonymous_story_claims;
create trigger anonymous_story_claims_append_only
before update or delete on public.anonymous_story_claims
for each row execute function public.aistory_reject_identity_claim_mutation();

drop trigger if exists anonymous_public_cache_claims_append_only
  on public.anonymous_public_cache_claims;
create trigger anonymous_public_cache_claims_append_only
before update or delete on public.anonymous_public_cache_claims
for each row execute function public.aistory_reject_identity_claim_mutation();

drop trigger if exists identity_audit_logs_append_only
  on public.identity_audit_logs;
create trigger identity_audit_logs_append_only
before update or delete on public.identity_audit_logs
for each row execute function public.aistory_reject_identity_claim_mutation();

create or replace function public.aistory_verify_phone_register_and_claim(
  verification jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  account_result jsonb;
  claim_payload jsonb;
  claim_user_id uuid;
  claim_subject_hash text;
  claim_idempotency_key text;
  claim_fingerprint text;
  claim_manifest_version text;
  claim_reason text;
  submitted_story_count integer;
  inherited_story_count integer := 0;
  inherited_checkpoint_count integer := 0;
  inherited_cache_count integer := 0;
  inherited_assignment_count integer := 0;
  skipped_count integer := 0;
  claim_status text;
  claim_id uuid;
  existing_binding public.anonymous_subject_bindings%rowtype;
  binding_exists boolean := false;
  existing_claim public.anonymous_subject_claims%rowtype;
  story jsonb;
  cache_ref jsonb;
  assignment jsonb;
  existing_variant text;
  accepted_story_ids jsonb := '[]'::jsonb;
  accepted_assignment_keys jsonb := '[]'::jsonb;
  accepted_assignments jsonb := '[]'::jsonb;
  skipped_by_reason jsonb := '{}'::jsonb;
  result_summary jsonb;
  skip_key text;
  skip_value jsonb;
begin
  -- Nested security-definer call remains inside this outer transaction, so OTP
  -- consumption, stable UUID creation, initial grant and claim commit together.
  account_result := public.aistory_verify_phone_and_register(
    verification - 'anonymous_claim'
  );
  if coalesce(account_result->>'status', '') <> 'verified' then
    return account_result;
  end if;

  claim_payload := verification->'anonymous_claim';
  if claim_payload is null or jsonb_typeof(claim_payload) <> 'object' then
    return account_result || jsonb_build_object(
      'claim',
      jsonb_build_object(
        'status', 'not_found',
        'accepted_story_record_ids', '[]'::jsonb,
        'accepted_assignment_keys', '[]'::jsonb,
        'accepted_assignments', '[]'::jsonb,
        'counts', jsonb_build_object(
          'submitted_stories', 0,
          'inherited_stories', 0,
          'inherited_checkpoints', 0,
          'inherited_cache_references', 0,
          'inherited_assignments', 0,
          'skipped', 0
        ),
        'skipped_by_reason', '{}'::jsonb
      )
    );
  end if;

  claim_user_id := (account_result->>'user_id')::uuid;
  claim_subject_hash := claim_payload->>'anonymousSubjectHash';
  claim_idempotency_key := claim_payload->>'idempotencyKey';
  claim_fingerprint := claim_payload->>'requestFingerprint';
  claim_manifest_version := claim_payload->>'manifestVersion';
  claim_reason := claim_payload->>'reason';
  submitted_story_count := coalesce(
    (claim_payload->>'submittedStories')::integer,
    0
  );

  if claim_subject_hash is null
    or claim_subject_hash !~ '^[a-f0-9]{64}$'
    or claim_fingerprint is null
    or claim_fingerprint !~ '^[a-f0-9]{64}$'
    or claim_idempotency_key is null
    or length(claim_idempotency_key) not between 16 and 160
    or claim_idempotency_key !~ '^[A-Za-z0-9:._-]+$'
    or claim_manifest_version is null
    or claim_manifest_version <> 'aistory-anonymous-claim-v1'
    or claim_reason is null
    or claim_reason <> 'same_browser_phone_login'
    or submitted_story_count not between 0 and 50
    or jsonb_typeof(claim_payload->'stories') <> 'array'
    or jsonb_array_length(claim_payload->'stories') > 50
    or jsonb_typeof(claim_payload->'cacheReferences') <> 'array'
    or jsonb_array_length(claim_payload->'cacheReferences') > 100
    or jsonb_typeof(claim_payload->'experimentAssignments') <> 'array'
    or jsonb_array_length(claim_payload->'experimentAssignments') > 32
  then
    return account_result || jsonb_build_object(
      'claim',
      jsonb_build_object(
        'status', 'conflict',
        'accepted_story_record_ids', '[]'::jsonb,
        'accepted_assignment_keys', '[]'::jsonb,
        'accepted_assignments', '[]'::jsonb,
        'counts', jsonb_build_object(
          'submitted_stories', submitted_story_count,
          'inherited_stories', 0,
          'inherited_checkpoints', 0,
          'inherited_cache_references', 0,
          'inherited_assignments', 0,
          'skipped', submitted_story_count
        ),
        'skipped_by_reason',
        jsonb_build_object('manifest_invalid', submitted_story_count)
      )
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(claim_subject_hash, 2901)
  );
  perform pg_advisory_xact_lock(
    hashtextextended(claim_idempotency_key, 2902)
  );

  select * into existing_binding
  from public.anonymous_subject_bindings
  where anonymous_subject_hash = claim_subject_hash
  for update;

  binding_exists := found;
  if binding_exists then
    if existing_binding.user_id <> claim_user_id then
      return account_result || jsonb_build_object(
        'claim',
        jsonb_build_object(
          'status', 'conflict',
          'accepted_story_record_ids', '[]'::jsonb,
          'accepted_assignment_keys', '[]'::jsonb,
          'accepted_assignments', '[]'::jsonb,
          'counts', jsonb_build_object(
            'submitted_stories', submitted_story_count,
            'inherited_stories', 0,
            'inherited_checkpoints', 0,
            'inherited_cache_references', 0,
            'inherited_assignments', 0,
            'skipped', submitted_story_count
          ),
          'skipped_by_reason',
          jsonb_build_object('manifest_invalid', submitted_story_count)
        )
      );
    end if;
  end if;

  select * into existing_claim
  from public.anonymous_subject_claims
  where idempotency_key = claim_idempotency_key
  for update;

  if found then
    if existing_claim.user_id = claim_user_id
      and existing_claim.anonymous_subject_hash = claim_subject_hash
      and existing_claim.request_fingerprint = claim_fingerprint
    then
      return account_result || jsonb_build_object(
        'claim',
        jsonb_set(
          existing_claim.result_summary,
          '{status}',
          to_jsonb('replayed'::text),
          true
        )
      );
    end if;
    return account_result || jsonb_build_object(
      'claim',
      jsonb_build_object(
        'status', 'conflict',
        'accepted_story_record_ids', '[]'::jsonb,
        'accepted_assignment_keys', '[]'::jsonb,
        'accepted_assignments', '[]'::jsonb,
        'counts', jsonb_build_object(
          'submitted_stories', submitted_story_count,
          'inherited_stories', 0,
          'inherited_checkpoints', 0,
          'inherited_cache_references', 0,
          'inherited_assignments', 0,
          'skipped', submitted_story_count
        ),
        'skipped_by_reason',
        jsonb_build_object('manifest_invalid', submitted_story_count)
      )
    );
  end if;

  if not binding_exists then
    insert into public.anonymous_subject_bindings (
      tenant_id, anonymous_subject_hash, user_id
    ) values ('platform', claim_subject_hash, claim_user_id);
  end if;

  claim_id := gen_random_uuid();

  for story in
    select value from jsonb_array_elements(claim_payload->'stories')
  loop
    if jsonb_typeof(story) <> 'object'
      or length(story->>'recordId') not between 1 and 160
      or length(story->>'storyId') not between 1 and 160
      or length(story->>'storyVersion') not between 1 and 160
      or length(story->>'currentNodeId') not between 1 and 160
      or length(story->>'currentBeatId') not between 1 and 160
      or (story->>'timelineRevision') !~ '^[a-f0-9]{64}$'
      or jsonb_typeof(story->'branchIds') <> 'array'
      or jsonb_array_length(story->'branchIds') > 128
      or jsonb_typeof(story->'selectedChoiceIds') <> 'array'
      or jsonb_array_length(story->'selectedChoiceIds') > 256
      or (story->>'checkpointCount')::integer not between 0 and 512
      or (story->>'localRevision')::integer not between 1 and 1000000
      or (story->>'updatedAt')::bigint < 0
    then
      raise exception 'invalid sanitized story claim';
    end if;
    insert into public.anonymous_story_claims (
      claim_id, user_id, story_record_id, story_id, story_version,
      current_node_id, current_beat_id, timeline_revision, branch_count,
      selected_choice_count, checkpoint_count, local_revision,
      client_updated_at_ms
    ) values (
      claim_id, claim_user_id, story->>'recordId', story->>'storyId',
      story->>'storyVersion', story->>'currentNodeId',
      story->>'currentBeatId', story->>'timelineRevision',
      jsonb_array_length(story->'branchIds'),
      jsonb_array_length(story->'selectedChoiceIds'),
      (story->>'checkpointCount')::integer,
      (story->>'localRevision')::integer,
      (story->>'updatedAt')::bigint
    );
    inherited_story_count := inherited_story_count + 1;
    inherited_checkpoint_count := inherited_checkpoint_count
      + (story->>'checkpointCount')::integer;
    accepted_story_ids := accepted_story_ids || to_jsonb(story->>'recordId');
  end loop;

  for cache_ref in
    select value from jsonb_array_elements(claim_payload->'cacheReferences')
  loop
    if jsonb_typeof(cache_ref) <> 'object'
      or length(cache_ref->>'storyId') not between 1 and 160
      or length(cache_ref->>'storyVersion') not between 1 and 160
      or length(cache_ref->>'resourceKey') not between 1 and 240
      or left(cache_ref->>'resourceKey', 1) <> '/'
      or position('..' in cache_ref->>'resourceKey') > 0
      or (cache_ref->>'contentHash') !~ '^[a-f0-9]{64}$'
    then
      raise exception 'invalid sanitized cache claim';
    end if;
    insert into public.anonymous_public_cache_claims (
      claim_id, user_id, story_id, story_version, resource_key, content_hash
    ) values (
      claim_id, claim_user_id, cache_ref->>'storyId',
      cache_ref->>'storyVersion', cache_ref->>'resourceKey',
      cache_ref->>'contentHash'
    );
    inherited_cache_count := inherited_cache_count + 1;
  end loop;

  for assignment in
    select value
    from jsonb_array_elements(claim_payload->'experimentAssignments')
  loop
    if jsonb_typeof(assignment) <> 'object'
      or length(assignment->>'experimentKey') not between 1 and 160
      or length(assignment->>'experimentVersion') not between 1 and 160
      or length(assignment->>'variantKey') not between 1 and 160
    then
      raise exception 'invalid sanitized experiment assignment';
    end if;
    insert into public.user_experiment_assignments (
      tenant_id, user_id, experiment_key, experiment_version,
      variant_key, source_claim_id
    ) values (
      'platform', claim_user_id, assignment->>'experimentKey',
      assignment->>'experimentVersion', assignment->>'variantKey', claim_id
    )
    on conflict do nothing;

    select variant_key into existing_variant
    from public.user_experiment_assignments
    where tenant_id = 'platform'
      and user_id = claim_user_id
      and experiment_key = assignment->>'experimentKey'
      and experiment_version = assignment->>'experimentVersion';
    if existing_variant = assignment->>'variantKey' then
      inherited_assignment_count := inherited_assignment_count + 1;
      accepted_assignment_keys := accepted_assignment_keys || to_jsonb(
        (assignment->>'experimentKey')
        || ':' || (assignment->>'experimentVersion')
      );
      accepted_assignments := accepted_assignments || jsonb_build_array(
        jsonb_build_object(
          'experiment_key', assignment->>'experimentKey',
          'experiment_version', assignment->>'experimentVersion',
          'variant_key', existing_variant
        )
      );
    else
      skipped_count := skipped_count + 1;
      skipped_by_reason := jsonb_set(
        skipped_by_reason,
        '{assignment_unavailable}',
        to_jsonb(coalesce(
          (skipped_by_reason->>'assignment_unavailable')::integer,
          0
        ) + 1),
        true
      );
    end if;
  end loop;

  if jsonb_typeof(claim_payload->'skippedByReason') = 'object' then
    for skip_key, skip_value in
      select key, value
      from jsonb_each(claim_payload->'skippedByReason')
    loop
      if skip_key in (
        'not_published',
        'version_mismatch',
        'node_unavailable',
        'resource_unavailable',
        'assignment_unavailable',
        'manifest_invalid'
      )
        and jsonb_typeof(skip_value) = 'number'
        and (skip_value #>> '{}')::integer between 0 and 182
      then
        skipped_count := skipped_count + (skip_value #>> '{}')::integer;
        skipped_by_reason := jsonb_set(
          skipped_by_reason,
          array[skip_key],
          to_jsonb(
            coalesce((skipped_by_reason->>skip_key)::integer, 0)
            + (skip_value #>> '{}')::integer
          ),
          true
        );
      end if;
    end loop;
  end if;

  claim_status := case
    when inherited_story_count + inherited_cache_count
      + inherited_assignment_count = 0
    then 'empty'
    else 'claimed'
  end;
  result_summary := jsonb_build_object(
    'status', claim_status,
    'claim_id', claim_id,
    'accepted_story_record_ids', accepted_story_ids,
    'accepted_assignment_keys', accepted_assignment_keys,
    'accepted_assignments', accepted_assignments,
    'counts', jsonb_build_object(
      'submitted_stories', submitted_story_count,
      'inherited_stories', inherited_story_count,
      'inherited_checkpoints', inherited_checkpoint_count,
      'inherited_cache_references', inherited_cache_count,
      'inherited_assignments', inherited_assignment_count,
      'skipped', skipped_count
    ),
    'skipped_by_reason', skipped_by_reason
  );

  insert into public.anonymous_subject_claims (
    id, tenant_id, anonymous_subject_hash, user_id, idempotency_key,
    request_fingerprint, manifest_version, status, submitted_story_count,
    inherited_story_count, inherited_checkpoint_count,
    inherited_cache_reference_count, inherited_assignment_count,
    skipped_count, result_summary
  ) values (
    claim_id, 'platform', claim_subject_hash, claim_user_id,
    claim_idempotency_key, claim_fingerprint, claim_manifest_version,
    claim_status, submitted_story_count, inherited_story_count,
    inherited_checkpoint_count, inherited_cache_count,
    inherited_assignment_count, skipped_count, result_summary
  );

  insert into public.identity_audit_logs (
    tenant_id, actor_app_user_id, action, target_type, target_id,
    reason, idempotency_key, subject_fingerprint, summary
  ) values (
    'platform', claim_user_id, 'anonymous.claimed', 'app_user',
    claim_user_id::text, claim_reason, claim_idempotency_key,
    left(claim_subject_hash, 12),
    jsonb_build_object(
      'claimId', claim_id,
      'manifestVersion', claim_manifest_version,
      'submittedStories', submitted_story_count,
      'inheritedStories', inherited_story_count,
      'inheritedCheckpoints', inherited_checkpoint_count,
      'inheritedCacheReferences', inherited_cache_count,
      'inheritedAssignments', inherited_assignment_count,
      'skipped', skipped_count
    )
  );

  return account_result || jsonb_build_object('claim', result_summary);
end;
$$;

create or replace function public.aistory_get_anonymous_claim_receipt(
  anonymous_subject_hash text,
  app_user_id uuid
)
returns jsonb
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select jsonb_set(
    claim.result_summary,
    '{status}',
    to_jsonb('replayed'::text),
    true
  )
  from public.anonymous_subject_claims claim
  join public.app_users app_user on app_user.id = claim.user_id
  where claim.anonymous_subject_hash = aistory_get_anonymous_claim_receipt.anonymous_subject_hash
    and claim.user_id = app_user_id
    and app_user.status = 'active'
  order by claim.claimed_at desc, claim.id desc
  limit 1;
$$;

insert into public.aistory_schema_gates (gate_name, version)
values ('production_identity_billing', '20260729183000')
on conflict (gate_name) do update
set version = excluded.version, installed_at = now();

alter table public.anonymous_subject_claims enable row level security;
alter table public.anonymous_subject_bindings enable row level security;
alter table public.anonymous_story_claims enable row level security;
alter table public.anonymous_public_cache_claims enable row level security;
alter table public.user_experiment_assignments enable row level security;
alter table public.identity_audit_logs enable row level security;

alter table public.anonymous_subject_claims force row level security;
alter table public.anonymous_subject_bindings force row level security;
alter table public.anonymous_story_claims force row level security;
alter table public.anonymous_public_cache_claims force row level security;
alter table public.user_experiment_assignments force row level security;
alter table public.identity_audit_logs force row level security;

revoke all on public.anonymous_subject_claims from public, anon, authenticated;
revoke all on public.anonymous_subject_bindings
  from public, anon, authenticated;
revoke all on public.anonymous_story_claims from public, anon, authenticated;
revoke all on public.anonymous_public_cache_claims
  from public, anon, authenticated;
revoke all on public.user_experiment_assignments
  from public, anon, authenticated;
revoke all on public.identity_audit_logs from public, anon, authenticated;

revoke insert, update, delete on public.anonymous_subject_claims
  from service_role;
revoke insert, update, delete on public.anonymous_subject_bindings
  from service_role;
revoke insert, update, delete on public.anonymous_story_claims
  from service_role;
revoke insert, update, delete on public.anonymous_public_cache_claims
  from service_role;
revoke insert, update, delete on public.user_experiment_assignments
  from service_role;
revoke insert, update, delete on public.identity_audit_logs
  from service_role;

revoke all on function public.aistory_verify_phone_register_and_claim(jsonb)
  from public, anon, authenticated;
revoke all on function public.aistory_get_anonymous_claim_receipt(text, uuid)
  from public, anon, authenticated;
grant execute on function public.aistory_verify_phone_register_and_claim(jsonb)
  to service_role;
grant execute on function public.aistory_get_anonymous_claim_receipt(text, uuid)
  to service_role;
