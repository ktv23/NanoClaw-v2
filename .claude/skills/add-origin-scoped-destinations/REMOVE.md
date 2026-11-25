# Remove origin-scoped destinations

## 1. Remove the reach-in

In `src/modules/agent-to-agent/write-destinations.ts`, delete the import line:

```ts
import { scopeToSessionOrigin } from './origin-scope.js';
```

and restore the first line of `writeDestinations` to:

```ts
  const rows = await getDestinations(agentGroupId);
```

## 2. Remove the copied files

```bash
rm -f src/modules/agent-to-agent/origin-scope.ts src/modules/agent-to-agent/origin-scope.test.ts
```

## 3. Build and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

Each session lists every channel of its agent group again the next time its container starts.
