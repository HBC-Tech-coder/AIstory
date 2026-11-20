-- Gate16 is a forward-only safety gate for the P0.5 qualification incident.
-- Applying this file installs the retirement contract but never retires a
-- principal. An empty Gate15 baseline advances as not_required; a non-empty
-- baseline stays on Gate15 until the owner-only finalizer verifies both proofs.
-- Finalization is database-owner-only and requires a one-time protected
-- attestation commitment plus an exact database-computed pre-state commitment.

do $$
declare
  v_database_owner text;
  v_gate_version text;
begin
  select pg_catalog.pg_get_userbyid(database_row.datdba)
  into strict v_database_owner
  from pg_catalog.pg_database as database_row
  where database_row.datname = pg_catalog.current_database();
  if session_user is distinct from v_database_owner
    or current_user is distinct from v_database_owner then
    raise exception 'independent administrator Gate16 database owner unavailable';
  end if;
  select gate_row.version into v_gate_version
  from public.aistory_schema_gates as gate_row
  where gate_row.gate_name = 'independent_admin_principal';

  if v_gate_version is distinct from '20260828233000'
    or public.aistory_independent_admin_security_posture()
      is distinct from true
    or public.aistory_database_gate_status() is distinct from '20260811193000'
    or public.aistory_database_security_posture() is distinct from true
    or public.aistory_admin_rpc_security_posture() is distinct from true
    or to_regclass(
      'public.independent_admin_qualification_resolutions'
    ) is not null
    or exists (
      select 1
      from information_schema.columns as column_row
      where column_row.table_schema = 'public'
        and column_row.table_name = 'independent_admin_principals'
        and column_row.column_name in (
          'qualification_resolution_ref',
          'qualification_pre_state_sha256',
          'qualification_retired_at'
        )
    ) then
    raise exception 'independent administrator Gate16 prerequisite unavailable';
  end if;
  if (
    (select count(*) from public.independent_admin_principals) = 0
    and (
      exists (select 1 from public.independent_admin_login_buckets)
      or exists (select 1 from public.independent_admin_session_families)
      or exists (select 1 from public.independent_admin_sessions)
      or exists (select 1 from public.independent_admin_auth_audit)
    )
  ) or (
    (select count(*) from public.independent_admin_principals) > 0
    and (
      (select count(*) from public.independent_admin_principals) <> 1
      or not exists (
        select 1
        from public.independent_admin_principals as principal_row
        where principal_row.singleton_slot = 1
          and principal_row.status = 'active'
          and principal_row.tenant_id = 'platform'
          and principal_row.role = 'super_admin'
      )
      or exists (
        select 1
        from public.independent_admin_session_families as family_row
        where family_row.revoked_at is null
      )
      or exists (
        select 1
        from public.independent_admin_sessions as session_row
        where session_row.state = 'active'
      )
    )
  ) then
    raise exception 'independent administrator Gate16 data state unavailable';
  end if;
end;
$$;

create table public.independent_admin_qualification_resolutions (
  resolution_slot smallint primary key default 1
    check (resolution_slot = 1),
  schema_version text not null
    check (
      schema_version =
        'aistory.independent-admin.qualification-retirement-resolution.v1'
    ),
  authorization_ref text unique
    check (
      authorization_ref is null
      or authorization_ref ~ '^iar_[A-Za-z0-9_-]{32,96}$'
    ),
  state text not null
    check (state in (
      'awaiting_attestation',
      'qualification_residue_retired',
      'not_required'
    )),
  prior_gate_version text not null
    check (prior_gate_version = '20260828233000'),
  gate_version text not null
    check (gate_version = '20260829063000'),
  incident_receipt_sha256 text not null
    check (
      incident_receipt_sha256 =
        'f38be911c5c8128ed9344e7e094f2ed2604ee21bc451505e62ad10515f0c4ad3'
    ),
  gate15_package_sha256 text not null
    check (
      gate15_package_sha256 =
        '9e34b8387754c7533c47aeb22ac9d9399f14a95fc65718e567f07d565c91412b'
    ),
  gate15_migration_sha256 text not null
    check (
      gate15_migration_sha256 =
        '29c23ec6ef72ae04a9037d5c191ccc2b9d0e7fee614284f26a611bb4c4ef2b97'
    ),
  post_qualification_dump_sha256 text not null
    check (
      post_qualification_dump_sha256 =
        'd85d63ed3cf54f8231207383dd5474cb5661aebaab433ee75c1f04eeeb8d1794'
    ),
  expected_pre_state_commitment_sha256 text not null
    check (expected_pre_state_commitment_sha256 ~ '^[a-f0-9]{64}$'),
  observed_pre_state_commitment_sha256 text not null
    check (
      observed_pre_state_commitment_sha256 ~ '^[a-f0-9]{64}$'
      and observed_pre_state_commitment_sha256 =
        expected_pre_state_commitment_sha256
    ),
  owner_marker_commitment_sha256 text unique
    check (
      owner_marker_commitment_sha256 is null
      or owner_marker_commitment_sha256 ~ '^[a-f0-9]{64}$'
    ),
  attestation_commitment_sha256 text unique
    check (
      attestation_commitment_sha256 is null
      or attestation_commitment_sha256 ~ '^[a-f0-9]{64}$'
    ),
  subject_principal_ref text references public.independent_admin_principals(
    principal_ref
  ) on delete restrict,
  retirement_audit_sequence bigint references public.independent_admin_auth_audit(
    sequence
  ) on delete restrict,
  captured_at timestamptz not null,
  resolved_at timestamptz,
  check (
    (
      state = 'awaiting_attestation'
      and authorization_ref is null
      and owner_marker_commitment_sha256 is null
      and attestation_commitment_sha256 is null
      and subject_principal_ref is not null
      and retirement_audit_sequence is null
      and resolved_at is null
    )
    or (
      state = 'qualification_residue_retired'
      and authorization_ref is not null
      and owner_marker_commitment_sha256 is not null
      and attestation_commitment_sha256 is not null
      and owner_marker_commitment_sha256 <>
        attestation_commitment_sha256
      and subject_principal_ref is not null
      and retirement_audit_sequence is not null
      and resolved_at is not null
      and resolved_at >= captured_at
    )
    or (
      state = 'not_required'
      and authorization_ref is null
      and owner_marker_commitment_sha256 is null
      and attestation_commitment_sha256 is null
      and subject_principal_ref is null
      and retirement_audit_sequence is null
      and resolved_at is not null
      and resolved_at >= captured_at
    )
  )
);

alter table public.independent_admin_qualification_resolutions
  enable row level security;
alter table public.independent_admin_qualification_resolutions
  force row level security;
revoke all on table public.independent_admin_qualification_resolutions
from public, anon, authenticated, service_role;

alter table public.independent_admin_principals
  drop constraint independent_admin_principals_singleton_slot_check;
alter table public.independent_admin_principals
  add column qualification_resolution_ref text,
  add column qualification_pre_state_sha256 text,
  add column qualification_retired_at timestamptz;
alter table public.independent_admin_principals
  add constraint independent_admin_principals_singleton_slot_gate16_check
  check (singleton_slot in (0, 1));
