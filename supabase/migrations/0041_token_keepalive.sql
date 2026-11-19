-- NOCT 0041: the Instagram credential refreshes itself, whether or not anything is posted.
--
-- An Instagram Login token lasts 60 days and is refreshable, so src/post/token.ts refreshed it on the way
-- to a publish and the reasoning was that a weekly post is a weekly refresh. On 3 November the account
-- published with the token fourteen days and two hours from lapsing -- two hours outside the refresh
-- window -- passed on the following week's deck, and the credential died on 17 November. Nothing had gone
-- wrong. The refresh had simply been attached to the one action that stops happening when an account goes
-- quiet, which is exactly when nobody is watching the expiry.
--
-- So it gets a job of its own. Daily rather than weekly because the call costs nothing on the days it does
-- nothing: inside the function the token is only sent to Instagram once it is within two weeks of lapsing,
-- and otherwise this is a single row read. Daily also means six consecutive failures still leave the
-- credential alive, which weekly does not.
--
-- This posts nothing. /api/publish accepts the cron bearer for ?refresh=token alone -- it cannot name a
-- post, and the token never leaves the function. Publishing stays a person pressing a button.
--
-- Requires app_setting vercel_base_url + cron_secret (0008). Without them noct_call does nothing and says so.
set search_path = public, extensions;

do $do$
begin
  if to_regprocedure('cron.schedule(text,text,text)') is null then
    raise notice '0041: pg_cron not installed; the token keep-alive is not scheduled';
    return;
  end if;
  -- 15:05 UTC: clear of the ingest jobs at :12 to :29 and the hourly enrich at :40.
  perform cron.schedule('noct-token-refresh', '5 15 * * *', $c$select public.noct_call('/api/publish?refresh=token')$c$);
end $do$;
