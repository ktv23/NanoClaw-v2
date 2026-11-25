/**
 * Integration-point test: for a locked-down group, the destination projection
 * keeps only the channel a chat session came from. Drives the real
 * `writeDestinations` with its central-DB reads and the session mailbox
 * stubbed; goes red if the `scopeToSessionOrigin` call is removed from
 * write-destinations.ts.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetSession,
  mockGetDestinations,
  mockGetMessagingGroup,
  mockGetAgentGroup,
  mockGetContainerConfig,
  mockGetWiring,
  mockReplaceDestinations,
  mockWarn,
} = vi.hoisted(() => ({
  mockGetWiring: vi.fn(),
  mockGetSession: vi.fn(),
  mockGetDestinations: vi.fn(),
  mockGetMessagingGroup: vi.fn(),
  mockGetAgentGroup: vi.fn(),
  mockGetContainerConfig: vi.fn(),
  mockReplaceDestinations: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('./db/sessions.js', () => ({ getSession: (...a: unknown[]) => mockGetSession(...a) }));
vi.mock('./db/container-configs.js', () => ({
  getContainerConfig: (...a: unknown[]) => mockGetContainerConfig(...a),
}));
vi.mock('./modules/agent-to-agent/db/agent-destinations.js', () => ({
  getDestinations: (...a: unknown[]) => mockGetDestinations(...a),
}));
vi.mock('./db/messaging-groups.js', () => ({
  getMessagingGroup: (...a: unknown[]) => mockGetMessagingGroup(...a),
  getMessagingGroupAgentByPair: (...a: unknown[]) => mockGetWiring(...a),
}));
vi.mock('./db/agent-groups.js', () => ({ getAgentGroup: (...a: unknown[]) => mockGetAgentGroup(...a) }));
vi.mock('./log.js', () => ({ log: { debug: vi.fn(), warn: mockWarn, info: vi.fn(), error: vi.fn() } }));
vi.mock('./session-manager.js', () => ({
  withMailboxSession: async (
    _agentGroupId: string,
    _sessionId: string,
    fn: (db: { replaceDestinations: (rows: unknown[]) => void }) => unknown,
  ) => fn({ replaceDestinations: mockReplaceDestinations }),
}));

// Import after the mocks are registered.
const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');

// Central agent_destinations rows: the origin channel, a sibling channel from a
// second wiring of the same shared group, and an explicitly granted agent.
const ORIGIN_MG = 'mg-tonys-thoughts';
const SIBLING_MG = 'mg-mtg';
const CENTRAL_ROWS = [
  { agent_group_id: 'g1', local_name: 'tonys-thoughts', target_type: 'channel', target_id: ORIGIN_MG, created_at: '1' },
  { agent_group_id: 'g1', local_name: 'mtg', target_type: 'channel', target_id: SIBLING_MG, created_at: '2' },
  { agent_group_id: 'g1', local_name: 'helper-child', target_type: 'agent', target_id: 'child-ag', created_at: '3' },
];
const ALL = ['helper-child', 'mtg', 'tonys-thoughts'];

let root: string;

function projectedNames(): string[] {
  const rows = mockReplaceDestinations.mock.calls.at(-1)![0] as Array<{ name: string }>;
  return rows.map((r) => r.name).sort();
}

function groupSelects(skills: unknown): void {
  mockGetContainerConfig.mockResolvedValue({ skills: JSON.stringify(skills) });
}

beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-origin-scope-'));
  for (const [name, helper] of Object.entries({
    'mtg-helper': { trigger: 'mtg', directive: 'MTG RULES' },
    gatekeeper: { trigger: '', enforce: true, fallback_message: 'use a code' },
  })) {
    fs.mkdirSync(path.join(root, 'container', 'skills', name), { recursive: true });
    fs.writeFileSync(path.join(root, 'container', 'skills', name, 'helper.json'), JSON.stringify(helper));
  }
  vi.spyOn(process, 'cwd').mockReturnValue(root);

  mockGetDestinations.mockResolvedValue(CENTRAL_ROWS);
  mockGetMessagingGroup.mockImplementation(async (id: string) => ({
    id,
    name: id,
    channel_type: 'discord',
    platform_id: `discord:${id}`,
  }));
  mockGetAgentGroup.mockImplementation(async (id: string) => ({ id, name: id.toUpperCase() }));
  mockGetSession.mockResolvedValue({ id: 's1', messaging_group_id: ORIGIN_MG });
  mockGetWiring.mockResolvedValue({ session_mode: 'shared' });
  groupSelects(['mtg-helper', 'gatekeeper']);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('writeDestinations origin scoping for locked-down groups', () => {
  it('prunes sibling channels but keeps the origin channel and agent grants', async () => {
    await writeDestinations('g1', 's1');
    expect(projectedNames()).toEqual(['helper-child', 'tonys-thoughts']);
  });

  it('leaves a group that selected no lockdown skill untouched', async () => {
    groupSelects(['mtg-helper']);
    await writeDestinations('g1', 's1');
    expect(projectedNames()).toEqual(ALL);
  });

  it("leaves a group on skills: 'all' untouched", async () => {
    groupSelects('all');
    await writeDestinations('g1', 's1');
    expect(projectedNames()).toEqual(ALL);
  });

  it('fails open (keeps every channel) when the session has no channel origin', async () => {
    mockGetSession.mockResolvedValue({ id: 's1', messaging_group_id: null });
    await writeDestinations('g1', 's1');
    expect(projectedNames()).toEqual(ALL);
  });

  it('fails open when the session row is missing entirely', async () => {
    mockGetSession.mockResolvedValue(undefined);
    await writeDestinations('g1', 's1');
    expect(projectedNames()).toEqual(ALL);
  });

  it('fails open, with a warning, when the origin channel has no destination row', async () => {
    mockGetSession.mockResolvedValue({ id: 's1', messaging_group_id: 'mg-orphan' });
    await writeDestinations('g1', 's1');
    expect(projectedNames()).toEqual(ALL);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('fails open for an agent-shared session, which serves every channel of the group', async () => {
    mockGetWiring.mockResolvedValue({ session_mode: 'agent-shared' });
    await writeDestinations('g1', 's1');
    expect(projectedNames()).toEqual(ALL);
  });

  it('fails open when the group has no container config row', async () => {
    mockGetContainerConfig.mockResolvedValue(undefined);
    await writeDestinations('g1', 's1');
    expect(projectedNames()).toEqual(ALL);
  });
});
