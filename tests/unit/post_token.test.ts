import { describe, expect, it } from 'vitest';
import {
  daysUntilExpiry, MIN_TOKEN_AGE_MS, needsReseed, normaliseSeed, REFRESH_WINDOW_MS, seedFingerprint,
  shouldRefresh, type StoredToken,
} from '../../src/post/token.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-09-15T12:00:00.000Z');

function token(over: Partial<StoredToken> = {}): StoredToken {
  return {
    token: 'IGQ-whatever',
    expiresAt: new Date(NOW.getTime() + 60 * DAY),
    obtainedAt: new Date(NOW.getTime() - 30 * DAY),
    ...over,
  };
}

/**
 * The whole reason this policy exists: an Instagram Login token lasts 60 days where a Facebook Page token
 * did not expire at all, and NOCT posts once a week unattended.
 */
describe('when to refresh the Instagram token', () => {
  it('leaves a healthy token alone', () => {
    expect(shouldRefresh(token(), NOW)).toBe(false);
    expect(shouldRefresh(token({ expiresAt: new Date(NOW.getTime() + 20 * DAY) }), NOW)).toBe(false);
  });

  it('refreshes once inside the window, with weeks of slack before it actually lapses', () => {
    expect(shouldRefresh(token({ expiresAt: new Date(NOW.getTime() + 13 * DAY) }), NOW)).toBe(true);
    // The boundary itself, to pin the constant rather than assume it.
    const atEdge = new Date(NOW.getTime() + REFRESH_WINDOW_MS - 1000);
    expect(shouldRefresh(token({ expiresAt: atEdge }), NOW)).toBe(true);
  });

  it('refreshes an already-expired token, so a long gap still tries rather than giving up', () => {
    expect(shouldRefresh(token({ expiresAt: new Date(NOW.getTime() - DAY) }), NOW)).toBe(true);
  });

  it('refreshes a seed from the environment, whose remaining life is unknown', () => {
    // Converting it into a token with a known expiry is the state everything downstream wants.
    expect(shouldRefresh(token({ expiresAt: null, obtainedAt: null }), NOW)).toBe(true);
  });

  it('will not refresh a token under 24 hours old, because Instagram refuses those', () => {
    const fresh = token({ expiresAt: null, obtainedAt: new Date(NOW.getTime() - 60 * 60 * 1000) });
    expect(shouldRefresh(fresh, NOW)).toBe(false);
    // Just past the minimum age, it becomes eligible again.
    const older = token({ expiresAt: null, obtainedAt: new Date(NOW.getTime() - MIN_TOKEN_AGE_MS - 1000) });
    expect(shouldRefresh(older, NOW)).toBe(true);
  });

  it('does not refresh a young token that is nowhere near expiry', () => {
    const justIssued = token({
      expiresAt: new Date(NOW.getTime() + 60 * DAY),
      obtainedAt: new Date(NOW.getTime() - 60 * 60 * 1000),
    });
    expect(shouldRefresh(justIssued, NOW)).toBe(false);
  });

  it('a weekly post keeps the token alive indefinitely', () => {
    // Refresh at day 46 of 60 gives a new 60 days, so the only thing that can kill it is a two-month gap.
    let t = token({ expiresAt: new Date(NOW.getTime() + 60 * DAY), obtainedAt: NOW });
    let now = NOW;
    for (let week = 0; week < 52; week++) {
      now = new Date(now.getTime() + 7 * DAY);
      if (shouldRefresh(t, now)) t = { token: 'fresh', expiresAt: new Date(now.getTime() + 60 * DAY), obtainedAt: now };
      expect(daysUntilExpiry(t, now)!).toBeGreaterThan(0);
    }
  });
});

describe('daysUntilExpiry', () => {
  it('counts whole days left', () => {
    expect(daysUntilExpiry(token({ expiresAt: new Date(NOW.getTime() + 59.5 * DAY) }), NOW)).toBe(59);
  });

  it('goes negative once lapsed, so the caller can tell "expired" from "unknown"', () => {
    expect(daysUntilExpiry(token({ expiresAt: new Date(NOW.getTime() - 2 * DAY) }), NOW)).toBeLessThan(0);
    expect(daysUntilExpiry(token({ expiresAt: null }), NOW)).toBeNull();
  });
});

describe('normaliseSeed', () => {
  it('strips the whitespace a dashboard paste picks up', () => {
    // A trailing newline or space makes Instagram answer "Failed to decrypt", which says nothing about why.
    expect(normaliseSeed('IGAAtoken\n')).toBe('IGAAtoken');
    expect(normaliseSeed('  IGAAtoken  ')).toBe('IGAAtoken');
  });

  it('strips the quotes a value was copied out of', () => {
    expect(normaliseSeed('"IGAAtoken"')).toBe('IGAAtoken');
    expect(normaliseSeed("'IGAAtoken'")).toBe('IGAAtoken');
    expect(normaliseSeed(' "IGAAtoken" \n')).toBe('IGAAtoken');
  });

  it('leaves a clean token alone, including quote characters that are not wrapping it', () => {
    expect(normaliseSeed('IGAAtoken')).toBe('IGAAtoken');
    expect(normaliseSeed('"IGAAtoken')).toBe('"IGAAtoken');
  });

  it('treats empty as unset', () => {
    expect(normaliseSeed(undefined)).toBeUndefined();
    expect(normaliseSeed('   ')).toBeUndefined();
    expect(normaliseSeed('""')).toBeUndefined();
  });
});

describe('needsReseed', () => {
  it('takes a seed the database has never stored', () => {
    expect(needsReseed('IGAAone', null)).toBe(true);
  });

  it('keeps using the stored token while the env var is unchanged, even after refreshes', () => {
    // A refreshed token differs from the seed, which is why the fingerprint is of the seed, not the token.
    expect(needsReseed('IGAAone', seedFingerprint('IGAAone'))).toBe(false);
  });

  it('replaces the stored token when the env var changes, so fixing a bad token actually fixes it', () => {
    expect(needsReseed('IGAAtwo', seedFingerprint('IGAAone'))).toBe(true);
  });

  it('keeps the stored token when the env var is removed', () => {
    expect(needsReseed(undefined, seedFingerprint('IGAAone'))).toBe(false);
  });

  it('fingerprints without storing the token itself', () => {
    const fp = seedFingerprint('IGAAsecret');
    expect(fp).toHaveLength(16);
    expect(fp).not.toContain('IGAA');
  });
});
