/**
 * Shared helper-trigger matching for lookup bots.
 *
 * A lookup helper fires when the user's message OPENS with its trigger word
 * (e.g. `mtg how does trample work?`). Detection runs against the formatted
 * `<message …>…</message>` block, so the anchor is the tag's closing `>`.
 *
 * The wrinkle: the message body is XML-escaped (formatter.formatSingleChat), and
 * on Discord the platform @mention is part of the body text. So
 * `<@1539002280878014484> mtg …` renders as
 * `<message …>&lt;@1539002280878014484&gt; mtg …</message>` — the mention sits
 * between the tag's `>` and the code, and its own `>` is now the literal text
 * `&gt;`. A naive `>\s*<trigger>` therefore NEVER matches a mention-mode Discord
 * message, even though mention mode REQUIRES that @mention. This matcher skips
 * one or more leading mentions (escaped Discord `&lt;@…&gt;` or a plain textual
 * `@handle`) before the trigger, so the gate and the per-game directive agree
 * on what counts as a game turn on every platform.
 */

/** A leading platform mention token: escaped Discord (`&lt;@123&gt;`,
 * `&lt;@!123&gt;`, `&lt;@&amp;123&gt;`) or a plain `@handle` (Telegram/Slack). */
const MENTION = '(?:&lt;@(?:!|&amp;)?\\d+&gt;|@\\S+)';

/** Regex matching `trigger` at the start of a message body, past any mentions. */
export function triggerRegex(trigger: string): RegExp {
  const esc = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('>\\s*(?:' + MENTION + '\\s+)*' + esc + '\\b', 'i');
}

/**
 * Explicit "current turn" text, published by the poll loop before it gates or
 * queries a batch (initial AND follow-up). The wake message — the trigger=1 row
 * that engaged this turn — is the correct thing to classify, but the formatted
 * prompt is ordered by seq, so a trigger=0 context row that "rides along" with a
 * HIGHER seq than the wake sorts LAST. The old last-block heuristic then picked
 * that context row, which both over-blocked a real game code (the wake is not
 * last) and leaked a code-less turn (a context row that starts with a code is
 * last). Setting this to the wake block makes the gate and the per-game
 * directive key off the same message and agree. null → last-block fallback.
 */
let currentTurnOverride: string | null = null;

export function setCurrentTurn(text: string | null): void {
  currentTurnOverride = text;
}

/**
 * The CURRENT turn's text used for trigger detection. Returns the explicit
 * override the poll loop published for this turn (the wake message's block); if
 * none is set, falls back to the LAST `<message …>…</message>` block of the
 * prompt (bare-body and test callers, where the last block is the current one).
 */
export function currentTurnText(prompt: string): string {
  if (currentTurnOverride !== null) return currentTurnOverride;
  const open = /<message\b[^>]*>/gi;
  let idx = -1;
  let m: RegExpExecArray | null;
  while ((m = open.exec(prompt)) !== null) idx = m.index;
  return idx === -1 ? prompt : prompt.slice(idx);
}

/**
 * True when the CURRENT message (last block, past any leading mention) opens
 * with one of `triggers`. Scoped to the current turn so an earlier context
 * message's code cannot leak onto a code-less current message.
 */
export function matchesAnyTrigger(prompt: string, triggers: string[]): boolean {
  const turn = currentTurnText(prompt);
  return triggers.some((t) => triggerRegex(t).test(turn));
}
