-- NOCT 0033: a publish attempt that is waiting on Instagram, not one that failed.
--
-- A carousel's children are ready the moment the Graph API returns their ids, so a publish is one straight
-- run of calls and every outcome is either 'succeeded' or 'failed'. A reel is not: the container is
-- processed **asynchronously**, and `media_publish` refuses it until `status_code` reads FINISHED. How long
-- that takes is Meta's business, and for a 90-second clip it can outlast the 120 s function cap in
-- vercel.json.
--
-- Without a third state, that leaves two bad options: hold the lambda until it is killed mid-publish, or
-- record a 'failed' run for something that is going perfectly well and whose container is still valid for
-- 24 hours. So 'pending' means exactly one thing: **the container exists and the work can be resumed.**
-- The next POST to /api/publish finds it and polls it instead of encoding and uploading a second copy.
--
-- 'pending' deliberately does not block a new claim the way 'running' does (see claimForPublish): being
-- told "a publish is already in flight" when nothing is in flight is the state this replaces.
set search_path = public, extensions;

alter table ig_publish_run drop constraint if exists ig_publish_run_status_check;
alter table ig_publish_run add constraint ig_publish_run_status_check
  check (status in ('running','pending','succeeded','failed'));

-- A pending run is only resumable if it actually named a container; without one there is nothing to poll.
alter table ig_publish_run drop constraint if exists ig_publish_run_pending_has_container;
alter table ig_publish_run add constraint ig_publish_run_pending_has_container
  check (status <> 'pending' or container_id is not null);

-- Looking up "is there a container to resume for this post" is the one new read, and it wants the newest.
create index if not exists ig_publish_run_pending_idx
  on ig_publish_run (post_id, started_at desc) where status = 'pending';

comment on column ig_publish_run.status is
  'running = in flight; pending = reel container created, still processing at Meta, resumable; '
  'succeeded / failed = terminal.';
