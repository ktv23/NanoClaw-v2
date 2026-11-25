/**
 * Integration-point test: the three skill-selection verbs are registered on
 * the `groups` resource and edit the real `container_configs.skills` column.
 * Drives the real `dispatch` against a migrated test database; every case goes
 * red if the `...skillsConfigOperations` spread is removed from groups.ts.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../container-restart.js', () => ({
  restartAgentGroupContainers: vi.fn().mockResolvedValue(0),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-groups-skills' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-groups-skills';
const GID = 'ag-skills';

import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { dispatch } from '../dispatch.js';
// Side-effect import: registers the `groups-*` commands.
import './groups.js';

async function storedSkills(): Promise<unknown> {
  return JSON.parse((await getContainerConfig(GID))!.skills);
}

async function run(command: string, args: Record<string, unknown>) {
  return dispatch({ id: `req-${command}`, command, args: { id: GID, ...args } }, { caller: 'host' });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: GID,
    name: 'skills',
    folder: 'skills',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig(GID);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('groups config skill-selection verbs', () => {
  it('set-skills pins an explicit list, and "all" restores the default', async () => {
    const pinned = await run('groups-config-set-skills', { skills: 'kdm, mtg-helper' });
    expect(pinned.ok).toBe(true);
    expect(await storedSkills()).toEqual(['kdm', 'mtg-helper']);

    const all = await run('groups-config-set-skills', { skills: 'all' });
    expect(all.ok).toBe(true);
    expect(await storedSkills()).toBe('all');
  });

  it('add-skill is a successful no-op when the group mounts "all"', async () => {
    await updateContainerConfigJson(GID, 'skills', 'all');

    const resp = await run('groups-config-add-skill', { skill: 'kdm' });

    expect(resp.ok).toBe(true);
    expect(await storedSkills()).toBe('all');
  });

  it('add-skill appends to an explicit list once', async () => {
    await updateContainerConfigJson(GID, 'skills', ['kdm']);

    expect((await run('groups-config-add-skill', { skill: 'mtg-helper' })).ok).toBe(true);
    expect((await run('groups-config-add-skill', { skill: 'mtg-helper' })).ok).toBe(true);

    expect(await storedSkills()).toEqual(['kdm', 'mtg-helper']);
  });

  it('remove-skill drops one skill from an explicit list', async () => {
    await updateContainerConfigJson(GID, 'skills', ['kdm', 'mtg-helper']);

    const resp = await run('groups-config-remove-skill', { skill: 'kdm' });

    expect(resp.ok).toBe(true);
    expect(await storedSkills()).toEqual(['mtg-helper']);
  });

  it('remove-skill refuses when the group mounts "all"', async () => {
    await updateContainerConfigJson(GID, 'skills', 'all');

    const resp = await run('groups-config-remove-skill', { skill: 'kdm' });

    expect(resp.ok).toBe(false);
    expect(await storedSkills()).toBe('all');
  });

  it('rejects a call with no --skill', async () => {
    const resp = await run('groups-config-add-skill', {});
    expect(resp.ok).toBe(false);
  });
});
