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
 * helper.json (the "gatekeeper" skill), the poll loop answers such a message
 * with that skill's `fallback_message`, verbatim, and never shows it to the
 * provider.
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
import { categorizeMessage, extractRouting, formatMessages, isSessionEcho } from '../formatter.js';
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
 * A chat message a person typed on a platform, that the gate must judge. Chat
 * rows the host or another agent addressed to this agent (channel `agent`: an
 * approval result, a delivery-failure notice) and session echoes are not.
 *
 * Nor is an ADMIN slash command (`/compact`, `/cost`, …): the host's command
 * gate lets those reach a container only when an owner or admin of this group
 * sent them, so one that arrives here is an operator's instruction, not a
 * question.
 *
 * Every OTHER slash-prefixed message is judged like any message. The host
 * passes unknown slash commands through from anyone, so exempting them would
 * let anybody step around a locked-down bot by starting a message with `/`.
 */
function isAsked(m: MessageInRow, providerName: string): boolean {
  if (m.kind !== 'chat' && m.kind !== 'chat-sdk') return false;
  if (m.channel_type === 'agent' || isSessionEcho(m)) return false;
  return categorizeMessage(m, providerName).category !== 'admin';
}

/**
 * Publish the current turn for trigger detection: the block of the newest wake
 * (trigger=1) message in the batch. The gate and the directive hook both read
 * it through trigger-match.currentTurnText, so they classify the message that
 * engaged the turn rather than whatever context row sorts last.
 *
 * A person's message wins over a notice addressed to the agent: when a game
 * question and a host notice land in one batch, the question is the turn, and
 * its directive must still be injected. A batch with no wake row (task,
 * system) clears the override, restoring the last-block fallback.
 */
function publishCurrentTurn(batch: MessageInRow[], providerName: string): void {
  const wakeRows = batch.filter((m) => m.trigger === 1);
  const fromPeople = wakeRows.filter((m) => isAsked(m, providerName));
  const turn = (fromPeople.length > 0 ? fromPeople : wakeRows).at(-1);
  setCurrentTurn(turn ? formatMessages([turn]) : null);
}

/**
 * The poll loop's single call, made for every batch before it is formatted for
 * the provider (the initial batch and each follow-up pushed into a warm
 * query). Returns the rows that should still reach the provider.
 *
 * Always publishes the current turn. Then, when a gate is active and the
 * message a person is waiting on opens with no allowed trigger, it writes the
 * fallback message to that person's chat, marks their rows completed, and
 * returns the batch without them. Everything else — tasks, webhooks, system
 * messages, notices addressed to the agent, an admin's slash commands —
 * always stays in the batch, so a notice that shares a batch with an off-topic
 * message is still delivered to the model while the off-topic message is not.
 *
 * An empty result means the caller must skip the provider.
 */
export async function gateLookupBatch(batch: MessageInRow[], providerName: string): Promise<MessageInRow[]> {
  publishCurrentTurn(batch, providerName);
  if (gate === undefined) gate = loadGate();
  if (!gate) return batch;

  const asked = batch.filter((m) => isAsked(m, providerName));
  const waking = asked.filter((m) => m.trigger === 1);
  if (waking.length === 0) return batch; // nobody is waiting on an answer
  if (promptHasAllowedTrigger(formatMessages(waking), gate.allowedTriggers)) return batch;

  const routing = extractRouting(asked);
  await writeMessageOut({
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    in_reply_to: routing.inReplyTo,
    kind: 'chat',
    platform_id: routing.platformId,
    channel_type: routing.channelType,
    thread_id: routing.threadId,
    content: JSON.stringify({ text: gate.fallbackMessage }),
  });
  markCompleted(asked.map((m) => m.id));
  log('gate: no game trigger in turn — sent the usage card, kept it from the provider');

  const gated = new Set(asked.map((m) => m.id));
  return batch.filter((m) => !gated.has(m.id));
}
