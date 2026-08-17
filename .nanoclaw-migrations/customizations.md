# Customizations — reapply details

All snippets below are extracted verbatim from fork HEAD `32e1cbd7`. Where a whole
file is unchanged-from-fork, prefer restoring it from the backup tag created at
upgrade time (referred to below as `$BACKUP_TAG`) rather than retyping.

---

## §1 — KDM/MTG lookup-helper directives (REAPPLY)

**Intent:** When an inbound chat message matches a mounted skill's trigger (e.g.
`kdm …`, `mtg …`), inject that skill's hard per-turn directive into the turn so
the agent does a real archive lookup and cites sources — instead of answering
from model memory. Data-driven: each helper skill ships a `helper.json`
(`{ "trigger": "kdm", "directive": "…" }`) at its root; **no per-game code**.
Independent of mnemon (works on any install).

**File:** `container/agent-runner/src/providers/claude.ts`

**Dependencies already present upstream:** `import fs from 'fs'`, `import path
from 'path'` (both imported in upstream claude.ts). Needs a `log` helper — if
upstream's claude.ts doesn't already define one at module scope, add:
```typescript
function log(msg: string): void { console.error(`[claude-provider] ${msg}`); }
```

**Note on the DATA:** the `helper.json` files + corpora live in the mounted skill
dirs (`/app/skills/<skill>/helper.json`), deployed by `forge deploy` from the
helper-forge project — they are NOT in this repo (KDM content is off-GitHub).
This section reapplies only the *code that reads* them.

### 1a. Add the loader (module scope, near the top-of-file constants)

```typescript
// Data-driven lookup-helper directives. Each mounted skill MAY ship a
// `helper.json` at its root:
//   { "trigger": "kdm", "directive": "…hard per-turn instructions…" }
// When an inbound message matches a skill's trigger, that skill's directive is
// injected into the turn (via UserPromptSubmit additionalContext — the reliable
// lever; static CLAUDE.local.md lines get ignored). The trigger is matched after
// the formatter's `>` wrapper, so a bare prefix like "kdm" becomes />\s*kdm\b/i;
// an empty/absent trigger injects on every turn (dedicated always-on bots).
const SKILLS_DIR = process.env.SKILLS_DIR || '/app/skills';

interface HelperDirective {
  re: RegExp | null; // null => always inject
  directive: string;
}

export function loadHelperDirectives(dir: string = SKILLS_DIR): HelperDirective[] {
  const out: HelperDirective[] = [];
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return out; // no skills dir (e.g. host-side tests) — nothing to inject
  }
  for (const name of entries) {
    const p = `${dir}/${name}/helper.json`;
    try {
      if (!fs.existsSync(p)) continue;
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8')) as { trigger?: string; directive?: string };
      if (!cfg.directive) continue;
      const trigger = (cfg.trigger ?? '').trim();
      const re = trigger
        ? new RegExp('>\\s*' + trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'i')
        : null;
      out.push({ re, directive: cfg.directive });
    } catch (err) {
      log(`helper.json load skipped for ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}

// Loaded once per container — skills are read-only and mounted at spawn.
const HELPER_DIRECTIVES = loadHelperDirectives();
```

### 1b. Add a programmatic UserPromptSubmit hook that injects the directives

This is the **slimmed** version — the original also did mnemon recall/remember
inline; that is dropped now that mnemon comes from the official skill.

```typescript
const helperUserPromptSubmitHook: HookCallback = async (input) => {
  const prompt = ((input as { prompt?: string }).prompt ?? '').trim();
  // Lookup-helper directives (KDM, MTG, …) — driven by each skill's helper.json.
  const helperBlocks = HELPER_DIRECTIVES
    .filter((h) => h.re === null || h.re.test(prompt))
    .map((h) => h.directive);
  const additionalContext = helperBlocks.filter(Boolean).join('\n\n');
  if (!additionalContext) return {};
  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  } as unknown as ReturnType<HookCallback>;
};
```

### 1c. Wire it into the SDK `hooks:` block

Upstream registers `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`PreCompact` (around line ~576 in upstream claude.ts). Add a `UserPromptSubmit`
entry alongside them:

