/**
 * Interim "still working" feedback.
 *
 * When a person's message has gone unanswered for INTERIM_FEEDBACK_MS and the
 * agent is still working on it, send one short note into the same chat so the
 * conversation is not simply silent. One note per message, and only for the
 * slow tail: the threshold sits above a normal turn.
 *
 * "Still working" is read from the session mailbox: the container holds a
 * processing claim from the moment it picks a batch up until it finishes the
 * turn. That needs nothing from the container beyond what it already records.
 *
 * The note goes straight out through the channel adapter. It is never written
 * to the session's outbound mailbox, which belongs to the container and is
 * what the container reads to decide whether it has already answered a turn.
 *
 * This file holds the logic and registers nothing; ./index.ts starts it.
 */
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getRunningSessions, isTaskThread } from '../../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { MailboxHistoryMessage } from '../../mailbox/types.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';

/** How long a message may wait before the note is sent. */
export const INTERIM_FEEDBACK_MS = 30_000;
/** A message older than this is not "being worked on" in any way a note helps. */
export const INTERIM_MAX_AGE_MS = 10 * 60_000;
export const INTERIM_TEXT = "⏳ Still on it — this one's taking a bit, hang tight.";

const CHECK_INTERVAL_MS = 5_000;
const HISTORY_DEPTH = 20;

/** What the mailbox says about a session's current turn. Newest rows first. */
export interface TurnView {
  openClaims: number;
  inbound: MailboxHistoryMessage[];
  outbound: MailboxHistoryMessage[];
}

function isChat(message: MailboxHistoryMessage): boolean {
  return message.kind === 'chat' || message.kind === 'chat-sdk';
}

/** A chat row the host wrote to the agent itself (an approval result, a failure notice). */
function isSystemChat(message: MailboxHistoryMessage): boolean {
  try {
    const content = JSON.parse(message.content) as { sender?: unknown; senderId?: unknown };
    return content.sender === 'system' || content.senderId === 'system';
  } catch {
    return false;
  }
}

/** The newest message a person sent in this session. */
export function newestUserChat(inbound: MailboxHistoryMessage[]): MailboxHistoryMessage | undefined {
  return inbound.find((m) => isChat(m) && !isSystemChat(m));
}

/**
 * Decide whether to send the note now. `turnKey` identifies the message the
 * decision was about, so the caller can remember it was handled.
 */
export function shouldNudge(
  view: TurnView,
  alreadyNudgedFor: string | undefined,
  now: number,
): { nudge: boolean; turnKey?: string } {
  if (view.openClaims === 0) return { nudge: false };

  const asked = newestUserChat(view.inbound);
  if (!asked) return { nudge: false };
  const askedAt = Date.parse(asked.timestamp);
  if (!Number.isFinite(askedAt)) return { nudge: false };

  const waited = now - askedAt;
  if (waited < INTERIM_FEEDBACK_MS || waited > INTERIM_MAX_AGE_MS) return { nudge: false };

  const turnKey = asked.timestamp;
  if (alreadyNudgedFor === turnKey) return { nudge: false, turnKey };

  // The agent has already said something since the message arrived: a partial
  // answer mid-turn is its own "still working".
  const replied = view.outbound.some((m) => m.kind === 'chat' && Date.parse(m.timestamp) >= askedAt);
  if (replied) return { nudge: false, turnKey };

  return { nudge: true, turnKey };
}

/** sessionId → the message we already sent a note for. */
const nudgedFor = new Map<string, string>();

async function checkSession(session: Session, adapter: ChannelDeliveryAdapter, now: number): Promise<void> {
  // A session with no single chat of origin (agent-to-agent), or a scheduled
  // task's own session, has nobody waiting on a reply.
  if (!session.messaging_group_id || isTaskThread(session.thread_id)) return;

  const view = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => ({
    openClaims: mailbox.getProcessingClaims().length,
    inbound: mailbox.getInboundHistory(HISTORY_DEPTH),
    outbound: mailbox.getOutboundHistory(HISTORY_DEPTH),
  }));
  if (!view) return;

  const decision = shouldNudge(view, nudgedFor.get(session.id), now);
  if (!decision.nudge || !decision.turnKey) return;

  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg) return;

  nudgedFor.set(session.id, decision.turnKey);
  try {
    await adapter.deliver(
      mg.channel_type,
      mg.platform_id,
      session.thread_id,
      'chat',
      JSON.stringify({ text: INTERIM_TEXT }),
      undefined,
      mg.instance,
    );
    log.info('Sent interim "still working" feedback', { sessionId: session.id });
  } catch (err) {
    nudgedFor.delete(session.id); // let a later tick try again
    log.warn('Interim feedback delivery failed', { sessionId: session.id, err });
  }
}

/** One pass over every session with a live container. Never throws. */
export async function checkSessions(adapter: ChannelDeliveryAdapter, now: number = Date.now()): Promise<void> {
  let sessions: Session[];
  try {
    sessions = await getRunningSessions();
  } catch (err) {
    log.warn('Interim feedback could not list running sessions', { err });
    return;
  }

  const running = new Set(sessions.map((s) => s.id));
  for (const sessionId of nudgedFor.keys()) {
    if (!running.has(sessionId)) nudgedFor.delete(sessionId);
  }

  for (const session of sessions) {
    try {
      await checkSession(session, adapter, now);
    } catch (err) {
      log.warn('Interim feedback check failed', { sessionId: session.id, err });
    }
  }
}

let timer: NodeJS.Timeout | null = null;
let passInFlight = false;

export function startInterimFeedback(adapter: ChannelDeliveryAdapter): void {
  if (timer) return;
  timer = setInterval(() => {
    if (passInFlight) return;
    passInFlight = true;
    void checkSessions(adapter).finally(() => {
      passInFlight = false;
    });
  }, CHECK_INTERVAL_MS);
  timer.unref();
}

export function stopInterimFeedback(): void {
  if (timer) clearInterval(timer);
  timer = null;
  nudgedFor.clear();
}
