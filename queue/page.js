/**
 * The review queue.
 *
 * Every slide preview on this page is the real renderer's output, fetched from /api/render as a JPEG. It is
 * not a CSS approximation of the post: what she approves is the file Instagram will be handed, which is the
 * whole point of the endpoint existing. It also means a preview costs a render, so URLs are only re-signed
 * when something that changes the pixels changes.
 *
 * State lives on the server. The page holds no truth of its own beyond what it last fetched, so a second
 * tab, a reload or a different laptop all show the same queue.
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
    venue: 'venue', venuecover: 'venues', note: 'note',
  };
  var TAKES_IMAGE = { event: 1, venue: 1 };

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
    var queue = byId('queueView');
    if (queue) queue.hidden = true;
    byId('gateView').hidden = false;
    byId('gatePass').focus();
  }

  // ── caption rules ─────────────────────────────────────────────────────────
  // A copy of the checks in src/post/caption.ts so the warning appears as she types. The server runs the
  // real ones before publishing; this is a courtesy, never the enforcement.

  function tagCount(s) { return (String(s).match(/#[^\s#]+/g) || []).length; }

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

  function headline(p) {
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
      + '<span class="spacer"></span>'
      + '<button type="button" class="chip" id="draftBtn">Draft the coming weekend</button>';
  }

  function renderReady() {
    var a = posts.filter(function (p) { return p.status === 'approved'; }).length;
    byId('ready').innerHTML = a === 0
      ? 'Nothing approved yet'
      : '<b>' + a + '</b> ' + (a === 1 ? 'post' : 'posts') + ' ready to publish';
  }

  function slideMarkup(p, s, n) {
    var takesImage = !!TAKES_IMAGE[s.template];
    var img = (s.data || {}).image;
    var ui = takesImage && img
      ? '<div class="shot-ui">'
        + '<a href="' + esc(img.src) + '" target="_blank" rel="noopener noreferrer">Open flyer</a>'
        + '<button type="button" data-fit="cover" data-slide="' + n + '" aria-pressed="' + (img.fit !== 'contain') + '">Fill</button>'
        + '<button type="button" data-fit="contain" data-slide="' + n + '" aria-pressed="' + (img.fit === 'contain') + '">Fit whole flyer</button>'
        + '</div>'
      : '';
    return '<div class="shot" data-slide="' + n + '">'
      + '<div class="pending">Rendering</div>' + ui + '</div>';
  }

  function renderStream() {
    var host = byId('stream');
    var list = visible();

    if (!list.length) {
      var name = FILTERS.filter(function (f) { return f.k === filter; })[0].t;
      host.innerHTML = '<p class="empty">' + (posts.length
        ? 'Nothing under <strong>' + esc(name) + '</strong> right now.'
        : 'The queue is empty. <strong>Draft the coming weekend</strong> builds a deck from the live feed.')
        + '</p>';
      return;
    }

    host.innerHTML = list.map(function (p, i) {
      var cap = p.caption || '';
      var locked = p.status === 'posted';
      var sl = slidesOf(p);
      var warnings = captionWarnings(cap);

      var strip = sl.map(function (s, n) { return slideMarkup(p, s, n); }).join('');
      var dots = sl.length > 1
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
        +   '</div>'
        +   '<div class="field">'
        +     '<label for="cap-' + esc(p.id) + '">Caption</label>'
        +     '<textarea id="cap-' + esc(p.id) + '" data-cap="' + esc(p.id) + '"' + (locked ? ' readonly' : '') + '>'
        +       esc(cap) + '</textarea>'
        +     '<div class="counts">'
        +       '<span class="count' + (tagCount(cap) > TAG_MAX ? ' over' : '') + '" data-tags="' + esc(p.id) + '">'
        +         tagCount(cap) + ' / ' + TAG_MAX + ' tags</span>'
        +       '<span class="count' + (cap.length > IG_MAX ? ' over' : '') + '" data-count="' + esc(p.id) + '">'
        +         cap.length + ' / ' + IG_MAX + '</span>'
        +     '</div>'
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
   * because Archivo and the fallback do not wrap at the same place.
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

  function draftWeekend(btn) {
    var was = btn.textContent;
    btn.textContent = 'Drafting…';
    btn.disabled = true;
    api('/api/posts?draft=weekend', { method: 'POST' })
      .then(function (res) {
        if (!res.post) { btn.textContent = res.note || 'Nothing to draft'; return; }
        delete shots[res.post.id];
        var i = posts.findIndex(function (p) { return p.id === res.post.id; });
        if (i >= 0) posts[i] = res.post; else posts.unshift(res.post);
        filter = 'queued';
        render();
      })
      .catch(function (err) { btn.textContent = err.message; })
      .finally(function () {
        setTimeout(function () { btn.disabled = false; if (btn.textContent !== was) renderFilters(); }, 2500);
      });
  }

  /**
   * Wire the queue half of the page. Only called when that half was actually served: signed out, none of
   * these elements exist, and reaching for them would throw before the sign-in form could be used.
   */
  function wireQueue() {
    var stream = byId('stream');

    byId('filters').addEventListener('click', function (e) {
      var chip = e.target.closest('button[data-f]');
      if (chip) { filter = chip.getAttribute('data-f'); render(); return; }
      if (e.target.closest('#draftBtn')) draftWeekend(e.target.closest('#draftBtn'));
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
        count.textContent = v.length + ' / ' + IG_MAX;
        count.classList.toggle('over', v.length > IG_MAX);
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
    byId('tx').addEventListener('change', applyLook);
    byId('gr').addEventListener('change', applyLook);
  }

  // ── boot ──────────────────────────────────────────────────────────────────

  // This file is only served to a signed-in visitor (api/queue.ts); the door and its script stand alone in
  // queue/gate.js. The guard is for the one case that still reaches here without a queue: nothing.
  if (!byId('queueView')) return;

  byId('queueView').hidden = false;
  wireQueue();
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
    byId('stream').innerHTML = '<p class="empty">Could not load the queue. <strong>' + esc(err.message) + '</strong></p>';
  });
})();
