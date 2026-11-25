/**
 * Hard "lookup only" gate for locked lookup bots.
 *
 * A lookup bot mounts one skill per game, each with a helper.json `trigger`
 * (kdm, mtg, btech, …) whose directive constrains the model to answer only from
 * that game's on-disk archive. On a platform where the bot engages on any
 * @mention, a mention carrying no game code would otherwise reach the model as
 * an unconstrained turn and get a generic, from-memory answer — exactly what a
 * locked reference bot must never do.
 *
 * When a skill the group SELECTED declares `"enforce": true` in its
 * helper.json (the "gatekeeper" skill), the poll loop delivers that skill's
 * `fallback_message` verbatim and ends the turn WITHOUT calling the provider.
 *
 * Data-driven and self-scoping:
 *  - active only in containers whose group selected an enforcing skill, so a
 *    personal assistant (which selects none) is unaffected;
 *  - the allow-list is every selected helper.json's non-empty trigger, so
 *    adding a game helper widens it with no code change.
 *
 * Scoping note: the whole `container/skills/` tree is mounted read-only at
 * `/app/skills` in every container regardless of selection, so reading that
 * path would fire the gate for ANY container once a gatekeeper skill exists in
 * the shared tree. The group's actual selection is the symlink set the host
 * syncs into `/home/node/.claude/skills/`, so that is what is read here.
 */
import fs from 'node:fs';
import path from 'node:path';

import { markCompleted, type MessageInRow } from '../db/messages-in.js';
import { writeMessageOut } from '../db/messages-out.js';
import { formatMessages, type RoutingContext } from '../formatter.js';
import { matchesAnyTrigger, setCurrentTurn } from './trigger-match.js';

const SELECTED_SKILLS_DIR = '/home/node/.claude/skills';

function log(msg: string): void {
  console.error(`[lookup-helpers] ${msg}`);
}

export interface GateConfig {
  /** Non-empty triggers across the selected helper.json files (kdm, mtg, …). */
  allowedTriggers: string[];
  /** Message sent verbatim when a turn carries no allowed trigger. */
  fallbackMessage: string;
}

/**
 * Load the enforcing gatekeeper from the selected skills, or null when there is
 * none (the common case: the gate then does nothing). A gatekeeper with an
 * empty or absent `fallback_message` counts as absent, so a misconfigured skill
 * fails open rather than silencing the bot.
 */
export function loadGate(dir: string = SELECTED_SKILLS_DIR): GateConfig | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null; // no skills dir (tests): gate inactive
  }

  const allowedTriggers: string[] = [];
  let fallbackMessage: string | null = null;
  for (const name of names) {
    let cfg: { trigger?: string; enforce?: boolean; fallback_message?: string };
    try {
      cfg = JSON.parse(fs.readFileSync(path.join(dir, name, 'helper.json'), 'utf8'));
    } catch {
      continue; // no helper.json, or an invalid one, for this skill
    }
    const trigger = (cfg.trigger ?? '').trim();
    if (trigger) allowedTriggers.push(trigger);
    if (cfg.enforce === true) fallbackMessage = (cfg.fallback_message ?? '').trim() || null;
  }

  if (!fallbackMessage) return null;
  return { allowedTriggers, fallbackMessage };
}

/**
 * True when the CURRENT message opens with one of the allowed triggers. Uses
 * the same matcher as ./directives.ts, so if this returns true the game's
 * directive was injected, and if false the gate blocks and the model never runs.
 */
export function promptHasAllowedTrigger(prompt: string, allowedTriggers: string[]): boolean {
  return matchesAnyTrigger(prompt, allowedTriggers);
}

// Resolved on first use and kept for the container's life: the selection is a
// mount fixed at spawn. `undefined` means not loaded yet.
let gate: GateConfig | null | undefined;

/** Tests only: clear the cached gate, or load it from `dir`. */
export function resetGateForTest(dir?: string): void {
  gate = dir === undefined ? undefined : loadGate(dir);
}

/**
 * Publish the current turn for trigger detection: the block of the newest wake
 * (trigger=1) message in the batch. The gate and the directive hook both read
 * it through trigger-match.currentTurnText, so they classify the message that
 * engaged the turn rather than whatever context row sorts last. A batch with no
 * wake row (task, system) clears it, restoring the last-block fallback.
 */
function publishCurrentTurn(batch: MessageInRow[]): void {
  const wakeRows = batch.filter((m) => m.trigger === 1);
  setCurrentTurn(wakeRows.length > 0 ? formatMessages([wakeRows[wakeRows.length - 1]]) : null);
}

/**
 * The poll loop's single call, made for every batch before it reaches the
 * provider (the initial batch and each follow-up pushed into a warm query).
 *
 * Always publishes the current turn. Then, when a gate is active and this is a
 * user-chat batch with no allowed trigger, writes the fallback message to
 * `routing`, marks the batch completed, and returns true: the caller must skip
 * the provider. Tasks, webhooks and system messages pass straight through.
 */
export async function gateLookupTurn(
  batch: MessageInRow[],
  prompt: string,
  routing: RoutingContext,
): Promise<boolean> {
  publishCurrentTurn(batch);
  if (gate === undefined) gate = loadGate();
  if (!gate) return false;
  if (!batch.every((m) => m.kind === 'chat' || m.kind === 'chat-sdk')) return false;
  if (promptHasAllowedTrigger(prompt, gate.allowedTriggers)) return false;

  await writeMessageOut({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: gate.fallbackMessage }),
  });
  markCompleted(batch.map((m) => m.id));
  log('gate: no game trigger in turn — sent the usage card, skipped the provider');
  return true;
}
