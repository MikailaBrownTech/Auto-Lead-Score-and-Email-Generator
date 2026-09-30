-- Leads (core row). id stays the app's existing human-readable text id (e.g. "lead-smithtax-example")
-- rather than a uuid, so the migration from SQLite preserves every existing reference exactly.
-- Shared across all ClearPath staff, same as clients in the proposal-generator app.

create table public.leads (
  id text primary key,
  input_url text,
  source public.lead_source not null,
  status public.lead_status not null default 'new',
  score integer,
  tier public.lead_tier,
  gate_status public.lead_gate_status,
  gate_reasons jsonb not null default '[]'::jsonb,
  gate_approved boolean not null default false,
  -- Optional per-lead override of no_named_contact (e.g. a solo practice whose only address is the
  -- owner's inbox). Logged in lead_events too.
  direct_contact_override_reason text,
  direct_contact_override_at timestamptz,
  -- Tier is low mainly because of NOT_FOUND fields; the score is not raised for this.
  incomplete_data boolean not null default false,
  error text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger leads_set_updated_at
  before update on public.leads
  for each row execute function public.set_updated_at();

alter table public.leads enable row level security;

create policy "leads_authenticated_all"
  on public.leads for all
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

-- The dossier (verified facts + evidence) is its own table: it is a large JSON blob written once per
-- research run and read far more often than the lead row itself.
create table public.lead_dossiers (
  lead_id text primary key references public.leads(id) on delete cascade,
  dossier jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger lead_dossiers_set_updated_at
  before update on public.lead_dossiers
  for each row execute function public.set_updated_at();

alter table public.lead_dossiers enable row level security;

create policy "lead_dossiers_authenticated_all"
  on public.lead_dossiers for all
  using (auth.uid() is not null)
  with check (auth.uid() is not null);
