import { describe, it, expect } from 'vitest';

import { parseSkillsArg, addSkill, removeSkill } from './skills-util.js';

describe('parseSkillsArg', () => {
  it('parses the "all" sentinel case-insensitively', () => {
    expect(parseSkillsArg('all')).toBe('all');
    expect(parseSkillsArg('  ALL ')).toBe('all');
  });

  it('parses a JSON array', () => {
    expect(parseSkillsArg('["a","b"]')).toEqual(['a', 'b']);
  });

  it('parses a comma-separated list, trimming and dropping empties', () => {
    expect(parseSkillsArg('a, b ,c,')).toEqual(['a', 'b', 'c']);
  });

  it('de-duplicates while preserving order', () => {
    expect(parseSkillsArg('a,b,a')).toEqual(['a', 'b']);
  });

  it('rejects non-array JSON and non-string entries', () => {
    expect(() => parseSkillsArg('{"x":1}')).toThrow();
    expect(() => parseSkillsArg('[1,2]')).toThrow();
  });
});

describe('addSkill', () => {
  it('appends to an explicit list', () => {
    expect(addSkill(['a'], 'b')).toEqual({
      skills: ['a', 'b'],
      added: true,
      note: expect.any(String),
    });
  });

  it('is a no-op when the skill is already present', () => {
    const r = addSkill(['a', 'b'], 'b');
    expect(r.added).toBe(false);
    expect(r.skills).toEqual(['a', 'b']);
  });

  it('is a no-op when the group mounts "all" (already included)', () => {
    const r = addSkill('all', 'b');
    expect(r.added).toBe(false);
    expect(r.skills).toBe('all');
  });
});

describe('removeSkill', () => {
  it('removes from an explicit list', () => {
    expect(removeSkill(['a', 'b'], 'b')).toEqual({ skills: ['a'], removed: true });
  });

  it('reports removed=false when the skill was absent', () => {
    expect(removeSkill(['a'], 'b')).toEqual({ skills: ['a'], removed: false });
  });

  it('throws when the group mounts "all"', () => {
    expect(() => removeSkill('all', 'b')).toThrow(/all/i);
  });
});
