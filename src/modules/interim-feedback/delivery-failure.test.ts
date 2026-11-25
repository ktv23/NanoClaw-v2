/**
 * Integration-point tests for the delivery-failure notice.
 *
 * Drives the real `deliverSessionMessages` with a channel adapter that always
 * fails. The first test goes red if the `notifyDeliveryFailure` call is
 * removed from delivery.ts. The reset test loads the module only through the
 * real modules barrel, so it goes red if the barrel line is removed.
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
    DATA_DIR: '/tmp/nanoclaw-test-delivery-failure',
    GROUPS_DIR: '/tmp/nanoclaw-test-delivery-failure/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-failure';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { deliverSessionMessages, setDeliveryAdapter } from '../../delivery.js';
import { outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession, withMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
// The real barrel, and nothing from this module directly.
import '../index.js';

function now(): string {
  return new Date().toISOString();
}

function insertOutbound(sessionId: string, msgId: string, text: string): void {
  const db = new Database(outboundDbPath('ag-1', sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, datetime('now'), 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, JSON.stringify({ text }));
  db.close();
}

/** The notices the session has been sent: system chats the host wrote to the agent. */
async function notices(session: Session): Promise<string[]> {
  const history = await withMailboxSession('ag-1', session.id, (mailbox) => mailbox.getInboundHistory(20));
  return history
    .map((m) => JSON.parse(m.content) as { text?: string; sender?: string })
    .filter((c) => c.sender === 'system' && typeof c.text === 'string')
    .map((c) => c.text as string);
}

/** Run delivery until the row is given up on (three attempts). */
async function exhaust(session: Session): Promise<void> {
  for (let i = 0; i < 3; i++) await deliverSessionMessages(session);
  // The notice is written just after the row is marked failed.
  await vi.waitFor(async () => expect((await notices(session)).length).toBeGreaterThan(0));
}

let session: Session;

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({ id: 'ag-1', name: 'Nova', folder: 'nova', agent_provider: null, created_at: now() });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Kevin',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  session = (await resolveSession('ag-1', 'mg-1', null, 'shared')).session;
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('delivery-failure notice', () => {
  it('tells the session when a reply is given up on, with the reason and the start of the text', async () => {
    insertOutbound(session.id, 'out-1', 'See https://example.com/a_(b) for the rules');
    setDeliveryAdapter({
      async deliver() {
        throw new Error("can't parse entities: Can't find end of a URL");
      },
    });

    await exhaust(session);

    const sent = await notices(session);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('could NOT be delivered');
    expect(sent[0]).toContain("can't parse entities");
    expect(sent[0]).toContain('See https://example.com/a_(b) for the rules');
  });

  it('sends nothing while a failing reply is still being retried', async () => {
    insertOutbound(session.id, 'out-1', 'hello');
    setDeliveryAdapter({
      async deliver() {
        throw new Error('network timeout');
      },
    });

    await deliverSessionMessages(session);
    await deliverSessionMessages(session);

    expect(await notices(session)).toHaveLength(0);
  });

  it('stops after two notices in a row, and starts again after a reply is delivered', async () => {
    let failing = true;
    setDeliveryAdapter({
      async deliver() {
        if (failing) throw new Error('network timeout');
        return 'platform-1';
      },
    });

    insertOutbound(session.id, 'out-1', 'first');
    await exhaust(session);
    insertOutbound(session.id, 'out-2', 'second');
    for (let i = 0; i < 3; i++) await deliverSessionMessages(session);
    await vi.waitFor(async () => expect(await notices(session)).toHaveLength(2));

    // A third failure in a row is not announced: the loop guard holds.
    insertOutbound(session.id, 'out-3', 'third');
    for (let i = 0; i < 3; i++) await deliverSessionMessages(session);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(await notices(session)).toHaveLength(2);

    // A delivered reply resets the count (registered through the modules barrel).
    failing = false;
    insertOutbound(session.id, 'out-4', 'fourth');
    await deliverSessionMessages(session);
    failing = true;
    insertOutbound(session.id, 'out-5', 'fifth');
    for (let i = 0; i < 3; i++) await deliverSessionMessages(session);
    await vi.waitFor(async () => expect(await notices(session)).toHaveLength(3));
  });
});