alter table public.independent_admin_principals
  add constraint independent_admin_principals_retirement_state_check
  check (
    (
      singleton_slot = 1
      and qualification_resolution_ref is null
      and qualification_pre_state_sha256 is null
      and qualification_retired_at is null
    )
    or (
      singleton_slot = 0
      and status = 'revoked'
      and qualification_resolution_ref ~ '^iar_[A-Za-z0-9_-]{32,96}$'
      and qualification_pre_state_sha256 ~ '^[a-f0-9]{64}$'
      and qualification_retired_at is not null
    )
  );
alter table public.independent_admin_principals
  add constraint independent_admin_principals_resolution_ref_fkey
  foreign key (qualification_resolution_ref)
  references public.independent_admin_qualification_resolutions(
    authorization_ref
  ) on delete restrict;

alter table public.independent_admin_auth_audit
  drop constraint independent_admin_auth_audit_event_check;
alter table public.independent_admin_auth_audit
  add constraint independent_admin_auth_audit_event_gate16_check
  check (event in (
    'initialized', 'origin_rejected', 'invalid_credentials', 'rate_limited',
    'login_succeeded', 'session_rotated', 'session_replay_rejected',
    'logout', 'credential_rotated', 'break_glass_revoked',
    'qualification_residue_retired'
  ));
alter table public.independent_admin_auth_audit
  drop constraint independent_admin_auth_audit_request_id_check;
alter table public.independent_admin_auth_audit
  add constraint independent_admin_auth_audit_request_id_gate16_check
  check (
    request_id is null
    or (
      event = 'qualification_residue_retired'
      and request_id ~ '^iar_[A-Za-z0-9_-]{32,96}$'
    )
    or (
      event <> 'qualification_residue_retired'
      and request_id ~ '^ipr_[A-Za-z0-9_-]{32,96}$'
    )
  );

create function public.aistory_independent_admin_assert_database_owner()
returns void
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_database_owner text;
begin
  select pg_catalog.pg_get_userbyid(database_row.datdba)
  into strict v_database_owner
  from pg_catalog.pg_database as database_row
  where database_row.datname = pg_catalog.current_database();
  if session_user is distinct from v_database_owner then
    raise exception 'independent administrator owner authorization unavailable';
  end if;
end;
$$;

create function public.aistory_independent_admin_reject_resolution_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_resolution_ref text;
begin
  if tg_op = 'UPDATE' then
    v_resolution_ref := nullif(pg_catalog.current_setting(
      'aistory.independent_admin_qualification_resolution_ref',
      true
    ), '');
    if old.state = 'awaiting_attestation'
      and new.state = 'qualification_residue_retired'
      and v_resolution_ref is not null
      and new.authorization_ref = v_resolution_ref
      and new.resolution_slot = old.resolution_slot
      and new.schema_version = old.schema_version
      and new.prior_gate_version = old.prior_gate_version
      and new.gate_version = old.gate_version
      and new.incident_receipt_sha256 = old.incident_receipt_sha256
      and new.gate15_package_sha256 = old.gate15_package_sha256
      and new.gate15_migration_sha256 = old.gate15_migration_sha256
      and new.post_qualification_dump_sha256 =
        old.post_qualification_dump_sha256
      and new.expected_pre_state_commitment_sha256 =
        old.expected_pre_state_commitment_sha256
      and new.observed_pre_state_commitment_sha256 =
        old.observed_pre_state_commitment_sha256
      and new.subject_principal_ref = old.subject_principal_ref
      and new.captured_at = old.captured_at
      and old.authorization_ref is null
      and old.owner_marker_commitment_sha256 is null
      and old.attestation_commitment_sha256 is null
      and old.retirement_audit_sequence is null
      and old.resolved_at is null
      and new.owner_marker_commitment_sha256 ~ '^[a-f0-9]{64}$'
      and new.attestation_commitment_sha256 ~ '^[a-f0-9]{64}$'
      and new.retirement_audit_sequence is not null
      and new.resolved_at is not null then
      return new;
    end if;
  end if;
  raise exception 'independent administrator qualification resolution is append-only';
end;
$$;

create trigger independent_admin_qualification_resolution_append_only
before update or delete on public.independent_admin_qualification_resolutions
for each row execute function
  public.aistory_independent_admin_reject_resolution_mutation();

create trigger independent_admin_qualification_resolution_no_truncate
before truncate on public.independent_admin_qualification_resolutions
for each statement execute function
  public.aistory_independent_admin_reject_resolution_mutation();

create function public.aistory_independent_admin_reject_principal_history_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_resolution_ref text;
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'independent administrator principal history is immutable';
  end if;
  if old.singleton_slot = 0 then
    raise exception 'independent administrator retired principal is immutable';
  end if;
  if new.singleton_slot = 0 then
    v_resolution_ref := nullif(pg_catalog.current_setting(
      'aistory.independent_admin_qualification_resolution_ref',
      true
    ), '');
    if v_resolution_ref is null
      or new.qualification_resolution_ref is distinct from v_resolution_ref
      or new.principal_ref is distinct from old.principal_ref
      or new.tenant_id is distinct from old.tenant_id
      or new.role is distinct from old.role
      or new.status is distinct from 'revoked'
      or new.credential_binding_sha256 is distinct from
        old.credential_binding_sha256
      or new.credential_epoch_sha256 is distinct from
        old.credential_epoch_sha256
      or new.password_verifier_reference_sha256 is distinct from
        old.password_verifier_reference_sha256
      or new.password_algorithm is distinct from old.password_algorithm
      or new.password_parameters is distinct from old.password_parameters
      or new.init_request_id is distinct from old.init_request_id
      or new.last_rotation_request_id is distinct from
        old.last_rotation_request_id
      or new.prior_credential_binding_sha256 is distinct from
        old.prior_credential_binding_sha256
      or new.credential_revision is distinct from old.credential_revision
      or new.created_at is distinct from old.created_at
      or new.updated_at is distinct from new.qualification_retired_at
      or not exists (
        select 1
        from public.independent_admin_qualification_resolutions as resolution_row
        where resolution_row.authorization_ref = v_resolution_ref
          and resolution_row.state = 'qualification_residue_retired'
          and resolution_row.subject_principal_ref = old.principal_ref
          and resolution_row.expected_pre_state_commitment_sha256 =
            new.qualification_pre_state_sha256
      ) then
      raise exception 'independent administrator retirement context unavailable';
    end if;
  elsif new.singleton_slot is distinct from old.singleton_slot
    or new.qualification_resolution_ref is distinct from
      old.qualification_resolution_ref
    or new.qualification_pre_state_sha256 is distinct from
      old.qualification_pre_state_sha256
    or new.qualification_retired_at is distinct from
      old.qualification_retired_at then
    raise exception 'independent administrator principal history is immutable';
  end if;
  return new;
end;
$$;

create trigger independent_admin_principal_history_immutable
before update or delete on public.independent_admin_principals
for each row execute function
  public.aistory_independent_admin_reject_principal_history_mutation();

create trigger independent_admin_principal_no_truncate
before truncate on public.independent_admin_principals
for each statement execute function
  public.aistory_independent_admin_reject_principal_history_mutation();

