import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { initTestSessionDb, closeSessionDb, getInboundDb, setHeartbeatPathForTest } from './db/connection.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

// The host's interim "still working" nudge only fires when the container's
// heartbeat is fresh (<15s). The heartbeat is otherwise touched only on stream
// events, so a long no-event stretch mid-turn (SDK compaction, a slow single
// tool call) would starve it and the nudge would arrive late or not at all.
// processQuery therefore touches the heartbeat on the active-turn poller.
//
// This must be scoped: fed WHILE a post-init turn streams (so the nudge works),
// but NOT while idle between turns (so the host's 30-min idle ceiling can still
// recycle an idle container). These tests pin both halves via a real temp
// heartbeat file whose mtime the stub generator samples at the turn boundaries.

const CHAT_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
};

let hbPath: string;
let prevHbPath: string;

beforeEach(() => {
  initTestSessionDb();
  hbPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nc-hb-')), '.heartbeat');
  fs.writeFileSync(hbPath, '');
  prevHbPath = setHeartbeatPathForTest(hbPath);
});

afterEach(() => {
  setHeartbeatPathForTest(prevHbPath);
  closeSessionDb();
});

function makeStubQuery(events: AsyncGenerator<ProviderEvent>): AgentQuery {
  return { push: () => {}, end: () => {}, events, abort: () => {} };
}

function seedDest(): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-main','discord-main','channel','discord','chan-1',NULL)`,
    )
    .run();
}

function mtimeMs(): number {
  return fs.statSync(hbPath).mtimeMs;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('active-turn heartbeat keeps the interim nudge fed', () => {
  it('advances the heartbeat during a post-init no-event stretch, but not while idle after the result', async () => {
    seedDest();

    // Force the heartbeat mtime into the past so any touch is unambiguously newer.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(hbPath, past, past);

    let afterInit = 0;
    let afterTurnGap = 0;
    let baseAfterResult = 0;
    let afterIdleGap = 0;

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Sampled after the init event's own touch — so the gap comparison below
      // isolates the active-turn poller, not the init touch.
      afterInit = mtimeMs();
      // A long no-event stretch WHILE the turn streams: the active-turn poller
      // (500ms) must touch the heartbeat across it.
      await sleep(750);
      afterTurnGap = mtimeMs();
      // Empty result → no retry → turn goes idle.
      yield { type: 'result', text: '' };
      baseAfterResult = mtimeMs();
      // A long stretch WHILE idle: the heartbeat must NOT be touched now, so an
      // idle container still ages out under the host ceiling.
      await sleep(750);
      afterIdleGap = mtimeMs();
    }

    await processQuery(makeStubQuery(events()), CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    // Fed by the poller during the no-event stretch (strictly newer than the
    // init touch alone).
    expect(afterTurnGap).toBeGreaterThan(afterInit);
    // Not fed during idle: the mtime is unchanged from the turn-boundary sample.
    expect(afterIdleGap).toBe(baseAfterResult);
  });

  it('does NOT touch the heartbeat before the first init (a pre-init hang stays detectable)', async () => {
    seedDest();
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(hbPath, past, past);
    const start = mtimeMs();

    let afterPreInitGap = 0;

    async function* events(): AsyncGenerator<ProviderEvent> {
      // Simulate a resume/startup hang: a long stretch before any event.
      await sleep(750);
      afterPreInitGap = mtimeMs();
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: '' };
    }

    await processQuery(makeStubQuery(events()), CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    // Frozen through the pre-init stretch → host-sweep's kill-claim can still fire.
    expect(afterPreInitGap).toBe(start);
  });
});
