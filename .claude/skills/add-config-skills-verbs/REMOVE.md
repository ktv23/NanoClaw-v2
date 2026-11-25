# Remove the skill-selection verbs

## 1. Remove the reach-in

In `src/cli/resources/groups.ts`, delete the import line:

```ts
import { skillsConfigOperations } from './groups-skills-config.js';
```

and the spread at the top of `customOperations`:

```ts
    ...skillsConfigOperations,
```

## 2. Remove the copied files

```bash
rm -f src/cli/resources/skills-util.ts src/cli/resources/skills-util.test.ts
rm -f src/cli/resources/groups-skills-config.ts src/cli/resources/groups-skills-config.test.ts
```

## 3. Build and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

Each group keeps the selection it had. Without these verbs a selection can only be changed by editing the group's container config row.
