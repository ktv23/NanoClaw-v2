/**
 * `ncl groups config set-skills | add-skill | remove-skill`.
 *
 * A group's container config holds `skills`: `'all'` (mount every shared
 * container skill) or an explicit list. These verbs edit that selection, which
 * the other `groups config` verbs do not reach.
 *
 * Spread into the `groups` resource's `customOperations`, so they register,
 * validate, gate on approval and show up in help exactly like the built-in
 * verbs. The selection is read when a container starts.
 */
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import type { CustomOperation } from '../crud.js';
import { addSkill, parseSkillsArg, removeSkill, type Skills } from './skills-util.js';

async function currentSkills(id: string): Promise<Skills> {
  const row = await getContainerConfig(id);
  if (!row) throw new Error(`No container config for group: ${id}`);
  return JSON.parse(row.skills) as Skills;
}

function requireString(args: Record<string, unknown>, flag: string): string {
  const value = args[flag];
  if (typeof value !== 'string' || !value) throw new Error(`--${flag} is required`);
  return value;
}

export const skillsConfigOperations: Record<string, CustomOperation> = {
  'config set-skills': {
    access: 'approval',
    description:
      'Set the exact skills a group mounts. Requires `ncl groups restart` to take effect. ' +
      'Use --id <group-id> and --skills all (mount every skill) or --skills "a,b,c" (or a JSON array) ' +
      'to mount exactly those.',
    handler: async (args) => {
      const id = requireString(args, 'id');
      if (args.skills === undefined) {
        throw new Error('--skills is required (use "all", a comma-separated list, or a JSON array)');
      }
      await currentSkills(id);
      const value = parseSkillsArg(String(args.skills));
      await updateContainerConfigJson(id, 'skills', value);
      return { skills: value, note: 'Run `ncl groups restart` to remount.' };
    },
  },
  'config add-skill': {
    access: 'approval',
    description:
      "Add a skill to a group's mount list. Requires `ncl groups restart` to take effect. " +
      'Use --id <group-id> --skill <skill-name>. If the group mounts "all" skills, the skill is already ' +
      'included (no-op).',
    handler: async (args) => {
      const id = requireString(args, 'id');
      const skill = requireString(args, 'skill');
      const result = addSkill(await currentSkills(id), skill);
      if (result.added) await updateContainerConfigJson(id, 'skills', result.skills);
      return result;
    },
  },
  'config remove-skill': {
    access: 'approval',
    description:
      "Remove a skill from a group's mount list. Requires `ncl groups restart` to take effect. " +
      'Use --id <group-id> --skill <skill-name>. Not valid when the group mounts "all" — use ' +
      '`config set-skills` to pin an explicit list first.',
    handler: async (args) => {
      const id = requireString(args, 'id');
      const skill = requireString(args, 'skill');
      const result = removeSkill(await currentSkills(id), skill);
      await updateContainerConfigJson(id, 'skills', result.skills);
      return { ...result, note: 'Run `ncl groups restart` to remount.' };
    },
  },
};
