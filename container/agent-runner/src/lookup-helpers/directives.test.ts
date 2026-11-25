/**
 * Tests for lookup-helper directives (./directives.ts): loading helper.json
 * files from the shared skills mount and choosing the directive for a prompt.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  directivesFor,
  loadHelperDirectives,
  lookupHelperPromptHook,
  resetHelperDirectivesForTest,
} from './directives.js';
import { setCurrentTurn } from './trigger-match.js';

let dir: string;

function writeSkill(name: string, cfg: Record<string, unknown>): void {
  const d = path.join(dir, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'helper.json'), JSON.stringify(cfg));
}

async function runHook(prompt: string): Promise<string | undefined> {
  const out = (await lookupHelperPromptHook(
    { hook_event_name: 'UserPromptSubmit', prompt } as never,
    undefined,
    { signal: new AbortController().signal },
  )) as { hookSpecificOutput?: { additionalContext?: string } };
  return out.hookSpecificOutput?.additionalContext;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-directives-'));
  setCurrentTurn(null);
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  resetHelperDirectivesForTest();
  setCurrentTurn(null);
});

describe('loadHelperDirectives', () => {
  it('loads a directive per skill that ships one', () => {
    writeSkill('kdm', { trigger: 'kdm', directive: 'KDM RULES' });
    writeSkill('mtg-helper', { trigger: 'mtg', directive: 'MTG RULES' });
    expect(
      loadHelperDirectives(dir)
        .map((h) => h.directive)
        .sort(),
    ).toEqual(['KDM RULES', 'MTG RULES']);
  });

  it('skips a helper.json with no directive (a gatekeeper) and a skill with none at all', () => {
    writeSkill('gatekeeper', { trigger: '', enforce: true, fallback_message: 'use a code' });
    fs.mkdirSync(path.join(dir, 'plain-skill'));
    expect(loadHelperDirectives(dir)).toEqual([]);
  });

  it('skips an invalid helper.json without dropping the others', () => {
    fs.mkdirSync(path.join(dir, 'broken'));
    fs.writeFileSync(path.join(dir, 'broken', 'helper.json'), '{ not json');
    writeSkill('kdm', { trigger: 'kdm', directive: 'KDM RULES' });
    expect(loadHelperDirectives(dir)).toHaveLength(1);
  });

  it('returns nothing for a missing skills dir', () => {
    expect(loadHelperDirectives(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('directivesFor', () => {
  beforeEach(() => {
    writeSkill('kdm', { trigger: 'kdm', directive: 'KDM RULES' });
    writeSkill('mtg-helper', { trigger: 'mtg', directive: 'MTG RULES' });
  });

  it('returns only the directive whose trigger opens the message', () => {
    const helpers = loadHelperDirectives(dir);
    expect(directivesFor('<message sender="a">mtg how does trample work?</message>', helpers)).toBe('MTG RULES');
  });

  it('returns nothing for a code-less message', () => {
    const helpers = loadHelperDirectives(dir);
    expect(directivesFor('<message sender="a">how are you</message>', helpers)).toBe('');
  });

  it('matches past a leading escaped Discord mention', () => {
    const helpers = loadHelperDirectives(dir);
    expect(directivesFor('<message sender="a">&lt;@1539002280878014484&gt; kdm white lion</message>', helpers)).toBe(
      'KDM RULES',
    );
  });

  it('does not inject for a code in an earlier context message', () => {
    const helpers = loadHelperDirectives(dir);
    const prompt = '<message sender="a">mtg what does Liliana do?</message><message sender="b">and the weather?</message>';
    expect(directivesFor(prompt, helpers)).toBe('');
  });

  it('always injects a directive with an empty trigger', () => {
    writeSkill('always-on', { trigger: '', directive: 'ALWAYS' });
    const helpers = loadHelperDirectives(dir);
    expect(directivesFor('<message sender="a">how are you</message>', helpers)).toBe('ALWAYS');
  });
});

describe('lookupHelperPromptHook', () => {
  it('returns the directive as UserPromptSubmit additional context', async () => {
    writeSkill('kdm', { trigger: 'kdm', directive: 'KDM RULES' });
    resetHelperDirectivesForTest(dir);
    expect(await runHook('<message sender="a">kdm white lion stats</message>')).toBe('KDM RULES');
  });

  it('returns no context for a code-less prompt', async () => {
    writeSkill('kdm', { trigger: 'kdm', directive: 'KDM RULES' });
    resetHelperDirectivesForTest(dir);
    expect(await runHook('<message sender="a">hello</message>')).toBeUndefined();
  });

  it('classifies the published wake message over the prompt text', async () => {
    writeSkill('kdm', { trigger: 'kdm', directive: 'KDM RULES' });
    resetHelperDirectivesForTest(dir);
    setCurrentTurn('<message sender="a">kdm white lion stats</message>');
    expect(await runHook('<message sender="b">a later context row</message>')).toBe('KDM RULES');
  });
});