create function public.aistory_independent_admin_qualification_pre_state_commitment()
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_projection jsonb;
begin
  perform public.aistory_independent_admin_assert_database_owner();
  if public.aistory_database_gate_status()
      is distinct from '20260811193000'
    or public.aistory_independent_admin_gate_status()
      is distinct from '20260828233000' then
    raise exception 'independent administrator qualification pre-state unavailable';
  end if;
  select jsonb_build_object(
    'schemaVersion',
      'aistory.independent-admin.qualification-pre-state.v1',
    'productionIdentityGateVersion',
      public.aistory_database_gate_status(),
    'independentAdminGateVersion',
      public.aistory_independent_admin_gate_status(),
    'principals', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'singletonSlot', principal_row.singleton_slot,
            'principalRef', principal_row.principal_ref,
            'tenantId', principal_row.tenant_id,
            'role', principal_row.role,
            'status', principal_row.status,
            'credentialBindingSha256',
              principal_row.credential_binding_sha256,
            'credentialEpochSha256',
              principal_row.credential_epoch_sha256,
            'passwordVerifierReferenceSha256',
              principal_row.password_verifier_reference_sha256,
            'passwordAlgorithm', principal_row.password_algorithm,
            'passwordParameters', principal_row.password_parameters,
            'initRequestId', principal_row.init_request_id,
            'lastRotationRequestId', principal_row.last_rotation_request_id,
            'priorCredentialBindingSha256',
              principal_row.prior_credential_binding_sha256,
            'credentialRevision', principal_row.credential_revision,
            'createdAtEpochMicros',
              (extract(epoch from principal_row.created_at) * 1000000)::bigint,
            'updatedAtEpochMicros',
              (extract(epoch from principal_row.updated_at) * 1000000)::bigint
          )
          order by principal_row.singleton_slot,
            principal_row.principal_ref collate "C"
        ),
        '[]'::jsonb
      )
      from public.independent_admin_principals as principal_row
    ),
    'loginBuckets', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'bucketHash', bucket_row.bucket_hash,
            'windowStartedAtEpochMicros',
              (extract(epoch from bucket_row.window_started_at)
                * 1000000)::bigint,
            'attemptCount', bucket_row.attempt_count,
            'lockedUntilEpochMicros', case
              when bucket_row.locked_until is null then null
              else (extract(epoch from bucket_row.locked_until)
                * 1000000)::bigint
            end,
            'updatedAtEpochMicros',
              (extract(epoch from bucket_row.updated_at) * 1000000)::bigint
          )
          order by bucket_row.bucket_hash collate "C"
        ),
        '[]'::jsonb
      )
      from public.independent_admin_login_buckets as bucket_row
    ),
    'sessionFamilies', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'familyHash', family_row.family_hash,
            'principalRef', family_row.principal_ref,
            'credentialBindingSha256',
              family_row.credential_binding_sha256,
            'createdAtEpochMicros',
              (extract(epoch from family_row.created_at) * 1000000)::bigint,
            'absoluteExpiresAtEpochMicros',
              (extract(epoch from family_row.absolute_expires_at)
                * 1000000)::bigint,
            'revokedAtEpochMicros', case
              when family_row.revoked_at is null then null
              else (extract(epoch from family_row.revoked_at)
                * 1000000)::bigint
            end,
            'revocationCode', family_row.revocation_code
          )
          order by family_row.family_hash collate "C"
        ),
        '[]'::jsonb
      )
      from public.independent_admin_session_families as family_row
    ),
    'sessions', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'sessionHash', session_row.session_hash,
            'familyHash', session_row.family_hash,
            'rotationOrdinal', session_row.rotation_ordinal,
            'issuedAtEpochMicros',
              (extract(epoch from session_row.issued_at) * 1000000)::bigint,
            'expiresAtEpochMicros',
              (extract(epoch from session_row.expires_at) * 1000000)::bigint,
            'state', session_row.state,
            'replacementSessionHash', session_row.replacement_session_hash,
            'terminalAtEpochMicros', case
              when session_row.terminal_at is null then null
              else (extract(epoch from session_row.terminal_at)
                * 1000000)::bigint
            end
          )
          order by session_row.session_hash collate "C"
        ),
        '[]'::jsonb
      )
      from public.independent_admin_sessions as session_row
    ),
    'authAudit', (
      select coalesce(
        jsonb_agg(
          jsonb_build_object(
            'sequence', audit_row.sequence,
            'principalRef', audit_row.principal_ref,
            'event', audit_row.event,
            'familyHash', audit_row.family_hash,
            'requestId', audit_row.request_id,
            'occurredAtEpochMicros',
              (extract(epoch from audit_row.occurred_at) * 1000000)::bigint
          )
          order by audit_row.sequence
        ),
        '[]'::jsonb
      )
      from public.independent_admin_auth_audit as audit_row
    ),
    'authAuditSequence', (
      select jsonb_build_object(
        'schemaQualifiedName',
          'public.independent_admin_auth_audit_sequence_seq',
        'lastValue', sequence_row.last_value,
        'isCalled', sequence_row.is_called
      )
      from public.independent_admin_auth_audit_sequence_seq as sequence_row
    )
  ) into v_projection;
  return encode(
    digest(convert_to(v_projection::text, 'UTF8'), 'sha256'),
    'hex'
  );
end;
$$;

create function public.aistory_independent_admin_qualification_attestation_commitment(
  attestation_payload jsonb
)
returns text
language sql
immutable
security definer
set search_path = pg_catalog, public
as $$
  select encode(digest(convert_to(concat_ws(
    E'\n',
    attestation_payload->>'schemaVersion',
    attestation_payload->>'authorizationRef',
    attestation_payload->>'outcome',
    attestation_payload->>'incidentReceiptSha256',
    attestation_payload->>'gate15PackageSha256',
    attestation_payload->>'gate15MigrationSha256',
    attestation_payload->>'postQualificationDumpSha256',
    attestation_payload->>'expectedPreStateCommitmentSha256',
    attestation_payload->>'ownerMarkerCommitmentSha256'
  ), 'UTF8'), 'sha256'), 'hex');
$$;

