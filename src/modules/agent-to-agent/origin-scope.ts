/**
 * Origin scoping for projected destinations.
 *
 * A channel destination is created for every wiring, so a shared agent group
 * wired to several channels lists all of them as destinations. Projecting all
 * of them into a chat session lets the agent address a SIBLING channel: a
 * question asked in one channel can be answered into another, because both are
 * addressable and the model routes by topic instead of by where it was asked.
 *
 * This prunes channel destinations to the one the session came from. The agent
 * can always reply where it was addressed; it can no longer cross-post to an
 * unrelated sibling channel. Explicitly granted AGENT destinations are always
 * kept: those are deliberate wiring, not incidental co-tenancy.
 *
 * Fails open in two cases, because pruning every channel would leave the agent
 * unable to reply at all:
 *  - the session has no channel origin (task and agent-to-agent sessions);
 *  - the origin is not among the group's channel destinations (a legacy wiring
 *    with no destination row).
 *
 * Single-wiring groups are unaffected either way: their one channel is the origin.
 */
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';

interface ScopableDestination {
  target_type: string;
  target_id: string;
}

export async function scopeToSessionOrigin<T extends ScopableDestination>(rows: T[], sessionId: string): Promise<T[]> {
  const originMessagingGroupId = (await getSession(sessionId))?.messaging_group_id ?? null;
  if (originMessagingGroupId == null) return rows;

  const channelRows = rows.filter((r) => r.target_type === 'channel');
  if (channelRows.length === 0) return rows;

  if (!channelRows.some((r) => r.target_id === originMessagingGroupId)) {
    log.warn('Destination origin not found among channel destinations — skipping origin scope', {
      sessionId,
      originMessagingGroupId,
    });
    return rows;
  }

  return rows.filter((r) => r.target_type !== 'channel' || r.target_id === originMessagingGroupId);
}
