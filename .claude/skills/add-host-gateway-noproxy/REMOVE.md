# Remove the host-gateway proxy exemption

## 1. Remove the reach-in

In `src/container-runner.ts`, delete the import line:

```ts
import { withHostGatewayNoProxy } from './host-gateway-no-proxy.js';
```

and unwrap the `contributedEnv` literal in `composeSessionSpec`, keeping every entry inside it:

```ts
  const contributedEnv: Record<string, string> = {
    ...(contribution.env ?? {}),
    ...(gateway.env ?? {}),
  };
```

## 2. Remove the copied files

```bash
rm -f src/host-gateway-no-proxy.ts src/host-gateway-no-proxy.test.ts
```

## 3. Build and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

Agent traffic to `host.docker.internal` goes through the gateway's proxy again once each container restarts. An MCP server or model server addressed that way may stop responding.
