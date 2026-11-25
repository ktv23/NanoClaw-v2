# Remove Discord thread titles

## 1. Remove the barrel line

In `src/modules/index.ts`, delete:

```ts
import './discord-thread-titles/index.js';
```

## 2. Remove the copied files

```bash
rm -rf src/modules/discord-thread-titles
```

## 3. Build and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

New threads keep the adapter's `Thread <timestamp>` name. Threads already renamed keep their titles.
