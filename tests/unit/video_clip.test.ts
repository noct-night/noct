/**
 * The video pipeline, without the binary.
 *
 * Everything here is argument and filtergraph construction, which is where this step actually goes wrong.
 * A bad filtergraph does not crash: ffmpeg accepts it and writes out something squashed, stretched, or
 * missing its title, and the first place that is noticed is the account. So the graph is asserted rather
 * than eyeballed. Anything that needs ffmpeg itself is in tests/live/clip.live.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { DISPLAY_FONT } from '../../src/post/font.js';
import { ffmpegArgs, videoGraph } from '../../src/video/clip.js';
import { framingFilter, parseFrameRate } from '../../src/video/ffmpeg.js';
import {
  checkReel, clipSpecSchema, formatTimecode, parseTimecode, REEL, REEL_LIMITS, type VideoMeta,
} from '../../src/video/spec.js';
import { objectPath, publicUrl } from '../../src/video/storage.js';
import { scrimSvg, titleTree } from '../../src/video/title.js';

const base: VideoMeta = {
  seconds: 30, width: REEL.w, height: REEL.h, fps: 30, bytes: 12_000_000, vcodec: 'h264', acodec: 'aac',
};

const opts = (over: Partial<Parameters<typeof ffmpegArgs>[0]> = {}) => ({
  ...clipSpecSchema.parse({}),
  input: '/in/night.mov',
  output: '/out/night-reel.mp4',
  ...over,
});

describe('parseTimecode', () => {
  it('reads seconds, mm:ss and hh:mm:ss as the same scale', () => {
    expect(parseTimecode('90')).toBe(90);
    expect(parseTimecode('1:30')).toBe(90);
    expect(parseTimecode('0:01:30')).toBe(90);
    expect(parseTimecode('1:00:00')).toBe(3600);
  });

  it('keeps fractional seconds', () => {
    expect(parseTimecode('1:30.5')).toBeCloseTo(90.5, 3);
  });

  it('refuses anything that is not a timecode', () => {
    for (const bad of ['', 'soon', '1:2:3:4', '-5', '1m30s']) {
      expect(() => parseTimecode(bad), bad).toThrow(/not a timecode/);
    }
  });

  it('round-trips through formatTimecode', () => {
    for (const s of [0, 1.5, 90, 3661.25]) {
      expect(parseTimecode(formatTimecode(s))).toBeCloseTo(s, 2);
    }
  });
});

describe('framingFilter', () => {
  it('fills the canvas for cover, which is the difference from contain', () => {
    const f = framingFilter('cover');
    expect(f).toContain('force_original_aspect_ratio=increase');
    expect(f).toContain(`crop=${REEL.w}:${REEL.h}`);
    expect(f).not.toContain('pad=');
  });

  it('fits and pads with the ground colour for contain', () => {
    const f = framingFilter('contain');
    expect(f).toContain('force_original_aspect_ratio=decrease');
    expect(f).toContain('color=0x0B0B0B');
    expect(f).not.toContain('crop=');
  });

  it('builds a two-branch graph for blur, with every label consumed', () => {
    const f = framingFilter('blur');
    // Every label produced must be read by a later stage, or ffmpeg refuses the graph outright.
    for (const label of ['bg', 'fg', 'blurred', 'framed']) {
      expect(f.match(new RegExp(`\\[${label}\\]`, 'g'))?.length, label).toBe(2);
    }
    expect(f).toContain('gblur=');
    expect(f).toContain('overlay=(W-w)/2:(H-h)/2');
  });
});

describe('videoGraph', () => {
  it('ends in [v] with no title, so -map [v] has something to find', () => {
    const g = videoGraph({ framing: 'cover', titleSeconds: 0 }, { titleIdx: null, silenceIdx: null });
    expect(g.endsWith('[v]')).toBe(true);
    expect(g).not.toContain('overlay=0:0');
  });

  it('scales before dropping frames, not after', () => {
    const g = videoGraph({ framing: 'cover', titleSeconds: 0 }, { titleIdx: null, silenceIdx: null });
    expect(g.indexOf('scale=')).toBeLessThan(g.indexOf('fps='));
  });

  it('overlays the title input at the origin, since the layer is already canvas-sized', () => {
    const g = videoGraph({ framing: 'cover', titleSeconds: 0 }, { titleIdx: 1, silenceIdx: null });
    expect(g).toContain('[base][1:v]overlay=0:0[v]');
  });

  it('escapes the comma in the enable expression', () => {
    // Unescaped, ffmpeg reads `lte(t` and `5)` as two separate filter options and rejects the graph.
    const g = videoGraph({ framing: 'cover', titleSeconds: 5 }, { titleIdx: 1, silenceIdx: null });
    expect(g).toContain('enable=lte(t\\,5)');
    expect(g).not.toContain('enable=lte(t,5)');
  });

  it('keeps working when blur and a title are combined', () => {
    const g = videoGraph({ framing: 'blur', titleSeconds: 0 }, { titleIdx: 1, silenceIdx: null });
    expect(g.endsWith('[v]')).toBe(true);
    expect(g).toContain('[base][1:v]overlay');
    // The blur graph's own overlay must not be confused for the title's.
    expect(g.match(/overlay/g)?.length).toBe(2);
  });
});

describe('ffmpegArgs', () => {
  it('seeks before the input, which is what makes a long source cheap to cut', () => {
    const args = ffmpegArgs(opts({ start: 75 }), { titleIdx: null, silenceIdx: null }, null);
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(args[args.indexOf('-ss') + 1]).toBe('00:01:15.000');
  });

  it('omits -ss entirely when starting at zero', () => {
    expect(ffmpegArgs(opts(), { titleIdx: null, silenceIdx: null }, null)).not.toContain('-ss');
  });

  it('loops the title still, or it shows for a single frame', () => {
    const args = ffmpegArgs(opts({ title: 'SACRO' }), { titleIdx: 1, silenceIdx: null }, '/tmp/title.png');
    const at = args.indexOf('/tmp/title.png');
    expect(args.slice(at - 3, at)).toEqual(['-loop', '1', '-i']);
    // Without -shortest the looping still would extend the output forever.
    expect(args).toContain('-shortest');
  });

  it('maps the generated silence instead of the source when there is none', () => {
    const args = ffmpegArgs(opts({ mute: true }), { titleIdx: null, silenceIdx: 1 }, null);
    expect(args).toContain('anullsrc=channel_layout=stereo:sample_rate=44100');
    expect(args.slice(args.indexOf('-map')).join(' ')).toContain('1:a');
    expect(args).not.toContain('0:a');
  });

  it('maps the source audio when it is being kept', () => {
    const args = ffmpegArgs(opts(), { titleIdx: null, silenceIdx: null }, null);
    expect(args).toContain('0:a');
  });

  it('writes the specs Instagram documents', () => {
    const args = ffmpegArgs(opts(), { titleIdx: null, silenceIdx: null }, null).join(' ');
    expect(args).toContain('-c:v libx264');
    expect(args).toContain('-pix_fmt yuv420p');
    expect(args).toContain('-c:a aac');
    // Without faststart Meta must fetch the whole file before it can read the header.
    expect(args).toContain('-movflags +faststart');
  });

  it('puts the output last and never invokes a shell', () => {
    const args = ffmpegArgs(opts({ title: 'a"; rm -rf /' }), { titleIdx: null, silenceIdx: null }, null);
    expect(args[args.length - 1]).toBe('/out/night-reel.mp4');
    // The title never reaches the argument list at all; it is rendered to a PNG well before this.
    expect(args.join(' ')).not.toContain('rm -rf');
  });
});

describe('checkReel', () => {
  it('passes a 9:16 30s h264 clip with no complaints', () => {
    expect(checkReel(base)).toEqual({ errors: [], warnings: [] });
  });

  it('refuses what the Graph API would refuse', () => {
    expect(checkReel({ ...base, seconds: 2 }).errors[0]).toMatch(/at least 3s/);
    expect(checkReel({ ...base, vcodec: 'hevc' }).errors[0]).toMatch(/H\.264/);
    expect(checkReel({ ...base, fps: 120 }).errors[0]).toMatch(/60 fps/);
    expect(checkReel({ ...base, bytes: REEL_LIMITS.maxBytes + 1 }).errors[0]).toMatch(/1 GB/);
  });

  it('only warns about the things a person might have meant', () => {
    // Letterboxing is a choice someone could have made on purpose, so it must not block an encode.
    const landscape = checkReel({ ...base, width: 1920, height: 1080 });
    expect(landscape.errors).toEqual([]);
    expect(landscape.warnings[0]).toMatch(/letterbox/);

    expect(checkReel({ ...base, seconds: 200 }).errors).toEqual([]);
    expect(checkReel({ ...base, seconds: 200 }).warnings.join(' ')).toMatch(/house limit/);
    expect(checkReel({ ...base, acodec: null }).warnings.join(' ')).toMatch(/silent/);
  });
});

describe('parseFrameRate', () => {
  it('reads the rational ffprobe actually returns', () => {
    expect(parseFrameRate('30/1')).toBe(30);
    expect(parseFrameRate('30000/1001')).toBeCloseTo(29.97, 2);
  });

  it('survives the unmeasurable stream without producing NaN', () => {
    // "0/0" would otherwise become NaN and pass every numeric limit check silently.
    for (const bad of ['0/0', undefined, '']) expect(parseFrameRate(bad)).toBe(0);
  });
});

describe('the title layer', () => {
  it('sets the post typeface rather than naming one of its own', () => {
    const tree = titleTree({ title: 'SACRO' }) as { props: { style: Record<string, unknown> } };
    // The point of drawing this with satori instead of ffmpeg's drawtext: it comes from the design system.
    expect(tree.props.style.fontFamily).toBe(DISPLAY_FONT);   // whatever the posts use -- Archivo since a4511f6
    expect(tree.props.style.width).toBe(REEL.w);
    expect(tree.props.style.height).toBe(REEL.h);
  });

  it('keeps the type clear of Instagram\'s own bottom chrome', () => {
    const find = (node: unknown): Record<string, unknown>[] => {
      const n = node as { props?: { style?: Record<string, unknown>; children?: unknown } };
      const here = n.props?.style ? [n.props.style] : [];
      const kids = n.props?.children;
      const list = Array.isArray(kids) ? kids : typeof kids === 'object' && kids ? [kids] : [];
      return [...here, ...list.flatMap(find)];
    };
    const styles = find(titleTree({ title: 'SACRO', position: 'low' }));
    expect(styles.some((s) => Number(s.paddingBottom) >= 300)).toBe(true);
  });

  it('washes the scrim toward the type, not away from it', () => {
    // `low` has to be heaviest at the bottom and `high` at the top, or the type sits on the clear half.
    const lastStopOpacity = (svg: string): number => {
      const stops = [...svg.matchAll(/stop-opacity="([\d.]+)"/g)].map((m) => Number(m[1]));
      return stops[stops.length - 1]!;
    };
    expect(lastStopOpacity(scrimSvg('low').toString())).toBeGreaterThan(0.8);
    expect(lastStopOpacity(scrimSvg('high').toString())).toBe(0);
    for (const position of ['low', 'middle', 'high'] as const) {
      const svg = scrimSvg(position).toString();
      expect(svg, position).toContain(`width="${REEL.w}" height="${REEL.h}"`);
    }
  });
});

describe('storage paths', () => {
  it('groups a reel under its post id, so a deleted post is one prefix', () => {
    expect(objectPath('11111111-2222-3333-4444-555555555555', 'reel.mp4'))
      .toBe('11111111-2222-3333-4444-555555555555/reel.mp4');
  });

  it('refuses to let a path argument escape the post prefix', () => {
    // basename() is what stops "../../other-post/reel.mp4" becoming a write outside the prefix.
    expect(objectPath('post-id', '../../etc/passwd')).toBe('post-id/passwd');
  });

  it('builds the public URL Meta will fetch', () => {
    const env = { SUPABASE_URL: 'https://ref.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'k' };
    expect(publicUrl('post-id/reel.mp4', env))
      .toBe('https://ref.supabase.co/storage/v1/object/public/reels/post-id/reel.mp4');
  });

  it('says what to do when the write key is missing rather than using the publishable one', () => {
    expect(() => publicUrl('x', { SUPABASE_URL: 'https://ref.supabase.co' }))
      .toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});
