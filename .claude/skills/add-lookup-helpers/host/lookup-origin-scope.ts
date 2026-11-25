/**
 * A locked-down lookup bot answers where it was asked.
 *
 * A channel destination exists for every wiring, so an agent group wired to
 * several channels can address all of them from any session. For an ordinary
 * assistant that is the point. For a locked-down reference bot shared by
 * several channels it is a leak: a question asked in one channel can be
 * answered into another, because both are addressable and the model routes by
 * topic instead of by where it was asked.
 *
 * For a group that selected a lockdown skill, this prunes the channel
 * destinations projected into a chat session to the one channel that session
 * came from. Explicitly granted AGENT destinations are always kept.
 *
 * Fails open, keeping every channel, whenever pruning could leave the agent
 * unable to reply at all:
 *  - the session has no channel origin (task and agent-to-agent sessions);
 *  - the origin is not among the group's channel destinations (a wiring with
 *    no destination row).
 */
import path from 'path';

import { getContainerConfig } from './db/container-configs.js';
import { getSession } from './db/sessions.js';
import { log } from './log.js';
import { selectsLockdownSkill } from './lookup-lockdown.js';

interface ScopableDestination {
  target_type: string;
  target_id: string;
}

async function groupIsLockedDown(agentGroupId: string): Promise<boolean> {
  const row = await getContainerConfig(agentGroupId);
  if (!row) return false;
  let skills: unknown;
  try {
    skills = JSON.parse(row.skills);
  } catch {
    return false;
  }
  if (skills !== 'all' && !(Array.isArray(skills) && skills.every((s) => typeof s === 'string'))) return false;
  return selectsLockdownSkill(skills as string[] | 'all', path.join(process.cwd(), 'container', 'skills'));
}

export async function scopeToSessionOrigin<T extends ScopableDestination>(
  rows: T[],
  agentGroupId: string,
  sessionId: string,
): Promise<T[]> {
  const channelRows = rows.filter((r) => r.target_type === 'channel');
  if (channelRows.length < 2) return rows; // nothing to cross-post to
  if (!(await groupIsLockedDown(agentGroupId))) return rows;

  const originMessagingGroupId = (await getSession(sessionId))?.messaging_group_id ?? null;
  if (originMessagingGroupId == null) return rows;

  if (!channelRows.some((r) => r.target_id === originMessagingGroupId)) {
    log.warn('Destination origin not found among channel destinations — skipping origin scope', {
      sessionId,
      originMessagingGroupId,
    });
    return rows;
  }

  return rows.filter((r) => r.target_type !== 'channel' || r.target_id === originMessagingGroupId);
}
