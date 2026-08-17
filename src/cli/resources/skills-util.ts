/**
 * Pure helpers for the `ncl groups config {set,add,remove}-skill` verbs.
 *
 * The container config's `skills` column is `string[] | 'all'` (the default is
 * `'all'` = mount every skill). These helpers own the sentinel handling so the
 * CLI handlers stay thin and the tricky cases are unit-tested.
 */
export type Skills = string[] | 'all';

/**
 * Parse a `--skills` argument into a `Skills` value:
 *   "all"            -> 'all'
 *   '["a","b"]'      -> ['a','b']   (JSON array)
 *   "a, b ,c"        -> ['a','b','c'] (comma-separated)
 * Empty entries are dropped; duplicates are collapsed (order preserved).
 */
export function parseSkillsArg(raw: string): Skills {
  const s = raw.trim();
  if (s.toLowerCase() === 'all') return 'all';
  let list: unknown;
  if (s.startsWith('[') || s.startsWith('{')) {
    list = JSON.parse(s);
    if (!Array.isArray(list)) throw new Error('--skills JSON must be an array of strings');
  } else {
    list = s.split(',');
  }
  const out: string[] = [];
  for (const item of list as unknown[]) {
    if (typeof item !== 'string') throw new Error('--skills entries must be strings');
    const name = item.trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Ensure `skill` is mounted. If the group already mounts `'all'`, the skill is
 * already included — a no-op success (this is what `forge deploy` relies on).
 */
export function addSkill(cur: Skills, skill: string): { skills: Skills; added: boolean; note: string } {
  if (cur === 'all') {
    return { skills: 'all', added: false, note: `Group mounts all skills; "${skill}" is already included.` };
  }
  if (cur.includes(skill)) {
    return { skills: cur, added: false, note: `"${skill}" already present.` };
  }
  return {
    skills: [...cur, skill],
    added: true,
    note: 'Run `ncl groups restart --rebuild` to remount.',
  };
}

/**
 * Remove `skill` from an explicit list. Not meaningful when the group mounts
 * `'all'` (you cannot subtract one skill from "everything") — the caller must
 * pin an explicit list via set-skills first, so this throws.
 */
export function removeSkill(cur: Skills, skill: string): { skills: string[]; removed: boolean } {
  if (cur === 'all') {
    throw new Error(
      'Group mounts all skills; cannot remove one from "all". Use `config set-skills` to pin an explicit list first.',
    );
  }
  const next = cur.filter((s) => s !== skill);
  return { skills: next, removed: next.length !== cur.length };
}
