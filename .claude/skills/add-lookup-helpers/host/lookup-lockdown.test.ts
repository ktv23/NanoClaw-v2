/**
 * Integration-point test: a group that mounts `skills: 'all'` never inherits a
 * lockdown skill, while a group that lists it explicitly gets it. Drives the
 * real `syncSkillSymlinks`; goes red if the `withoutLockdownSkills` call is
 * removed from the skill selection in container-runner.ts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ContainerConfig } from './container-config.js';
import { syncSkillSymlinks } from './container-runner.js';
import { resetGatewayProvider, type GatewayProviderDefinition } from './gateway-providers/index.js';
import { skillEnforcesLockdown } from './lookup-lockdown.js';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

let root: string;
let claudeDir: string;

function writeSkill(name: string, helper?: Record<string, unknown>): void {
  const dir = path.join(root, 'container', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`);
  if (helper) fs.writeFileSync(path.join(dir, 'helper.json'), JSON.stringify(helper));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-lockdown-root-'));
  claudeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-lockdown-claude-'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  // A gateway that contributes no agent skills, so the selection is exactly ours.
  resetGatewayProvider({ kind: 'test', agentSkills: [] } as unknown as GatewayProviderDefinition);

  writeSkill('welcome');
  writeSkill('mtg-helper', { trigger: 'mtg', directive: 'MTG RULES' });
  writeSkill('gatekeeper', { trigger: '', enforce: true, fallback_message: 'use a code' });
});

afterEach(() => {
  vi.restoreAllMocks();
  resetGatewayProvider();
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(claudeDir, { recursive: true, force: true });
});

describe('lockdown skills and skill selection', () => {
  it("leaves a lockdown skill out of 'all'", () => {
    const selected = syncSkillSymlinks(claudeDir, { skills: 'all' } as ContainerConfig);

    expect(selected.sort()).toEqual(['mtg-helper', 'welcome']);
    expect(fs.existsSync(path.join(claudeDir, 'skills', 'gatekeeper'))).toBe(false);
    expect(fs.lstatSync(path.join(claudeDir, 'skills', 'mtg-helper')).isSymbolicLink()).toBe(true);
  });

  it('mounts a lockdown skill for a group that lists it explicitly', () => {
    const selected = syncSkillSymlinks(claudeDir, { skills: ['mtg-helper', 'gatekeeper'] } as ContainerConfig);

    expect(selected.sort()).toEqual(['gatekeeper', 'mtg-helper']);
    expect(fs.readlinkSync(path.join(claudeDir, 'skills', 'gatekeeper'))).toBe('/app/skills/gatekeeper');
  });
});

describe('skillEnforcesLockdown', () => {
  it('is true only for helper.json with enforce: true', () => {
    const skills = path.join(root, 'container', 'skills');
    expect(skillEnforcesLockdown(path.join(skills, 'gatekeeper'))).toBe(true);
    expect(skillEnforcesLockdown(path.join(skills, 'mtg-helper'))).toBe(false);
    expect(skillEnforcesLockdown(path.join(skills, 'welcome'))).toBe(false);
  });

  it('treats a malformed helper.json as not a lockdown', () => {
    const dir = path.join(root, 'container', 'skills', 'broken');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'helper.json'), '{ not json');
    expect(skillEnforcesLockdown(dir)).toBe(false);
  });
});
