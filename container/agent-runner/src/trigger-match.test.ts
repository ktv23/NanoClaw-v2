/**
 * Tests for shared helper-trigger matching (./trigger-match.ts).
 *
 * The load-bearing case is a Discord mention-mode message: the platform
 * @mention is rendered into the XML-escaped body before the game code, which a
 * naive `>\s*<trigger>` misses. See the "croque monsieur" regression below.
 */
import { describe, it, expect } from 'bun:test';

import { triggerRegex, matchesAnyTrigger, currentTurnText } from './trigger-match.js';

// How formatter.formatSingleChat renders a chat message (escaped body).
function fmt(bodyText: string): string {
  const esc = bodyText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return `<message id="5" from="discord-tonys" sender="kinkouin" time="4:39 PM">${esc}</message>`;
}

// A multi-message prompt (getPendingMessages merges context + current, formatted
// oldest-first); the CURRENT message is the last block.
function convo(...bodies: string[]): string {
  return bodies.map(fmt).join('');
}

describe('triggerRegex', () => {
  it('matches a plain code-first message (Telegram-style)', () => {
    expect(triggerRegex('mtg').test(fmt('mtg how does trample work?'))).toBe(true);
  });

  it('REGRESSION: matches past a leading Discord @mention (mention mode)', () => {
    // The exact shape that shipped the usage card by mistake.
    const prompt = fmt('<@1539002280878014484> mtg how do I make a croquet monsieur');
    expect(triggerRegex('mtg').test(prompt)).toBe(true);
  });

  it('matches past a nickname (<@!id>) and role (<@&id>) mention', () => {
    expect(triggerRegex('kdm').test(fmt('<@!123> kdm survival limit'))).toBe(true);
    expect(triggerRegex('btech').test(fmt('<@&456> btech heat rules'))).toBe(true);
  });

  it('matches past a plain textual @handle', () => {
    expect(triggerRegex('sctmg').test(fmt('@GameHelper sctmg what is cover'))).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(triggerRegex('mtg').test(fmt('<@1> MTG flying'))).toBe(true);
  });

  it('does not match when there is no leading code', () => {
    expect(triggerRegex('mtg').test(fmt('<@1> how do I not get bodied by toxrill?'))).toBe(false);
    expect(triggerRegex('mtg').test(fmt('<@1> hello'))).toBe(false);
  });

  it('requires a word boundary (no substring false-positives)', () => {
    expect(triggerRegex('mtg').test(fmt('<@1> mtgfoo bar'))).toBe(false);
    expect(triggerRegex('mtg').test(fmt('what about mtg arena'))).toBe(false);
  });
});

describe('matchesAnyTrigger', () => {
  const triggers = ['kdm', 'mtg', 'btech', 'sctmg'];

  it('finds the code past a mention across the allow-list', () => {
    expect(matchesAnyTrigger(fmt('<@1539002280878014484> mtg croque monsieur'), triggers)).toBe(true);
    expect(matchesAnyTrigger(fmt('<@1> sctmg engagement range'), triggers)).toBe(true);
  });

  it('is false for a code-less mention', () => {
    expect(matchesAnyTrigger(fmt('<@1> how do I not get bodied?'), triggers)).toBe(false);
  });

  // The Ambassador-Blorpityblorpboob incident: a code-less current message that
  // arrives after mtg-coded traffic must NOT inherit the mtg classification.
  it('REGRESSION: a code in an EARLIER context block does not leak onto a code-less current message', () => {
    const prompt = convo(
      '<@1> mtg show me a full legend of every mana symbol',
      '<@1> mtg what does Liliana, Dreadhorde General do?',
      '<@1> what does Ambassador Blorpityblorpboob do?', // current: no code
    );
    expect(matchesAnyTrigger(prompt, triggers)).toBe(false);
  });

  it('matches when the CURRENT (last) block carries the code, even after code-less context', () => {
    const prompt = convo(
      '<@1> just chatting about nothing',
      '<@1> mtg what does Ambassador Blorpityblorpboob do?', // current: coded
    );
    expect(matchesAnyTrigger(prompt, triggers)).toBe(true);
  });
});

describe('currentTurnText', () => {
  it('returns the last message block of a multi-message prompt', () => {
    const prompt = convo('mtg first question', 'kdm second question');
    const turn = currentTurnText(prompt);
    expect(turn.includes('second question')).toBe(true);
    expect(turn.includes('first question')).toBe(false);
  });

  it('returns the whole string when there is no message block (bare body)', () => {
    expect(currentTurnText('mtg bare text')).toBe('mtg bare text');
  });
});
