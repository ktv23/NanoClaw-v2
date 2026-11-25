---
name: add-origin-scoped-destinations
description: Keep an agent's replies in the channel that asked. In a chat session, a shared agent group wired to several channels can address only the channel the session came from, not its sibling channels. Use when one agent serves several channels and an answer landed in the wrong one.
---

# Add origin-scoped destinations

A channel destination exists for every wiring, so an agent group wired to several channels can address all of them from any session. The model then sometimes routes by topic instead of by origin: a question asked in one channel is answered into another.

This skill prunes the channel destinations projected into a chat session to the one channel that session came from. Agent destinations granted on purpose are always kept. The pruning fails open, keeping every channel, when a session has no channel origin (tasks, agent-to-agent) or when the origin has no destination row.

An agent group with one wiring behaves exactly as before.

## Apply

### 1. Copy the skill's files

```bash
S=.claude/skills/add-origin-scoped-destinations
cp $S/origin-scope.ts $S/origin-scope.test.ts src/modules/agent-to-agent/
```

### 2. Scope the projection

In `src/modules/agent-to-agent/write-destinations.ts`, import the helper after the `getDestinations` import:

```ts
import { scopeToSessionOrigin } from './origin-scope.js';
```

Then, in `writeDestinations`, wrap the rows read from the central table:

```ts
  const rows = await scopeToSessionOrigin(await getDestinations(agentGroupId), sessionId);
```

Skip both edits if `grep -q scopeToSessionOrigin src/modules/agent-to-agent/write-destinations.ts` already matches.

### 3. Build and test

```bash
pnpm run build
pnpm exec vitest run src/modules/agent-to-agent/origin-scope.test.ts
```

`origin-scope.test.ts` drives the real `writeDestinations` and goes red if the `scopeToSessionOrigin` call is removed.

The projection is rewritten on every container wake, so the change reaches each session the next time its container starts after the host restarts.

## Troubleshooting

- **An agent can no longer post to a second channel from a chat.** That is this skill working: a chat session keeps only its own channel. Sessions with no channel origin keep every destination.
- **`Destination origin not found among channel destinations` in the host log.** The session's channel has a wiring but no destination row, so nothing was pruned. Add the row: `ncl destinations add --agent-group-id <group> --local-name <name> --target-type channel --target-id <messaging-group-id>`.
