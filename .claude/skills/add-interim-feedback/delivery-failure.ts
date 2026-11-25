/**
 * Delivery-failure notice.
 *
 * When a reply permanently fails to deliver, the agent otherwise never finds
 * out: its own history shows it answered, and the person sees nothing. This
 * tells the agent's session that the reply did not arrive, with the reason and
 * the start of the text, so it can send a corrected version.
 *
 * Bounded per session: a channel that can never be delivered to would
 * otherwise loop notice → retry → notice. The count resets on any successful
 * delivery.
 *
 * This file holds the logic and registers nothing. delivery.ts calls
 * `notifyDeliveryFailure`; ./index.ts registers the reset.
 */
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { notifyAgent } from '../approvals/index.js';

const MAX_CONSECUTIVE_NOTICES = 2;
const PREVIEW_CHARS = 200;

/** sessionId → notices sent since the last successful delivery. */
const noticeCount = new Map<string, number>();

export function resetDeliveryFailureCount(sessionId: string): void {
  noticeCount.delete(sessionId);
}

interface FailedMessage {
  id: string;
  kind: string;
  channelType: string | null;
  content: string;
}

export function deliveryFailureText(msg: FailedMessage, err: unknown): string {
  let preview = '';
  try {
    preview = String((JSON.parse(msg.content) as { text?: unknown })?.text ?? '').slice(0, PREVIEW_CHARS);
  } catch {
    // content is not JSON: no preview
  }
  const reason = err instanceof Error ? err.message : String(err);
  return [
    'Your last reply could NOT be delivered after retries. The person you were answering did not receive it.',
    `Reason: ${reason}`,
    preview ? `It began: ${preview}` : '',
    'Send a corrected version as a normal reply. If the reason looks like a formatting or markdown problem, simplify the formatting.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Tell the session its reply was not delivered. Never throws. */
export async function notifyDeliveryFailure(session: Session, msg: FailedMessage, err: unknown): Promise<void> {
  // Only replies to a person. A system row, or a message to another agent, has
  // nobody waiting on a corrected version.
  if (msg.kind !== 'chat' || msg.channelType === 'agent') return;

  const count = (noticeCount.get(session.id) ?? 0) + 1;
  noticeCount.set(session.id, count);
  if (count > MAX_CONSECUTIVE_NOTICES) {
    log.warn('Suppressing delivery-failure notice (loop guard)', { sessionId: session.id, messageId: msg.id });
    return;
  }

  try {
    await notifyAgent(session, deliveryFailureText(msg, err));
    log.info('Told the session its reply was not delivered', { sessionId: session.id, messageId: msg.id });
  } catch (notifyErr) {
    log.warn('Could not tell the session its reply was not delivered', { sessionId: session.id, err: notifyErr });
  }
}
