/**
 * Integration-point test: the poll loop consults the lookup gate before a
 * batch reaches the provider — for the initial batch and for a follow-up pushed
 * into a warm query. Drives the real `runPollLoop`; both tests go red if the
 * matching `gateLookupTurn` call is removed from poll-loop.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { runPollLoop } from '../poll-loop.js';
import { MockProvider } from '../providers/mock.js';
import { resetGateForTest } from './gate.js';
import { setCurrentTurn } from './trigger-match.js';

const CONTRACT = { textDelivery: 'mid-turn-complete', commands: { formatting: 'xml' } } as const;
const FALLBACK = 'Start your message with a game code.';

let dir: string;

function writeSkill(name: string, cfg: Record<string, unknown>): void {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'helper.json'), JSON.stringify(cfg));
}

function insertMessage(id: string, text: string, threadId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'C123', 'discord', ?, ?)`,
    )
    .run(id, threadId, JSON.stringify({ sender: 'Kin', text }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond: () => boolean, ms: number): Promise<void> {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function texts(): string[] {
  return getUndeliveredMessages().map((m) => (JSON.parse(m.content) as { text: string }).text);
}

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('table', 'Table', 'channel', 'discord', 'C123', NULL)`,
    )
    .run();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-wiring-'));
  writeSkill('mtg-helper', { trigger: 'mtg', directive: 'MTG RULES' });
  writeSkill('gatekeeper', { trigger: '', enforce: true, fallback_message: FALLBACK });
  resetGateForTest(dir);
});
afterEach(() => {
  closeSessionDb();
  resetGateForTest();
  setCurrentTurn(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('lookup gate wiring in the poll loop', () => {
  it('initial batch: a code-less turn gets the fallback and the provider is never asked', async () => {
    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return '<message to="table">model answer</message>';
    });
    insertMessage('m-a', 'what is the weather', 'thread-A');

    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/tmp',
      signal: controller.signal,
    });
    await waitFor(() => getUndeliveredMessages().length >= 1, 3000);
    await sleep(300);
    controller.abort();
    await loop.catch(() => {});

    expect(texts()).toEqual([FALLBACK]);
    expect(getUndeliveredMessages()[0].thread_id).toBe('thread-A');
    expect(prompts).toHaveLength(0);
  });

  it('follow-up: a code-less message pushed into a warm query gets the fallback, not the model', async () => {
    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return '<message to="table">model answer</message>';
    });
    insertMessage('m-a', 'mtg how does trample work?', 'thread-A');

    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/tmp',
      signal: controller.signal,
    });
    // Turn 1 carries a code: it reaches the provider and the model answers.
    await waitFor(() => getUndeliveredMessages().length >= 1, 3000);
    await sleep(300);
    expect(prompts).toHaveLength(1);

    // Turn 2 arrives while the query is still open, with no code.
    insertMessage('m-b', 'and what is the weather?', 'thread-B');
    await waitFor(() => getUndeliveredMessages().length >= 2, 5000);
    await sleep(300);
    controller.abort();
    await loop.catch(() => {});

    expect(texts()).toEqual(['model answer', FALLBACK]);
    expect(getUndeliveredMessages()[1].thread_id).toBe('thread-B');
    expect(prompts).toHaveLength(1);
  });

  it('a host notice sharing a batch with an off-topic question still reaches the provider, alone', async () => {
    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return '<message to="table">model answer</message>';
    });
    insertMessage('m-a', 'what is the weather', 'thread-A');
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('n-1', 'chat', datetime('now'), 'pending', 'ag-1', 'agent', ?)`,
      )
      .run(JSON.stringify({ sender: 'system', senderId: 'system', text: 'Your last reply could NOT be delivered.' }));

    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/tmp',
      signal: controller.signal,
    });
    await waitFor(() => getUndeliveredMessages().length >= 2, 4000);
    await sleep(300);
    controller.abort();
    await loop.catch(() => {});

    expect(texts().sort()).toEqual([FALLBACK, 'model answer'].sort());
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('could NOT be delivered');
    expect(prompts[0]).not.toContain('what is the weather');
  });

  it('with no enforcing skill selected, a code-less turn reaches the provider as usual', async () => {
    fs.rmSync(path.join(dir, 'gatekeeper'), { recursive: true, force: true });
    resetGateForTest(dir);
    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return '<message to="table">model answer</message>';
    });
    insertMessage('m-a', 'what is the weather', 'thread-A');

    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerContract: CONTRACT,
      providerName: 'mock',
      cwd: '/tmp',
      signal: controller.signal,
    });
    await waitFor(() => getUndeliveredMessages().length >= 1, 3000);
    await sleep(300);
    controller.abort();
    await loop.catch(() => {});

    expect(texts()).toEqual(['model answer']);
    expect(prompts).toHaveLength(1);
  });
});