create or replace function public.aistory_independent_admin_initialize(
  registration jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_existing public.independent_admin_principals%rowtype;
  v_binding jsonb;
  v_request_id text;
begin
  perform public.aistory_independent_admin_assert_service_role();
  if public.aistory_independent_admin_exact_object(
      registration,
      array[
      'principal_ref', 'credential_binding_sha256',
      'credential_epoch_sha256', 'password_verifier_reference_sha256',
      'password_algorithm', 'password_parameters', 'request_id'
      ]
    ) is distinct from true then
    raise exception 'independent administrator registration invalid';
  end if;
  v_binding := registration - 'request_id';
  perform public.aistory_independent_admin_assert_binding(v_binding);
  v_request_id := registration->>'request_id';
  if v_request_id !~ '^ipr_[A-Za-z0-9_-]{32,96}$' then
    raise exception 'independent administrator registration invalid';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('aistory:independent-admin:singleton:v1', 0)
  );
  if public.aistory_independent_admin_gate_status()
      is distinct from '20260829063000'
    or not exists (
      select 1
      from public.independent_admin_qualification_resolutions as resolution_row
      where resolution_row.resolution_slot = 1
        and resolution_row.gate_version = '20260829063000'
        and resolution_row.state in (
          'qualification_residue_retired',
          'not_required'
        )
    )
    or exists (
      select 1
      from public.independent_admin_principals as retired_row
      where retired_row.singleton_slot = 0
        and (
          retired_row.principal_ref = registration->>'principal_ref'
          or retired_row.init_request_id = v_request_id
        )
    ) then
    raise exception 'independent administrator initialization unavailable';
  end if;

  select principal_row.* into v_existing
  from public.independent_admin_principals as principal_row
  where principal_row.singleton_slot = 1
  for update;
  if found then
    if v_existing.principal_ref = registration->>'principal_ref'
      and v_existing.credential_binding_sha256
        = registration->>'credential_binding_sha256'
      and v_existing.credential_epoch_sha256
        = registration->>'credential_epoch_sha256'
      and v_existing.password_verifier_reference_sha256
        = registration->>'password_verifier_reference_sha256'
      and v_existing.init_request_id = v_request_id then
      return jsonb_build_object('initialized', true, 'replayed', true);
    end if;
    raise exception 'independent administrator already initialized';
  end if;

  insert into public.independent_admin_principals (
    principal_ref, credential_binding_sha256, credential_epoch_sha256,
    password_verifier_reference_sha256, password_algorithm,
    password_parameters, init_request_id
  ) values (
    registration->>'principal_ref',
    registration->>'credential_binding_sha256',
    registration->>'credential_epoch_sha256',
    registration->>'password_verifier_reference_sha256',
    registration->>'password_algorithm',
    registration->'password_parameters',
    v_request_id
  );
  insert into public.independent_admin_auth_audit (
    principal_ref, event, request_id
  ) values (
    registration->>'principal_ref', 'initialized', v_request_id
  );
  return jsonb_build_object('initialized', true, 'replayed', false);
end;
$$;

