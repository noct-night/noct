-- NOCT 0040: the weekend deck drafts itself on Thursday morning.
--
-- The studio has always been able to draft on demand, which means the week's post exists only once someone
-- remembers to make it, usually on the day it should already have gone out. Drafting is also the only part
-- of the pipeline that says nothing in public: it reads the feed and writes a queued post. So it is the one
-- part worth doing unattended -- Thursday at 09:40 New York, the deck is waiting, and the person's job is
-- the part that needs a person: read it, fix the words, publish.
--
-- Nothing else is scheduled. Approving and publishing stay manual by design (docs/INSTAGRAM.md), and a
-- cron that could publish would be a cron that could post the wrong thing while nobody was looking.
--
-- 14:40 UTC is 09:40 in New York during daylight time and 09:40 standard time is 14:40 too only in summer;
-- the hour drifts by one in winter, which does not matter for a draft that waits.
--
-- Requires app_setting vercel_base_url + cron_secret (0008). Without them noct_call does nothing and says so.
set search_path = public, extensions;

do $do$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice '0040: pg_cron not installed; the weekly draft is not scheduled';
    return;
  end if;
  -- Thursday, so there is a clear day to review it before the weekend it is about.
  perform cron.schedule('noct-draft-weekend', '40 14 * * 4', $c$select public.noct_call('/api/posts?draft=weekend')$c$);
end $do$;
