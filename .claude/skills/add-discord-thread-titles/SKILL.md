---
name: add-discord-thread-titles
description: Name Discord threads after the question that started them. When an @mention opens a new thread session, the bot renames the adapter's auto-generated "Thread <timestamp>" to the text of that message. Use when a Discord channel's thread list is a wall of timestamps. Requires the Discord channel (/add-discord).
---

# Add Discord thread titles

The Discord adapter opens a thread for every channel @mention and names it `Thread <timestamp>`. This skill renames that thread after the message that started it, with mention tokens removed and capped at 90 characters.

Only an auto-generated name is replaced: a thread a person named keeps its name. Direct messages, other channels' platforms and later messages in an existing thread are untouched. The rename is best-effort and never delays or blocks a reply.

It registers on the router's session-created hook, so it adds no code to the router or to the Discord adapter.

## Prerequisite

The Discord channel is installed (`src/channels/discord.ts` exists) and `DISCORD_BOT_TOKEN` is set in `.env`. Run `/add-discord` first if not. The bot renames threads it created with the permissions it already has.

## Apply

### 1. Copy the module

```bash
S=.claude/skills/add-discord-thread-titles
mkdir -p src/modules/discord-thread-titles
cp $S/index.ts $S/discord-thread-titles.test.ts src/modules/discord-thread-titles/
```

### 2. Load it from the modules barrel

Append to `src/modules/index.ts`:

```ts
import './discord-thread-titles/index.js';
```

Skip if `grep -q discord-thread-titles src/modules/index.ts` already matches.

### 3. Build and test

```bash
pnpm run build
pnpm exec vitest run src/modules/discord-thread-titles/discord-thread-titles.test.ts
```

The test loads the module through the real modules barrel and sends a mention through the real router, with Discord's API stubbed. It goes red if the barrel line is removed.

The rename starts working once the host restarts.

## Troubleshooting

- **Threads keep their timestamp names.** The wiring must reply in threads: a Discord group wiring with `threads` on, so each mention gets its own session. Check `ncl wirings list`.
- **`Discord thread rename failed` in the host log.** Discord rejected the call. The bot can rename only threads it created, unless it has Manage Threads.
