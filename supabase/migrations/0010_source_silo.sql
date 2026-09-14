-- NOCT 0010: SILO Brooklyn venue-direct source (DICE data read from the venue's own site) + its cron job.
set search_path = public, extensions;

insert into source (source_key, display_name, kind, priority, fees_included_default, is_ticketer, tos_notes) values
  ('silo', 'DICE · SILO', 'feed', 75, true, true,
   'SILO Brooklyn''s website (www.silobrooklyn.com) server-renders its DICE calendar; NOCT reads that public page daily. Tickets on dice.fm. No DICE API/key.')
on conflict (source_key) do update set display_name = excluded.display_name, kind = excluded.kind, priority = excluded.priority,
  fees_included_default = excluded.fees_included_default, is_ticketer = excluded.is_ticketer, tos_notes = excluded.tos_notes;

-- 0006 seeded the venue as 'SILO Brooklyn' (slug silo-brooklyn); make sure the DICE label variants resolve to it.
insert into venue_alias (alias_norm, alias, venue_id, kind, source_key)
select norm_text(a), a, v.venue_id, 'source_label', 'silo'
from venue v, unnest(array['SILO Brooklyn', 'Silo Brooklyn', 'SILO', 'Silo']) as a
where v.slug = 'silo-brooklyn'
on conflict (alias_norm) do nothing;
insert into venue_external_id (source_key, source_id, venue_id)
select 'silo', '8169', v.venue_id from venue v where v.slug = 'silo-brooklyn'
on conflict do nothing;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'noct-ingest-venues-silo';
    perform cron.schedule('noct-ingest-venues-silo', '26 9 * * *', $c$select public.noct_call('/api/ingest/silo')$c$);
    raise notice 'noct-ingest-venues-silo scheduled';
  else
    raise notice 'pg_cron not installed; skipping silo schedule';
  end if;
end $$;
