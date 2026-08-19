/**
 * Tests for the destination projection's ORIGIN SCOPING.
 *
 * A channel destination is auto-created per wiring, so a shared agent group
 * wired to several channels lists them all. Projecting all of them into a
 * chat session let the agent cross-post to a sibling channel (an `mtg`
 * question in the #tonys-thoughts→ti4 thread got answered into #mtg). The
 * projection now prunes channel destinations to the session's origin while
 * always keeping explicitly-granted agent destinations.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DestinationRow } from '../../db/session-db.js';

const { mockGetSession, mockGetDestinations, mockGetMessagingGroup, mockGetAgentGroup, mockReplaceDestinations } =
  vi.hoisted(() => ({
    mockGetSession: vi.fn(),
    mockGetDestinations: vi.fn(),
    mockGetMessagingGroup: vi.fn(),
    mockGetAgentGroup: vi.fn(),
    mockReplaceDestinations: vi.fn(),
  }));

vi.mock('fs', () => ({ default: { existsSync: () => true } }));
vi.mock('../../db/sessions.js', () => ({ getSession: (...a: unknown[]) => mockGetSession(...a) }));
vi.mock('./db/agent-destinations.js', () => ({ getDestinations: (...a: unknown[]) => mockGetDestinations(...a) }));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: (...a: unknown[]) => mockGetMessagingGroup(...a),
}));
vi.mock('../../db/agent-groups.js', () => ({ getAgentGroup: (...a: unknown[]) => mockGetAgentGroup(...a) }));
vi.mock('../../db/session-db.js', () => ({ replaceDestinations: (...a: unknown[]) => mockReplaceDestinations(...a) }));
vi.mock('../../log.js', () => ({ log: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('../../session-manager.js', () => ({
  inboundDbPath: () => '/tmp/inbound.db',
  openInboundDb: () => ({ close: vi.fn() }),
}));

// Import after mocks are registered.
const { writeDestinations } = await import('./write-destinations.js');

// Central agent_destinations rows: origin channel, a sibling channel from a
// second wiring of the same shared group, and an explicitly-granted agent.
const ORIGIN_MG = 'mg-tonys-thoughts';
const SIBLING_MG = 'mg-mtg';
const CENTRAL_ROWS = [
  { agent_group_id: 'g1', local_name: 'tonys-thoughts', target_type: 'channel', target_id: ORIGIN_MG, created_at: '1' },
  { agent_group_id: 'g1', local_name: 'mtg', target_type: 'channel', target_id: SIBLING_MG, created_at: '2' },
  { agent_group_id: 'g1', local_name: 'helper-child', target_type: 'agent', target_id: 'child-ag', created_at: '3' },
];

function projectedNames(): string[] {
  const rows = mockReplaceDestinations.mock.calls.at(-1)![1] as DestinationRow[];
  return rows.map((r) => r.name);
}

describe('writeDestinations origin scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetDestinations.mockReturnValue(CENTRAL_ROWS);
    mockGetMessagingGroup.mockImplementation((id: string) => ({
      id,
      name: id,
      channel_type: 'discord',
      platform_id: `discord:${id}`,
    }));
    mockGetAgentGroup.mockImplementation((id: string) => ({ id, name: id.toUpperCase() }));
  });
  afterEach(() => vi.restoreAllMocks());

  it('prunes sibling channels but keeps the origin channel and agent grants', () => {
    mockGetSession.mockReturnValue({ id: 's1', messaging_group_id: ORIGIN_MG });

    writeDestinations('g1', 's1');

    const names = projectedNames();
    expect(names).toContain('tonys-thoughts'); // origin channel kept
    expect(names).toContain('helper-child'); // explicit agent grant kept
    expect(names).not.toContain('mtg'); // sibling channel pruned
  });

  it('fails open (keeps every channel) when the session has no channel origin', () => {
    // Task / agent-to-agent sessions carry no messaging_group_id — pruning all
    // channels there would leave the agent unable to reach any channel.
    mockGetSession.mockReturnValue({ id: 's1', messaging_group_id: null });

    writeDestinations('g1', 's1');

    const names = projectedNames();
    expect(names).toEqual(expect.arrayContaining(['tonys-thoughts', 'mtg', 'helper-child']));
  });

  it('fails open when the session row is missing entirely', () => {
    mockGetSession.mockReturnValue(undefined);

    writeDestinations('g1', 's1');

    expect(projectedNames()).toEqual(expect.arrayContaining(['tonys-thoughts', 'mtg', 'helper-child']));
  });

  it('fails open when the origin channel has no destination row (legacy wiring)', () => {
    // Origin resolves, but no channel destination targets it — scoping would
    // otherwise mute the agent, so keep every channel.
    mockGetSession.mockReturnValue({ id: 's1', messaging_group_id: 'mg-orphan' });

    writeDestinations('g1', 's1');

    expect(projectedNames()).toEqual(expect.arrayContaining(['tonys-thoughts', 'mtg', 'helper-child']));
  });
});
