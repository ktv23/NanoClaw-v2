/**
 * Tests for the interim "still working" note (./nudge.ts).
 *
 * The decision is tested as a pure function. `checkSessions` is then run
 * against the real central database and a real session mailbox, with only the
 * channel adapter faked: that is the leg that goes red if a core API this
 * module consumes (running-session listing, mailbox claims and history,
 * messaging-group lookup) changes shape.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-interim-nudge',
    GROUPS_DIR: '/tmp/nanoclaw-test-interim-nudge/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-interim-nudge';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { updateSession } from '../../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import type { MailboxHistoryMessage } from '../../mailbox/types.js';
import { resolveSession } from '../../session-manager.js';
import {
  checkSessions,
  CLAIM_WINDOW_MS,
  INTERIM_FEEDBACK_MS,
  INTERIM_MAX_AGE_MS,
  INTERIM_TEXT,
  newestUserChat,
  shouldNudge,
  stopInterimFeedback,
  type TurnView,
} from './nudge.js';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function chat(msAgo: number, extra: Record<string, unknown> = {}): MailboxHistoryMessage {
  return { timestamp: iso(msAgo), kind: 'chat-sdk', content: JSON.stringify({ sender: 'Kin', text: 'q', ...extra }) };
}
function reply(msAgo: number): MailboxHistoryMessage {
  return { timestamp: iso(msAgo), kind: 'chat', content: JSON.stringify({ text: 'a' }) };
}

/** A view with one turn open, its claim taken `claimedMsAgo` ago (null: no open turn). */
function view(
  inbound: MailboxHistoryMessage[],
  outbound: MailboxHistoryMessage[] = [],
  claimedMsAgo: number | null = INTERIM_FEEDBACK_MS + 500,
): TurnView {
  return { openClaimTimes: claimedMsAgo === null ? [] : [iso(claimedMsAgo)], inbound, outbound };
}

describe('shouldNudge', () => {
  it('nudges once a message has waited past the threshold with its turn still open', () => {
    const decision = shouldNudge(view([chat(INTERIM_FEEDBACK_MS + 1000)]), undefined, NOW);
    expect(decision.nudge).toBe(true);
    expect(decision.turnKey).toBe(iso(INTERIM_FEEDBACK_MS + 1000));
  });

  it('waits until the threshold', () => {
    expect(shouldNudge(view([chat(5_000)], [], 4_000), undefined, NOW).nudge).toBe(false);
  });

  it('does not nudge when no turn is open', () => {
    expect(shouldNudge(view([chat(60_000)], [], null), undefined, NOW).nudge).toBe(false);
  });

  it('does not nudge twice for the same message', () => {
    expect(shouldNudge(view([chat(60_000)], [], 59_000), iso(60_000), NOW).nudge).toBe(false);
  });

  it('does not nudge when the agent has already said something this turn', () => {
    expect(shouldNudge(view([chat(60_000)], [reply(20_000)], 59_000), undefined, NOW).nudge).toBe(false);
  });

  it('ignores a reply that predates the message', () => {
    expect(shouldNudge(view([chat(60_000)], [reply(90_000)], 59_000), undefined, NOW).nudge).toBe(true);
  });

  it('does not nudge for an old unanswered message while some later turn is open', () => {
    expect(shouldNudge(view([chat(INTERIM_MAX_AGE_MS + 1000)], [], 10_000), undefined, NOW).nudge).toBe(false);
  });

  it('does not nudge when the open turn was claimed long after the message: it is some other turn', () => {
    // Asked five minutes ago and left unanswered; a notice woke the session 40 seconds ago.
    const fiveMinutes = 5 * 60_000;
    expect(fiveMinutes - 40_000).toBeGreaterThan(CLAIM_WINDOW_MS);
    expect(shouldNudge(view([chat(fiveMinutes)], [], 40_000), undefined, NOW).nudge).toBe(false);
  });

  it('allows for a cold start between the message and its claim', () => {
    expect(shouldNudge(view([chat(60_000)], [], 40_000), undefined, NOW).nudge).toBe(true);
  });

  it('does not nudge for a scheduled task turn', () => {
    const task: MailboxHistoryMessage = { timestamp: iso(60_000), kind: 'task', content: '{"prompt":"daily"}' };
    expect(shouldNudge(view([task], [], 59_000), undefined, NOW).nudge).toBe(false);
  });
});

describe('newestUserChat', () => {
  it('skips chat rows the host wrote to the agent itself', () => {
    const system = chat(1_000, { sender: 'system', senderId: 'system' });
    const person = chat(50_000);
    expect(newestUserChat([system, person])).toBe(person);
  });
});

