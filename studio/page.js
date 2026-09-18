/**
 * The studio: reviewing and publishing NOCT's Instagram posts.
 *
 * Every slide preview on this page is the real renderer's output, fetched from /api/render as a JPEG. It is
 * not a CSS approximation of the post: what she approves is the file Instagram will be handed, which is the
 * whole point of the endpoint existing. It also means a preview costs a render, so URLs are only re-signed
 * when something that changes the pixels changes.
 *
 * State lives on the server. The page holds no truth of its own beyond what it last fetched, so a second
 * tab, a reload or a different laptop all show the same studio.
 */
(function () {
  'use strict';

  var IG_MAX = 2200;
  var TAG_MAX = 5;
  /**
   * The top bar, in three groups: the posts being worked on, the record of what went out, and the site's own
   * traffic. Three different questions, and reading them as one row of eight made the bar a list rather than
   * a place. Last slide and Draft belong with the posts, so they sit in that group.
   */
  var TABS = [
    [
      { k: 'queued', t: 'Queue' },
      { k: 'approved', t: 'Approved' },
      { k: 'posted', t: 'Published' },
      { k: 'passed', t: 'Passed' },
      { k: 'all', t: 'Everything' },
    ],
    [{ k: 'calendar', t: 'Calendar' }],
    [{ k: 'traffic', t: 'Traffic' }],
  ];
  var FILTERS = TABS.reduce(function (all, group) { return all.concat(group); }, []);
  var LABEL = { queued: 'In queue', approved: 'Approved', passed: 'Passed', posted: 'Published' };
  var TPL_LABEL = {
    cover: 'carousel', event: 'event', table: 'table', listing: 'listing',
    venue: 'venue', venuecover: 'venues', note: 'note', cta: 'cta',
  };
  var TAKES_IMAGE = { cover: 1, event: 1, venue: 1 };
  /** Slides whose rewritten words survive a redraft (the server marks them `edited`). */
  var KEEPS_EDITS = { cover: 1, event: 1, venue: 1, cta: 1 };
  var LOOKS = [
    { k: 'none', t: 'Raw' },
    { k: 'mono', t: 'Mono' },
    { k: 'crush', t: 'Mono, crushed' },
    { k: 'warm', t: 'Warm mono' },
  ];
  /**
   * The words on each template that can be rewritten, as [field, label, multiline, max length]. The lengths
   * are the schema's (src/post/types.ts), so the field stops where the server would refuse.
   */
  var FIELDS = {
    cover: [['lede', 'Title', true, 400], ['date', 'Date line', false, 400], ['foot', 'Bottom left', false, 120]],
    event: [['position', 'Day', false, 120], ['name', 'Title', true, 400], ['venue', 'Venue', false, 120],
      ['time', 'Time', false, 120], ['genre', 'Genre', false, 120]],
    venue: [['index', 'Number', false, 120], ['name', 'Name', false, 400], ['hood', 'Neighbourhood', false, 120],
      ['note', 'About', true, 600], ['foot', 'Address', false, 400]],
    venuecover: [['lede', 'Title', true, 400], ['sub', 'Subtitle', true, 400], ['foot', 'Bottom left', false, 120]],
    note: [['text', 'Text', true, 400], ['after', 'After', true, 600], ['foot', 'Foot', false, 120]],
    cta: [['question', 'Question', true, 400], ['answer', 'Answer', false, 400], ['link', 'Link', false, 120],
      ['note', 'Note', false, 120]],
    table: [['kicker', 'Kicker', false, 120], ['when', 'Heading', false, 400], ['rows', 'Rows', true, 0]],
    listing: [['kicker', 'Kicker', false, 120], ['when', 'Heading', false, 400]],
  };
  var TABLE_ROWS_MAX = 7;
  var NY = 'America/New_York';
  /** What the Draft menu offers, in the order a week is usually worked through. */
  var DRAFT_KINDS = [
    { k: 'weekend', t: 'This weekend', hint: 'The weekend guide: cover, top nights, tables' },
    { k: 'genre', t: 'Genre editions', hint: 'Up to 3, one per strong genre this weekend' },
    { k: 'spotlight', t: 'Spotlights', hint: 'The 3 most anticipated nights, next 2 weeks' },
    { k: 'venue', t: 'Venue posts', hint: 'The 4 busiest venues, next 2 weeks' },
  ];

  var posts = [];
  var filter = 'queued';
  /** post id -> array of signed render URLs, in slide order. Dropped whenever the deck or the look changes. */
  var shots = {};
  var busy = {};
  /** The month the calendar shows, YYYY-MM. Set to this month the first time it opens. */
  var calMonth = null;
  /**
   * The traffic report (/api/traffic, src/ops/traffic.ts): NOCT's own visit and action rows, aggregated. Held
   * with the window it was fetched for and when, so switching tabs does not refetch and Refresh does.
   */
  var traffic = { days: 30, data: null, at: 0, loading: false, error: null };
  var TRAFFIC_WINDOWS = [7, 30, 90];
  var TRAFFIC_FRESH_MS = 60 * 1000;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function byId(id) { return document.getElementById(id); }

  // ── talking to the API ────────────────────────────────────────────────────

  function api(path, options) {
    var opts = options || {};
    return fetch(path, {
      method: opts.method || 'GET',
      headers: opts.body ? { 'content-type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        if (res.status === 401) { showGate(); throw new Error('signed out'); }
        if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
        return body;
      });
    });
  }

  function showGate() {
    var studio = byId('studioView');
    if (studio) studio.hidden = true;
    byId('gateView').hidden = false;
    byId('gatePass').focus();
  }

  // ── caption rules ─────────────────────────────────────────────────────────
  // A copy of the checks in src/post/caption.ts so the warning appears as she types. The server runs the
  // real ones before publishing; this is a courtesy, never the enforcement.

  function tagCount(s) { return (String(s).match(/#[^\s#]+/g) || []).length; }

  /**
   * The caption's length as it will publish: credits are added after the text (src/post/photos.ts
   * withCredits), and Instagram's 2200 counts them.
   */
  function publishedLength(caption, credits) {
    if (!credits.length) return caption.length;
    return caption.replace(/\s+$/, '').length + 2 + credits.join('\n').length;
  }

  /** Things to check before approving that are about the post, not the caption's wording. */
  function reviewNotes(p) {
    var out = [];
    (p.slides || []).forEach(function (s) {
      if (s.template !== 'venue') return;
      if (s.data && s.data.verified === false) {
        out.push('Check the address: nobody has verified the details for ' + (s.data.name || 'this venue') + ' yet.');
      }
      if (!s.data || !s.data.image) out.push('No venue photo yet. Use Add photo under the venue slide.');
    });
    return out;
  }

  function captionWarnings(caption) {
    var out = [];
    if (caption.length > IG_MAX) out.push((caption.length - IG_MAX) + ' characters over Instagram’s limit.');
    if (tagCount(caption) > TAG_MAX) out.push('Keep the ' + TAG_MAX + ' hashtags closest to the event and drop the rest.');
    if (/[—–]/.test(caption)) out.push('Em dash. Use a comma, a full stop or a slash.');
    if (caption.indexOf('·') >= 0) out.push('Middle dot separator. Use a slash or a hyphen.');
    if (/\b(?:it['’]?s|it is|this is|these are|that['’]?s|that is)\b[^.!?\n]{1,80}?,\s*not\b/i.test(caption)) {
      out.push('"A, not B" construction. Say what it is and stop.');
    }
    return out;
  }

  // ── previews ──────────────────────────────────────────────────────────────

  /** Ask the server to sign this deck's slides, then swap the URLs in. */
  function loadShots(post) {
    if (shots[post.id] || !post.slides.length) return Promise.resolve();
    shots[post.id] = 'pending';
    return api('/api/render', {
      method: 'POST',
      body: { slides: post.slides, treatment: post.treatment, grain: post.grain },
    }).then(function (body) {
      shots[post.id] = body.urls;
      paintShots(post.id);
    }).catch(function (err) {
      shots[post.id] = { error: err.message };
      paintShots(post.id);
    });
  }

  /**
   * What a saved slide is called on disk: the post it belongs to and its place in the deck, so a folder of
   * them still says which weekend they are and which order they go up in.
   */
  function fileName(p, n) {
    var when = p.slot || (p.posted_at || '').slice(0, 10) || 'undated';
    return ('noct-' + when + '-' + p.series + '-' + pad(n + 1) + '.jpg').replace(/[^a-zA-Z0-9.\-]+/g, '-');
  }

  function paintShots(id) {
    var urls = shots[id];
    var row = document.querySelector('.row[data-id="' + id + '"]');
    if (!row) return;
    Array.prototype.forEach.call(row.querySelectorAll('.shot'), function (shot, n) {
      var slot = shot.querySelector('.pending');
      if (!slot) return;
      if (urls && urls.error) {
        slot.className = 'pending failed';
        slot.textContent = urls.error;
        return;
      }
      if (!urls || urls === 'pending' || !urls[n]) return;
      var link = shot.parentNode.querySelector('[data-save="' + n + '"]');
      if (link) { link.href = urls[n]; link.hidden = false; }
      var img = new Image();
      img.alt = '';
      img.onload = function () { slot.replaceWith(img); };
      img.onerror = function () { slot.className = 'pending failed'; slot.textContent = 'Could not render this slide.'; };
      img.src = urls[n];
    });
  }

  // ── rendering the page ────────────────────────────────────────────────────

  function slidesOf(p) { return p.slides || []; }

  function isReel(p) { return p.kind === 'reel'; }

  /** Seconds and dimensions, from what ffprobe measured at encode time. */
  function reelSub(p) {
    var m = p.video_meta || {};
    var bits = [];
    if (m.seconds) bits.push(Math.round(m.seconds) + 's');
    if (m.width && m.height) bits.push(m.width + 'x' + m.height);
    if (m.bytes) bits.push((m.bytes / 1e6).toFixed(1) + ' MB');
    return bits.length ? 'Reel / ' + bits.join('  /  ') : 'Reel';
  }

  function headline(p) {
    // A reel carries no slides, so its title comes from the caption's first line -- which is the only
    // text the post has that a person wrote.
    if (isReel(p)) return (p.caption || '').split('\n')[0].slice(0, 80) || 'Untitled reel';
    var s = slidesOf(p)[0];
    if (!s) return 'Empty post';
    var d = s.data || {};
    if (s.template === 'cover') return d.lede || 'Cover';
    if (s.template === 'table') return d.when || 'Weekend table';
    if (s.template === 'event') return d.name || 'Untitled event';
    if (s.template === 'listing') return d.when || 'Tonight';
    if (s.template === 'venue') return d.name || 'Venue';
    if (s.template === 'venuecover') return d.lede || 'Venues';
    return d.text || 'Note';
  }

  function subline(p) {
    if (isReel(p)) return reelSub(p);
    var sl = slidesOf(p);
    if (sl.length > 1) return sl.length + ' slides';
    return sl.length === 1 ? (TPL_LABEL[sl[0].template] || sl[0].template) : 'no slides';
  }

  function visible() {
    return filter === 'all' ? posts : posts.filter(function (p) { return p.status === filter; });
  }

  function chipFor(f) {
    var n = f.k === 'all' ? posts.length
      : f.k === 'calendar' ? posts.filter(function (p) { return p.status === 'posted'; }).length
      : f.k === 'traffic' ? (traffic.data ? traffic.data.visits.recent : null)   /* the week's visits, once read */
      : posts.filter(function (p) { return p.status === f.k; }).length;
    return '<button type="button" class="chip" data-f="' + f.k + '" aria-current="' + (filter === f.k) + '">'
      + f.t + (n == null ? '' : '<span class="n">' + n + '</span>') + '</button>';
  }

  function renderFilters() {
    var groups = TABS.map(function (group, i) {
      return '<div class="tabs">'
        + group.map(chipFor).join('')
        // The posts group carries what is done to posts: the closing slide's words, and drafting new ones.
        + (i === 0 ? '<button type="button" class="chip" data-cta>Last slide</button>' : '')
        + '</div>';
    }).join('');
    byId('filters').innerHTML = groups
      + '<div class="draft-menu">'
      +   '<button type="button" class="btn btn-go draft-toggle" aria-haspopup="menu" aria-expanded="false">Draft</button>'
      +   '<div class="draft-list" role="menu" hidden>'
      +     DRAFT_KINDS.map(function (d) {
              return '<button type="button" role="menuitem" data-draft="' + d.k + '">'
                + '<b>' + d.t + '</b><span>' + d.hint + '</span></button>';
            }).join('')
      +   '</div>'
      + '</div>';
  }

  function setDraftMenu(open) {
    var menu = document.querySelector('.draft-list');
    var toggle = document.querySelector('.draft-toggle');
    if (!menu || !toggle) return;
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) { var first = menu.querySelector('button'); if (first) first.focus(); }
  }

  function renderReady() {
    var a = posts.filter(function (p) { return p.status === 'approved'; }).length;
    byId('ready').innerHTML = a === 0
      ? 'Nothing approved yet'
      : '<b>' + a + '</b> ' + (a === 1 ? 'post' : 'posts') + ' ready to publish';
  }

  function isStudioPhoto(img) { return !!img && /^photo:/.test(img.src); }

  function lookOf(p, img) { return img.treatment || p.treatment; }
  function grainOf(p, img) { return img.grain === undefined ? p.grain : img.grain; }

  function slideMarkup(p, s, n) {
    var takesImage = !!TAKES_IMAGE[s.template];
    var img = (s.data || {}).image;
    var locked = p.status === 'posted';
    // Under the slide and always shown. These used to appear only on hover, over the bottom of the preview,
    // and a control you have to already know is there is one people go looking for and do not find.
    // The rendered JPEG, saved to disk. The href arrives with the preview (paintShots): it is the same
    // signed URL the preview draws and the one Instagram is handed, so what is saved is what would post.
    var save = '<a class="save" data-save="' + n + '" download="' + esc(fileName(p, n)) + '" hidden>Save</a>';
    var tools = '<div class="shot-tools">' + save + '</div>';
    if (!locked) {
      var photo = takesImage
        ? '<button type="button" data-photo="add" data-slide="' + n + '">' + (img ? 'Change photo' : 'Add photo') + '</button>'
          + (isStudioPhoto(img) ? '<button type="button" data-photo="remove" data-slide="' + n + '">'
              + (img.flyer ? 'Back to flyer' : 'Remove photo') + '</button>' : '')
        : '';
      // The look is per slide: a raw photo can sit next to mono flyers when that is what the deck needs.
      var look = takesImage && img
        ? '<span class="fit" role="group" aria-label="Framing">'
          +   '<button type="button" data-fit="cover" data-slide="' + n + '" aria-pressed="' + (img.fit !== 'contain') + '">Fill</button>'
          +   '<button type="button" data-fit="contain" data-slide="' + n + '" aria-pressed="' + (img.fit === 'contain') + '">Fit whole</button>'
          + '</span>'
          + '<select data-look="' + n + '" aria-label="Look for slide ' + (n + 1) + '">'
          +   LOOKS.map(function (o) {
                return '<option value="' + o.k + '"' + (lookOf(p, img) === o.k ? ' selected' : '') + '>' + o.t + '</option>';
              }).join('')
          + '</select>'
          + '<button type="button" data-grain="' + n + '" aria-pressed="' + !!grainOf(p, img) + '">Grain</button>'
        : '';
      var flyer = takesImage && img && !isStudioPhoto(img)
        ? '<a href="' + esc(img.src) + '" target="_blank" rel="noopener noreferrer">Open flyer</a>' : '';
      tools = '<div class="shot-tools">'
        + '<button type="button" data-edit="' + n + '">Edit text</button>'
        + photo + look + flyer + save
        + '</div>';
    }
    return '<div class="slide-col">'
      + '<div class="shot" data-slide="' + n + '"><div class="pending">Rendering</div></div>'
      + tools
      + '</div>';
  }

  /**
   * A reel's preview: the actual encoded MP4, played from the public bucket.
   *
   * Not a rendered frame and not the cover -- the thing being approved is a moving image with burned-in
   * type, and the only honest review of that is watching it. `preload="metadata"` so opening the studio
   * does not pull every reel in the list, and `playsinline` so a tap on a phone plays it in place instead
   * of taking over the screen.
   */
  function reelMarkup(p) {
    if (!p.video_url || p.video_url.indexOf('pending:') === 0) {
      return '<div class="shot shot-reel"><div class="failed">The upload did not finish.'
        + ' Run <strong>npm run clip</strong> again.</div></div>';
    }
    return '<div class="shot shot-reel">'
      + '<video src="' + esc(p.video_url) + '"' + (p.cover_url ? ' poster="' + esc(p.cover_url) + '"' : '')
      + ' controls preload="metadata" playsinline></video>'
      + '<div class="shot-ui">'
      +   '<a href="' + esc(p.video_url) + '" target="_blank" rel="noopener noreferrer">Open the file</a>'
      + '</div>'
      + '</div>';
  }

  function renderStream() {
    var host = byId('stream');
    if (filter === 'calendar') { renderCalendar(host); return; }
    if (filter === 'traffic') { renderTraffic(host); return; }
    var list = visible();

    if (!list.length) {
      var name = FILTERS.filter(function (f) { return f.k === filter; })[0].t;
      host.innerHTML = '<p class="empty">' + (posts.length
        ? 'Nothing under <strong>' + esc(name) + '</strong> right now.'
        : 'Nothing here yet. Use <strong>Draft</strong> to build posts from the live feed.')
        + '</p>';
      return;
    }

    // Where each deck was scrolled to, so saving a change to slide 4 does not throw her back to slide 1.
    var scrolled = {};
    Array.prototype.forEach.call(host.querySelectorAll('.row'), function (row) {
      var strip = row.querySelector('[data-strip]');
      if (strip) scrolled[row.getAttribute('data-id')] = strip.scrollLeft;
    });

    host.innerHTML = list.map(function (p, i) {
      var cap = p.caption || '';
      var locked = p.status === 'posted';
      var sl = slidesOf(p);
      var warnings = captionWarnings(cap);
      var credits = p.credits || [];
      var notes = reviewNotes(p);

      var strip = isReel(p) ? reelMarkup(p) : sl.map(function (s, n) { return slideMarkup(p, s, n); }).join('');
      var dots = !isReel(p) && sl.length > 1
        ? '<div class="dots" data-dots>' + sl.map(function (s, n) {
            return '<button type="button" data-go="' + n + '" aria-current="' + (n === 0)
              + '" aria-label="Slide ' + (n + 1) + '"></button>';
          }).join('') + '<span class="of">' + sl.length + ' slides</span></div>'
        : '';

      return '<article class="row is-' + p.status + '" data-id="' + esc(p.id) + '">'
        + '<div class="idx">' + pad(i + 1) + '</div>'
        + '<div class="deck"><div class="strip-wrap"><div class="strip" data-strip>' + strip + '</div>'
        +   (!isReel(p) && sl.length > 1
              ? '<button type="button" class="nav prev" data-nav="-1" aria-label="Previous slide">' + CHEVRON + '</button>'
                + '<button type="button" class="nav next" data-nav="1" aria-label="Next slide">' + CHEVRON + '</button>'
              : '')
        + '</div>' + dots + '</div>'
        + '<div class="meta">'
        +   '<div class="head">'
        +     '<div class="slot"><span class="pip"></span>' + esc(p.slot || 'Unscheduled')
        +       '<span class="tag">' + esc(p.series) + '</span></div>'
        +     '<h2 class="title">' + esc(headline(p)) + '</h2>'
        +     '<p class="sub">' + esc(subline(p)) + '</p>'
        +     notes.map(function (w) { return '<p class="warn">' + esc(w) + '</p>'; }).join('')
        +   '</div>'
        +   '<div class="field">'
        +     '<label for="cap-' + esc(p.id) + '">Caption</label>'
        +     '<textarea id="cap-' + esc(p.id) + '" data-cap="' + esc(p.id) + '"' + (locked ? ' readonly' : '') + '>'
        +       esc(cap) + '</textarea>'
        +     '<div class="counts">'
        +       '<span class="count' + (tagCount(cap) > TAG_MAX ? ' over' : '') + '" data-tags="' + esc(p.id) + '">'
        +         tagCount(cap) + ' / ' + TAG_MAX + ' tags</span>'
        +       '<span class="count' + (publishedLength(cap, credits) > IG_MAX ? ' over' : '') + '" data-count="' + esc(p.id) + '">'
        +         publishedLength(cap, credits) + ' / ' + IG_MAX + '</span>'
        +     '</div>'
        +     (credits.length
              ? '<p class="credits">Added to the caption when published:<br>' + credits.map(esc).join('<br>') + '</p>' : '')
        +     '<ul class="rules" data-rules="' + esc(p.id) + '">'
        +       warnings.map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('') + '</ul>'
        +   '</div>'
        +   '<div class="acts">'
        +     '<button type="button" class="btn ' + (p.status === 'approved' ? 'btn-on' : 'btn-go') + '" data-act="approve"'
        +       (locked ? ' disabled' : '') + '>' + (p.status === 'approved' ? 'Approved' : 'Approve') + '</button>'
        +     '<button type="button" class="btn ' + (p.status === 'passed' ? 'btn-on' : '') + '" data-act="pass"'
        +       (locked ? ' disabled' : '') + '>' + (p.status === 'passed' ? 'Passed' : 'Pass') + '</button>'
        +     (p.status === 'approved'
              ? '<button type="button" class="btn btn-go" data-act="publish">Publish to Instagram</button>' : '')
        +     (canChooseNights(p)
              ? '<button type="button" class="btn" data-act="nights">Choose nights</button>' : '')
        +     (isReel(p)
              ? (p.video_url && p.video_url.indexOf('pending:') !== 0
                  ? '<a class="btn" href="' + esc(p.video_url) + '" download target="_blank" rel="noopener noreferrer">Save video</a>' : '')
              : '<button type="button" class="btn" data-act="save">Save slides</button>')
        +     '<button type="button" class="btn" data-act="copy">Copy caption</button>'
        +     '<span class="state" data-state="' + esc(p.id) + '">'
        +       (p.ig_permalink
                 ? '<a href="' + esc(p.ig_permalink) + '" target="_blank" rel="noopener noreferrer">Published</a>'
                 : esc(LABEL[p.status] || p.status))
        +     '</span>'
        +   '</div>'
        + '</div></article>';
    }).join('');

    Array.prototype.forEach.call(host.querySelectorAll('.deck'), wireDeck);
    Array.prototype.forEach.call(host.querySelectorAll('.row'), function (row) {
      var strip = row.querySelector('[data-strip]');
      var left = scrolled[row.getAttribute('data-id')];
      if (strip && left) { strip.scrollLeft = left; strip.dispatchEvent(new Event('scroll')); }
    });
    sizeAllCaptions();
    list.forEach(function (p) { loadShots(p); paintShots(p.id); });
  }

  /**
   * Size every caption field to its content.
   *
   * Deferred to the next frame rather than run straight after innerHTML: measured too early the row's grid
   * has not resolved, the field is briefly a fraction of its real width, and the text wraps into a textarea
   * thousands of pixels tall that pushes the buttons off the page. Run again once the webfont has loaded,
   * because Red Hat Display and the fallback do not wrap at the same place.
   */
  function sizeAllCaptions() {
    requestAnimationFrame(function () {
      Array.prototype.forEach.call(document.querySelectorAll('[data-cap]'), autosize);
    });
  }

  function render() { renderFilters(); renderReady(); renderStream(); }

  function autosize(el) { el.style.height = 'auto'; el.style.height = (el.scrollHeight + 2) + 'px'; }

  /** A drawn chevron, pointing right; the previous-slide button mirrors it in CSS. */
  var CHEVRON = '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor"'
    + ' stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 4l6 6-6 6"/></svg>';

  /**
   * Move through a deck by the arrows, the dots or a swipe, keeping all three in step. The arrows exist
   * because a sideways scroll is easy on a trackpad or a phone and close to impossible with a mouse wheel.
   */
  function wireDeck(deck) {
    var strip = deck.querySelector('[data-strip]');
    if (!strip || strip.children.length < 2) return;
    var dots = deck.querySelectorAll('[data-dots] button');
    var prev = deck.querySelector('[data-nav="-1"]');
    var next = deck.querySelector('[data-nav="1"]');
    var last = strip.children.length - 1;
    var current = 0;
    function mark(n) {
      current = n;
      Array.prototype.forEach.call(dots, function (b, i) { b.setAttribute('aria-current', i === n); });
      if (prev) prev.disabled = n === 0;
      if (next) next.disabled = n === last;
    }
    function go(n) {
      var to = Math.max(0, Math.min(last, n));
      var slide = strip.children[to];
      if (slide) strip.scrollTo({ left: slide.offsetLeft - strip.offsetLeft, behavior: 'smooth' });
      mark(to);
    }
    var tick;
    strip.addEventListener('scroll', function () {
      clearTimeout(tick);
      tick = setTimeout(function () {
        var slide = strip.firstElementChild;
        if (!slide) return;
        var step = slide.getBoundingClientRect().width + 12;
        // At the far end the strip cannot scroll a whole step, so the last slide is read off the edge.
        var atEnd = strip.scrollLeft + strip.clientWidth >= strip.scrollWidth - 2;
        mark(atEnd ? last : Math.max(0, Math.min(last, Math.round(strip.scrollLeft / step))));
      }, 60);
    }, { passive: true });
    deck.addEventListener('click', function (e) {
      var dot = e.target.closest('button[data-go]');
      if (dot) { go(+dot.getAttribute('data-go')); return; }
      var nav = e.target.closest('button[data-nav]');
      if (nav) go(current + +nav.getAttribute('data-nav'));
    });
    // Left and right arrow keys too, once focus is anywhere in the deck.
    deck.addEventListener('keydown', function (e) {
      if (e.target.matches('input, textarea, select')) return;
      if (e.key === 'ArrowRight') { e.preventDefault(); go(current + 1); }
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(current - 1); }
    });
    mark(0);
  }

  // ── mutations ─────────────────────────────────────────────────────────────

  function find(id) { return posts.filter(function (p) { return p.id === id; })[0]; }

  function patch(id, body, opts) {
    var options = opts || {};
    return api('/api/posts?id=' + encodeURIComponent(id), { method: 'PATCH', body: body })
      .then(function (res) {
        var i = posts.findIndex(function (p) { return p.id === id; });
        if (i >= 0) posts[i] = res.post;
        if (options.repaint) { delete shots[id]; render(); }
        else { renderFilters(); renderReady(); }
        return res.post;
      })
      .catch(function (err) { say(id, err.message); });
  }

  function say(id, message) {
    var el = document.querySelector('[data-state="' + id + '"]');
    if (el) el.textContent = message;
  }

  function setStatus(id, next) {
    var p = find(id);
    if (!p || p.status === 'posted') return;
    patch(id, { status: p.status === next ? 'queued' : next }).then(render);
  }

  function publish(id) {
    var btn = document.querySelector('.row[data-id="' + id + '"] [data-act="publish"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Publishing…'; }
    say(id, 'Handing the deck to Instagram…');
    api('/api/publish?id=' + encodeURIComponent(id), { method: 'POST' })
      .then(function (res) {
        // 202: the container exists and Instagram is still fetching the media. Not a failure -- the post is
        // still approved and the container is valid for 24 hours, so the button goes back to being
        // pressable and the next press resumes the poll instead of submitting the media again.
        if (res.pending) {
          say(id, res.error || 'Instagram is still preparing the post. Press Publish again in a moment.');
          if (btn) { btn.disabled = false; btn.textContent = 'Publish to Instagram'; }
          return;
        }
        var i = posts.findIndex(function (p) { return p.id === id; });
        if (i >= 0) posts[i] = res.post;
        render();
      })
      .catch(function (err) {
        say(id, err.message);
        if (btn) { btn.disabled = false; btn.textContent = 'Publish to Instagram'; }
      });
  }

  // ── the words every deck closes with ──────────────────────────────────────
  // The last slide is the same on every post, which is the point of it, and it is also the copy most likely
  // to be rewritten. It is a setting rather than a constant, so this changes what the next draft says --
  // decks already in the queue keep the words they were drafted with, which is what makes them reviewable.

  function openCtaEditor() {
    var host = byId('stream');
    var old = document.querySelector('.cta-form');
    if (old) { old.remove(); return; }
    var panel = document.createElement('div');
    panel.className = 'photo-form panel cta-form';
    panel.innerHTML = '<p class="photo-name">Loading the closing slide\u2026</p>';
    host.parentNode.insertBefore(panel, host);
    api('/api/posts?cta=1').then(function (res) {
      var c = res.cta || {};
      panel.innerHTML = '<p class="photo-name">The last slide of every new post</p>'
        + '<p class="panel-note">Changing this changes what the next draft closes with. Posts already in the'
        + ' queue keep the words they were drafted with; to update one of those, use Edit text under its'
        + ' last slide.</p>'
        + FIELDS.cta.map(function (f) {
            var id = 'cta-' + f[0];
            return '<label for="' + id + '">' + f[1] + '</label>'
              + (f[2]
                ? '<textarea id="' + id + '" data-field="' + f[0] + '" rows="2" maxlength="' + f[3] + '">' + esc(c[f[0]] || '') + '</textarea>'
                : '<input type="text" id="' + id + '" data-field="' + f[0] + '" maxlength="' + f[3] + '" value="' + esc(c[f[0]] || '') + '">');
          }).join('')
        + '<div class="photo-acts">'
        +   '<button type="button" class="btn btn-go" data-cta-act="save">Save</button>'
        +   '<button type="button" class="btn" data-cta-act="cancel">Close</button>'
        +   '<span class="photo-status"></span>'
        + '</div>';
    }).catch(function (err) {
      panel.innerHTML = '<p class="photo-name">' + esc(err.message) + '</p>'
        + '<div class="photo-acts"><button type="button" class="btn" data-cta-act="cancel">Close</button></div>';
    });
  }

  function saveCta(panel, btn) {
    var body = {};
    Array.prototype.forEach.call(panel.querySelectorAll('[data-field]'), function (el) {
      body[el.getAttribute('data-field')] = el.value.trim();
    });
    var status = panel.querySelector('.photo-status');
    btn.disabled = true;
    status.textContent = 'Saving\u2026';
    api('/api/posts?cta=1', { method: 'PUT', body: body })
      .then(function () { status.textContent = 'Saved. The next draft will use it.'; })
      .catch(function (err) { status.textContent = err.message; })
      .finally(function () { btn.disabled = false; });
  }

  // ── saving a deck by hand ─────────────────────────────────────────────────
  // Publishing through the API is the normal path, but it is not the only one: Instagram can refuse a
  // perfectly good deck, and a post that has to go up tonight should not wait on a Graph API mood. These
  // save exactly the files the API would have been handed, and the caption exactly as it would have read.

  /** The deck's signed render URLs, signing them first if this post has not been previewed yet. */
  function urlsFor(id) {
    var urls = shots[id];
    if (urls && urls !== 'pending' && !urls.error) return Promise.resolve(urls);
    var post = find(id);
    if (!post || !post.slides.length) return Promise.reject(new Error('this post has no slides'));
    return api('/api/render', {
      method: 'POST',
      body: { slides: post.slides, treatment: post.treatment, grain: post.grain },
    }).then(function (body) { shots[id] = body.urls; return body.urls; });
  }

  function saveOne(url, name) {
    var a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  function saveDeck(id, btn) {
    var post = find(id);
    if (!post) return;
    var was = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Saving\u2026';
    urlsFor(id).then(function (urls) {
      // One at a time, with a gap: a burst of clicks is what a browser reads as a pop-up and blocks. The
      // first one asks whether this site may save several files; after that they land in Downloads.
      return urls.reduce(function (chain, url, n) {
        return chain.then(function () {
          saveOne(url, fileName(post, n));
          return new Promise(function (done) { setTimeout(done, 350); });
        });
      }, Promise.resolve()).then(function () { btn.textContent = urls.length + ' saved'; });
    }).catch(function (err) {
      btn.textContent = err.message;
    }).finally(function () {
      setTimeout(function () { btn.disabled = false; btn.textContent = was; }, 2600);
    });
  }

  /**
   * The caption as it would publish, credits included.
   *
   * A copy of withCredits in src/post/photos.ts: the credits are added at publish time and are not in the
   * stored caption, so copying the stored one to post by hand would drop them -- which is the one part of
   * a caption that is a promise to someone else.
   */
  function publishedCaption(p) {
    var credits = p.credits || [];
    var caption = p.caption || '';
    if (!credits.length) return caption;
    var block = credits.join('\n');
    var lines = caption.replace(/\s+$/, '').split('\n');
    var last = lines[lines.length - 1] || '';
    if (/^\s*#/.test(last)) {
      return lines.slice(0, -1).join('\n').replace(/\s+$/, '') + '\n\n' + block + '\n\n' + last;
    }
    return lines.join('\n') + '\n\n' + block;
  }

  function copyCaption(id, btn) {
    var post = find(id);
    if (!post) return;
    var text = publishedCaption(post);
    var was = btn.textContent;
    var done = function (message) {
      btn.textContent = message;
      setTimeout(function () { btn.textContent = was; }, 2000);
    };
    var fallback = function () {
      // Older browsers, and any page the clipboard API refuses: a hidden field and the old command.
      var field = document.createElement('textarea');
      field.value = text;
      field.setAttribute('readonly', '');
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      field.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
      field.remove();
      done(ok ? 'Copied' : 'Could not copy');
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done('Copied'); }).catch(fallback);
      return;
    }
    fallback();
  }

  // ── events ────────────────────────────────────────────────────────────────

  /**
   * Draft one kind of post. The weekend answers with one post; genre editions and spotlights answer with
   * several, so both shapes are folded into the list the same way: replace a post already shown, else add it.
   */
  function draftKind(kind, btn) {
    var was = btn.textContent;
    btn.textContent = 'Drafting…';
    btn.disabled = true;
    api('/api/posts?draft=' + encodeURIComponent(kind), { method: 'POST' })
      .then(function (res) {
        var drafted = res.posts || (res.post ? [res.post] : []);
        if (!drafted.length) { btn.textContent = res.note || 'Nothing to draft'; return; }
        drafted.forEach(function (post) {
          delete shots[post.id];
          var i = posts.findIndex(function (p) { return p.id === post.id; });
          if (i >= 0) posts[i] = post; else posts.unshift(post);
        });
        filter = 'queued';
        render();
      })
      .catch(function (err) { btn.textContent = err.message; })
      .finally(function () {
        setTimeout(function () { btn.disabled = false; if (btn.textContent !== was) renderFilters(); }, 2500);
      });
  }

  // ── photos ──────────────────────────────────────────────────────────────────
  // Human in the loop: a person picks the photo and says where it is from. The source is credited in the
  // caption on publish. Resized here first, so a phone photo fits under the request size limit; the server
  // re-encodes it anyway, which is what strips the location data a phone writes into the file.

  var picker = null;
  function choosePhoto(postId, n) {
    if (!picker) {
      picker = document.createElement('input');
      picker.type = 'file';
      picker.accept = 'image/*';
      picker.hidden = true;
      document.body.appendChild(picker);
    }
    picker.value = '';
    picker.onchange = function () {
      var file = picker.files && picker.files[0];
      if (file) openPhotoForm(postId, n, file);
    };
    picker.click();
  }

  function resizeToJpeg(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var k = Math.min(1, 2400 / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k);
        c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.9));
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        reject(new Error('That file could not be opened. Use a JPEG or PNG.'));
      };
      img.src = url;
    });
  }

  function openPhotoForm(postId, n, file) {
    var row = document.querySelector('.row[data-id="' + postId + '"]');
    if (!row) return;
    var old = row.querySelector('.photo-form');
    if (old) old.remove();
    var form = document.createElement('div');
    form.className = 'photo-form';
    form.setAttribute('data-post', postId);
    form.setAttribute('data-slide', n);
    form.innerHTML = '<p class="photo-name">Slide ' + (n + 1) + ': ' + esc(file.name) + '</p>'
      + '<label>Where is this photo from? It is credited in the caption.</label>'
      + '<input type="text" maxlength="200" placeholder="e.g. Nowadays / @nowadaysnyc" data-photo-source>'
      + '<div class="photo-acts">'
      +   '<button type="button" class="btn btn-go" data-photo-act="use">Use photo</button>'
      +   '<button type="button" class="btn" data-photo-act="cancel">Cancel</button>'
      +   '<span class="photo-status"></span>'
      + '</div>';
    form._file = file;
    row.querySelector('.meta').prepend(form);
    form.querySelector('[data-photo-source]').focus();
  }

  function submitPhoto(form) {
    var source = form.querySelector('[data-photo-source]').value.trim();
    var status = form.querySelector('.photo-status');
    if (!source) { status.textContent = 'Say where the photo is from first.'; return; }
    var postId = form.getAttribute('data-post');
    var n = +form.getAttribute('data-slide');
    status.textContent = 'Uploading\u2026';
    Array.prototype.forEach.call(form.querySelectorAll('button'), function (b) { b.disabled = true; });
    resizeToJpeg(form._file)
      .then(function (data) {
        return api('/api/photos?post=' + encodeURIComponent(postId) + '&slide=' + n, {
          method: 'POST', body: { data: data, source: source },
        });
      })
      .then(function (res) { replacePost(res.post); })
      .catch(function (err) {
        status.textContent = err.message;
        Array.prototype.forEach.call(form.querySelectorAll('button'), function (b) { b.disabled = false; });
      });
  }

  function removePhoto(postId, n) {
    api('/api/photos?post=' + encodeURIComponent(postId) + '&slide=' + n, { method: 'DELETE' })
      .then(function (res) { replacePost(res.post); })
      .catch(function (err) { say(postId, err.message); });
  }

  /** Swap in the server's copy of a post and re-render, dropping its cached slide previews. */
  function replacePost(post) {
    var i = posts.findIndex(function (p) { return p.id === post.id; });
    if (i >= 0) posts[i] = post; else posts.unshift(post);
    delete shots[post.id];
    render();
  }

  // ── rewriting a slide's words ─────────────────────────────────────────────
  // For a title the renderer cuts off, or a line that should not be on the slide at all. An empty field is
  // left off the slide. Cover, event and venue slides keep their words through a redraft.

  /** Panels above the caption: one at a time per post, so two half-finished edits cannot race each other. */
  function openPanel(postId, className, html) {
    var row = document.querySelector('.row[data-id="' + postId + '"]');
    if (!row) return null;
    Array.prototype.forEach.call(row.querySelectorAll('.panel'), function (el) { el.remove(); });
    var panel = document.createElement('div');
    panel.className = 'photo-form panel ' + className;
    panel.setAttribute('data-post', postId);
    panel.innerHTML = html;
    row.querySelector('.meta').prepend(panel);
    return panel;
  }

  function rowsToText(rows) {
    return (rows || []).map(function (r) { return [r.day, r.time, r.event, r.venue].join(' | '); }).join('\n');
  }

  function textToRows(value) {
    var lines = value.split('\n').map(function (l) { return l.trim(); }).filter(Boolean);
    if (lines.length > TABLE_ROWS_MAX) throw new Error('A table slide holds ' + TABLE_ROWS_MAX + ' rows at most.');
    return lines.map(function (line, i) {
      var parts = line.split('|').map(function (x) { return x.trim(); });
      if (!parts[0] || !parts[2]) throw new Error('Row ' + (i + 1) + ' needs a day and an event: Day | Time | Event | Venue');
      return { day: parts[0], time: parts[1] || '', event: parts[2], venue: parts[3] || '' };
    });
  }

  function openTextForm(postId, n) {
    var post = find(postId);
    var slide = post && post.slides[n];
    var fields = slide && FIELDS[slide.template];
    if (!fields) return;
    var d = slide.data || {};
    var panel = openPanel(postId, 'text-form',
      '<p class="photo-name">Slide ' + (n + 1) + ': edit the words</p>'
      + '<p class="panel-note">Leave a field empty to leave it off the slide.'
      + (slide.template === 'cover' ? ' A new line in the title starts a new line on the slide.' : '')
      + (slide.template === 'table' ? ' One row per line: Day | Time | Event | Venue.' : '')
      + '</p>'
      + fields.map(function (f) {
          var id = 'f-' + postId + '-' + n + '-' + f[0];
          var value = f[0] === 'rows' ? rowsToText(d.rows) : (d[f[0]] == null ? '' : d[f[0]]);
          var max = f[3] ? ' maxlength="' + f[3] + '"' : '';
          return '<label for="' + id + '">' + f[1] + '</label>'
            + (f[2]
              ? '<textarea id="' + id + '" data-field="' + f[0] + '" rows="' + (f[0] === 'rows' ? 7 : 2) + '"' + max + '>' + esc(value) + '</textarea>'
              : '<input type="text" id="' + id + '" data-field="' + f[0] + '"' + max + ' value="' + esc(value) + '">');
        }).join('')
      + '<div class="photo-acts">'
      +   '<button type="button" class="btn btn-go" data-text-act="save" data-slide="' + n + '">Save</button>'
      +   '<button type="button" class="btn" data-text-act="cancel">Cancel</button>'
      +   '<span class="photo-status"></span>'
      + '</div>');
    if (panel) panel.querySelector('[data-field]').focus();
  }

  function saveTextForm(panel, n) {
    var post = find(panel.getAttribute('data-post'));
    var status = panel.querySelector('.photo-status');
    if (!post || !post.slides[n]) return;
    var slides = JSON.parse(JSON.stringify(post.slides));
    var data = slides[n].data;
    try {
      Array.prototype.forEach.call(panel.querySelectorAll('[data-field]'), function (el) {
        var key = el.getAttribute('data-field');
        if (key === 'rows') { data.rows = textToRows(el.value); return; }
        // Trailing spaces on a line are never meant; a line break inside a title is.
        data[key] = el.value.split('\n').map(function (l) { return l.replace(/\s+$/, ''); }).join('\n').trim();
      });
    } catch (err) {
      status.textContent = err.message;
      return;
    }
    if (KEEPS_EDITS[slides[n].template]) data.edited = true;
    status.textContent = 'Saving…';
    patch(post.id, { slides: slides }, { repaint: true });
  }

  // ── choosing a deck's nights ──────────────────────────────────────────────

  function canChooseNights(p) {
    return !isReel(p) && p.status !== 'posted' && !!p.slot && (p.series === 'weekend' || p.series === 'genre');
  }

  function openNights(postId) {
    var post = find(postId);
    if (!post) return;
    var panel = openPanel(postId, 'nights-form', '<p class="photo-name">Loading the weekend’s nights…</p>');
    if (!panel) return;
    api('/api/posts?candidates=' + encodeURIComponent(postId)).then(function (res) {
      panel._chosen = res.chosen.slice();
      panel._rows = (res.rows || []).slice();
      panel._max = res.max;
      panel._rowsMax = res.rowsMax || 14;
      var queued = post.status === 'queued';
      panel.innerHTML = '<p class="photo-name">Choose the nights that get their own slide</p>'
        + '<p class="panel-note">Slide gives a night its own slide, up to ' + res.max + ', in the order you press them.'
        + ' List puts it in the tables instead, up to ' + panel._rowsMax + '. Leave the lists alone and the tables fill'
        + ' themselves with the busiest nights, share and share alike between Friday, Saturday and Sunday.'
        + ' Rebuilding redraws the slides and the caption; photos, looks and edited words stay with the nights you'
        + ' keep.</p>'
        + '<ol class="nights-list">'
        + res.candidates.map(function (c) {
            var meta = [c.day + (c.door ? ' ' + c.door : ''), c.venue, c.genre, c.interested ? c.interested + ' interested' : '']
              .filter(Boolean).join('  /  ');
            return '<li>'
              + '<span class="nights-order"></span>'
              + '<span class="nights-text"><b>' + esc(c.name) + '</b><span>' + esc(meta) + '</span></span>'
              + '<span class="nights-pick" role="group" aria-label="What to do with ' + esc(c.name) + '">'
              +   '<button type="button" data-pick="slide" data-id="' + esc(c.id) + '" aria-pressed="false">Slide</button>'
              +   '<button type="button" data-pick="row" data-id="' + esc(c.id) + '" aria-pressed="false">List</button>'
              + '</span>'
              + '</li>';
          }).join('')
        + '</ol>'
        + '<div class="photo-acts">'
        +   '<span class="nights-counts"></span>'
        +   '<button type="button" class="btn btn-go" data-nights-act="rebuild"' + (queued ? '' : ' disabled') + '>Rebuild deck</button>'
        +   '<button type="button" class="btn" data-nights-act="cancel">Cancel</button>'
        +   '<span class="photo-status">' + (queued ? '' : 'Take the approval back first: press Approved, then rebuild.') + '</span>'
        + '</div>';
      paintNights(panel);
    }).catch(function (err) {
      panel.innerHTML = '<p class="photo-name">' + esc(err.message) + '</p>'
        + '<div class="photo-acts"><button type="button" class="btn" data-nights-act="cancel">Close</button></div>';
    });
  }

  function paintNights(panel) {
    Array.prototype.forEach.call(panel.querySelectorAll('.nights-list li'), function (li) {
      var slide = li.querySelector('[data-pick="slide"]');
      var row = li.querySelector('[data-pick="row"]');
      var at = panel._chosen.indexOf(slide.getAttribute('data-id'));
      var listed = panel._rows.indexOf(row.getAttribute('data-id')) >= 0;
      slide.setAttribute('aria-pressed', at >= 0);
      row.setAttribute('aria-pressed', listed);
      li.querySelector('.nights-order').textContent = at >= 0 ? String(at + 1) : '';
    });
    var counts = panel.querySelector('.nights-counts');
    if (counts) {
      counts.textContent = panel._chosen.length + ' of ' + panel._max + ' slides'
        + (panel._rows.length ? '  /  ' + panel._rows.length + ' of ' + panel._rowsMax + ' listed' : '');
    }
  }

  /**
   * A night is a slide, a line in the tables, or neither. Pressing one role turns the other off: the deck
   * would otherwise show the same party twice, which wastes one of ten slides.
   */
  function pickNight(panel, btn) {
    var id = btn.getAttribute('data-id');
    var role = btn.getAttribute('data-pick');
    var mine = role === 'slide' ? panel._chosen : panel._rows;
    var other = role === 'slide' ? panel._rows : panel._chosen;
    var max = role === 'slide' ? panel._max : panel._rowsMax;
    var status = panel.querySelector('.photo-status');
    var at = mine.indexOf(id);
    if (at >= 0) {
      mine.splice(at, 1);
    } else if (mine.length >= max) {
      status.textContent = role === 'slide'
        ? 'That is ' + max + ' slides already. Take one off first.'
        : 'The tables hold ' + max + ' nights. Take one off first.';
      paintNights(panel);
      return;
    } else {
      mine.push(id);
      var elsewhere = other.indexOf(id);
      if (elsewhere >= 0) other.splice(elsewhere, 1);
      status.textContent = '';
    }
    paintNights(panel);
  }

  function rebuildNights(panel, btn) {
    var postId = panel.getAttribute('data-post');
    var status = panel.querySelector('.photo-status');
    if (!panel._chosen.length) { status.textContent = 'Choose at least one night.'; return; }
    btn.disabled = true;
    status.textContent = 'Rebuilding…';
    api('/api/posts?rebuild=' + encodeURIComponent(postId), {
      method: 'POST',
      body: panel._rows.length ? { events: panel._chosen, rows: panel._rows } : { events: panel._chosen },
    })
      .then(function (res) { replacePost(res.post); })
      .catch(function (err) { status.textContent = err.message; btn.disabled = false; });
  }

  // ── the calendar of published posts ───────────────────────────────────────

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October',
    'November', 'December'];

  /** YYYY-MM-DD in New York, which is the day the post went out as far as anyone following NOCT is concerned. */
  function nyDay(when) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: NY, year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(when);
  }
  function nyClock(when) {
    return new Intl.DateTimeFormat('en-US', { timeZone: NY, hour: 'numeric', minute: '2-digit' }).format(when);
  }

  function shiftMonth(ym, by) {
    var y = +ym.slice(0, 4);
    var m = +ym.slice(5, 7) - 1 + by;
    var d = new Date(Date.UTC(y, m, 1));
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1);
  }

  function renderCalendar(host) {
    var today = nyDay(new Date());
    if (!calMonth) calMonth = today.slice(0, 7);
    var y = +calMonth.slice(0, 4);
    var m = +calMonth.slice(5, 7);
    var lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    var length = new Date(Date.UTC(y, m, 0)).getUTCDate();

    var published = posts.filter(function (p) { return p.status === 'posted' && p.posted_at; })
      .map(function (p) { var at = new Date(p.posted_at); return { p: p, at: at, day: nyDay(at) }; })
      .sort(function (a, b) { return a.at - b.at; });
    var month = published.filter(function (x) { return x.day.slice(0, 7) === calMonth; });

    function entry(x, withTime) {
      var label = esc(headline(x.p));
      var bits = (withTime ? '<span class="cal-time">' + esc(nyClock(x.at)) + '</span>' : '')
        + '<span class="tag">' + esc(isReel(x.p) ? 'reel' : x.p.series) + '</span>'
        + '<span class="cal-name">' + label + '</span>';
      return x.p.ig_permalink
        ? '<a class="cal-post" href="' + esc(x.p.ig_permalink) + '" target="_blank" rel="noopener noreferrer">' + bits + '</a>'
        : '<span class="cal-post">' + bits + '</span>';
    }

    var cells = '';
    for (var i = 0; i < lead; i++) cells += '<div class="cal-day is-blank"></div>';
    for (var day = 1; day <= length; day++) {
      var date = calMonth + '-' + pad(day);
      var those = month.filter(function (x) { return x.day === date; });
      cells += '<div class="cal-day' + (date === today ? ' is-today' : '') + (those.length ? ' has-posts' : '') + '">'
        + '<span class="cal-n">' + day + '</span>'
        + those.map(function (x) { return entry(x, false); }).join('')
        + '</div>';
    }

    host.innerHTML = '<section class="cal">'
      + '<div class="cal-head">'
      +   '<button type="button" class="cal-nav prev" data-cal="-1" aria-label="Previous month">' + CHEVRON + '</button>'
      +   '<h2>' + MONTHS[m - 1] + ' ' + y + '</h2>'
      +   '<button type="button" class="cal-nav next" data-cal="1" aria-label="Next month">' + CHEVRON + '</button>'
      +   '<span class="cal-sum">' + month.length + ' published this month / ' + published.length + ' in all</span>'
      + '</div>'
      + '<div class="cal-grid">'
      +   ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(function (w) { return '<div class="cal-dow">' + w + '</div>'; }).join('')
      +   cells
      + '</div>'
      + (month.length
        ? '<ul class="cal-list">' + month.map(function (x) {
            return '<li><span class="cal-date">' + esc(x.day.slice(5).replace('-', '/')) + '</span>' + entry(x, true) + '</li>';
          }).join('') + '</ul>'
        : '<p class="empty">Nothing published in ' + MONTHS[m - 1] + '.</p>')
      + '</section>';
  }

  // ── traffic: who came, from where, and what they did ──────────────────────

  function loadTraffic(days, force) {
    if (traffic.loading) return;
    var fresh = traffic.data && traffic.days === days && Date.now() - traffic.at < TRAFFIC_FRESH_MS;
    if (fresh && !force) return;
    traffic.loading = true; traffic.error = null; traffic.days = days;
    render();
    fetch('/api/traffic?days=' + days, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) { if (!r.ok) throw new Error(r.status === 401 ? 'Signed out — reload and sign in again.' : 'HTTP ' + r.status); return r.json(); })
      .then(function (j) { traffic.data = j; traffic.at = Date.now(); })
      .catch(function (err) { traffic.error = err.message || String(err); })
      .then(function () { traffic.loading = false; render(); });
  }

  function pct(a, b) { return b ? Math.round((a / b) * 100) + '%' : '–'; }
  function nyWeekday(day) {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' }).format(new Date(day + 'T12:00:00Z'));
  }
  /** a list of counts as rows with a proportional bar: the bar is the mark, the text stays in text tokens */
  function trafficList(title, rows, total, empty) {
    var max = rows.reduce(function (m, r) { return Math.max(m, r.visits); }, 0);
    return '<div class="tr-list"><h3>' + esc(title) + '</h3>'
      + (rows.length ? rows.map(function (r) {
          return '<div class="tr-row">'
            + '<span class="tr-key">' + esc(r.key) + '</span>'
            + '<span class="tr-bar"><i style="width:' + (max ? Math.round((r.visits / max) * 100) : 0) + '%"></i></span>'
            + '<span class="tr-n">' + r.visits + (total ? '<small>' + pct(r.visits, total) + '</small>' : '') + '</span>'
            + '</div>';
        }).join('') : '<p class="tr-none">' + esc(empty || 'Nothing yet') + '</p>')
      + '</div>';
  }

  function renderTraffic(host) {
    var t = traffic.data;
    if (!t && !traffic.loading && !traffic.error) { loadTraffic(traffic.days, false); return; }
    var head = '<div class="tr-head">'
      + '<h2>Traffic</h2>'
      + '<div class="tr-range" role="group" aria-label="Window">'
      +   TRAFFIC_WINDOWS.map(function (d) {
            return '<button type="button" class="chip" data-tr-days="' + d + '" aria-current="' + (traffic.days === d) + '">' + d + ' days</button>';
          }).join('')
      + '</div>'
      + '<span class="tr-asof">' + (traffic.loading ? 'Reading…' : t ? 'as of ' + esc(nyClock(new Date(traffic.at))) + ' · New York days · devices are anonymous accounts, one per browser' : '') + '</span>'
      + '<button type="button" class="chip" data-tr-refresh aria-label="Refresh">Refresh</button>'
      + '</div>';
    if (!t) {
      host.innerHTML = '<section class="tr">' + head
        + (traffic.error ? '<p class="err">' + esc(traffic.error) + '</p>' : '<p class="empty">Reading the report…</p>')
        + '</section>';
      return;
    }
    var f = t.funnel;
    var tiles = '<div class="tr-tiles">'
      + '<div class="tr-tile"><span class="tr-label">Visits · ' + t.window_days + ' days</span><b>' + t.visits.window + '</b><span class="tr-sub">' + t.visits.recent + ' in the last 7</span></div>'
      + '<div class="tr-tile"><span class="tr-label">Devices</span><b>' + t.devices.window + '</b><span class="tr-sub">' + t.devices.new_window + ' new · ' + t.devices.recent + ' in the last 7</span></div>'
      + '<div class="tr-tile"><span class="tr-label">Came back</span><b>' + t.returning_share + '%</b><span class="tr-sub">seen on two or more days</span></div>'
      + '<div class="tr-tile"><span class="tr-label">Opened a night</span><b>' + pct(f.opened_a_night, f.visited) + '</b><span class="tr-sub">' + f.opened_a_night + ' of ' + f.visited + ' devices</span></div>'
      + '<div class="tr-tile"><span class="tr-label">Home screen</span><b>' + t.standalone + '</b><span class="tr-sub">visits from the icon</span></div>'
      + '</div>';

    // the daily series: one bar a day, visits; the peak and the last day carry their value, the rest is hover
    var days = t.daily;
    var max = days.reduce(function (m, d) { return Math.max(m, d.visits); }, 0);
    var peak = -1; days.forEach(function (d, i) { if (d.visits > 0 && (peak < 0 || d.visits > days[peak].visits)) peak = i; });
    var every = days.length > 45 ? 14 : days.length > 20 ? 7 : days.length > 8 ? 2 : 1;
    var chart = '<figure class="tr-chart" aria-label="Visits per day">'
      + '<figcaption>Visits per day</figcaption>'
      + '<div class="tr-plot" style="--n:' + days.length + '">'
      +   days.map(function (d, i) {
            var h = max ? Math.max(d.visits ? 3 : 0, Math.round((d.visits / max) * 100)) : 0;
            var label = (i === peak || (i === days.length - 1 && d.visits)) ? '<span class="tr-v">' + d.visits + '</span>' : '';
            return '<button type="button" class="tr-col" data-day="' + d.day + '" data-visits="' + d.visits + '" data-devices="' + d.devices + '" aria-label="' + esc(nyWeekday(d.day) + ' ' + d.day + ': ' + d.visits + ' visits, ' + d.devices + ' devices') + '">'
              + label + '<i style="height:' + h + '%"></i>'
              + '<span class="tr-day">' + ((days.length - 1 - i) % every === 0 ? esc(d.day.slice(5).replace('-', '/')) : '') + '</span>'
              + '</button>';
          }).join('')
      + '<div class="tr-tip" role="status" hidden></div>'
      + '</div>'
      + '</figure>';

    var funnelSteps = [['Visited', f.visited], ['Opened a night', f.opened_a_night], ['Saved or going', f.saved_or_going], ['Set a taste', f.set_taste], ['Made or joined a plan', f.planned]];
    var funnel = '<div class="tr-list tr-funnel"><h3>Funnel · distinct devices</h3>'
      + funnelSteps.map(function (s) {
          return '<div class="tr-row"><span class="tr-key">' + s[0] + '</span>'
            + '<span class="tr-bar"><i style="width:' + (f.visited ? Math.round((s[1] / f.visited) * 100) : 0) + '%"></i></span>'
            + '<span class="tr-n">' + s[1] + '<small>' + pct(s[1], f.visited) + '</small></span></div>';
        }).join('')
      + '</div>';

    var lists = '<div class="tr-grid">'
      + trafficList('Where from', t.sources, t.visits.window)
      + trafficList('How they arrived', t.entry.map(function (r) { return { key: r.key === 'event' ? 'a shared night' : r.key === 'group' ? 'a plan link' : 'the front door', visits: r.visits }; }), t.visits.window)
      + trafficList('City', t.city, t.visits.window)
      + trafficList('Device', t.device, t.visits.window)
      + trafficList('Language', t.lang, t.visits.window)
      + trafficList('What they did', t.actions.map(function (r) { return { key: r.key.replace(/_/g, ' '), visits: r.visits }; }), 0, 'No taps counted yet')
      + funnel
      + (t.campaigns.length ? trafficList('Campaigns (utm)', t.campaigns.map(function (c) { return { key: [c.source, c.medium, c.campaign].filter(Boolean).join(' / '), visits: c.visits }; }), t.visits.window) : '')
      + '</div>';

    host.innerHTML = '<section class="tr' + (traffic.loading ? ' is-loading' : '') + '">' + head
      + (traffic.error ? '<p class="err">' + esc(traffic.error) + '</p>' : '')
      + tiles + chart + lists + '</section>';
  }

  function trafficTip(col) {
    var tip = document.querySelector('.tr-tip');
    if (!tip) return;
    if (!col) { tip.hidden = true; return; }
    var day = col.getAttribute('data-day');
    tip.textContent = nyWeekday(day) + ' ' + day.slice(5).replace('-', '/') + ' · ' + col.getAttribute('data-visits') + ' visits · ' + col.getAttribute('data-devices') + ' devices';
    tip.hidden = false;
    var plot = col.parentNode.getBoundingClientRect(), me = col.getBoundingClientRect();
    var x = me.left - plot.left + me.width / 2, half = tip.offsetWidth / 2;
    tip.style.left = Math.max(half, Math.min(plot.width - half, x)) + 'px';   /* never past the plot's edge */
  }

  /**
   * Wire the studio half of the page. Only called when that half was actually served: signed out, none of
   * these elements exist, and reaching for them would throw before the sign-in form could be used.
   */
  function wireStudio() {
    var stream = byId('stream');

    byId('filters').addEventListener('click', function (e) {
      if (e.target.closest('button[data-cta]')) { openCtaEditor(); return; }
      var chip = e.target.closest('button[data-f]');
      if (chip) { filter = chip.getAttribute('data-f'); render(); return; }
      if (e.target.closest('.draft-toggle')) {
        var toggle = e.target.closest('.draft-toggle');
        if (!toggle.disabled) setDraftMenu(toggle.getAttribute('aria-expanded') !== 'true');
        return;
      }
      var item = e.target.closest('button[data-draft]');
      if (item) {
        setDraftMenu(false);
        var main = document.querySelector('.draft-toggle');
        if (main && !main.disabled) draftKind(item.getAttribute('data-draft'), main);
      }
    });

    document.addEventListener('click', function (e) {
      var act = e.target.closest('button[data-cta-act]');
      if (!act) return;
      var panel = act.closest('.cta-form');
      if (act.getAttribute('data-cta-act') === 'cancel') panel.remove();
      else saveCta(panel, act);
    });

    stream.addEventListener('click', function (e) {
      var act = e.target.closest('button[data-act]');
      if (act && !act.disabled) {
        var id = act.closest('.row').getAttribute('data-id');
        var kind = act.getAttribute('data-act');
        if (kind === 'publish') publish(id);
        else if (kind === 'save') saveDeck(id, act);
        else if (kind === 'copy') copyCaption(id, act);
        else if (kind === 'nights') openNights(id);
        else setStatus(id, kind === 'approve' ? 'approved' : 'passed');
        return;
      }
      var photoBtn = e.target.closest('button[data-photo]');
      if (photoBtn) {
        var prow = photoBtn.closest('.row');
        var pid = prow.getAttribute('data-id');
        var slideN = +photoBtn.getAttribute('data-slide');
        if (photoBtn.getAttribute('data-photo') === 'remove') removePhoto(pid, slideN);
        else choosePhoto(pid, slideN);
        return;
      }
      var photoAct = e.target.closest('button[data-photo-act]');
      if (photoAct) {
        var form = photoAct.closest('.photo-form');
        if (photoAct.getAttribute('data-photo-act') === 'cancel') form.remove();
        else submitPhoto(form);
        return;
      }
      var cal = e.target.closest('button[data-cal]');
      if (cal) { calMonth = shiftMonth(calMonth, +cal.getAttribute('data-cal')); render(); return; }
      var win = e.target.closest('button[data-tr-days]');
      if (win) { loadTraffic(+win.getAttribute('data-tr-days'), false); return; }
      if (e.target.closest('button[data-tr-refresh]')) { loadTraffic(traffic.days, true); return; }
      var edit = e.target.closest('button[data-edit]');
      if (edit) { openTextForm(edit.closest('.row').getAttribute('data-id'), +edit.getAttribute('data-edit')); return; }
      var textAct = e.target.closest('button[data-text-act]');
      if (textAct) {
        var tpanel = textAct.closest('.panel');
        if (textAct.getAttribute('data-text-act') === 'cancel') tpanel.remove();
        else saveTextForm(tpanel, +textAct.getAttribute('data-slide'));
        return;
      }
      var nightsAct = e.target.closest('button[data-nights-act]');
      if (nightsAct) {
        var npanel = nightsAct.closest('.panel');
        if (nightsAct.getAttribute('data-nights-act') === 'cancel') npanel.remove();
        else if (!nightsAct.disabled) rebuildNights(npanel, nightsAct);
        return;
      }
      var pick = e.target.closest('button[data-pick]');
      if (pick) { pickNight(pick.closest('.panel'), pick); return; }
      var grain = e.target.closest('button[data-grain]');
      if (grain) {
        var gn = +grain.getAttribute('data-grain');
        setLook(grain.closest('.row').getAttribute('data-id'), gn, { grain: grain.getAttribute('aria-pressed') !== 'true' });
        return;
      }
      var fit = e.target.closest('button[data-fit]');
      if (fit) {
        var row = fit.closest('.row');
        var post = find(row.getAttribute('data-id'));
        var n = +fit.getAttribute('data-slide');
        if (!post || !post.slides[n] || !post.slides[n].data.image) return;
        var slides = JSON.parse(JSON.stringify(post.slides));
        slides[n].data.image.fit = fit.getAttribute('data-fit');
        patch(post.id, { slides: slides }, { repaint: true });
      }
    });

    // the daily bars: the mark is the hit target, on hover and on focus alike
    stream.addEventListener('pointerover', function (e) { var col = e.target.closest('.tr-col'); if (col) trafficTip(col); });
    stream.addEventListener('pointerout', function (e) { if (e.target.closest('.tr-col') && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest('.tr-col'))) trafficTip(null); });
    stream.addEventListener('focusin', function (e) { var col = e.target.closest('.tr-col'); if (col) trafficTip(col); });
    stream.addEventListener('focusout', function (e) { if (e.target.closest('.tr-col')) trafficTip(null); });

    stream.addEventListener('change', function (e) {
      var look = e.target.closest('select[data-look]');
      if (look) {
        setLook(look.closest('.row').getAttribute('data-id'), +look.getAttribute('data-look'), { treatment: look.value });
        return;
      }
    });

    /** Set one slide's own treatment or grain. The post's values stay as the default for the other slides. */
    function setLook(id, n, change) {
      var post = find(id);
      if (!post || !post.slides[n] || !post.slides[n].data.image) return;
      var slides = JSON.parse(JSON.stringify(post.slides));
      var image = slides[n].data.image;
      if (change.treatment) image.treatment = change.treatment;
      if (change.grain !== undefined) image.grain = change.grain;
      patch(post.id, { slides: slides }, { repaint: true });
    }

    var capTimer = {};
    stream.addEventListener('input', function (e) {
      var t = e.target;
      if (!t.matches('[data-cap]')) return;
      var id = t.getAttribute('data-cap');
      var v = t.value;
      autosize(t);

      var count = stream.querySelector('[data-count="' + id + '"]');
      if (count) {
        var total = publishedLength(v, (find(id) || {}).credits || []);
        count.textContent = total + ' / ' + IG_MAX;
        count.classList.toggle('over', total > IG_MAX);
      }
      var tags = stream.querySelector('[data-tags="' + id + '"]');
      if (tags) {
        var n = tagCount(v);
        tags.textContent = n + ' / ' + TAG_MAX + ' tags';
        tags.classList.toggle('over', n > TAG_MAX);
      }
      var rules = stream.querySelector('[data-rules="' + id + '"]');
      if (rules) {
        rules.innerHTML = captionWarnings(v).map(function (w) { return '<li>' + esc(w) + '</li>'; }).join('');
      }

      clearTimeout(capTimer[id]);
      capTimer[id] = setTimeout(function () {
        if (busy[id]) return;
        busy[id] = true;
        patch(id, { caption: v }).finally(function () { busy[id] = false; });
      }, 650);
    });

    // The Draft menu closes on a click anywhere else, and on Escape, handing focus back to its button.
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.draft-menu')) setDraftMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var toggle = document.querySelector('.draft-toggle');
      if (toggle && toggle.getAttribute('aria-expanded') === 'true') { setDraftMenu(false); toggle.focus(); }
    });
  }

  // ── boot ──────────────────────────────────────────────────────────────────

  // This file is only served to a signed-in visitor (api/studio.ts); the door and its script stand alone
  // in studio/gate.js. The guard is for the one case that still reaches here without a studio: nothing.
  if (!byId('studioView')) return;

  byId('studioView').hidden = false;
  wireStudio();
  // A caption sized against the fallback face is a caption sized wrong; a narrower window rewraps it.
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(sizeAllCaptions);
  window.addEventListener('resize', sizeAllCaptions);
  api('/api/posts').then(function (body) {
    posts = body.posts || [];
    render();
  }).catch(function (err) {
    if (err.message === 'signed out') return;
    byId('stream').innerHTML = '<p class="empty">Could not load the studio. <strong>' + esc(err.message) + '</strong></p>';
  });
})();
