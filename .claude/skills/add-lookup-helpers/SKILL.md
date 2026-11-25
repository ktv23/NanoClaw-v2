---
name: add-lookup-helpers
description: Add data-driven lookup helpers. A container skill that ships a helper.json gets its directive injected on turns that open with its trigger word (kdm, mtg, …), and a group that selects an enforcing "gatekeeper" skill answers only those turns. Use when setting up a game-rules or reference bot, or when a helper skill's trigger is being ignored.
---

# Add lookup helpers

A lookup helper is a container skill that answers from an on-disk archive when a message opens with its trigger word. This skill adds the runtime that makes a helper reliable:

- **Directives.** A container skill may ship `helper.json` at its root: `{ "trigger": "kdm", "directive": "…per-turn instructions…" }`. When the message that engaged a turn opens with the trigger, the directive is injected into that turn through the Claude provider's `UserPromptSubmit` hook. An empty trigger injects on every turn.
- **Gate.** A skill whose `helper.json` declares `"enforce": true` and a `fallback_message` is a gatekeeper. A group that selects it answers only turns that open with one of its selected helpers' triggers; any other chat turn gets the fallback message and never reaches the model. Tasks, webhooks and system messages pass through.
- **Opt-in lockdown.** A gatekeeper skill is never part of `skills: 'all'`. A group gets it only by listing it.

The trigger is matched at the start of the message body, past any leading @mention, against the message that engaged the turn. Directives and the gate share one matcher, so they always agree on what counts as a helper turn.

Helper skills themselves (their archives, `SKILL.md` and `helper.json`) are content: put them under `container/skills/<name>/`. This skill installs only the runtime.

## Apply

### 1. Copy the skill's files into both trees

```bash
S=.claude/skills/add-lookup-helpers
mkdir -p container/agent-runner/src/lookup-helpers
cp $S/container/*.ts container/agent-runner/src/lookup-helpers/
cp $S/host/lookup-lockdown.ts $S/host/lookup-lockdown.test.ts src/
```

### 2. Register the directive hook in the Claude provider

In `container/agent-runner/src/providers/claude.ts`, import the hook alongside the other local imports:

```ts
import { lookupHelperPromptHook } from '../lookup-helpers/directives.js';
```

Then add one entry to the `hooks` object passed to the SDK query, after `PreCompact`:

```ts
          UserPromptSubmit: [{ hooks: [lookupHelperPromptHook] }],
```

Skip both edits if `grep -q lookupHelperPromptHook container/agent-runner/src/providers/claude.ts` already matches.

### 3. Consult the gate in the poll loop

In `container/agent-runner/src/poll-loop.ts`, the gate is one call at each of the two places a batch is about to reach the provider. Skip either block that `grep -n 'MODULE-HOOK:lookup-gate' container/agent-runner/src/poll-loop.ts` already shows.

In `runPollLoop`, directly after the initial batch's prompt is formatted (`const prompt = formatMessagesWithCommands(...)`):

```ts
    // MODULE-HOOK:lookup-gate:start
    const { gateLookupTurn } = await import('./lookup-helpers/gate.js');
    if (await gateLookupTurn(keep, prompt, routing)) continue;
    // MODULE-HOOK:lookup-gate:end
```

In `processQuery`'s follow-up poller, directly after the follow-up prompt is formatted (`const prompt = formatMessages(keep);`):

```ts
        // MODULE-HOOK:lookup-gate-followup:start
        const { gateLookupTurn } = await import('./lookup-helpers/gate.js');
        if (await gateLookupTurn(keep, prompt, extractRouting(keep))) return;
        // MODULE-HOOK:lookup-gate-followup:end
```

The call also publishes the turn's wake message for the directive hook, so it runs for every batch, gated or not.

### 4. Keep lockdown skills out of `skills: 'all'`

In `src/container-runner.ts`, import the helper alongside the other local imports:

```ts
import { withoutLockdownSkills } from './lookup-lockdown.js';
```

Then, in `selectedSkillNames`, filter what `'all'` expands to:

```ts
  const selected =
    containerConfig.skills === 'all' ? withoutLockdownSkills(sharedSkillsDir, available) : containerConfig.skills;
```

Skip both edits if `grep -q withoutLockdownSkills src/container-runner.ts` already matches.

### 5. Build and test

```bash
pnpm run build
pnpm exec vitest run src/lookup-lockdown.test.ts
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
cd container/agent-runner && bun test --isolate src/lookup-helpers/
```

Each integration point has a test that drives the real entry and goes red if its line is removed:

| Integration point | Test |
|---|---|
| `UserPromptSubmit` hook in `providers/claude.ts` | `lookup-helpers/claude-hook.wiring.test.ts` |
| Gate call, initial batch, in `poll-loop.ts` | `lookup-helpers/poll-loop.wiring.test.ts` |
| Gate call, follow-up, in `poll-loop.ts` | `lookup-helpers/poll-loop.wiring.test.ts` |
| `withoutLockdownSkills` in `container-runner.ts` | `src/lookup-lockdown.test.ts` |

Agent-runner source is mounted into containers at spawn, so the container edits take effect on the next container start with no image rebuild. The host edit takes effect when the host restarts.

## Using it

- A helper's directive is read once per container. After editing a `helper.json`, restart that group's container: `ncl groups restart --id <group-id>`.
- A session that already holds answers in an older style keeps mirroring them. To make a changed directive take effect in an existing conversation, clear that session.
- To lock a group down, select the helper skills and the gatekeeper skill by name (the group must not be on `skills: 'all'`), then restart its container.

## Troubleshooting

- **A coded message gets the fallback.** The gate reads only the skills the group selected. Check the helper is in the group's skill list, and that its `helper.json` has a non-empty `trigger`.
- **A personal assistant started answering with the fallback.** It selected a gatekeeper skill by name. Remove it from that group's skill list.
- **The directive is ignored.** Confirm the trigger opens the message (after any @mention) and that the container was restarted since `helper.json` last changed.
