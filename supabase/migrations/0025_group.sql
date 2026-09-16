-- NOCT 0025: Group Mode -- one link, everyone swipes, the count decides.
--
-- The friction this removes is the group chat: "where do we go" / "anywhere" / "she hates techno". The owner
-- opens a night, taps "Plan with friends", and NOCT makes a deck of up to twelve cards from the top of the
-- owner's own list for that night and copies a link. Everyone who opens the link swipes Like / Pass on the
-- same deck; the result is a count per card, in words -- "3 of 4 liked", "2 of 4 finished" -- never a
-- percentage and never "everyone" unless it is literally everyone who voted.
--
-- Storage is deliberately small: a session (city, night, deck) and one vote per person per card. Identity is
-- the anonymous Supabase account every visitor already has (app.js sbSession), so a link opens with no
-- sign-up. Privacy: a person's own votes are readable only by them (RLS); everyone else sees counts through
-- group_result(), a SECURITY DEFINER function that returns aggregates and the caller's own votes and nothing
-- per person. Sessions are not listable: there is no SELECT for non-owners, the link holder reads through the
-- function, and the id is a random uuid.
set search_path = public, extensions;

create table if not exists group_session (
  session_id uuid primary key default gen_random_uuid(),
  owner_id   uuid not null,
  city       text not null references city(city_key),
  night      date not null,
  -- the cards, in the order the owner's list had them; the client shows the ones still listed
  deck       uuid[] not null check (cardinality(deck) between 1 and 24),
  created_at timestamptz not null default now()
);

create table if not exists group_vote (
  session_id uuid not null references group_session(session_id) on delete cascade,
  user_id    uuid not null,
  event_id   uuid not null references event(event_id) on delete cascade,
  liked      boolean not null,
  created_at timestamptz not null default now(),
  primary key (session_id, user_id, event_id)
);
create index if not exists group_vote_session_idx on group_vote (session_id);

-- a vote is for a card in that session's deck, or it is nothing. SECURITY DEFINER because the check reads
-- group_session, whose rows only the owner may SELECT under RLS: a friend's vote ran this as `authenticated`,
-- saw no session, and was refused as "not in the deck" until the function ran as the table owner.
create or replace function group_vote_biu() returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if not exists (select 1 from group_session s where s.session_id = new.session_id and new.event_id = any(s.deck)) then
    raise exception 'event % is not in the deck of session %', new.event_id, new.session_id using errcode = 'check_violation';
  end if;
  return new;
end $$;
drop trigger if exists group_vote_biu on group_vote;
create trigger group_vote_biu before insert or update on group_vote for each row execute function group_vote_biu();

------------------------------------------------------------------------------
-- Supabase only: user_id defaults, foreign keys to auth.users, RLS
------------------------------------------------------------------------------
do $$
begin
  if to_regprocedure('auth.uid()') is null then
    raise notice 'auth.uid() not present: group defaults/policies skipped (local Postgres)';
    return;
  end if;
  execute 'alter table group_session alter column owner_id set default auth.uid()';
  execute 'alter table group_vote alter column user_id set default auth.uid()';
  if to_regclass('auth.users') is not null then
    if not exists (select 1 from pg_constraint where conname = 'group_session_owner_fk') then
      execute 'alter table group_session add constraint group_session_owner_fk foreign key (owner_id) references auth.users(id) on delete cascade';
    end if;
    if not exists (select 1 from pg_constraint where conname = 'group_vote_user_fk') then
      execute 'alter table group_vote add constraint group_vote_user_fk foreign key (user_id) references auth.users(id) on delete cascade';
    end if;
  end if;
  -- the owner creates a session and may read their own; nobody lists sessions, link holders use group_result()
  execute 'drop policy if exists group_session_own on group_session';
  execute 'create policy group_session_own on group_session for select to authenticated using (owner_id = auth.uid())';
  execute 'drop policy if exists group_session_make on group_session';
  execute 'create policy group_session_make on group_session for insert to authenticated with check (owner_id = auth.uid())';
  -- a vote is the voter's: written, changed and read by them only
  execute 'drop policy if exists group_vote_own on group_vote';
  execute 'create policy group_vote_own on group_vote for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid())';
end $$;

alter table group_session enable row level security;
alter table group_vote    enable row level security;

-- Supabase's default privileges hand anon/authenticated full DML on new tables; take it back before granting
revoke all on group_session, group_vote from public, anon, authenticated;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'grant select, insert on group_session to authenticated';
    execute 'grant select, insert, update on group_vote to authenticated';   -- update: an upsert can change a vote
  end if;
end $$;

------------------------------------------------------------------------------
-- group_result(): what a link holder may see -- the session, counts per card, and their own votes
------------------------------------------------------------------------------
create or replace function group_result(p_session uuid) returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_uid uuid := auth.uid();
  s     group_session%rowtype;
  live  uuid[];
begin
  if v_uid is null or p_session is null then return null; end if;
  select * into s from group_session where session_id = p_session;
  if not found then return null; end if;

  -- cards still listed: a merged or cancelled night cannot be voted on, so it must not block "finished"
  select coalesce(array_agg(d.e order by d.ord), '{}') into live
  from unnest(s.deck) with ordinality d(e, ord)
  join event ev on ev.event_id = d.e
  where ev.merged_into is null and ev.status = 'scheduled';

  return jsonb_build_object(
    'session', jsonb_build_object(
      'id', s.session_id, 'city', s.city, 'night', s.night::text, 'deck', to_jsonb(s.deck), 'live', to_jsonb(live),
      'owner', s.owner_id = v_uid, 'created_at', s.created_at),
    -- people who have voted on at least one card; opening the link is not membership
    'members', (select count(distinct v.user_id) from group_vote v where v.session_id = p_session),
    -- people who have voted on every card still listed
    'finished', (select count(*) from (
        select v.user_id from group_vote v
        where v.session_id = p_session and v.event_id = any(live)
        group by v.user_id having count(*) >= cardinality(live)) f),
    'events', (
      select coalesce(jsonb_agg(jsonb_build_object('event_id', d.e, 'likes', coalesce(c.likes, 0), 'votes', coalesce(c.votes, 0))
                                order by coalesce(c.likes, 0) desc, coalesce(c.votes, 0) desc, d.ord), '[]'::jsonb)
      from unnest(s.deck) with ordinality d(e, ord)
      left join lateral (
        select count(*) filter (where v.liked) as likes, count(*) as votes
        from group_vote v where v.session_id = p_session and v.event_id = d.e
      ) c on true),
    'mine', (
      select coalesce(jsonb_agg(jsonb_build_object('event_id', v.event_id, 'liked', v.liked)), '[]'::jsonb)
      from group_vote v where v.session_id = p_session and v.user_id = v_uid)
  );
end $$;

comment on function group_result(uuid) is
  'A group session as a link holder may see it: counts per card, who-has-finished counts, and the caller''s own votes. SECURITY DEFINER; never returns another person''s vote.';

revoke execute on function group_result(uuid) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function group_result(uuid) from anon';
    execute 'grant execute on function group_result(uuid) to authenticated';
  end if;
end $$;
