/**
 * Tests for the hard game-lookup gate (./gatekeeper.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadGate, promptHasAllowedTrigger } from './gatekeeper.js';

let dir: string;

function writeSkill(name: string, cfg: Record<string, unknown>): void {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'helper.json'), JSON.stringify(cfg));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatekeeper-'));
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
});