```typescript
        hooks: {
          PreToolUse: [{ hooks: [preToolUseHook] }],
          PostToolUse: [{ hooks: [postToolUseHook] }],
          PostToolUseFailure: [{ hooks: [postToolUseHook] }],
          PreCompact: [{ hooks: [createPreCompactHook(this.assistantName)] }],
          UserPromptSubmit: [{ hooks: [helperUserPromptSubmitHook] }],   // ADD
        },
```

Upstream's memory hook is a *command* hook written into `settings.json`, so this
programmatic hook does not collide with it.

**Verify:** `loadHelperDirectives('/nonexistent')` returns `[]` (no throw);
a message body `...">kdm White Lion` matches `/>\s*kdm\b/i`.

---

## §2 — Remote-MCP NO_PROXY host-local exemption (REAPPLY)

**Intent:** OneCLI injects `HTTPS_PROXY`/certs into every container so API calls
are credential-proxied. But **host-local endpoints** (remote MCP sidecars like
Homestead at the docker gateway, and host Ollama) must be reached **directly**,
not through the proxy. This exempts `host.docker.internal` from `NO_PROXY`,
merging into whatever the gateway/provider already set. Upstream now has the
remote-MCP transport (`{ type: 'http', url }`) natively, but **not** this
exemption — without it, Nova↔Homestead MCP breaks.

**File:** `src/container-runner.ts`

### 2a. Add the function (module scope)

```typescript
/**
 * Ensure `host.docker.internal` is exempt from the proxy env OneCLI injected.
 * Remote MCP sidecars and other host-local endpoints must be reached directly,
 * not via the credential proxy. Merges into an existing `-e NO_PROXY=...` /
 * `-e no_proxy=...` entry rather than clobbering what the gateway (or a
 * provider contribution) set, or appends one when none is set.
 */
export function ensureNoProxyHostGateway(args: string[]): void {
  const HOST = 'host.docker.internal';
  let found = false;
  for (let i = 0; i + 1 < args.length; i++) {
    if (args[i] !== '-e') continue;
    const match = args[i + 1].match(/^(NO_PROXY|no_proxy)=(.*)$/);
    if (!match) continue;
    found = true;
    const values = match[2] ? match[2].split(',') : [];
    if (!values.includes(HOST)) {
      args[i + 1] = `${match[1]}=${[...values, HOST].join(',')}`;
    }
  }
  if (!found) args.push('-e', `NO_PROXY=${HOST}`);
}
```

### 2b. Call it after the OneCLI gateway wiring in `buildContainerArgs`

In the fork it was called right after the OneCLI gateway `apply` step (after the
`log.info('OneCLI gateway applied', …)`), once all `-e` args are assembled:

```typescript
  ensureNoProxyHostGateway(args);
```

Place it after upstream's OneCLI-gateway application and before the container is
spawned, so it can merge into the gateway-set proxy env.

### 2c. Restore the test

```bash
git checkout $BACKUP_TAG -- src/no-proxy-merge.test.ts
```
(Update the import path in the test if upstream moved `container-runner.ts`.)

---

## §3 — config-skills CLI (REAPPLY — forge deploy depends on it)

**Intent:** `ncl groups config set-skills | add-skill | remove-skill` — manage
which container skills an agent group mounts (the `skills` column, `string[] |
'all'`). Used to lock down helper groups; **`forge deploy` relies on `add-skill`
being an idempotent no-op when the group already mounts `'all'`.**

**Files:** `src/cli/resources/skills-util.ts` (+ test), `src/cli/resources/groups.ts`

### 3a. Restore the util + its test verbatim (new files, not upstream)

```bash
git checkout $BACKUP_TAG -- src/cli/resources/skills-util.ts src/cli/resources/skills-util.test.ts
```

### 3b. Wire the three verbs into upstream's `groups config` verb map

Upstream `groups.ts` already has a config verb map (`config get`, `config
update`, `config add-mcp-server`, `config add-mount`, …). Add the import and the
three verb blocks beside `config add-mount`/`remove-mount`.

Import (top of groups.ts):
```typescript
import { parseSkillsArg, addSkill, removeSkill, type Skills } from './skills-util.js';
```

Verb blocks (inside the `config` verb map). These use `getContainerConfig`,
`updateContainerConfigJson` — already imported/used by upstream's own config
verbs, so no new deps:

