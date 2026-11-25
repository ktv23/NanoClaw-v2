---
name: fork-recipe
description: The recipe for this fork — every skill it applies on top of upstream NanoClaw, in order, and how to rebuild the fork from a clean upstream release. Use when rebuilding the fork after falling far behind upstream, when adding or removing a customization, or to see what this fork changes.
---

# Fork recipe

This fork is upstream NanoClaw plus the skills below, applied in this order. Nothing else in the source tree differs from upstream. If a change is not one of these skills, it is not part of the fork yet: turn it into a skill and add it here.

## Skills, in apply order

| # | Skill | From | What it adds | Depends on |
|---|---|---|---|---|
| 1 | `add-onecli` | upstream | The credential gateway | — |
| 2 | `add-telegram` | upstream | Telegram channel | — |
| 3 | `add-discord` | upstream | Discord channel | — |
| 4 | `add-mnemon` | upstream | Graph memory in the agent image | — |
| 5 | `add-lookup-helpers` | this fork | `helper.json` directives, the lookup gate, and locked-down bots that answer only where asked | — |
| 6 | `add-host-gateway-noproxy` | this fork | `host.docker.internal` bypasses the gateway proxy | — |
| 7 | `add-config-skills-verbs` | this fork | `ncl groups config set-skills / add-skill / remove-skill` | — |
| 8 | `add-discord-thread-titles` | this fork | Discord threads named after the question | 3 |
| 9 | `add-google-mcp-tools` | this fork | Gmail and Calendar MCP servers in the agent image | 1 |
| 10 | `add-interim-feedback` | this fork | "Still working" note and delivery-failure notice | — |

Skills 5 and 6 both reach into `src/container-runner.ts`, at different functions. Skills 8 and 10 both add a line to `src/modules/index.ts`. Skill 10 is last on purpose: it is the one most likely to need rework when upstream changes delivery, and it can be removed without touching the others.

## What is not in the recipe

These live on the install, not in the source tree, and survive any upgrade untouched:

- `.env`, `data/`, `groups/`, and the gateway's own state.
- The lookup-helper content skills under `container/skills/` (one folder per game, plus `gatekeeper`). They are deployed from the helper-forge project and are deliberately not committed. Keep them out of `git status` with `.git/info/exclude`, because `/update-nanoclaw` requires a clean tree.
- Each group's wiring: which skills it mounts, its MCP servers, its mounts.

## Routine upgrades

Run `/update-nanoclaw`. It stages upstream in a separate worktree, refreshes skills 1–3 from upstream, runs the tests, snapshots state and rolls back on failure. A failing test names the skill to fix: every fork skill has a test per line it adds to upstream code.

Upgrade on each upstream release rather than letting them pile up. The cost of an upgrade is the number of upstream changes that touch the handful of lines these skills add.

## Rebuilding from a clean upstream release

The rare path, for when the fork has fallen far behind or is being handed to someone else.

1. Start a branch at the upstream release tag.
2. Copy this fork's skill folders into `.claude/skills/`: `fork-recipe` and every skill marked "this fork" above.
3. Apply skills 1–10 in order, following each skill's `SKILL.md`. Each is safe to re-run.
4. Copy the stack test and run everything:

   ```bash
   cp .claude/skills/fork-recipe/fork-recipe.test.ts src/fork-recipe.test.ts
   pnpm run build
   pnpm test
   pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
   cd container/agent-runner && bun run test
   ```

5. Build the agent image: `./container/build.sh`.

`fork-recipe.test.ts` checks what only shows up with the skills applied together: every installed file still matches the copy in its skill folder, and the skills that share a file each kept their place.

## Changing the fork

- **Editing a skill's code:** edit the copy in the skill's folder, then copy it into the tree again (the `cp` line in that skill's `SKILL.md`). The stack test fails while the two differ.
- **Adding a customization:** get it working in the tree first, then move the logic into a new skill folder, reduce the edit to upstream code to a single call, add a test that fails when that call is removed, and add a row to the table above and to `COPY_SETS` in `fork-recipe.test.ts`.
- **Removing one:** follow the skill's `REMOVE.md`, delete its folder, and remove its row and its `COPY_SETS` entry.
