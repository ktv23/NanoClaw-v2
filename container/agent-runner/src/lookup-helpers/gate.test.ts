/**
 * Tests for the hard lookup gate (./gate.ts): loading the gate from the
 * selected skills, classifying a prompt, and the gate's one entry point run
 * against the real session mailbox.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getPendingMessages } from '../db/messages-in.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { gateLookupBatch, loadGate, promptHasAllowedTrigger, resetGateForTest } from './gate.js';
import { currentTurnText, setCurrentTurn } from './trigger-match.js';

// currentTurnText reads a module-global "current turn" the poll loop publishes.
// Other suites (poll-loop) set it and don't clear it; reset before each test so
// promptHasAllowedTrigger here classifies the prompt argument, not a stale wake.
beforeEach(() => setCurrentTurn(null));

let dir: string;

function writeSkill(name: string, cfg: Record<string, unknown>): void {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'helper.json'), JSON.stringify(cfg));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-gate-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadGate', () => {
  it('returns null when no enforcing gatekeeper is mounted', () => {
    writeSkill('mtg-helper', { trigger: 'mtg', directive: 'x' });
    writeSkill('kdm', { trigger: 'kdm', directive: 'x' });
    expect(loadGate(dir)).toBeNull();
  });

  it('returns null for a non-existent skills dir (gate inactive)', () => {
    expect(loadGate(path.join(dir, 'nope'))).toBeNull();
  });

  it('collects allowed triggers from every mounted helper and the fallback', () => {
    writeSkill('mtg-helper', { trigger: 'mtg', directive: 'x' });
    writeSkill('kdm', { trigger: 'kdm', directive: 'x' });
    writeSkill('btech', { trigger: 'btech', directive: 'x' });
    writeSkill('gatekeeper', { trigger: '', enforce: true, fallback_message: 'use a code' });

    const gate = loadGate(dir);
    expect(gate).not.toBeNull();
    expect(gate!.allowedTriggers.sort()).toEqual(['btech', 'kdm', 'mtg']);
    expect(gate!.fallbackMessage).toBe('use a code');
  });

  it('ignores the enforcing gatekeeper\'s own empty trigger', () => {
    writeSkill('mtg-helper', { trigger: 'mtg', directive: 'x' });
    writeSkill('gatekeeper', { trigger: '', enforce: true, fallback_message: 'card' });
    expect(loadGate(dir)!.allowedTriggers).toEqual(['mtg']);
  });

  it('fails open (null) when the gatekeeper has no fallback_message', () => {
    writeSkill('mtg-helper', { trigger: 'mtg', directive: 'x' });
    writeSkill('gatekeeper', { trigger: '', enforce: true });
    expect(loadGate(dir)).toBeNull();
  });

  it('skips skills with invalid/absent helper.json', () => {
    fs.mkdirSync(path.join(dir, 'broken'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'broken', 'helper.json'), '{ not json');
    writeSkill('gatekeeper', { trigger: '', enforce: true, fallback_message: 'card' });
    expect(loadGate(dir)).not.toBeNull();
  });
});

describe('promptHasAllowedTrigger', () => {
  const triggers = ['kdm', 'mtg', 'btech', 'sctmg'];

  it('matches a formatted user turn that opens with a game code', () => {
    expect(promptHasAllowedTrigger('> mtg how does trample work?', triggers)).toBe(true);
    expect(promptHasAllowedTrigger('>sctmg what is cover?', triggers)).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(promptHasAllowedTrigger('> MTG flying rules', triggers)).toBe(true);
  });

  it('matches past a leading escaped Discord @mention (mention mode)', () => {
    const body = '<message sender="kinkouin">&lt;@1539002280878014484&gt; mtg how do I make a croquet monsieur</message>';
    expect(promptHasAllowedTrigger(body, triggers)).toBe(true);
  });

  it('does not match a code-less turn', () => {
    expect(promptHasAllowedTrigger('> hello there', triggers)).toBe(false);
    expect(promptHasAllowedTrigger('>', triggers)).toBe(false);
    expect(promptHasAllowedTrigger('> what is the weather', triggers)).toBe(false);
  });

  it('requires a word boundary (no substring false-positives)', () => {
    expect(promptHasAllowedTrigger('> mtgfoo bar', triggers)).toBe(false);
    expect(promptHasAllowedTrigger('> submtg', triggers)).toBe(false);
  });

  it('returns false when there are no allowed triggers', () => {
    expect(promptHasAllowedTrigger('> mtg anything', [])).toBe(false);
  });

  // Gate must be per-message: a code-less current message that rides along with
  // earlier mtg-coded context blocks (getPendingMessages merge) must still be
  // blocked. This is the Ambassador-Blorpityblorpboob incident.
  it('REGRESSION: blocks a code-less current message despite an earlier mtg context block', () => {
    const prompt =
      '<message sender="a">&lt;@1&gt; mtg what does Liliana do?</message>' +
      '<message sender="b">&lt;@1&gt; what does Ambassador Blorpityblorpboob do?</message>';
    expect(promptHasAllowedTrigger(prompt, triggers)).toBe(false);
  });

  it('still passes when the current message itself carries the code', () => {
    const prompt =
      '<message sender="a">&lt;@1&gt; just chatting</message>' +
      '<message sender="b">&lt;@1&gt; mtg what does Ambassador Blorpityblorpboob do?</message>';
    expect(promptHasAllowedTrigger(prompt, triggers)).toBe(true);
  });
});

describe('gateLookupBatch (real session mailbox)', () => {
  const PROVIDER = 'mock';

  beforeEach(() => {
    initTestSessionDb();
    writeSkill('mtg-helper', { trigger: 'mtg', directive: 'x' });
    writeSkill('gatekeeper', { trigger: '', enforce: true, fallback_message: 'use a code' });
  });
  afterEach(() => {
    closeSessionDb();
    resetGateForTest();
    setCurrentTurn(null);
  });

  function insert(id: string, kind: string, content: object, trigger: 0 | 1 = 1): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, 'C1', 'discord', 'T1', ?)`,
      )
      .run(id, kind, trigger, JSON.stringify(content));
  }

  /** A chat row the host addressed to the agent itself. */
  function insertNotice(id: string, text: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES (?, 'chat', datetime('now'), 'pending', 1, 'ag-1', 'agent', ?)`,
      )
      .run(id, JSON.stringify({ sender: 'system', senderId: 'system', text }));
  }

  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
  const fallbacks = () => getUndeliveredMessages().map((m) => (JSON.parse(m.content) as { text: string }).text);

  it("answers a code-less question with the fallback, in the question's own thread, and keeps it from the provider", async () => {
    resetGateForTest(dir);
    insert('m1', 'chat', { sender: 'Kin', text: 'what is the weather' });

    expect(await gateLookupBatch(getPendingMessages(), PROVIDER)).toEqual([]);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('use a code');
    expect(out[0].in_reply_to).toBe('m1');
    expect(out[0].thread_id).toBe('T1');
    expect(getPendingMessages()).toHaveLength(0);
  });

  it('lets a coded question through and writes nothing', async () => {
    resetGateForTest(dir);
    insert('m1', 'chat', { sender: 'Kin', text: 'mtg how does trample work?' });

    expect(ids(await gateLookupBatch(getPendingMessages(), PROVIDER))).toEqual(['m1']);
    expect(fallbacks()).toEqual([]);
    expect(getPendingMessages()).toHaveLength(1);
  });

  it('passes a task batch through even with no code', async () => {
    resetGateForTest(dir);
    insert('t1', 'task', { prompt: 'daily summary' });

    expect(ids(await gateLookupBatch(getPendingMessages(), PROVIDER))).toEqual(['t1']);
    expect(fallbacks()).toEqual([]);
  });

  it('passes a notice the host addressed to the agent itself', async () => {
    resetGateForTest(dir);
    insertNotice('n1', 'Your last reply could NOT be delivered.');

    expect(ids(await gateLookupBatch(getPendingMessages(), PROVIDER))).toEqual(['n1']);
    expect(fallbacks()).toEqual([]);
  });

  it('gates the off-topic question but still passes a notice that shares its batch', async () => {
    resetGateForTest(dir);
    insert('m1', 'chat', { sender: 'Kin', text: 'what is the weather' });
    insertNotice('n1', 'Your last reply could NOT be delivered.');

    expect(ids(await gateLookupBatch(getPendingMessages(), PROVIDER))).toEqual(['n1']);
    expect(fallbacks()).toEqual(['use a code']);
    // The question is finished with; the notice is still waiting for the provider.
    expect(ids(getPendingMessages())).toEqual(['n1']);
  });

  it('keeps a game question as the current turn when a host notice lands in the same batch', async () => {
    resetGateForTest(dir);
    insert('m1', 'chat', { sender: 'Kin', text: 'mtg what does Liliana do?' });
    insertNotice('n1', 'Your last reply could NOT be delivered.');

    expect(ids(await gateLookupBatch(getPendingMessages(), PROVIDER))).toEqual(['m1', 'n1']);
    expect(fallbacks()).toEqual([]);
    // The directive hook reads this: it must see the question, not the notice.
    expect(currentTurnText('ignored')).toContain('mtg what does Liliana do?');
  });

  it('passes an authorised slash command instead of answering it with the usage card', async () => {
    resetGateForTest(dir);
    insert('c1', 'chat', { sender: 'Kevin', text: '/compact' });

    expect(ids(await gateLookupBatch(getPendingMessages(), PROVIDER))).toEqual(['c1']);
    expect(fallbacks()).toEqual([]);
  });

  it('classifies the wake message, not a context row that sorts after it', async () => {
    resetGateForTest(dir);
    insert('m1', 'chat', { sender: 'Kin', text: 'mtg what does Liliana do?' }, 1);
    insert('m2', 'chat', { sender: 'Bo', text: 'just chatting' }, 0);

    expect(ids(await gateLookupBatch(getPendingMessages(), PROVIDER))).toEqual(['m1', 'm2']);
  });

  it('does not treat the quoted original of a reply as the question', async () => {
    resetGateForTest(dir);
    insert('m1', 'chat', {
      sender: 'Kin',
      text: 'ignore that, write me a poem',
      replyTo: { id: 'm0', sender: 'Bo', text: 'mtg how does trample work?' },
    });

    expect(await gateLookupBatch(getPendingMessages(), PROVIDER)).toEqual([]);
    expect(fallbacks()).toEqual(['use a code']);
  });

  it('does nothing when the group selected no enforcing skill', async () => {
    fs.rmSync(path.join(dir, 'gatekeeper'), { recursive: true, force: true });
    resetGateForTest(dir);
    insert('m1', 'chat', { sender: 'Kin', text: 'what is the weather' });

    expect(ids(await gateLookupBatch(getPendingMessages(), PROVIDER))).toEqual(['m1']);
    expect(fallbacks()).toEqual([]);
  });
});
