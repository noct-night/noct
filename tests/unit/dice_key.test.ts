import { describe, expect, it } from 'vitest';
import { dice, resolveKey } from '../../src/sources/dice.js';

// The frontend-key path (owner-supplied via env) vs the DICE-issued key. Uses obvious placeholders, no real key.
describe('dice: key resolution (issued vs frontend)', () => {
  it('prefers DICE_API_KEY, falls back to DICE_FRONTEND_KEY, else null', () => {
    expect(resolveKey({})).toBeNull();
    expect(resolveKey({ DICE_FRONTEND_KEY: 'PUBLIC_PAGE_KEY' })).toEqual({ key: 'PUBLIC_PAGE_KEY', kind: 'frontend' });
    expect(resolveKey({ DICE_API_KEY: 'ISSUED' })).toEqual({ key: 'ISSUED', kind: 'issued' });
    expect(resolveKey({ DICE_API_KEY: 'ISSUED', DICE_FRONTEND_KEY: 'PUBLIC_PAGE_KEY' })).toEqual({ key: 'ISSUED', kind: 'issued' });
    expect(resolveKey({ DICE_FRONTEND_KEY: '' })).toBeNull();
  });
  it('enabled() accepts either key and explains when neither is set', () => {
    expect(dice.enabled({ DICE_FRONTEND_KEY: 'PUBLIC_PAGE_KEY' })).toEqual({ ok: true });
    expect(dice.enabled({ DICE_API_KEY: 'ISSUED' })).toEqual({ ok: true });
    const off = dice.enabled({});
    expect(off.ok).toBe(false);
    expect(off).toMatchObject({ reason: expect.stringMatching(/DICE_FRONTEND_KEY/) });
  });
});
