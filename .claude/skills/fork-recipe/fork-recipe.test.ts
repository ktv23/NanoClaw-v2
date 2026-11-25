/**
 * Stack test for this fork's recipe (host tree, vitest).
 *
 * Each skill's own tests prove that skill is wired in. This test covers what
 * only shows up when the skills are applied together:
 *
 *  - every file a skill copies into the tree is still identical to the copy in
 *    the skill's folder. The skill folder is the source; an edit made only to
 *    the installed copy would be lost the next time the skill is applied.
 *  - the skills that share a file or an ordering each kept their place.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

/** Repo root: the dir holding .claude/skills, wherever this file is copied to. */
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.claude', 'skills', 'fork-recipe', 'SKILL.md'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('.claude/skills/fork-recipe not found walking up from ' + __dirname);
}

const root = repoRoot();

/** A skill folder (or subfolder) whose .ts files are copied into one tree directory. */
interface CopySet {
  skill: string;
  from: string;
  to: string;
}

const COPY_SETS: CopySet[] = [
  { skill: 'add-mnemon', from: '.', to: 'src' },
  { skill: 'add-lookup-helpers', from: 'container', to: 'container/agent-runner/src/lookup-helpers' },
  { skill: 'add-lookup-helpers', from: 'host', to: 'src' },
  { skill: 'add-origin-scoped-destinations', from: '.', to: 'src/modules/agent-to-agent' },
  { skill: 'add-host-gateway-noproxy', from: '.', to: 'src' },
  { skill: 'add-config-skills-verbs', from: '.', to: 'src/cli/resources' },
  { skill: 'add-discord-thread-titles', from: '.', to: 'src/modules/discord-thread-titles' },
  { skill: 'add-google-mcp-tools', from: '.', to: 'src' },
  { skill: 'add-interim-feedback', from: '.', to: 'src/modules/interim-feedback' },
  { skill: 'fork-recipe', from: '.', to: 'src' },
];

function copiedFiles(set: CopySet): string[] {
  const dir = path.join(root, '.claude', 'skills', set.skill, set.from);
  return fs.readdirSync(dir).filter((name) => name.endsWith('.ts'));
}

describe('installed skill files match their source', () => {
  for (const set of COPY_SETS) {
    const files = copiedFiles(set);

    it(`${set.skill}/${set.from} ships at least one file`, () => {
      expect(files.length).toBeGreaterThan(0);
    });

    it.each(files)(`${set.skill}: %s is identical in ${set.to}`, (name) => {
      const source = fs.readFileSync(path.join(root, '.claude', 'skills', set.skill, set.from, name), 'utf8');
      const installedPath = path.join(root, set.to, name);
      expect(fs.existsSync(installedPath), `${set.to}/${name} is missing — re-apply ${set.skill}`).toBe(true);
      expect(fs.readFileSync(installedPath, 'utf8')).toBe(source);
    });
  }
});

describe('skills that share a file keep their place', () => {
  const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

  it('the modules barrel loads the fork modules after approvals', () => {
    const barrel = read('src/modules/index.ts');
    const at = (line: string) => barrel.indexOf(line);
    expect(at("import './discord-thread-titles/index.js';")).toBeGreaterThan(-1);
    // interim-feedback reaches the agent's session through the approvals module.
    expect(at("import './interim-feedback/index.js';")).toBeGreaterThan(at("import './approvals/index.js';"));
    expect(at("import './approvals/index.js';")).toBeGreaterThan(-1);
  });

  it('container-runner.ts carries both of its reach-ins', () => {
    const runner = read('src/container-runner.ts');
    expect(runner).toContain('withoutLockdownSkills(sharedSkillsDir, available)');
    expect(runner).toContain('withHostGatewayNoProxy({');
  });

  it('the image manifest keeps upstream tools alongside the fork tools', () => {
    const names = (JSON.parse(read('container/cli-tools.json')) as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(['agent-browser', '@anthropic-ai/claude-code', '@gongrzhe/server-gmail-autoauth-mcp']),
    );
  });
});
