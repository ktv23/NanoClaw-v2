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

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { updateSession } from '../../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import type { MailboxHistoryMessage } from '../../mailbox/types.js';
import { resolveSession } from '../../session-manager.js';
import {
  checkSessions,
  INTERIM_FEEDBACK_MS,
  INTERIM_MAX_AGE_MS,
  INTERIM_TEXT,
  newestUserChat,
  shouldNudge,
  stopInterimFeedback,
} from './nudge.js';

const NOW = Date.parse('2026-11-24T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function chat(msAgo: number, extra: Record<string, unknown> = {}): MailboxHistoryMessage {
  return { timestamp: iso(msAgo), kind: 'chat-sdk', content: JSON.stringify({ sender: 'Kin', text: 'q', ...extra }) };
}
function reply(msAgo: number): MailboxHistoryMessage {
  return { timestamp: iso(msAgo), kind: 'chat', content: JSON.stringify({ text: 'a' }) };
}

describe('shouldNudge', () => {
  it('nudges once a message has waited past the threshold with a turn still open', () => {
    const decision = shouldNudge(
      { openClaims: 1, inbound: [chat(INTERIM_FEEDBACK_MS + 1000)], outbound: [] },
      undefined,
      NOW,
    );
    expect(decision.nudge).toBe(true);
    expect(decision.turnKey).toBe(iso(INTERIM_FEEDBACK_MS + 1000));
  });

  it('waits until the threshold', () => {
    expect(shouldNudge({ openClaims: 1, inbound: [chat(5_000)], outbound: [] }, undefined, NOW).nudge).toBe(false);
  });

  it('does not nudge when no turn is open', () => {
    expect(shouldNudge({ openClaims: 0, inbound: [chat(60_000)], outbound: [] }, undefined, NOW).nudge).toBe(false);
  });

  it('does not nudge twice for the same message', () => {
    const view = { openClaims: 1, inbound: [chat(60_000)], outbound: [] };
    expect(shouldNudge(view, iso(60_000), NOW).nudge).toBe(false);
  });

  it('does not nudge when the agent has already said something this turn', () => {
    const view = { openClaims: 1, inbound: [chat(60_000)], outbound: [reply(20_000)] };
    expect(shouldNudge(view, undefined, NOW).nudge).toBe(false);
  });

  it('ignores a reply that predates the message', () => {
    const view = { openClaims: 1, inbound: [chat(60_000)], outbound: [reply(90_000)] };
    expect(shouldNudge(view, undefined, NOW).nudge).toBe(true);
  });

  it('does not nudge for an old unanswered message while some later turn is open', () => {
    const view = { openClaims: 1, inbound: [chat(INTERIM_MAX_AGE_MS + 1000)], outbound: [] };
    expect(shouldNudge(view, undefined, NOW).nudge).toBe(false);
  });

  it('does not nudge for a scheduled task turn', () => {
    const task: MailboxHistoryMessage = { timestamp: iso(60_000), kind: 'task', content: '{"prompt":"daily"}' };
    expect(shouldNudge({ openClaims: 1, inbound: [task], outbound: [] }, undefined, NOW).nudge).toBe(false);
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

  function claim(messageId: string, status: 'processing' | 'completed' = 'processing'): void {
    const db = new Database(outboundDbPath('ag-1', sessionId));
    db.prepare(
      `INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET status = excluded.status`,
    ).run(messageId, status, new Date().toISOString());
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

  it('tries again on a later pass when the send fails', async () => {
    insertInbound('m1', 'chat-sdk', iso(45_000), { sender: 'Kevin', text: 'summarise my inbox' });
    claim('m1');
    let calls = 0;
    const flaky: ChannelDeliveryAdapter = {
      async deliver() {
        calls++;
        if (calls === 1) throw new Error('network down');
        return undefined;
      },
    };

    await checkSessions(flaky, NOW);
    await checkSessions(flaky, NOW + 5_000);
    await checkSessions(flaky, NOW + 10_000);

    expect(calls).toBe(2);
  });
});
