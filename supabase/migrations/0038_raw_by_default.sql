-- NOCT 0038: new posts keep the photograph's own colour.
--
-- Mono was the default from the first deck, on the reasoning that one treatment across a feed of borrowed
-- promoter artwork makes an inconsistent set read as one account. In use the opposite turned out to be true
-- for NOCT: the colour is what the night looked like, and a wall of grey reads as a stock feed. Raw is the
-- default now; the treatments are still there, per post and per slide, for a flyer that needs one.
--
-- Posts already drafted keep what they were drafted with: a treatment somebody looked at and approved is a
-- decision, and a migration is not the place to overrule one.
set search_path = public, extensions;

alter table ig_post alter column treatment set default 'none';
comment on column ig_post.treatment is
  'Default look for this post''s photographs: none (raw colour, the default), mono, crush, warm. A slide may override it.';
