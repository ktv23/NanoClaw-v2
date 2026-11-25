---
name: add-host-gateway-noproxy
description: Let agent containers reach services on the Docker host directly instead of through the credential gateway's proxy. Adds host.docker.internal to every agent container's NO_PROXY. Use when an MCP server or local model server at host.docker.internal times out or fails only from inside agent containers.
---

# Add the host-gateway proxy exemption

The credential gateway routes an agent container's HTTP traffic through its proxy. A service on the Docker host that an agent reaches as `host.docker.internal` (a remote MCP sidecar, a local model server) should not go through that proxy: the gateway holds no credential for it and may not be able to reach a host-only address.

This skill adds `host.docker.internal` to the `NO_PROXY` of every agent container. It merges into the list the gateway or the model provider contributes, in whichever spelling they use, and sets `NO_PROXY` when neither contributes one.

## Apply

### 1. Copy the skill's files

```bash
S=.claude/skills/add-host-gateway-noproxy
cp $S/host-gateway-no-proxy.ts $S/host-gateway-no-proxy.test.ts src/
```

### 2. Wrap the contributed environment

In `src/container-runner.ts`, import the helper alongside the other local imports:

```ts
import { withHostGatewayNoProxy } from './host-gateway-no-proxy.js';
```

Then, in `composeSessionSpec`, wrap the `contributedEnv` literal:

```ts
  const contributedEnv: Record<string, string> = withHostGatewayNoProxy({
    ...(contribution.env ?? {}),
    ...(gateway.env ?? {}),
  });
```

Skip both edits if `grep -q withHostGatewayNoProxy src/container-runner.ts` already matches. If another skill has added entries to the literal, keep them inside the wrapped object.

### 3. Build and test

```bash
pnpm run build
pnpm exec vitest run src/host-gateway-no-proxy.test.ts
```

`host-gateway-no-proxy.test.ts` drives the real `composeSessionSpec` and goes red if the wrapper is removed.

The environment is fixed when a container starts, so the exemption reaches each agent the next time its container starts after the host restarts.

## Using it

Point an agent at a host service by its `host.docker.internal` address, for example an MCP server:

```bash
ncl groups config add-mcp-server --id <group-id> --name <name> --url http://host.docker.internal:<port>/mcp
```

The service must listen on an address the Docker bridge can reach (the bridge gateway address or `0.0.0.0`), not only on `127.0.0.1`.

## Troubleshooting

- **The agent still cannot reach the service.** From the host, check the listener is reachable on the bridge address: `curl -s http://172.17.0.1:<port>/health`. A service bound to `127.0.0.1` is invisible to containers.
- **A request to a different host-local name is still proxied.** Only `host.docker.internal` is exempt. Address the service by that name.
