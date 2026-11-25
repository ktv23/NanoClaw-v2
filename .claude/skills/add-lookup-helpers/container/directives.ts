/**
 * Lookup-helper directives.
 *
 * A container skill may ship a `helper.json` at its root:
 *
 *   { "trigger": "kdm", "directive": "…hard per-turn instructions…" }
 *
 * When the message that engaged a turn opens with a skill's trigger, that
 * skill's directive is injected into the turn through the provider's
 * UserPromptSubmit hook (`additionalContext`). Standing instructions in the
 * project document are not a reliable lever for "answer only from this
 * archive"; per-turn hook context is.
 *
 * An empty or absent trigger injects on every turn (a dedicated always-on bot).
 *
 * The trigger is matched with the shared matcher in ./trigger-match.ts, against
 * the current turn only, so this hook and the hard gate in ./gate.ts always
 * classify a message the same way.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';

import { currentTurnText, triggerRegex } from './trigger-match.js';

/** Every shared container skill is mounted here, selected or not. */
const SKILLS_DIR = process.env.SKILLS_DIR || '/app/skills';

function log(msg: string): void {
  console.error(`[lookup-helpers] ${msg}`);
}

export interface HelperDirective {
  /** null means inject on every turn. */
  re: RegExp | null;
  directive: string;
}

export function loadHelperDirectives(dir: string = SKILLS_DIR): HelperDirective[] {
  const out: HelperDirective[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out; // no skills dir (tests, a host-side import): nothing to inject
  }
  for (const name of entries) {
    const file = path.join(dir, name, 'helper.json');
    try {
      if (!fs.existsSync(file)) continue;
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as { trigger?: string; directive?: string };
      if (!cfg.directive) continue;
      const trigger = (cfg.trigger ?? '').trim();
      out.push({ re: trigger ? triggerRegex(trigger) : null, directive: cfg.directive });
    } catch (err) {
      log(`helper.json load skipped for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

/** The directive text for one prompt: every helper whose trigger opens the current turn. */
export function directivesFor(prompt: string, helpers: HelperDirective[]): string {
  // Match the CURRENT turn, not the whole prompt: a game code in an earlier
  // context message must not inject that game's directive for a code-less
  // message. See trigger-match.currentTurnText.
  const turn = currentTurnText(prompt);
  return helpers
    .filter((h) => h.re === null || h.re.test(turn))
    .map((h) => h.directive)
    .filter(Boolean)
    .join('\n\n');
}

// Loaded on first use and kept for the container's life: skills are a
// read-only mount fixed at spawn.
let loaded: HelperDirective[] | null = null;

/** Tests only: drop the cached helpers, or load them from `dir`. */
export function resetHelperDirectivesForTest(dir?: string): void {
  loaded = dir === undefined ? null : loadHelperDirectives(dir);
}

export const lookupHelperPromptHook: HookCallback = async (input) => {
  loaded ??= loadHelperDirectives();
  const prompt = ((input as { prompt?: string }).prompt ?? '').trim();
  const additionalContext = directivesFor(prompt, loaded);
  if (!additionalContext) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  } as unknown as ReturnType<HookCallback>;
};
