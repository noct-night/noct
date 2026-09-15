/**
 * The sign-in door, and only the door.
 *
 * Separate from page.js because it is the only script an unauthenticated visitor receives. page.js carries
 * the whole queue -- the endpoints it calls, the shape of a post, what the buttons do -- and none of that
 * is sent to someone who has not signed in. The endpoints are all gated server-side regardless, so this is
 * not the thing standing between a stranger and the account; it is simply that a page with nothing to
 * offer should not describe everything it would have offered.
 */
(function () {
  'use strict';

  var form = document.getElementById('gateForm');
  if (!form) return;

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var err = document.getElementById('gateErr');
    var pass = document.getElementById('gatePass');
    err.hidden = true;

    fetch('/api/studio', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: pass.value }),
      credentials: 'same-origin',
    }).then(function (res) {
      // A fresh load is what fetches the queue half, which the server would not have sent before now.
      if (res.ok) { window.location.reload(); return; }
      return res.json().catch(function () { return {}; }).then(function (body) {
        err.textContent = body.error || 'That password was not accepted.';
        err.hidden = false;
        pass.select();
      });
    }).catch(function () {
      err.textContent = 'Could not reach the server.';
      err.hidden = false;
    });
  });

  if (!document.getElementById('gateView').hidden) document.getElementById('gatePass').focus();
})();
