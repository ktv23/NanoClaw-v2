---
name: add-interim-feedback
description: Tell people when the agent is slow, and tell the agent when a reply did not arrive. Sends one "still working" note into the chat when a message has waited 30 seconds, and notifies the agent's session when a reply is given up on so it can send a corrected version. Use when slow turns look like silence, or when a reply the agent believes it sent never reached the chat.
---

# Add interim feedback

Two small feedback loops between the host and a conversation:

- **"Still working" note.** When a person's message has waited 30 seconds and the agent is still working on it, the host sends one short note into the same chat. One note per message. Nothing is sent if the agent has already said something that turn, if no turn is open, or for a scheduled task.
- **Delivery-failure notice.** When a reply is given up on after its delivery attempts, the host tells the agent's session, with the reason and the start of the text, so the agent can send a corrected version. At most two notices in a row per session; a delivered reply resets the count.

The note is sent straight through the channel adapter and is never written to the session's outbound mailbox. It is not part of the conversation the agent sees.

## Apply

### 1. Copy the module

```bash
S=.claude/skills/add-interim-feedback
mkdir -p src/modules/interim-feedback
cp $S/*.ts src/modules/interim-feedback/
```

### 2. Load it from the modules barrel

Append to `src/modules/index.ts`:

```ts
import './interim-feedback/index.js';
```

Skip if `grep -q interim-feedback src/modules/index.ts` already matches. It must come after `./approvals/index.js`, which it uses to reach the agent's session.

### 3. Report a given-up reply

In `src/delivery.ts`, in `failDelivery`, add one line directly after the `await markFailed(msg, session, agentGroup);` call:

```ts
    void (await import('./modules/interim-feedback/delivery-failure.js')).notifyDeliveryFailure(session, msg, err);
```

Skip if `grep -q notifyDeliveryFailure src/delivery.ts` already matches.

### 4. Build and test

```bash
pnpm run build
pnpm exec vitest run src/modules/interim-feedback/
```

| Integration point | Test |
|---|---|
| Barrel line in `src/modules/index.ts` | `interim-feedback.wiring.test.ts`, and the reset case in `delivery-failure.test.ts` |
| `notifyDeliveryFailure` call in `src/delivery.ts` | `delivery-failure.test.ts` |
| The module's use of the session mailbox, running-session list and messaging groups | `nudge.test.ts`, against a real database and mailbox |

Both loops start when the host restarts.

## Tuning

The thresholds and the note's wording are constants at the top of `src/modules/interim-feedback/nudge.ts`: `INTERIM_FEEDBACK_MS` (30 seconds) and `INTERIM_TEXT`. Change them in this skill's copy as well, so a re-apply keeps them.

## Troubleshooting

- **No note on a slow turn.** The note needs a running container holding the message. During a cold start nothing holds it yet, so the wait is counted from when the message arrived but the note cannot go out until the container has picked the message up.
- **A note arrives although the answer follows a second later.** That turn took just over the threshold. Raise `INTERIM_FEEDBACK_MS`.
- **`Suppressing delivery-failure notice (loop guard)` in the host log.** Three replies in a row could not be delivered to that chat. The channel itself is failing; the host log line before it carries the reason.