create or replace function public.aistory_independent_admin_append_security_event(
  security_event jsonb
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_binding jsonb;
  v_event text;
  v_occurred_at timestamptz;
  v_now timestamptz := clock_timestamp();
begin
  perform public.aistory_independent_admin_assert_service_role();
  if public.aistory_independent_admin_exact_object(
      security_event,
      array[
      'principal_ref', 'credential_binding_sha256',
      'credential_epoch_sha256', 'password_verifier_reference_sha256',
      'password_algorithm', 'password_parameters', 'event', 'occurred_at'
      ]
    ) is distinct from true then
    raise exception 'independent administrator event invalid';
  end if;
  v_binding := security_event - 'event' - 'occurred_at';
  perform public.aistory_independent_admin_assert_binding(v_binding);
  v_event := security_event->>'event';
  begin
    v_occurred_at := (security_event->>'occurred_at')::timestamptz;
  exception when others then
    raise exception 'independent administrator event invalid';
  end;
  if v_event not in ('origin_rejected', 'invalid_credentials')
    or abs(extract(epoch from (v_now - v_occurred_at))) > 60
    or not exists (
      select 1
      from public.independent_admin_principals as principal_row
      where principal_row.singleton_slot = 1
        and principal_row.status = 'active'
        and principal_row.principal_ref = security_event->>'principal_ref'
        and principal_row.credential_binding_sha256 =
          security_event->>'credential_binding_sha256'
        and principal_row.credential_epoch_sha256 =
          security_event->>'credential_epoch_sha256'
        and principal_row.password_verifier_reference_sha256 =
          security_event->>'password_verifier_reference_sha256'
        and principal_row.password_algorithm =
          security_event->>'password_algorithm'
        and principal_row.password_parameters =
          security_event->'password_parameters'
    ) then
    raise exception 'independent administrator event unavailable';
  end if;
  insert into public.independent_admin_auth_audit (
    principal_ref, event
  ) values (
    security_event->>'principal_ref', v_event
  );
  return true;
end;
$$;

create function public.aistory_independent_admin_gate16_schema_posture()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.aistory_database_gate_status() = '20260811193000'
    and public.aistory_database_security_posture()
    and public.aistory_admin_rpc_security_posture()
    and (
      select count(*) = 6
        and bool_and(
          class_row.relrowsecurity
          and class_row.relforcerowsecurity
          and class_row.relowner = (
            select database_row.datdba
            from pg_catalog.pg_database as database_row
            where database_row.datname = pg_catalog.current_database()
          )
        )
      from pg_catalog.pg_class as class_row
      where class_row.oid = any(array[
        'public.independent_admin_principals'::regclass,
        'public.independent_admin_login_buckets'::regclass,
        'public.independent_admin_session_families'::regclass,
        'public.independent_admin_sessions'::regclass,
        'public.independent_admin_auth_audit'::regclass,
        'public.independent_admin_qualification_resolutions'::regclass
      ])
    )
    and (
      select bool_and(
        not has_table_privilege(
          'anon', guarded.table_name,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
        and not has_table_privilege(
          'authenticated', guarded.table_name,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
        and not has_table_privilege(
          'service_role', guarded.table_name,
          'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
        )
      )
      from unnest(array[
        'public.independent_admin_principals',
        'public.independent_admin_login_buckets',
        'public.independent_admin_session_families',
        'public.independent_admin_sessions',
        'public.independent_admin_auth_audit',
        'public.independent_admin_qualification_resolutions'
      ]) as guarded(table_name)
    )
    and (
      select not has_sequence_privilege(
          'anon',
          'public.independent_admin_auth_audit_sequence_seq',
          'USAGE,SELECT,UPDATE'
        )
        and not has_sequence_privilege(
          'authenticated',
          'public.independent_admin_auth_audit_sequence_seq',
          'USAGE,SELECT,UPDATE'
        )
        and not has_sequence_privilege(
          'service_role',
          'public.independent_admin_auth_audit_sequence_seq',
          'USAGE,SELECT,UPDATE'
        )
        and (
          select sequence_row.relowner = database_row.datdba
          from pg_catalog.pg_class as sequence_row
          cross join pg_catalog.pg_database as database_row
          where sequence_row.oid =
              'public.independent_admin_auth_audit_sequence_seq'::regclass
            and database_row.datname = pg_catalog.current_database()
        )
    )
    and (
      select count(*) = 21
        and bool_and(
          procedure_row.prosecdef
          and procedure_row.proowner = (
            select database_row.datdba
            from pg_catalog.pg_database as database_row
            where database_row.datname = pg_catalog.current_database()
          )
          and coalesce(procedure_row.proconfig, '{}'::text[])
            @> array['search_path=pg_catalog, public']
          and procedure_row.provolatile = case
            when procedure_row.oid = any(array[
              'public.aistory_independent_admin_exact_object(jsonb,text[])'::regprocedure::oid,
              'public.aistory_independent_admin_qualification_attestation_commitment(jsonb)'::regprocedure::oid
            ]) then 'i'::"char"
            when procedure_row.oid = any(array[
              'public.aistory_independent_admin_read_snapshot(jsonb)'::regprocedure::oid,
              'public.aistory_independent_admin_gate_status()'::regprocedure::oid,
              'public.aistory_independent_admin_project_snapshot(text)'::regprocedure::oid,
              'public.aistory_independent_admin_assert_database_owner()'::regprocedure::oid,
              'public.aistory_independent_admin_gate16_schema_posture()'::regprocedure::oid
            ]) then 's'::"char"
            else 'v'::"char"
          end
        )
      from pg_catalog.pg_proc as procedure_row
      where procedure_row.oid = any(array[
        'public.aistory_independent_admin_exact_object(jsonb,text[])'::regprocedure::oid,
        'public.aistory_independent_admin_assert_service_role()'::regprocedure::oid,
        'public.aistory_independent_admin_assert_binding(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_reject_audit_mutation()'::regprocedure::oid,
        'public.aistory_independent_admin_initialize(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_rotate_credential(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_reserve_login(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_commit_login(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_verify_session(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_rotate_session(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_revoke_session(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_append_security_event(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_read_snapshot(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_gate_status()'::regprocedure::oid,
        'public.aistory_independent_admin_project_snapshot(text)'::regprocedure::oid,
        'public.aistory_independent_admin_assert_database_owner()'::regprocedure::oid,
        'public.aistory_independent_admin_reject_resolution_mutation()'::regprocedure::oid,
        'public.aistory_independent_admin_reject_principal_history_mutation()'::regprocedure::oid,
        'public.aistory_independent_admin_qualification_pre_state_commitment()'::regprocedure::oid,
        'public.aistory_independent_admin_qualification_attestation_commitment(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_gate16_schema_posture()'::regprocedure::oid
      ])
    )
    and not exists (
      select 1
      from pg_catalog.pg_proc as procedure_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      cross join lateral unnest(
        coalesce(procedure_row.proargnames, '{}'::text[])
      ) as argument_row(argument_name)
      join pg_catalog.pg_get_keywords() as keyword_row
        on keyword_row.word = lower(argument_row.argument_name)
       and keyword_row.catcode in ('R', 'T')
      where namespace_row.nspname = 'public'
        and procedure_row.proname like 'aistory\_independent\_admin\_%'
          escape '\'
    )
    and (
      select procedure_row.proargnames = array['request_payload']::text[]
      from pg_catalog.pg_proc as procedure_row
      where procedure_row.oid =
        'public.aistory_independent_admin_read_snapshot(jsonb)'::regprocedure::oid
    )
    and (
      select bool_and(
        not has_function_privilege('anon', guarded.rpc_oid, 'EXECUTE')
        and not has_function_privilege(
          'authenticated', guarded.rpc_oid, 'EXECUTE'
        )
        and has_function_privilege(
          'service_role', guarded.rpc_oid, 'EXECUTE'
        )
      )
      from unnest(array[
        'public.aistory_independent_admin_initialize(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_rotate_credential(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_reserve_login(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_commit_login(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_verify_session(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_rotate_session(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_revoke_session(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_append_security_event(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_read_snapshot(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_gate_status()'::regprocedure::oid
      ]) as guarded(rpc_oid)
    )
    and (
      select bool_and(
        not has_function_privilege('anon', guarded.owner_oid, 'EXECUTE')
        and not has_function_privilege(
          'authenticated', guarded.owner_oid, 'EXECUTE'
        )
        and not has_function_privilege(
          'service_role', guarded.owner_oid, 'EXECUTE'
        )
      )
      from unnest(array[
        'public.aistory_independent_admin_exact_object(jsonb,text[])'::regprocedure::oid,
        'public.aistory_independent_admin_assert_service_role()'::regprocedure::oid,
        'public.aistory_independent_admin_assert_binding(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_reject_audit_mutation()'::regprocedure::oid,
        'public.aistory_independent_admin_project_snapshot(text)'::regprocedure::oid,
        'public.aistory_independent_admin_assert_database_owner()'::regprocedure::oid,
        'public.aistory_independent_admin_qualification_pre_state_commitment()'::regprocedure::oid,
        'public.aistory_independent_admin_qualification_attestation_commitment(jsonb)'::regprocedure::oid,
        'public.aistory_independent_admin_reject_resolution_mutation()'::regprocedure::oid,
        'public.aistory_independent_admin_reject_principal_history_mutation()'::regprocedure::oid,
        'public.aistory_independent_admin_gate16_schema_posture()'::regprocedure::oid
      ]) as guarded(owner_oid)
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger_row
      where trigger_row.tgrelid =
          'public.independent_admin_auth_audit'::regclass
        and trigger_row.tgname =
          'independent_admin_auth_audit_append_only'
        and trigger_row.tgenabled = 'O'
        and not trigger_row.tgisinternal
        and trigger_row.tgfoid =
          'public.aistory_independent_admin_reject_audit_mutation()'::regprocedure::oid
        and trigger_row.tgtype = 27
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger_row
      where trigger_row.tgrelid =
          'public.independent_admin_auth_audit'::regclass
        and trigger_row.tgname =
          'independent_admin_auth_audit_no_truncate'
        and trigger_row.tgenabled = 'O'
        and not trigger_row.tgisinternal
        and trigger_row.tgfoid =
          'public.aistory_independent_admin_reject_audit_mutation()'::regprocedure::oid
        and trigger_row.tgtype = 34
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger_row
      where trigger_row.tgrelid =
          'public.independent_admin_principals'::regclass
        and trigger_row.tgname =
          'independent_admin_principal_history_immutable'
        and trigger_row.tgenabled = 'O'
        and not trigger_row.tgisinternal
        and trigger_row.tgfoid =
          'public.aistory_independent_admin_reject_principal_history_mutation()'::regprocedure::oid
        and trigger_row.tgtype = 27
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger_row
      where trigger_row.tgrelid =
          'public.independent_admin_principals'::regclass
        and trigger_row.tgname = 'independent_admin_principal_no_truncate'
        and trigger_row.tgenabled = 'O'
        and not trigger_row.tgisinternal
        and trigger_row.tgfoid =
          'public.aistory_independent_admin_reject_principal_history_mutation()'::regprocedure::oid
        and trigger_row.tgtype = 34
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger_row
      where trigger_row.tgrelid =
          'public.independent_admin_qualification_resolutions'::regclass
        and trigger_row.tgname =
          'independent_admin_qualification_resolution_append_only'
        and trigger_row.tgenabled = 'O'
        and not trigger_row.tgisinternal
        and trigger_row.tgfoid =
          'public.aistory_independent_admin_reject_resolution_mutation()'::regprocedure::oid
        and trigger_row.tgtype = 27
    )
    and exists (
      select 1
      from pg_catalog.pg_trigger as trigger_row
      where trigger_row.tgrelid =
          'public.independent_admin_qualification_resolutions'::regclass
        and trigger_row.tgname =
          'independent_admin_qualification_resolution_no_truncate'
        and trigger_row.tgenabled = 'O'
        and not trigger_row.tgisinternal
        and trigger_row.tgfoid =
          'public.aistory_independent_admin_reject_resolution_mutation()'::regprocedure::oid
        and trigger_row.tgtype = 34
    );
$$;

create function public.aistory_independent_admin_finalize_qualification_resolution(
  attestation_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
#variable_conflict error
declare
  v_observed_pre_state text;
  v_expected_attestation text;
  v_resolution public.independent_admin_qualification_resolutions%rowtype;
  v_principal public.independent_admin_principals%rowtype;
  v_audit_sequence bigint;
  v_now timestamptz := clock_timestamp();
  v_gate_rows integer;
begin
  perform public.aistory_independent_admin_assert_database_owner();
  if public.aistory_independent_admin_exact_object(
      attestation_payload,
      array[
      'schemaVersion', 'authorizationRef', 'outcome',
      'incidentReceiptSha256', 'gate15PackageSha256',
      'gate15MigrationSha256', 'postQualificationDumpSha256',
      'expectedPreStateCommitmentSha256',
      'ownerMarkerCommitmentSha256', 'attestationCommitmentSha256'
      ]
    ) is distinct from true then
    raise exception 'independent administrator qualification resolution unavailable';
  end if;
  if attestation_payload->>'schemaVersion' is distinct from
      'aistory.independent-admin.qualification-retirement-attestation.v1'
    or (attestation_payload->>'authorizationRef'
      ~ '^iar_[A-Za-z0-9_-]{32,96}$') is distinct from true
    or attestation_payload->>'outcome' is distinct from
      'qualification_residue_retired'
    or attestation_payload->>'incidentReceiptSha256' is distinct from
      'f38be911c5c8128ed9344e7e094f2ed2604ee21bc451505e62ad10515f0c4ad3'
    or attestation_payload->>'gate15PackageSha256' is distinct from
      '9e34b8387754c7533c47aeb22ac9d9399f14a95fc65718e567f07d565c91412b'
    or attestation_payload->>'gate15MigrationSha256' is distinct from
      '29c23ec6ef72ae04a9037d5c191ccc2b9d0e7fee614284f26a611bb4c4ef2b97'
    or attestation_payload->>'postQualificationDumpSha256' is distinct from
      'd85d63ed3cf54f8231207383dd5474cb5661aebaab433ee75c1f04eeeb8d1794'
    or (attestation_payload->>'expectedPreStateCommitmentSha256'
      ~ '^[a-f0-9]{64}$') is distinct from true
    or (attestation_payload->>'ownerMarkerCommitmentSha256'
      ~ '^[a-f0-9]{64}$') is distinct from true
    or (attestation_payload->>'attestationCommitmentSha256'
      ~ '^[a-f0-9]{64}$') is distinct from true
    or attestation_payload->>'ownerMarkerCommitmentSha256' =
      attestation_payload->>'attestationCommitmentSha256' then
    raise exception 'independent administrator qualification resolution unavailable';
  end if;
  if attestation_payload->>'ownerMarkerCommitmentSha256' = any(array[
    attestation_payload->>'incidentReceiptSha256',
    attestation_payload->>'gate15PackageSha256',
    attestation_payload->>'gate15MigrationSha256',
    attestation_payload->>'postQualificationDumpSha256',
    attestation_payload->>'expectedPreStateCommitmentSha256'
  ]) then
    raise exception 'independent administrator qualification resolution unavailable';
  end if;
  v_expected_attestation :=
    public.aistory_independent_admin_qualification_attestation_commitment(
      attestation_payload - 'attestationCommitmentSha256'
    );
  if v_expected_attestation is distinct from
      attestation_payload->>'attestationCommitmentSha256' then
    raise exception 'independent administrator qualification resolution unavailable';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'aistory:independent-admin:qualification-resolution:v1',
      0
    )
  );
  lock table public.aistory_schema_gates,
    public.independent_admin_principals,
    public.independent_admin_login_buckets,
    public.independent_admin_session_families,
    public.independent_admin_sessions,
    public.independent_admin_auth_audit,
    public.independent_admin_qualification_resolutions
  in share row exclusive mode;

  if public.aistory_independent_admin_gate_status()
      is distinct from '20260828233000'
    or public.aistory_independent_admin_gate16_schema_posture()
      is distinct from true then
    raise exception 'independent administrator qualification resolution unavailable';
  end if;
  select resolution_row.* into v_resolution
  from public.independent_admin_qualification_resolutions as resolution_row
  where resolution_row.resolution_slot = 1
    and resolution_row.state = 'awaiting_attestation'
  for update;
  if not found then
    raise exception 'independent administrator qualification resolution unavailable';
  end if;
  v_observed_pre_state :=
    public.aistory_independent_admin_qualification_pre_state_commitment();
  if v_resolution.expected_pre_state_commitment_sha256 is distinct from
      v_resolution.observed_pre_state_commitment_sha256
    or v_resolution.expected_pre_state_commitment_sha256 is distinct from
      attestation_payload->>'expectedPreStateCommitmentSha256'
    or v_observed_pre_state is distinct from
      v_resolution.expected_pre_state_commitment_sha256
    or v_resolution.incident_receipt_sha256 is distinct from
      attestation_payload->>'incidentReceiptSha256'
    or v_resolution.gate15_package_sha256 is distinct from
      attestation_payload->>'gate15PackageSha256'
    or v_resolution.gate15_migration_sha256 is distinct from
      attestation_payload->>'gate15MigrationSha256'
    or v_resolution.post_qualification_dump_sha256 is distinct from
      attestation_payload->>'postQualificationDumpSha256' then
    raise exception 'independent administrator qualification resolution unavailable';
  end if;

  select principal_row.* into v_principal
  from public.independent_admin_principals as principal_row
  where principal_row.singleton_slot = 1
    and principal_row.status = 'active'
    and principal_row.tenant_id = 'platform'
    and principal_row.role = 'super_admin'
    and principal_row.principal_ref = v_resolution.subject_principal_ref
    and principal_row.qualification_resolution_ref is null
    and principal_row.qualification_pre_state_sha256 is null
    and principal_row.qualification_retired_at is null
  for update;
  if not found
    or (select count(*) from public.independent_admin_principals) <> 1
    or exists (
      select 1
      from public.independent_admin_session_families as family_row
      where family_row.revoked_at is null
    )
    or exists (
      select 1
      from public.independent_admin_sessions as session_row
      where session_row.state = 'active'
    ) then
    raise exception 'independent administrator qualification resolution unavailable';
  end if;

  insert into public.independent_admin_auth_audit (
    principal_ref, event, request_id, occurred_at
  ) values (
    v_principal.principal_ref,
    'qualification_residue_retired',
    attestation_payload->>'authorizationRef',
    v_now
  ) returning sequence into v_audit_sequence;
  perform pg_catalog.set_config(
    'aistory.independent_admin_qualification_resolution_ref',
    attestation_payload->>'authorizationRef',
    true
  );
  update public.independent_admin_qualification_resolutions as resolution_row
  set authorization_ref = attestation_payload->>'authorizationRef',
      state = 'qualification_residue_retired',
      owner_marker_commitment_sha256 =
        attestation_payload->>'ownerMarkerCommitmentSha256',
      attestation_commitment_sha256 =
        attestation_payload->>'attestationCommitmentSha256',
      retirement_audit_sequence = v_audit_sequence,
      resolved_at = v_now
  where resolution_row.resolution_slot = 1
    and resolution_row.state = 'awaiting_attestation'
    and resolution_row.subject_principal_ref = v_principal.principal_ref
    and resolution_row.expected_pre_state_commitment_sha256 =
      v_observed_pre_state;
  if not found then
    raise exception 'independent administrator qualification resolution unavailable';
  end if;
  update public.independent_admin_principals as principal_row
  set singleton_slot = 0,
      status = 'revoked',
      qualification_resolution_ref =
        attestation_payload->>'authorizationRef',
      qualification_pre_state_sha256 = v_observed_pre_state,
      qualification_retired_at = v_now,
      updated_at = v_now
  where principal_row.singleton_slot = 1
    and principal_row.principal_ref = v_principal.principal_ref;
  if not found then
    raise exception 'independent administrator qualification resolution unavailable';
  end if;

  update public.aistory_schema_gates as gate_row
  set version = '20260829063000', installed_at = v_now
  where gate_row.gate_name = 'independent_admin_principal'
    and gate_row.version = '20260828233000';
  get diagnostics v_gate_rows = row_count;
  if v_gate_rows <> 1 then
    raise exception 'independent administrator qualification resolution unavailable';
  end if;
  if public.aistory_independent_admin_security_posture()
      is distinct from true then
    raise exception 'independent administrator qualification resolution unavailable';
  end if;
  return jsonb_build_object(
    'resolved', true,
    'outcome', 'qualification_residue_retired'
  );
end;
$$;

revoke all on function public.aistory_independent_admin_assert_database_owner()
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_reject_resolution_mutation()
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_reject_principal_history_mutation()
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_qualification_pre_state_commitment()
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_qualification_attestation_commitment(jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_gate16_schema_posture()
from public, anon, authenticated, service_role;
revoke all on function public.aistory_independent_admin_finalize_qualification_resolution(jsonb)
from public, anon, authenticated, service_role;

create or replace function public.aistory_independent_admin_security_posture()
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.aistory_independent_admin_gate16_schema_posture()
    and (
      select count(*) = 1
      from public.independent_admin_qualification_resolutions
    )
    and exists (
      select 1
      from public.independent_admin_qualification_resolutions as resolution_row
      where resolution_row.resolution_slot = 1
        and resolution_row.prior_gate_version = '20260828233000'
        and resolution_row.gate_version = '20260829063000'
        and resolution_row.expected_pre_state_commitment_sha256 =
          resolution_row.observed_pre_state_commitment_sha256
        and (
          (
            public.aistory_independent_admin_gate_status() = '20260828233000'
            and resolution_row.state = 'awaiting_attestation'
            and resolution_row.authorization_ref is null
            and resolution_row.owner_marker_commitment_sha256 is null
            and resolution_row.attestation_commitment_sha256 is null
            and resolution_row.subject_principal_ref is not null
            and resolution_row.retirement_audit_sequence is null
            and resolution_row.resolved_at is null
            and (
              select count(*) = 1
              from public.independent_admin_principals
            )
            and exists (
              select 1
              from public.independent_admin_principals as current_row
              where current_row.singleton_slot = 1
                and current_row.status = 'active'
                and current_row.tenant_id = 'platform'
                and current_row.role = 'super_admin'
                and current_row.principal_ref =
                  resolution_row.subject_principal_ref
                and current_row.qualification_resolution_ref is null
                and current_row.qualification_pre_state_sha256 is null
                and current_row.qualification_retired_at is null
            )
            and not exists (
              select 1
              from public.independent_admin_principals as retired_row
              where retired_row.singleton_slot = 0
            )
            and not exists (
              select 1
              from public.independent_admin_auth_audit as audit_row
              where audit_row.event = 'qualification_residue_retired'
            )
            and not exists (
              select 1
              from public.independent_admin_session_families as family_row
              where family_row.revoked_at is null
            )
            and not exists (
              select 1
              from public.independent_admin_sessions as session_row
              where session_row.state = 'active'
            )
          )
          or (
            public.aistory_independent_admin_gate_status() = '20260829063000'
            and resolution_row.state = 'qualification_residue_retired'
            and resolution_row.authorization_ref is not null
            and resolution_row.owner_marker_commitment_sha256 is not null
            and resolution_row.owner_marker_commitment_sha256 <>
              resolution_row.attestation_commitment_sha256
            and resolution_row.attestation_commitment_sha256 =
              public.aistory_independent_admin_qualification_attestation_commitment(
                jsonb_build_object(
                  'schemaVersion',
                    'aistory.independent-admin.qualification-retirement-attestation.v1',
                  'authorizationRef', resolution_row.authorization_ref,
                  'outcome', 'qualification_residue_retired',
                  'incidentReceiptSha256',
                    resolution_row.incident_receipt_sha256,
                  'gate15PackageSha256', resolution_row.gate15_package_sha256,
                  'gate15MigrationSha256',
                    resolution_row.gate15_migration_sha256,
                  'postQualificationDumpSha256',
                    resolution_row.post_qualification_dump_sha256,
                  'expectedPreStateCommitmentSha256',
                    resolution_row.expected_pre_state_commitment_sha256,
                  'ownerMarkerCommitmentSha256',
                    resolution_row.owner_marker_commitment_sha256
                )
              )
            and exists (
              select 1
              from public.independent_admin_principals as retired_row
              where retired_row.singleton_slot = 0
                and retired_row.status = 'revoked'
                and retired_row.principal_ref =
                  resolution_row.subject_principal_ref
                and retired_row.qualification_resolution_ref =
                  resolution_row.authorization_ref
                and retired_row.qualification_pre_state_sha256 =
                  resolution_row.expected_pre_state_commitment_sha256
                and retired_row.qualification_retired_at =
                  resolution_row.resolved_at
            )
            and (
              select count(*) = 1
              from public.independent_admin_auth_audit as audit_row
              where audit_row.event = 'qualification_residue_retired'
            )
            and exists (
              select 1
              from public.independent_admin_auth_audit as audit_row
              where audit_row.sequence =
                  resolution_row.retirement_audit_sequence
                and audit_row.event = 'qualification_residue_retired'
                and audit_row.principal_ref =
                  resolution_row.subject_principal_ref
                and audit_row.request_id = resolution_row.authorization_ref
                and audit_row.occurred_at = resolution_row.resolved_at
            )
            and not exists (
              select 1
              from public.independent_admin_session_families as family_row
              where family_row.principal_ref =
                  resolution_row.subject_principal_ref
                and family_row.revoked_at is null
            )
            and not exists (
              select 1
              from public.independent_admin_sessions as session_row
              join public.independent_admin_session_families as family_row
                on family_row.family_hash = session_row.family_hash
              where family_row.principal_ref =
                  resolution_row.subject_principal_ref
                and session_row.state = 'active'
            )
          )
          or (
            public.aistory_independent_admin_gate_status() = '20260829063000'
            and resolution_row.state = 'not_required'
            and resolution_row.authorization_ref is null
            and resolution_row.owner_marker_commitment_sha256 is null
            and resolution_row.attestation_commitment_sha256 is null
            and resolution_row.subject_principal_ref is null
            and resolution_row.retirement_audit_sequence is null
            and resolution_row.resolved_at is not null
            and not exists (
              select 1
              from public.independent_admin_auth_audit as audit_row
              where audit_row.event = 'qualification_residue_retired'
            )
            and not exists (
              select 1
              from public.independent_admin_principals as retired_row
              where retired_row.singleton_slot = 0
            )
          )
        )
    )
    and exists (
      select 1
      from pg_catalog.pg_proc as procedure_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      where namespace_row.nspname = 'public'
        and procedure_row.oid =
          'public.aistory_independent_admin_finalize_qualification_resolution(jsonb)'::regprocedure::oid
        and procedure_row.proargnames =
          array['attestation_payload']::text[]
        and procedure_row.prosecdef
        and procedure_row.proowner = (
          select database_row.datdba
          from pg_catalog.pg_database as database_row
          where database_row.datname = pg_catalog.current_database()
        )
        and procedure_row.provolatile = 'v'::"char"
        and coalesce(procedure_row.proconfig, '{}'::text[])
          @> array['search_path=pg_catalog, public']
        and not has_function_privilege(
          'anon', procedure_row.oid, 'EXECUTE'
        )
        and not has_function_privilege(
          'authenticated', procedure_row.oid, 'EXECUTE'
        )
        and not has_function_privilege(
          'service_role', procedure_row.oid, 'EXECUTE'
        )
    )
    and exists (
      select 1
      from pg_catalog.pg_proc as procedure_row
      join pg_catalog.pg_namespace as namespace_row
        on namespace_row.oid = procedure_row.pronamespace
      where namespace_row.nspname = 'public'
        and procedure_row.proname =
          'aistory_independent_admin_security_posture'
        and procedure_row.pronargs = 0
        and procedure_row.prosecdef
        and procedure_row.proowner = (
          select database_row.datdba
          from pg_catalog.pg_database as database_row
          where database_row.datname = pg_catalog.current_database()
        )
        and procedure_row.provolatile = 's'::"char"
        and coalesce(procedure_row.proconfig, '{}'::text[])
          @> array['search_path=pg_catalog, public']
        and not has_function_privilege(
          'anon', procedure_row.oid, 'EXECUTE'
        )
        and not has_function_privilege(
          'authenticated', procedure_row.oid, 'EXECUTE'
        )
        and has_function_privilege(
          'service_role', procedure_row.oid, 'EXECUTE'
        )
    );
$$;

revoke all on function public.aistory_independent_admin_security_posture()
from public, anon, authenticated, service_role;
grant execute on function public.aistory_independent_admin_security_posture()
to service_role;

do $$
declare
  v_captured_at timestamptz := clock_timestamp();
  v_gate_rows integer;
  v_pre_state_commitment text;
  v_subject_principal_ref text;
begin
  perform public.aistory_independent_admin_assert_database_owner();
  lock table public.aistory_schema_gates,
    public.independent_admin_principals,
    public.independent_admin_login_buckets,
    public.independent_admin_session_families,
    public.independent_admin_sessions,
    public.independent_admin_auth_audit,
    public.independent_admin_qualification_resolutions
  in share row exclusive mode;

  if public.aistory_independent_admin_gate_status()
      is distinct from '20260828233000'
    or public.aistory_independent_admin_gate16_schema_posture()
      is distinct from true
    or exists (
      select 1
      from public.independent_admin_qualification_resolutions
    ) then
    raise exception 'independent administrator Gate16 capture unavailable';
  end if;

  if not exists (
    select 1 from public.independent_admin_principals
  ) then
    if exists (select 1 from public.independent_admin_login_buckets)
      or exists (select 1 from public.independent_admin_session_families)
      or exists (select 1 from public.independent_admin_sessions)
      or exists (select 1 from public.independent_admin_auth_audit) then
      raise exception 'independent administrator Gate16 capture unavailable';
    end if;
    v_pre_state_commitment :=
      public.aistory_independent_admin_qualification_pre_state_commitment();
    insert into public.independent_admin_qualification_resolutions (
      schema_version, state, prior_gate_version, gate_version,
      incident_receipt_sha256, gate15_package_sha256,
      gate15_migration_sha256, post_qualification_dump_sha256,
      expected_pre_state_commitment_sha256,
      observed_pre_state_commitment_sha256,
      captured_at, resolved_at
    ) values (
      'aistory.independent-admin.qualification-retirement-resolution.v1',
      'not_required', '20260828233000', '20260829063000',
      'f38be911c5c8128ed9344e7e094f2ed2604ee21bc451505e62ad10515f0c4ad3',
      '9e34b8387754c7533c47aeb22ac9d9399f14a95fc65718e567f07d565c91412b',
      '29c23ec6ef72ae04a9037d5c191ccc2b9d0e7fee614284f26a611bb4c4ef2b97',
      'd85d63ed3cf54f8231207383dd5474cb5661aebaab433ee75c1f04eeeb8d1794',
      v_pre_state_commitment, v_pre_state_commitment,
      v_captured_at, v_captured_at
    );
    update public.aistory_schema_gates as gate_row
    set version = '20260829063000', installed_at = v_captured_at
    where gate_row.gate_name = 'independent_admin_principal'
      and gate_row.version = '20260828233000';
    get diagnostics v_gate_rows = row_count;
    if v_gate_rows <> 1
      or public.aistory_independent_admin_security_posture()
        is distinct from true then
      raise exception 'independent administrator Gate16 capture unavailable';
    end if;
    return;
  end if;

  if (select count(*) from public.independent_admin_principals) <> 1
    or exists (
      select 1
      from public.independent_admin_session_families as family_row
      where family_row.revoked_at is null
    )
    or exists (
      select 1
      from public.independent_admin_sessions as session_row
      where session_row.state = 'active'
    ) then
    raise exception 'independent administrator Gate16 capture unavailable';
  end if;
  select principal_row.principal_ref into v_subject_principal_ref
  from public.independent_admin_principals as principal_row
  where principal_row.singleton_slot = 1
    and principal_row.status = 'active'
    and principal_row.tenant_id = 'platform'
    and principal_row.role = 'super_admin'
    and principal_row.qualification_resolution_ref is null
    and principal_row.qualification_pre_state_sha256 is null
    and principal_row.qualification_retired_at is null;
  if not found then
    raise exception 'independent administrator Gate16 capture unavailable';
  end if;
  v_pre_state_commitment :=
    public.aistory_independent_admin_qualification_pre_state_commitment();
  insert into public.independent_admin_qualification_resolutions (
    schema_version, state, prior_gate_version, gate_version,
    incident_receipt_sha256, gate15_package_sha256,
    gate15_migration_sha256, post_qualification_dump_sha256,
    expected_pre_state_commitment_sha256,
    observed_pre_state_commitment_sha256, subject_principal_ref,
    captured_at
  ) values (
    'aistory.independent-admin.qualification-retirement-resolution.v1',
    'awaiting_attestation', '20260828233000', '20260829063000',
    'f38be911c5c8128ed9344e7e094f2ed2604ee21bc451505e62ad10515f0c4ad3',
    '9e34b8387754c7533c47aeb22ac9d9399f14a95fc65718e567f07d565c91412b',
    '29c23ec6ef72ae04a9037d5c191ccc2b9d0e7fee614284f26a611bb4c4ef2b97',
    'd85d63ed3cf54f8231207383dd5474cb5661aebaab433ee75c1f04eeeb8d1794',
    v_pre_state_commitment, v_pre_state_commitment,
    v_subject_principal_ref, v_captured_at
  );
  if public.aistory_independent_admin_gate_status()
      is distinct from '20260828233000'
    or public.aistory_independent_admin_security_posture()
      is distinct from true then
    raise exception 'independent administrator Gate16 capture unavailable';
  end if;
end;
$$;
