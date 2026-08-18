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

/** True when `prompt` opens (past any leading mention) with one of `triggers`. */
export function matchesAnyTrigger(prompt: string, triggers: string[]): boolean {
  return triggers.some((t) => triggerRegex(t).test(prompt));
}
