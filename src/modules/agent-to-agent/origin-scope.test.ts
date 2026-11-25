/**
 * Integration-point test: the destination projection prunes channel
 * destinations to the session's origin. Drives the real `writeDestinations`
 * with its central-DB reads and the session mailbox stubbed; goes red if the
 * `scopeToSessionOrigin` call is removed from write-destinations.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockGetSession,
  mockGetDestinations,
  mockGetMessagingGroup,
  mockGetAgentGroup,
  mockReplaceDestinations,
  mockWarn,
} = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockGetDestinations: vi.fn(),
  mockGetMessagingGroup: vi.fn(),
  mockGetAgentGroup: vi.fn(),
  mockReplaceDestinations: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('../../db/sessions.js', () => ({ getSession: (...a: unknown[]) => mockGetSession(...a) }));
vi.mock('./db/agent-destinations.js', () => ({ getDestinations: (...a: unknown[]) => mockGetDestinations(...a) }));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: (...a: unknown[]) => mockGetMessagingGroup(...a),
}));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: (...a: unknown[]) => mockGetAgentGroup(...a) }));
vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), warn: mockWarn, info: vi.fn(), error: vi.fn() } }));
vi.mock('../../session-manager.js', () => ({
  withMailboxSession: async (
    _agentGroupId: string,
    _sessionId: string,
    fn: (db: { replaceDestinations: (rows: unknown[]) => void }) => unknown,
  ) => fn({ replaceDestinations: mockReplaceDestinations }),
}));

// Import after the mocks are registered.
const { writeDestinations } = await import('./write-destinations.js');

// Central agent_destinations rows: the origin channel, a sibling channel from a
// second wiring of the same shared group, and an explicitly granted agent.
const ORIGIN_MG = 'mg-tonys-thoughts';
const SIBLING_MG = 'mg-mtg';
const CENTRAL_ROWS = [
  { agent_group_id: 'g1', local_name: 'tonys-thoughts', target_type: 'channel', target_id: ORIGIN_MG, created_at: '1' },
  { agent_group_id: 'g1', local_name: 'mtg', target_type: 'channel', target_id: SIBLING_MG, created_at: '2' },
  { agent_group_id: 'g1', local_name: 'helper-child', target_type: 'agent', target_id: 'child-ag', created_at: '3' },
];

function projectedNames(): string[] {
  const rows = mockReplaceDestinations.mock.calls.at(-1)![0] as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe('writeDestinations origin scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDestinations.mockResolvedValue(CENTRAL_ROWS);
    mockGetMessagingGroup.mockImplementation(async (id: string) => ({
      id,
      name: id,
      channel_type: 'discord',
      platform_id: `discord:${id}`,
    }));
    mockGetAgentGroup.mockImplementation(async (id: string) => ({ id, name: id.toUpperCase() }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('prunes sibling channels but keeps the origin channel and agent grants', async () => {
    mockGetSession.mockResolvedValue({ id: 's1', messaging_group_id: ORIGIN_MG });

    await writeDestinations('g1', 's1');

    expect(projectedNames().sort()).toEqual(['helper-child', 'tonys-thoughts']);
  });

  it('fails open (keeps every channel) when the session has no channel origin', async () => {
    mockGetSession.mockResolvedValue({ id: 's1', messaging_group_id: null });

    await writeDestinations('g1', 's1');

    expect(projectedNames().sort()).toEqual(['helper-child', 'mtg', 'tonys-thoughts']);
  });

  it('fails open when the session row is missing entirely', async () => {
    mockGetSession.mockResolvedValue(undefined);

    await writeDestinations('g1', 's1');

    expect(projectedNames().sort()).toEqual(['helper-child', 'mtg', 'tonys-thoughts']);
  });

  it('fails open, with a warning, when the origin channel has no destination row', async () => {
    mockGetSession.mockResolvedValue({ id: 's1', messaging_group_id: 'mg-orphan' });

    await writeDestinations('g1', 's1');

    expect(projectedNames().sort()).toEqual(['helper-child', 'mtg', 'tonys-thoughts']);
    expect(mockWarn).toHaveBeenCalledTimes(1);
  });

  it('leaves a single-wiring group untouched', async () => {
    mockGetDestinations.mockResolvedValue([CENTRAL_ROWS[0], CENTRAL_ROWS[2]]);
    mockGetSession.mockResolvedValue({ id: 's1', messaging_group_id: ORIGIN_MG });

    await writeDestinations('g1', 's1');

    expect(projectedNames().sort()).toEqual(['helper-child', 'tonys-thoughts']);
  });
});
