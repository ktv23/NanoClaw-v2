# Remove interim feedback

## 1. Remove the reach-ins

In `src/delivery.ts`, delete this line from `failDelivery`:

```ts
    void (await import('./modules/interim-feedback/delivery-failure.js')).notifyDeliveryFailure(session, msg, err);
```

In `src/modules/index.ts`, delete:

```ts
import './interim-feedback/index.js';
```

## 2. Remove the copied files

```bash
rm -rf src/modules/interim-feedback
```

## 3. Build and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

Slow turns are silent again apart from the typing indicator, and an agent is no longer told when a reply is given up on.
