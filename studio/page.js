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
  var FILTERS = [
    { k: 'queued', t: 'Queue' },
    { k: 'approved', t: 'Approved' },
    { k: 'posted', t: 'Published' },
    { k: 'passed', t: 'Passed' },
    { k: 'all', t: 'Everything' },
  ];
  var LABEL = { queued: 'In queue', approved: 'Approved', passed: 'Passed', posted: 'Published' };
  var TPL_LABEL = {
    cover: 'carousel', event: 'event', table: 'table', listing: 'listing',
    venue: 'venue', venuecover: 'venues', note: 'note', cta: 'cta',
  };
  var TAKES_IMAGE = { event: 1, venue: 1 };
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

  function renderFilters() {
    var chips = FILTERS.map(function (f) {
      var n = f.k === 'all' ? posts.length : posts.filter(function (p) { return p.status === f.k; }).length;
      return '<button type="button" class="chip" data-f="' + f.k + '" aria-current="' + (filter === f.k) + '">'
        + f.t + '<span class="n">' + n + '</span></button>';
    }).join('');
    byId('filters').innerHTML = chips
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

  function slideMarkup(p, s, n) {
    var takesImage = !!TAKES_IMAGE[s.template];
    var img = (s.data || {}).image;
    var locked = p.status === 'posted';
    // Under the slide and always shown. These used to appear only on hover, over the bottom of the preview,
    // and a control you have to already know is there is one people go looking for and do not find.
    var tools = takesImage && !locked
      ? '<div class="shot-tools">'
        + '<button type="button" data-photo="add" data-slide="' + n + '">' + (img ? 'Change photo' : 'Add photo') + '</button>'
        + (isStudioPhoto(img) ? '<button type="button" data-photo="remove" data-slide="' + n + '">'
            + (img.flyer ? 'Back to flyer' : 'Remove photo') + '</button>' : '')
        + (img
          ? '<span class="fit" role="group" aria-label="Framing">'
            + '<button type="button" data-fit="cover" data-slide="' + n + '" aria-pressed="' + (img.fit !== 'contain') + '">Fill</button>'
            + '<button type="button" data-fit="contain" data-slide="' + n + '" aria-pressed="' + (img.fit === 'contain') + '">Fit whole</button>'
            + '</span>'
          : '')
        + (img && !isStudioPhoto(img)
          ? '<a href="' + esc(img.src) + '" target="_blank" rel="noopener noreferrer">Open flyer</a>' : '')
        + '</div>'
      : '';
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
    var list = visible();

    if (!list.length) {
      var name = FILTERS.filter(function (f) { return f.k === filter; })[0].t;
      host.innerHTML = '<p class="empty">' + (posts.length
        ? 'Nothing under <strong>' + esc(name) + '</strong> right now.'
        : 'Nothing here yet. Use <strong>Draft</strong> to build posts from the live feed.')
        + '</p>';
      return;
    }

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
        + '<div class="deck"><div class="strip" data-strip>' + strip + '</div>' + dots + '</div>'
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
        +     '<span class="state" data-state="' + esc(p.id) + '">'
        +       (p.ig_permalink
                 ? '<a href="' + esc(p.ig_permalink) + '" target="_blank" rel="noopener noreferrer">Published</a>'
                 : esc(LABEL[p.status] || p.status))
        +     '</span>'
        +   '</div>'
        + '</div></article>';
    }).join('');

    Array.prototype.forEach.call(host.querySelectorAll('.deck'), wireDeck);
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

  /** Keep the dots and the scroll position in step, both directions. */
  function wireDeck(deck) {
    var strip = deck.querySelector('[data-strip]');
    var dots = deck.querySelector('[data-dots]');
    if (!strip || !dots) return;
    var buttons = dots.querySelectorAll('button');
    function mark(n) {
      Array.prototype.forEach.call(buttons, function (b, i) { b.setAttribute('aria-current', i === n); });
    }
    var tick;
    strip.addEventListener('scroll', function () {
      clearTimeout(tick);
      tick = setTimeout(function () {
        var slide = strip.firstElementChild;
        if (!slide) return;
        var step = slide.getBoundingClientRect().width + 12;
        mark(Math.max(0, Math.min(buttons.length - 1, Math.round(strip.scrollLeft / step))));
      }, 60);
    }, { passive: true });
    dots.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-go]');
      if (!b) return;
      var n = +b.getAttribute('data-go');
      var slide = strip.children[n];
      if (slide) strip.scrollTo({ left: slide.offsetLeft - strip.offsetLeft, behavior: 'smooth' });
      mark(n);
    });
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
        // 202: a reel container exists and Instagram is still transcoding it. Not a failure -- the post is
        // still approved and the container is valid for 24 hours, so the button goes back to being
        // pressable and the next press resumes the poll instead of re-uploading the video.
        if (res.pending) {
          say(id, res.error || 'Instagram is still processing the video. Press Publish again in a moment.');
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

  /**
   * Wire the studio half of the page. Only called when that half was actually served: signed out, none of
   * these elements exist, and reaching for them would throw before the sign-in form could be used.
   */
  function wireStudio() {
    var stream = byId('stream');

    byId('filters').addEventListener('click', function (e) {
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

    stream.addEventListener('click', function (e) {
      var act = e.target.closest('button[data-act]');
      if (act && !act.disabled) {
        var id = act.closest('.row').getAttribute('data-id');
        var kind = act.getAttribute('data-act');
        if (kind === 'publish') publish(id);
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

    // The treatment is one look across the feed, so it is written to every post that is still editable.
    function applyLook() {
      var treatment = byId('tx').value;
      var grain = byId('gr').value === 'on';
      var editable = posts.filter(function (p) {
        return p.status !== 'posted' && (p.treatment !== treatment || p.grain !== grain);
      });
      Promise.all(editable.map(function (p) {
        delete shots[p.id];
        return patch(p.id, { treatment: treatment, grain: grain });
      })).then(render);
    }
    // The Draft menu closes on a click anywhere else, and on Escape, handing focus back to its button.
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.draft-menu')) setDraftMenu(false);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var toggle = document.querySelector('.draft-toggle');
      if (toggle && toggle.getAttribute('aria-expanded') === 'true') { setDraftMenu(false); toggle.focus(); }
    });
    byId('tx').addEventListener('change', applyLook);
    byId('gr').addEventListener('change', applyLook);
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
    var first = posts.filter(function (p) { return p.status !== 'posted'; })[0];
    if (first) {
      byId('tx').value = first.treatment;
      byId('gr').value = first.grain ? 'on' : 'off';
    }
    render();
  }).catch(function (err) {
    if (err.message === 'signed out') return;
    byId('stream').innerHTML = '<p class="empty">Could not load the studio. <strong>' + esc(err.message) + '</strong></p>';
  });
})();
