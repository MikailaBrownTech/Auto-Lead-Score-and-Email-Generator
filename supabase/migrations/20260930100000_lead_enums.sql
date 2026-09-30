-- Lead Console tables live in the SAME Supabase project as the proposal-generator app
-- (clearpath-app/clearpath-proposal-generator), reusing its profiles/role model as-is:
-- public.profiles, public.is_owner(), public.set_updated_at(), the on_auth_user_created trigger,
-- and the user_role enum are already defined by that app's migrations and are NOT redefined here.
--
-- Enumerated types for the Lead Console's own tables.

create type public.lead_source as enum ('web', 'pasted');
create type public.lead_status as enum ('new', 'researching', 'extracted', 'no_named_contact', 'budget_exceeded', 'failed');
create type public.lead_tier as enum ('A', 'B', 'C');
create type public.lead_gate_status as enum ('qualified', 'out_of_icp', 'needs_review');
create type public.lead_sequence_status as enum ('blocked', 'passed', 'approved');
create type public.lead_event_kind as enum ('direct_contact_override', 'gate_override', 'paste_rerun', 'write_attempt');
create type public.candidate_status as enum ('pending', 'promoted', 'dismissed');
-- "write" and "personal_line" are kept for historical runs logged by earlier writer versions.
create type public.run_call_type as enum ('smoke', 'extract', 'extract_retry', 'write', 'personal_line', 'judge');
create type public.run_status as enum ('ok', 'error');
create type public.suppression_kind as enum ('email', 'domain');