```typescript
    'config set-skills': {
      access: 'approval',
      description:
        'Set the exact skills a group mounts. Requires `ncl groups restart --rebuild` to take effect. ' +
        'Use --id <group-id> and --skills all (mount every skill) or --skills "a,b,c" (or a JSON array) ' +
        'to mount exactly those.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        if (args.skills === undefined)
          throw new Error('--skills is required (use "all", a comma-separated list, or a JSON array)');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        const value = parseSkillsArg(String(args.skills));
        updateContainerConfigJson(id, 'skills', value);
        return { skills: value, note: 'Run `ncl groups restart --rebuild` to remount.' };
      },
    },
    'config add-skill': {
      access: 'approval',
      description:
        "Add a skill to a group's mount list. Requires `ncl groups restart --rebuild` to take effect. " +
        'Use --id <group-id> --skill <skill-name>. If the group mounts "all" skills, the skill is already ' +
        'included (no-op).',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const skill = args.skill as string;
        if (!skill) throw new Error('--skill is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        const result = addSkill(JSON.parse(row.skills) as Skills, skill);
        if (result.added) updateContainerConfigJson(id, 'skills', result.skills);
        return result;
      },
    },
    'config remove-skill': {
      access: 'approval',
      description:
        "Remove a skill from a group's mount list. Requires `ncl groups restart --rebuild` to take effect. " +
        'Use --id <group-id> --skill <skill-name>. Not valid when the group mounts "all" — use ' +
        '`config set-skills` to pin an explicit list first.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const skill = args.skill as string;
        if (!skill) throw new Error('--skill is required');
        const row = getContainerConfig(id);
        if (!row) throw new Error(`No container config for group: ${id}`);
        const result = removeSkill(JSON.parse(row.skills) as Skills, skill);
        updateContainerConfigJson(id, 'skills', result.skills);
        return { ...result, note: 'Run `ncl groups restart --rebuild` to remount.' };
      },
    },
```

**Verify:** `ncl groups config add-skill --id <g> --skill kingdom-death-wiki` on
a group that mounts `'all'` returns `added:false` without error (the `forge
deploy` contract).

---

## §4 — Fork docs (KEEP — restore from backup)

`README.md` and `CLAUDE.md` are the personal-fork versions (fork README replaces
upstream's; `CLAUDE.md` carries the KDM/helper/OneCLI/mnemon gotchas). Restore
over upstream's:

```bash
git checkout $BACKUP_TAG -- README.md CLAUDE.md
```

**Review after restore:** upstream `CLAUDE.md` may document new subsystems worth
folding in (memory module, remote-MCP, per-group provider config). Diff and hand-
merge any genuinely new upstream sections into the fork `CLAUDE.md` rather than
losing them. This is a docs merge, not code — low risk.

> Not reapplied here: `groups/*/CLAUDE.md` — not tracked at HEAD and absent on
> disk. The live agent personas are untracked runtime data on `.100`, preserved
> automatically by `git reset --hard` during rollout.

---

## §5 — Task `context_mode` (REAPPLY — not in upstream)

**Intent:** Per-scheduled-task control over how much prior conversation a task
sees when it fires. Ported from v1's `scheduled_tasks.context_mode`. Values:
- `full` (default / NULL) — keep the SDK continuation, inject nothing extra.
- `none` — drop continuation; only the task itself is shown (fresh window).
- `recent` — drop continuation; prepend up to `RECENT_CONTEXT_LIMIT` (10) prior
  inbound chat rows as accumulated context.

Most-restrictive wins in a mixed batch. Chat-only batches always resolve `full`.

**Not in upstream** (verified against `upstream/main`). These files have
diverged upstream, so reapply by intent + the verbatim functions below. Exact
original hunks are always retrievable: `git diff 8d57bdfa 32e1cbd7 -- <file>`.

### 5a. Schema — add the column (two DBs)

- **Central** `src/db/schema.ts`: add `context_mode TEXT` to the `messages_in`
  `CREATE TABLE`.
- **Per-session** `src/db/session-db.ts`: idempotent migration on inbound.db:
  ```typescript
  if (!cols.has('context_mode')) {
    db.prepare('ALTER TABLE messages_in ADD COLUMN context_mode TEXT').run();
  }
  ```

### 5b. Scheduling — type + set on task rows

`src/modules/scheduling/db.ts`:
```typescript
// NULL/undefined means 'full'.
export type TaskContextMode = 'none' | 'recent' | 'full';
```
Carry `contextMode` (default `null`) into the task's `messages_in` INSERT and
into each recurrence occurrence's INSERT (`context_mode` column, `@contextMode` /
`msg.context_mode ?? null`).

