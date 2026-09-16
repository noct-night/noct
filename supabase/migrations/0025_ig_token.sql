-- NOCT 0025: the Instagram access token, and why it cannot live in an environment variable alone.
--
-- The app is configured for Instagram Login, whose tokens last 60 days. A Facebook Page token would not
-- expire at all, but that path needs a Facebook Page and ties the credential to a personal profile, which
-- is the trade this project chose against. So the token has to be refreshed, and a refreshed token has to
-- be written somewhere a running function can write: environment variables on Vercel are immutable at
-- runtime, and a weekly post that needs a human to paste a new token every two months is the thing this
-- whole feature exists to avoid.
--
-- IG_ACCESS_TOKEN remains the seed. This table holds what is actually current.
--
-- One row, enforced by a boolean primary key that can only ever be true. Closed to anon and authenticated
-- the same way ig_post is: reachable only by the owner the API pool connects as.
set search_path = public, extensions;

create table if not exists ig_token (
  id          boolean primary key default true check (id),
  token       text not null,
  -- Null means a seed copied from the environment, whose remaining life we have not been told.
  expires_at  timestamptz,
  obtained_at timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

drop trigger if exists ig_token_touch on ig_token;
create trigger ig_token_touch before update on ig_token for each row execute function touch_updated_at();

alter table ig_token enable row level security;
revoke all on ig_token from anon, authenticated;

comment on table ig_token is
  'The current Instagram access token. Server-side only, never exposed through PostgREST or any API response.';
comment on column ig_token.expires_at is
  'When Instagram says it lapses. src/post/token.ts refreshes within 14 days of this.';
