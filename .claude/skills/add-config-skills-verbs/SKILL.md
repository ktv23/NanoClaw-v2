---
name: add-config-skills-verbs
description: Add ncl verbs that choose which container skills an agent group mounts — groups config set-skills, add-skill and remove-skill. Use when a group should mount only some skills, when a deploy script needs to add a skill to a group idempotently, or when locking a group down to a fixed skill list.
---

# Add the skill-selection verbs

Each agent group mounts either every shared container skill (`skills: 'all'`, the default) or an explicit list. This skill adds the `ncl` verbs that edit that selection:

| Verb | What it does |
|---|---|
| `ncl groups config set-skills --id <group> --skills <all \| a,b,c \| JSON array>` | Replace the selection. |
| `ncl groups config add-skill --id <group> --skill <name>` | Add one skill. Succeeds without changing anything when the group mounts `all` or already lists the skill, so a deploy script can call it unconditionally. |
| `ncl groups config remove-skill --id <group> --skill <name>` | Remove one skill from an explicit list. Refuses when the group mounts `all`; pin a list with `set-skills` first. |

They behave like the other `groups config` verbs: run directly from the host, held for admin approval when an agent calls them.

## Apply

### 1. Copy the skill's files

```bash
S=.claude/skills/add-config-skills-verbs
cp $S/skills-util.ts $S/skills-util.test.ts $S/groups-skills-config.ts $S/groups-skills-config.test.ts src/cli/resources/
```

### 2. Register the verbs on the groups resource

In `src/cli/resources/groups.ts`, import the operations after the `./destinations.js` import:

```ts
import { skillsConfigOperations } from './groups-skills-config.js';
```

Then spread them as the first entry of the resource's `customOperations`:

```ts
  customOperations: {
    ...skillsConfigOperations,
```

Skip both edits if `grep -q skillsConfigOperations src/cli/resources/groups.ts` already matches.

### 3. Build and test

```bash
pnpm run build
pnpm exec vitest run src/cli/resources/groups-skills-config.test.ts src/cli/resources/skills-util.test.ts
```

`groups-skills-config.test.ts` runs each verb through the real command dispatcher against a migrated test database and goes red if the spread is removed.

The verbs exist once the host restarts.

## Using it

A group reads its selection when its container starts, so follow a change with a restart:

```bash
ncl groups config add-skill --id <group-id> --skill mtg-helper
ncl groups restart --id <group-id>
```

`ncl groups config get --id <group-id>` shows the current selection.

## Troubleshooting

- **`Unknown command` for one of the verbs.** The host is still running the build from before this skill. Restart it.
- **A skill was added but the agent does not see it.** The group's container has not restarted since the change.