`src/modules/scheduling/actions.ts`:
```typescript
const VALID_CONTEXT_MODES: ReadonlySet<TaskContextMode> = new Set(['none', 'recent', 'full']);
function coerceContextMode(value: unknown): TaskContextMode | null {
  return (VALID_CONTEXT_MODES as Set<string>).has(value) ? (value as TaskContextMode) : null;
}
// in the create-task handler:
const contextMode = coerceContextMode(content.contextMode);
```
Pass `contextMode` through to the scheduling db insert. (Expose `contextMode` on
the `schedule_task` MCP tool input if the fork did — check the tool schema.)

### 5c. Agent-runner — read + apply

`container/agent-runner/src/db/messages-in.ts`: add to `MessageInRow`:
```typescript
  context_mode?: string | null;
```

`container/agent-runner/src/formatter.ts`: add these two functions and call them
in `formatMessagesForFiring` (resolve the mode; if `none`/`recent`, drop the SDK
continuation; for `recent`, prepend the fetched rows):

```typescript
import { openInboundDb } from './db/connection.js';

/** Number of prior inbound rows to include when context_mode='recent'. */
const RECENT_CONTEXT_LIMIT = 10;

export type EffectiveTaskContextMode = 'none' | 'recent' | 'full';

/**
 * Most-restrictive mode wins across task rows in a batch; NULL/unknown => 'full'.
 * Chat-only batches (no task rows) resolve 'full'.
 */
export function resolveTaskContextMode(messages: MessageInRow[]): EffectiveTaskContextMode {
  let result: EffectiveTaskContextMode = 'full';
  for (const m of messages) {
    if (m.kind !== 'task') continue;
    const mode = m.context_mode;
    if (mode === 'none') return 'none';
    if (mode === 'recent' && result === 'full') result = 'recent';
  }
  return result;
}

/**
 * Most recent prior inbound rows for 'recent' mode. Excludes the firing batch
 * (by id), skips system (MCP-response) and task rows. Chronological (oldest
 * first). Errors -> [] (task still fires, just without the preamble).
 */
export function fetchRecentContextRows(excludeIds: string[]): MessageInRow[] {
  let db: ReturnType<typeof openInboundDb> | null = null;
  try {
    db = openInboundDb();
    const placeholders = excludeIds.length > 0 ? excludeIds.map(() => '?').join(',') : "''";
    const rows = db
      .prepare(
        `SELECT * FROM messages_in
         WHERE id NOT IN (${placeholders})
           AND kind NOT IN ('task','system')
         ORDER BY seq DESC LIMIT ?`,
      )
      .all(...excludeIds, RECENT_CONTEXT_LIMIT) as MessageInRow[];
    return rows.reverse();
  } catch {
    return [];
  } finally {
    db?.close?.();
  }
}
```
> The `SELECT` above is reconstructed from the fork's behavior — confirm the
> exact WHERE/columns against `git show 32e1cbd7:container/agent-runner/src/formatter.ts`
> when applying, since upstream's row shape may differ.

Wiring in `formatMessagesForFiring`: `const mode = resolveTaskContextMode(messages);`
then for `none`/`recent` suppress the continuation, and for `recent` prepend
`fetchRecentContextRows(messages.map(m => m.id))` formatted as context.

**Verify:** a task row with `context_mode='none'` fires with no prior-turn
continuation; `'recent'` prepends ≤10 prior chat rows; absent/`'full'` behaves
exactly as upstream default.

---

## §6 — pdf-reader container skill (KEEP — copy from backup)

**Intent:** PDF text extraction available to agents (e.g. Nova reading PDF email
attachments). Custom v1-ported skill; not in any upstream branch.

**Restore into the worktree:**
```bash
git checkout $BACKUP_TAG -- container/skills/pdf-reader
```
`container/skills/` is bind-mounted into every container at `/app/skills`, so no
image rebuild is needed for the skill content — but confirm the `pdf-reader`
binary/interpreter it shells out to is present in the container image (check the
Dockerfile; if the fork added a pdf tool there, that Dockerfile line must also be
reapplied — grep the backup Dockerfile for the pdf dependency).