describe('checkSessions (real database and session mailbox)', () => {
  let delivered: Array<{
    channelType: string;
    platformId: string;
    threadId: string | null;
    content: string;
    instance?: string;
  }>;
  let adapter: ChannelDeliveryAdapter;
  let sessionId: string;

  function insertInbound(id: string, kind: string, timestamp: string, content: object): void {
    const db = new Database(inboundDbPath('ag-1', sessionId));
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_in), ?, ?, 'pending', 1, 'telegram:123', 'telegram', ?)`,
    ).run(id, kind, timestamp, JSON.stringify(content));
    db.close();
  }

  function claim(messageId: string, status: 'processing' | 'completed' = 'processing', takenMsAgo = 44_000): void {
    const db = new Database(outboundDbPath('ag-1', sessionId));
    db.prepare(
      `INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET status = excluded.status`,
    ).run(messageId, status, iso(takenMsAgo));
    db.close();
  }

  function insertOutbound(id: string, timestamp: string): void {
    const db = new Database(outboundDbPath('ag-1', sessionId));
    db.prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages_out), ?, 'chat', 'telegram:123', 'telegram', ?)`,
    ).run(id, timestamp, JSON.stringify({ text: 'partial answer' }));
    db.close();
  }

  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await runMigrations(await initTestDb());
    await createAgentGroup({ id: 'ag-1', name: 'Nova', folder: 'nova', agent_provider: null, created_at: iso(0) });
    await createMessagingGroup({
      id: 'mg-1',
      channel_type: 'telegram',
      platform_id: 'telegram:123',
      name: 'Kevin',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: iso(0),
    });
    const { session } = await resolveSession('ag-1', 'mg-1', null, 'shared');
    sessionId = session.id;
    await updateSession(sessionId, { container_status: 'running' });

    delivered = [];
    adapter = {
      async deliver(channelType, platformId, threadId, _kind, content, _files, instance) {
        delivered.push({ channelType, platformId, threadId, content, instance });
        return undefined;
      },
    };
  });

  afterEach(async () => {
    stopInterimFeedback();
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('sends one note to the chat a slow turn came from', async () => {
    insertInbound('m1', 'chat-sdk', iso(45_000), { sender: 'Kevin', text: 'summarise my inbox' });
    claim('m1');

    await checkSessions(adapter, NOW);
    await checkSessions(adapter, NOW + 5_000);

    expect(delivered).toHaveLength(1);
    expect(delivered[0].channelType).toBe('telegram');
    expect(delivered[0].platformId).toBe('telegram:123');
    expect(delivered[0].threadId).toBeNull();
    expect(JSON.parse(delivered[0].content)).toEqual({ text: INTERIM_TEXT });
  });

  it('sends nothing once the turn has finished', async () => {
    insertInbound('m1', 'chat-sdk', iso(45_000), { sender: 'Kevin', text: 'summarise my inbox' });
    claim('m1', 'completed');

    await checkSessions(adapter, NOW);

    expect(delivered).toHaveLength(0);
  });

  it('sends nothing when the agent has already replied mid-turn', async () => {
    insertInbound('m1', 'chat-sdk', iso(45_000), { sender: 'Kevin', text: 'summarise my inbox' });
    claim('m1');
    insertOutbound('out-1', iso(10_000));

    await checkSessions(adapter, NOW);

    expect(delivered).toHaveLength(0);
  });

  it('skips a session whose container is not running', async () => {
    insertInbound('m1', 'chat-sdk', iso(45_000), { sender: 'Kevin', text: 'summarise my inbox' });
    claim('m1');
    await updateSession(sessionId, { container_status: 'stopped' });

    await checkSessions(adapter, NOW);

    expect(delivered).toHaveLength(0);
  });

  it('makes one attempt per message, so a failing channel is not hammered', async () => {
    insertInbound('m1', 'chat-sdk', iso(45_000), { sender: 'Kevin', text: 'summarise my inbox' });
    claim('m1');
    let calls = 0;
    const failing: ChannelDeliveryAdapter = {
      async deliver() {
        calls++;
        throw new Error('rate limited');
      },
    };

    await checkSessions(failing, NOW);
    await checkSessions(failing, NOW + 5_000);
    await checkSessions(failing, NOW + 10_000);

    expect(calls).toBe(1);
  });

  it('sends nothing for an agent-shared session, whose bound chat may not be the one that asked', async () => {
    await createMessagingGroupAgent({
      id: 'mga-1',
      messaging_group_id: 'mg-1',
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'agent-shared',
      priority: 0,
      created_at: iso(0),
    });
    insertInbound('m1', 'chat-sdk', iso(45_000), { sender: 'Kevin', text: 'summarise my inbox' });
    claim('m1');

    await checkSessions(adapter, NOW);

    expect(delivered).toHaveLength(0);
  });

  it('sends nothing when the only open turn started long after the message', async () => {
    insertInbound('m1', 'chat-sdk', iso(5 * 60_000), { sender: 'Kevin', text: 'thanks, no reply needed' });
    insertInbound('n1', 'chat', iso(40_000), { sender: 'system', senderId: 'system', text: 'approved' });
    claim('n1', 'processing', 40_000);

    await checkSessions(adapter, NOW);

    expect(delivered).toHaveLength(0);
  });
});
