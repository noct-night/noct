import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripStudio } from '../../api/studio.js';

const asset = (name: string): Promise<string> => readFile(join(process.cwd(), 'studio', name), 'utf8');

const safe = (s: string): string => s.replace(/<\/(script|style)/gi, '<\\/$1');

/** The same assembly api/studio.ts does, against the real files. */
async function assemble(signedIn: boolean): Promise<string> {
  const [html, css, gate, js] = await Promise.all([
    asset('page.html'), asset('page.css'), asset('gate.js'), asset('page.js'),
  ]);
  const base = html.replace('/*noct:css*/', () => safe(css)).replace('/*noct:gate*/', () => safe(gate));
  return signedIn ? base.replace('/*noct:js*/', () => safe(js)) : stripStudio(base).replace('/*noct:js*/', '');
}

describe('the studio page source', () => {
  it('has the placeholders api/studio.ts substitutes into', async () => {
    const html = await asset('page.html');
    for (const marker of ['/*noct:css*/', '/*noct:gate*/', '/*noct:js*/']) expect(html).toContain(marker);
  });

  it('marks the boundary of the studio half explicitly', async () => {
    const html = await asset('page.html');
    expect(html.indexOf('<!--noct:studio-start-->')).toBeGreaterThan(-1);
    expect(html.indexOf('<!--noct:studio-end-->')).toBeGreaterThan(html.indexOf('<!--noct:studio-start-->'));
  });

  it('inlines every asset, so the response needs no separately gated files', async () => {
    const page = await assemble(true);
    expect(page).toContain('--post:#0B0B0B');
    expect(page).toContain("byId('stream')");
    expect(page).toContain('/api/session');
    for (const marker of ['/*noct:css*/', '/*noct:gate*/', '/*noct:js*/']) expect(page).not.toContain(marker);
  });

  it('keeps the page out of search results', async () => {
    expect(await asset('page.html')).toContain('name="robots"');
  });
});

describe('what a visitor with no session receives', () => {
  it('has no studio markup', async () => {
    const out = await assemble(false);
    expect(out).not.toContain('id="studioView"');
    expect(out).not.toContain('id="stream"');
    expect(out).not.toContain('Instagram posts');
    expect(out).not.toContain('Draft the coming weekend');
  });

  it('has none of the studio script, so it enumerates no endpoints or actions', async () => {
    const out = await assemble(false);
    // The whole point of splitting gate.js out of page.js: stripping markup alone left this behind.
    for (const leak of ['/api/posts', '/api/publish', '/api/render', 'Publish to Instagram', 'captionWarnings']) {
      expect(out, leak).not.toContain(leak);
    }
  });

  it('still gets a working door, revealed', async () => {
    const out = await assemble(false);
    expect(out).toContain('id="gateForm"');
    expect(out).toContain('id="gatePass"');
    expect(out).toContain('/api/session');
    // The hidden attribute is dropped, because the door is now the whole page.
    expect(out).toContain('<div class="wrap" id="gateView">');
    expect(out).not.toContain('<div class="wrap" id="gateView" hidden>');
    expect(out.trimEnd().endsWith('</html>')).toBe(true);
  });
});

describe('stripStudio', () => {
  it('removes exactly the marked region', () => {
    const html = `<a><!--noct:studio-start--><b>secret</b><!--noct:studio-end--><c>`;
    expect(stripStudio(html)).toBe('<a><c>');
  });

  it('leaves a page with no markers alone', () => {
    const plain = '<!doctype html><html><body>nothing here</body></html>';
    expect(stripStudio(plain)).toBe(plain);
  });
});

describe('the page script', () => {
  it('survives a session expiring mid-edit by showing the door rather than throwing', async () => {
    const js = await asset('page.js');
    expect(js).toContain("if (res.status === 401)");
    // showGate() has to tolerate a page that was served without the studio half.
    expect(js).toContain("var studio = byId('studioView');");
  });

  it('treats the caption rules as a courtesy, with the server enforcing them', async () => {
    const js = await asset('page.js');
    expect(js).toContain('never the enforcement');
  });

  it('previews a reel as the encoded video, not as a rendered frame', async () => {
    const js = await asset('page.js');
    // The thing being approved is a moving image with burned-in type; a still cannot be reviewed.
    expect(js).toContain('<video src="');
    expect(js).toContain('preload="metadata"');
    // Opening the studio must not pull every reel in the list, and a tap on a phone must play in place.
    expect(js).toContain('playsinline');
  });

  it('can rewrite the words every new deck closes with', async () => {
    const js = await asset('page.js');
    expect(js).toContain("api('/api/posts?cta=1'");
    // Saying which posts it reaches matters: a queued deck keeps the words it was drafted with.
    expect(js).toContain('what the next draft closes with');
  });

  it('offers the rendered files and the caption, so a deck can go up by hand', async () => {
    const js = await asset('page.js');
    // The same signed URLs the preview draws and Instagram is handed: what is saved is what would post.
    expect(js).toContain('data-save="');
    expect(js).toContain('data-act="save"');
    expect(js).toContain('data-act="copy"');
    // Credits are added at publish time, so copying the stored caption alone would drop them.
    expect(js).toContain('function publishedCaption');
  });

  it('treats a 202 from publish as resumable rather than as a failure', async () => {
    const js = await asset('page.js');
    // A reel container that is still transcoding leaves the post approved and the button pressable; the
    // next press resumes the poll. Rendering it as an error would send someone to re-encode the video.
    expect(js).toContain('if (res.pending)');
    expect(js).toContain('Press Publish again');
  });
});
