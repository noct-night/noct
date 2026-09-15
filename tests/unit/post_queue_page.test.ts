import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stripQueue } from '../../api/queue.js';

const asset = (name: string): Promise<string> => readFile(join(process.cwd(), 'queue', name), 'utf8');

const safe = (s: string): string => s.replace(/<\/(script|style)/gi, '<\\/$1');

/** The same assembly api/queue.ts does, against the real files. */
async function assemble(signedIn: boolean): Promise<string> {
  const [html, css, gate, js] = await Promise.all([
    asset('page.html'), asset('page.css'), asset('gate.js'), asset('page.js'),
  ]);
  const base = html.replace('/*noct:css*/', () => safe(css)).replace('/*noct:gate*/', () => safe(gate));
  return signedIn ? base.replace('/*noct:js*/', () => safe(js)) : stripQueue(base).replace('/*noct:js*/', '');
}

describe('the queue page source', () => {
  it('has the placeholders api/queue.ts substitutes into', async () => {
    const html = await asset('page.html');
    for (const marker of ['/*noct:css*/', '/*noct:gate*/', '/*noct:js*/']) expect(html).toContain(marker);
  });

  it('marks the boundary of the queue half explicitly', async () => {
    const html = await asset('page.html');
    expect(html.indexOf('<!--noct:queue-start-->')).toBeGreaterThan(-1);
    expect(html.indexOf('<!--noct:queue-end-->')).toBeGreaterThan(html.indexOf('<!--noct:queue-start-->'));
  });

  it('inlines every asset, so the response needs no separately gated files', async () => {
    const page = await assemble(true);
    expect(page).toContain('--post:#0B0B0B');
    expect(page).toContain("byId('stream')");
    expect(page).toContain('/api/studio');
    for (const marker of ['/*noct:css*/', '/*noct:gate*/', '/*noct:js*/']) expect(page).not.toContain(marker);
  });

  it('keeps the page out of search results', async () => {
    expect(await asset('page.html')).toContain('name="robots"');
  });
});

describe('what a visitor with no session receives', () => {
  it('has no queue markup', async () => {
    const out = await assemble(false);
    expect(out).not.toContain('id="queueView"');
    expect(out).not.toContain('id="stream"');
    expect(out).not.toContain('Instagram post queue');
    expect(out).not.toContain('Draft the coming weekend');
  });

  it('has none of the queue script, so it enumerates no endpoints or actions', async () => {
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
    expect(out).toContain('/api/studio');
    // The hidden attribute is dropped, because the door is now the whole page.
    expect(out).toContain('<div class="wrap" id="gateView">');
    expect(out).not.toContain('<div class="wrap" id="gateView" hidden>');
    expect(out.trimEnd().endsWith('</html>')).toBe(true);
  });
});

describe('stripQueue', () => {
  it('removes exactly the marked region', () => {
    const html = `<a><!--noct:queue-start--><b>secret</b><!--noct:queue-end--><c>`;
    expect(stripQueue(html)).toBe('<a><c>');
  });

  it('leaves a page with no markers alone', () => {
    const plain = '<!doctype html><html><body>nothing here</body></html>';
    expect(stripQueue(plain)).toBe(plain);
  });
});

describe('the page script', () => {
  it('survives a session expiring mid-edit by showing the door rather than throwing', async () => {
    const js = await asset('page.js');
    expect(js).toContain("if (res.status === 401)");
    // showGate() has to tolerate a page that was served without the queue half.
    expect(js).toContain("var queue = byId('queueView');");
  });

  it('treats the caption rules as a courtesy, with the server enforcing them', async () => {
    const js = await asset('page.js');
    expect(js).toContain('never the enforcement');
  });
});
