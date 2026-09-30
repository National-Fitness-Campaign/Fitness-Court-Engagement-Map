-- Incremental scan rollup for the Fitness Court Engagement Map
-- (migrations: engagement_map_scan_rollup_step1 / _step2)
--
-- Why: scan_daily/scan_totals re-deduped all of scan_logs (jsonb, 400+ MB) on
-- every request and started hitting the 8s PostgREST statement timeout.
-- Now an AFTER INSERT trigger tallies each event once, into a small table,
-- using the same rules as scan_events_clean:
--   * qr_code.scanned rows count once per mappable_id (first insert wins)
--   * legacy rows (event_type IS NULL) count once, on their stored scan_date
--   * dates are America/Los_Angeles, from the event time
-- The trigger never raises: a rollup bug must not cost the webhook a scan.

-- ── Step 1: tables, trigger, cutoff ────────────────────────────────────────
create table if not exists public.scan_rollup_dedup (
  mappable_id text primary key
);

create table if not exists public.scan_daily_rollup (
  qr_id        text    not null,
  scan_date_la date    not null,
  is_bot       boolean not null,
  scans        int     not null default 0,
  primary key (qr_id, scan_date_la, is_bot)
);

create table if not exists public.scan_rollup_meta (
  key   text primary key,
  value text not null
);

alter table public.scan_rollup_dedup enable row level security;
alter table public.scan_daily_rollup enable row level security;
alter table public.scan_rollup_meta  enable row level security;
revoke all on public.scan_rollup_dedup, public.scan_daily_rollup, public.scan_rollup_meta from anon, authenticated;
grant select on public.scan_daily_rollup to service_role;

create or replace function public.scan_rollup_on_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_type text := new.raw_payload->>'event_type';
  v_mid  text := new.raw_payload->'event_detail'->>'mappable_id';
  v_date date;
  v_bot  boolean;
begin
  if v_type = 'qr_code.scanned' then
    if v_mid is null then return null; end if;
    insert into scan_rollup_dedup (mappable_id) values (v_mid) on conflict do nothing;
    if not found then return null; end if;  -- duplicate delivery
    v_date := (coalesce(
                 to_timestamp((new.raw_payload->'event_detail'->>'time')::bigint / 1000.0),
                 new.created_at
               ) at time zone 'America/Los_Angeles')::date;
    v_bot := coalesce((new.raw_payload->'event_detail'->>'isBotScan')::boolean, false);
  elsif v_type is null then
    v_date := new.scan_date;
    v_bot := false;
  else
    return null;  -- qr_code_view etc.: the paired duplicate, not counted
  end if;

  insert into scan_daily_rollup (qr_id, scan_date_la, is_bot, scans)
  values (new.qr_id, v_date, v_bot, 1)
  on conflict (qr_id, scan_date_la, is_bot) do update set scans = scan_daily_rollup.scans + 1;
  return null;
exception when others then
  raise warning 'scan_rollup_on_insert failed for scan_logs.id=%: %', new.id, sqlerrm;
  return null;
end $$;

revoke all on function public.scan_rollup_on_insert() from public, anon, authenticated;

drop trigger if exists scan_logs_rollup on public.scan_logs;
create trigger scan_logs_rollup
  after insert on public.scan_logs
  for each row execute function public.scan_rollup_on_insert();

-- Rows at or below this id are backfilled in step 2; everything after is live.
-- (CREATE TRIGGER holds a lock that blocks concurrent inserts, so max(id) here
-- is exact.)
insert into public.scan_rollup_meta (key, value)
select 'backfill_cutoff_id', coalesce(max(id), 0)::text from public.scan_logs
on conflict (key) do nothing;

-- ── Step 2: backfill everything at or below the cutoff ─────────────────────
-- Same rules as scan_events_clean, restricted to id <= backfill_cutoff_id.
-- Verified 2026-09-30: 10,244 rows / 44,811 scans, identical to the old view.
--   (see migration engagement_map_scan_rollup_step2_backfill for the SQL)

-- ── Step 3: point the read views at the rollup ─────────────────────────────
create or replace view public.scan_daily as
select qr_id, scan_date_la, is_bot, scans
from public.scan_daily_rollup
where scans > 0;

revoke all on public.scan_daily from anon, authenticated;
grant select on public.scan_daily to service_role;
-- scan_totals (views.sql) aggregates scan_daily and needs no change.
-- scan_events_clean is kept as the slow, from-scratch reference. To audit:
--   select * from scan_daily_rollup except select qr_id, scan_date_la, is_bot, count(*)::int
--   from scan_events_clean group by 1,2,3;   -- expect 0 rows

-- ── qr_site_links (migration: engagement_map_qr_site_links) ────────────────
-- Uniqode QR code -> Salesforce Site__c + court coordinates, written by
-- scripts/sync-salesforce-locations.mjs, read by /api/courts.
create table if not exists public.qr_site_links (
  qr_id        text primary key,
  qr_name      text not null,
  sf_site_id   text,
  sf_site_name text,
  match        text not null check (match in ('exact','likely','override','none')),
  score        real,
  lat          double precision,
  lon          double precision,
  coord_note   text,
  synced_at    timestamptz not null default now()
);
alter table public.qr_site_links enable row level security;
revoke all on public.qr_site_links from anon, authenticated;
grant select, insert, update, delete on public.qr_site_links to service_role;

-- ── Guard + maintenance (migration: engagement_map_scan_logs_guard) ───────
-- * scan_rollup_errors: the trigger records any row it couldn't tally.
-- * scan_logs is append-only: BEFORE UPDATE/DELETE (row) and BEFORE TRUNCATE
--   (statement) triggers raise unless app.scan_logs_maintenance = 'on', and
--   UPDATE/DELETE/TRUNCATE are revoked from anon, authenticated, service_role.
-- * rebuild_scan_rollup(): recomputes scan_daily_rollup + scan_rollup_dedup
--   from scratch with the scan_events_clean rules (idempotent — this replaces
--   the one-off step-2 backfill, which must NOT be re-run: it adds).
-- * scan_rollup_audit: rows where the rollup and a full recount disagree.
--
-- Deliberate cleanup (e.g. removing test scans):
--   begin;
--   set local app.scan_logs_maintenance = 'on';
--   delete from public.scan_logs where ...;
--   select * from public.rebuild_scan_rollup();
--   commit;
--
-- Health check (expect 0 and 0):
--   select (select count(*) from scan_rollup_audit), (select count(*) from scan_rollup_errors);
--
-- Full SQL as applied: see the migration in the Supabase dashboard
-- (Database → Migrations → engagement_map_scan_logs_guard).

-- ── scan_logs is server-only (migration: engagement_map_scan_logs_server_only)
-- The old policies (allow_read_scan_logs SELECT, allow_service_insert INSERT)
-- applied to role `public`, so the public anon key could insert fake scans.
-- Writers/readers are the receive-scan edge function and this app's API, both
-- service_role (bypasses RLS). Verified after: anon → 42501 on read and insert.
drop policy if exists allow_read_scan_logs on public.scan_logs;
drop policy if exists allow_service_insert on public.scan_logs;
revoke all on public.scan_logs from anon, authenticated;
alter table public.scan_logs enable row level security;
revoke all on sequence public.scan_logs_id_seq from anon, authenticated;
