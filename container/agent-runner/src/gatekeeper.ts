/**
 * Hard "game-lookup only" gate for locked lookup bots.
 *
 * A lookup bot (see the helper-forge project) mounts one skill per game, each
 * with a helper.json `trigger` (kdm, mtg, btech, sctmg, …) whose directive
 * constrains the model to answer only from that game's on-disk archive. On
 * Discord the bot engages on any @mention, so a mention carrying no game code
 * would otherwise reach the model as an unconstrained turn and get a generic,
 * from-memory answer — exactly what a locked reference bot must never do.
 *
 * When a mounted skill's helper.json declares `"enforce": true` (the
 * "gatekeeper" skill), this module turns that soft prompt-guard into a HARD,
 * model-independent gate: poll-loop delivers the gatekeeper's `fallback_message`
 * verbatim and ends the turn WITHOUT calling the provider, so the model can
 * never emit a generic reply for a code-less message.
 *
 * Data-driven and self-scoping:
 *  - active only in containers that mount an enforcing gatekeeper skill, so a
 *    personal assistant (which mounts none) is unaffected;
 *  - the allow-list is collected from every mounted helper.json's non-empty
 *    trigger, so adding a game helper automatically widens it — no code change.
 */
import fs from 'node:fs';
import path from 'node:path';

const SKILLS_DIR = '/app/skills';

export interface GateConfig {
  /** Non-empty triggers across all mounted helper.json (kdm, mtg, …). */
  allowedTriggers: string[];
  /** Message sent verbatim when a turn carries no allowed trigger. */
  fallbackMessage: string;
}

/**
 * Load the enforcing gatekeeper from the mounted skills, or null if none is
 * mounted (the common case — the gate then does nothing). A gatekeeper with an
 * empty/absent `fallback_message` is treated as absent, so a misconfigured
 * skill fails open rather than silencing the bot.
 */
export function loadGate(dir: string = SKILLS_DIR): GateConfig | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null; // no skills dir (e.g. tests) → gate inactive
  }

  const allowedTriggers: string[] = [];
  let fallbackMessage: string | null = null;
  for (const name of names) {
    let cfg: { trigger?: string; enforce?: boolean; fallback_message?: string };
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(dir, name, 'helper.json'), 'utf8'));
    } catch {
      continue; // no/invalid helper.json for this skill
    }
    const trigger = (cfg.trigger ?? '').trim();
    if (trigger) allowedTriggers.push(trigger);
    if (cfg.enforce === true) fallbackMessage = (cfg.fallback_message ?? '').trim() || null;
  }

  if (!fallbackMessage) return null;
  return { allowedTriggers, fallbackMessage };
}

/**
 * True when the formatted prompt opens with one of the allowed game triggers.
 * Mirrors the directive-injection match in providers/claude.ts exactly
 * (`>\s*<trigger>\b`, case-insensitive) so the gate and the per-game directive
 * always agree on what counts as a game turn: if this returns true the game's
 * directive was injected; if false the gate blocks and the model never runs.
 */
export function promptHasAllowedTrigger(prompt: string, allowedTriggers: string[]): boolean {
  return allowedTriggers.some((t) => {
    const esc = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('>\\s*' + esc + '\\b', 'i').test(prompt);
  });
}
