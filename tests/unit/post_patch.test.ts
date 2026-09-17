import { describe, expect, it } from 'vitest';
import { postPatchSchema } from '../../src/post/types.js';

describe('postPatchSchema', () => {
  it('does not invent a treatment when a patch does not send one', () => {
    // It used to fill in "mono", so saving a caption or approving a post reset the look someone had chosen.
    expect(postPatchSchema.parse({ caption: 'hello' })).toEqual({ caption: 'hello' });
    expect(postPatchSchema.parse({ status: 'approved' })).toEqual({ status: 'approved' });
  });

  it('still accepts a treatment that is sent, and refuses one that does not exist', () => {
    expect(postPatchSchema.parse({ treatment: 'crush' })).toEqual({ treatment: 'crush' });
    expect(() => postPatchSchema.parse({ treatment: 'sepia' })).toThrow();
  });
});
