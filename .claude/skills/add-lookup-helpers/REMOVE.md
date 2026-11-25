# Remove lookup helpers

Reverses every change `add-lookup-helpers` makes. Helper content skills under `container/skills/` are not part of this skill and stay where they are; without the runtime their `helper.json` files are inert.

## 1. Remove the reach-ins

In `container/agent-runner/src/providers/claude.ts`, delete the import line and the hook entry:

```ts
import { lookupHelperPromptHook } from '../lookup-helpers/directives.js';
```

```ts
          UserPromptSubmit: [{ hooks: [lookupHelperPromptHook] }],
```

In `container/agent-runner/src/poll-loop.ts`, delete both marker blocks, from each `// MODULE-HOOK:lookup-gate…:start` line through its matching `:end` line.

In `src/container-runner.ts`, delete the import line:

```ts
import { withoutLockdownSkills } from './lookup-lockdown.js';
```

and restore the selection in `selectedSkillNames` to:

```ts
  const selected = containerConfig.skills === 'all' ? available : containerConfig.skills;
```

## 2. Remove the copied files

```bash
rm -rf container/agent-runner/src/lookup-helpers
rm -f src/lookup-lockdown.ts src/lookup-lockdown.test.ts
```

## 3. Build and restart

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
bash setup/lib/restart.sh
```

A group that listed a gatekeeper skill is no longer locked down once its container restarts: every message reaches the model. Remove such a group's wiring first if that is not wanted.
