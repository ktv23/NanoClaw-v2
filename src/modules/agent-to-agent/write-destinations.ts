/**
 * Project the agent's central `agent_destinations` rows into its per-session
 * `inbound.db` so the running container can resolve names locally. Called on
 * every container wake and after admin-time destination edits (e.g. create_agent).
 *
 * Core container-runner calls this via a dynamic import guarded by a
 * `hasTable('agent_destinations')` check — without the agent-to-agent module
 * installed, the central table doesn't exist and the projection is skipped.
 */
import fs from 'fs';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { replaceDestinations, type DestinationRow } from '../../db/session-db.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb } from '../../session-manager.js';
import { getDestinations } from './db/agent-destinations.js';

export function writeDestinations(agentGroupId: string, sessionId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  // Origin scoping: a channel destination is auto-created per wiring
  // (ensureAgentDestinationForWiring), so a shared agent group wired to
  // several channels lists ALL of them as mutual destinations. In a chat
  // session that let the agent address a SIBLING channel — e.g. an `mtg`
  // question asked in the #tonys-thoughts→ti4 thread got its answer sent to
  // the #mtg channel, because both channels were addressable and the model
  // routed by topic instead of by origin. We prune channel destinations to
  // just the one this session actually came from; the agent can always reply
  // where it was addressed but can no longer cross-post to an unrelated
  // sibling channel. Explicitly-granted AGENT destinations (create_agent) are
  // always kept — those are deliberate wiring, not incidental co-tenancy.
  //
  // Fail-open when the origin is unknown (session has no messaging_group_id:
  // task/agent-to-agent sessions with no channel origin) — pruning every
  // channel there would leave the agent unable to reach a channel at all.
  // Single-wiring groups are unaffected either way (their one channel IS the
  // origin), so the real blast radius is exactly multi-channel shared groups.
  const originMessagingGroupId = getSession(sessionId)?.messaging_group_id ?? null;

  const rows = getDestinations(agentGroupId);
  const channelRows = rows.filter((r) => r.target_type === 'channel');
  // Defensive fail-open: only scope when the origin channel is actually among
  // this group's destinations. If it isn't (a legacy/corrupt wiring with no
  // auto-created destination row), pruning would drop EVERY channel and leave
  // the agent unable to reply — keep them all in that case rather than mute it.
  const scopeChannels =
    originMessagingGroupId != null && channelRows.some((r) => r.target_id === originMessagingGroupId);
  if (originMessagingGroupId != null && !scopeChannels && channelRows.length > 0) {
    log.warn('Destination origin not found among channel destinations — skipping origin scope', {
      sessionId,
      originMessagingGroupId,
    });
  }

  const resolved: DestinationRow[] = [];

  for (const row of rows) {
    if (row.target_type === 'channel') {
      if (scopeChannels && row.target_id !== originMessagingGroupId) continue;
      const mg = getMessagingGroup(row.target_id);
      if (!mg) continue;
      resolved.push({
        name: row.local_name,
        display_name: mg.name ?? row.local_name,
        type: 'channel',
        channel_type: mg.channel_type,
        platform_id: mg.platform_id,
        agent_group_id: null,
      });
    } else if (row.target_type === 'agent') {
      const ag = getAgentGroup(row.target_id);
      if (!ag) continue;
      resolved.push({
        name: row.local_name,
        display_name: ag.name,
        type: 'agent',
        channel_type: null,
        platform_id: null,
        agent_group_id: ag.id,
      });
    }
  }

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    replaceDestinations(db, resolved);
  } finally {
    db.close();
  }
  log.debug('Destination map written', { sessionId, count: resolved.length });
}
