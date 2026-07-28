create table if not exists public.platform_provider_configs (
  id text primary key,
  tenant_id text not null,
  modality text not null check (modality in ('text', 'image', 'vision', 'tts', 'video')),
  provider text not null,
  base_url text not null,
  model text not null,
  capabilities jsonb not null default '[]'::jsonb,
  enabled boolean not null default false,
  status text not null check (status in ('unconfigured', 'configured', 'disabled')),
  secret_reference text,
  updated_at timestamptz not null default now(),
  unique (tenant_id, modality)
);

alter table public.platform_provider_configs enable row level security;

-- No browser policy is defined deliberately. Only the server-side admin
-- repository/service-role may read or write secret reference metadata.
revoke all on public.platform_provider_configs from anon, authenticated;
