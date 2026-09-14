-- NOCT 0012: 19hz.info community listings (regions outside New York) + daily cron.
set search_path = public, extensions;

insert into source (source_key, display_name, kind, priority, fees_included_default, is_ticketer, tos_notes) values
  ('19hz', '19hz', 'scrape', 45, false, false,
   'Community-run regional listings (19hz.info). One page per enabled city per day; rows link to the ticket platform. No New York list.')
on conflict (source_key) do update set display_name = excluded.display_name, kind = excluded.kind, priority = excluded.priority,
  fees_included_default = excluded.fees_included_default, is_ticketer = excluded.is_ticketer, tos_notes = excluded.tos_notes;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'noct-ingest-19hz';
    perform cron.schedule('noct-ingest-19hz', '48 9 * * *', $c$select public.noct_call('/api/ingest/19hz')$c$);
    raise notice 'noct-ingest-19hz scheduled';
  else
    raise notice 'pg_cron not installed; skipping 19hz schedule';
  end if;
end $$;
