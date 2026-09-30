-- New table (no SQLite source): a pre-import queue. A URL or firm name staff want to look into, before
-- it becomes a full researched lead row. Promoting a candidate creates a leads row and records it here.

create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  url text,
  firm_name text,
  note text,
  status public.candidate_status not null default 'pending',
  promoted_lead_id text references public.leads(id) on delete set null,
  submitted_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger candidates_set_updated_at
  before update on public.candidates
  for each row execute function public.set_updated_at();

alter table public.candidates enable row level security;

create policy "candidates_authenticated_all"
  on public.candidates for all
  using (auth.uid() is not null)
  with check (auth.uid() is not null);
