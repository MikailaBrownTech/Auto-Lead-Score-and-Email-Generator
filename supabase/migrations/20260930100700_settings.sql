-- Founder-facing settings: the docs/01 signature/footer/offer fields, and the monthly spend cap.
-- A singleton table (id is always true; the check constraint forbids a second row). Prompts, scoring,
-- and style stay file-based in docs/ (CLAUDE.md's source of truth) -- this table is only the small set
-- of values the founder edits from the Settings screen, matching how plans/add_ons already restrict
-- writes to an owner: anyone signed in may read it, only an owner may change it.

create table public.settings (
  id boolean primary key default true,
  sender_name text not null default '',
  sender_title text not null default '',
  company_name text not null default '',
  company_website text not null default '',
  opt_out_line text not null default '',
  physical_address text not null default '',
  approved_proof jsonb not null default '[]'::jsonb,
  founding_client_offer text,
  booking_link text not null default '',
  region text not null default '',
  company_one_liner text not null default '',
  include_dns_observation boolean not null default false,
  checklist_ready boolean not null default false,
  monthly_spend_cap_usd numeric(10, 2) not null default 10,
  updated_at timestamptz not null default now(),
  constraint settings_singleton check (id)
);

create trigger settings_set_updated_at
  before update on public.settings
  for each row execute function public.set_updated_at();

alter table public.settings enable row level security;

create policy "settings_select_authenticated"
  on public.settings for select
  using (auth.uid() is not null);

create policy "settings_insert_owner"
  on public.settings for insert
  with check (public.is_owner());

create policy "settings_update_owner"
  on public.settings for update
  using (public.is_owner())
  with check (public.is_owner());
