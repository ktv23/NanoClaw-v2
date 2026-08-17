# NanoClaw Migration Guide

Generated: 2026-08-17
Base (last common commit): `8d57bdfa` (v2.0.54, 2026-05-09)
HEAD at generation: `32e1cbd7`
Upstream target: `f0d35831` (v2.2.0+94)

This guide reapplies Kevin's fork customizations onto a **clean upstream** checkout
instead of merging 877 upstream commits. Built on `.12` (the code checkout);
rollout to the live `.100` install is a **separate deliberate step** (see
"Rollout to .100" below), not part of the worktree upgrade.

## Scope

- Upstream drift since base: **877 commits**, ~700 files.
- Fork drift since base: **18 commits**, 48 files, +3241 / −709.
- Tier: **3 (complex)** — deep edits to core files; but most fork work is now
  either upstream-native or replaceable by official skills, so the true reapply
  surface is small.

## Ledger (decided with Kevin 2026-08-17)

| # | Customization | Plan | Section |
|---|---|---|---|
| 1 | KDM/MTG lookup-helper directives (`helper.json` driven) | **Reapply** | customizations.md §1 |
| 2 | mnemon persistent memory | **Replace** → official `/add-mnemon` (semantic recall dropped; optional graft in appendix) | §Skills + appendix |
| 3 | Remote-MCP `NO_PROXY` host-local exemption (Nova↔Homestead) | **Reapply** (transport is now upstream-native) | customizations.md §2 |
| 4 | Gmail / Calendar tools | **Replace** → upstream `/add-gmail-tool` + `/add-gcal-tool` | §Skills |
| 5 | Telegram channel (v1 port) | **Replace** → upstream `/add-telegram` | §Skills |
| 6 | Prusa MCP | **Drop** | — |
| 7 | config-skills CLI (`groups config set/add/remove-skill`) | **Reapply** — `forge deploy` depends on it | customizations.md §3 |
| 8 | matrix-sms disable; v1→v2 migration handoff | **Drop** (moot on clean upstream) | — |
| 9 | Fork docs (`README.md`, `CLAUDE.md`) | **Keep** — restore from backup tag | customizations.md §4 |
| 10 | Task `context_mode` (per-task context control) | **Reapply** — not in upstream | customizations.md §5 |
| 11 | pdf-reader container skill | **Keep** — copy from backup | customizations.md §6 |

### Why the "drops" are safe
- **mnemon**: upstream productized it — native `container/agent-runner/src/memory/`
  module + `/add-mnemon` skill + `/migrate-memory` for existing data. Kevin's
  semantic-Ollama recall is a fragile per-turn dependency (VRAM contention with
  ComfyUI, fails open to keyword anyway). Dropped; graftable back via appendix.
- **Telegram / Gmail / Cal**: now shipped as upstream skills on the `channels`/
  `providers`/`ncl` branches. Reinstalling gets maintained versions.
- **Prusa MCP, matrix-sms disable, v1→v2 migration**: Kevin no longer wants /
  needs them. matrix-sms isn't installed on clean upstream so there's nothing to
  disable; migration handoff was one-time.

## Applied skills (reinstall in the worktree, in this order)

Run each `/add-*` skill against the upgraded worktree (they copy code from the
matching upstream branch + append self-registration imports + pin deps):

1. `/add-telegram`   — branch `channels` (telegram adapter, pairing, registration)
2. `/add-gmail-tool` — branch `channels`/`providers`/`ncl`
3. `/add-gcal-tool`  — branch `channels`/`providers`/`ncl`
4. `/add-mnemon`     — in upstream `main` (`.claude/skills/add-mnemon/`)
5. `/migrate-memory` — only if carrying existing mnemon data from `.100`

No custom (user-authored, non-upstream) skills to copy.

**⚠️ Gmail/Cal is a credential-model change, not a drop-in.** The fork ran
standalone MCP servers (`@gongrzhe/server-gmail-autoauth-mcp`,
`@cocal/google-calendar-mcp`) with **local** OAuth creds (`~/.gmail-mcp/`,
`~/.config/google-calendar-mcp/`). Upstream `/add-gmail-tool` + `/add-gcal-tool`
use **OneCLI-injected** OAuth (no creds in the container). Reinstalling adopts the
OneCLI model — at `.100` rollout you must **connect Google in OneCLI's web UI**
(mind the localhost-redirect gotcha in CLAUDE.md), not copy the old cred files.

**telegram-markdown-sanitize is intentionally dropped** — it was a workaround for
the old adapter; upstream telegram.ts states it replaced that sanitizer and now
renders escaped MarkdownV2 itself. The fork comment said "remove once upstream
ships mode-aware conversion" — it has.

## Migration plan (order of operations)

1. Upgrade worktree = clean `upstream/main`.
2. Reinstall skills (list above) — validate build after.
3. Reapply code customizations §1–§3 (customizations.md).
4. Restore fork docs §4.
5. `pnpm install && pnpm build && pnpm test` in the worktree.
6. Container typecheck (`pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit`).
7. Swap worktree into main; commit.

**Risk areas:** §1 (KDM helpers) rides a *programmatic* `UserPromptSubmit` hook
that upstream's hooks block doesn't currently register — the reapply must add
that wiring. Upstream's own memory hook is a *command* hook (settings.json), so
the two do not collide.

## Rollout to .100 (separate step — do NOT do during the worktree upgrade)

`.100` (live: Nova + KDM/MTG Telegram helper bot) currently tracks the same
history as `.12`. After this migration, `.12`'s `main` is rewritten (new history,
diverged from `32e1cbd7`) — so `.100` cannot fast-forward.

Plan when ready:
1. On `.100`: confirm no unique local commits (`git log origin/main..HEAD`).
2. Push migrated `main` from `.12` to `origin`.
3. On `.100`: `git fetch origin && git reset --hard origin/main`.
   - Untracked/ignored runtime data is preserved: `data/`, `groups/` (Nova's real
     personas + helper groups), `.env`, and the off-GitHub
     `container/skills/kingdom-death-wiki/` (via `.git/info/exclude`). `reset
     --hard` does not touch untracked files.
4. Re-run `forge deploy` from `~/Projects/helper-forge` to re-lay helper.json +
   corpora into the (now upstream-based) skill dirs.
5. Re-connect Google in OneCLI's web UI if Nova uses Gmail/Cal (new OneCLI
   credential model — see the Gmail/Cal note above). Verify remote-MCP DB rows
   for the Homestead sidecar still match upstream's `{type:'http',url}` shape
   (`ncl groups config get`); re-add via `ncl groups config add-mcp-server --url`
   if the fork stored them differently.
6. `pnpm install && pnpm build && ./container/build.sh`.
7. Restart the **system** service (`.100` runs nanoclaw as root systemd).
8. Smoke test: DM Nova; `kdm <query>` in the helper group; confirm a scheduled
   task fires (context_mode) and Nova↔Homestead MCP responds.

## Rollback

Backup branch + tag are created at upgrade time (`pre-migrate-<hash>-<ts>`).
`git reset --hard <backup-tag>` restores the pre-migration fork exactly.
