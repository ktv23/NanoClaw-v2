/**
 * Lockdown skills are opt-in.
 *
 * A container skill whose `helper.json` declares `"enforce": true` (the lookup
 * gatekeeper) turns a bot into a locked reference bot that answers nothing
 * outside its allow-list. A group that mounts `skills: 'all'` is a
 * general-purpose assistant, so `'all'` must never include such a skill: it has
 * to be listed explicitly by the group that wants it.
 */
import fs from 'fs';
import path from 'path';

/**
 * True when a skill directory declares an enforcing lockdown. Read
 * defensively: a missing or malformed helper.json means "not a lockdown".
 */
export function skillEnforcesLockdown(skillDir: string): boolean {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(skillDir, 'helper.json'), 'utf8')) as { enforce?: unknown };
    return cfg?.enforce === true;
  } catch {
    return false;
  }
}

/** The names `'all'` expands to: every shared skill except lockdown skills. */
export function withoutLockdownSkills(sharedSkillsDir: string, names: string[]): string[] {
  return names.filter((name) => !skillEnforcesLockdown(path.join(sharedSkillsDir, name)));
}
