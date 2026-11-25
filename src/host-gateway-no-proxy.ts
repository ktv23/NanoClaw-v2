/**
 * Exempt the Docker host from the credential gateway's proxy.
 *
 * A credential gateway routes an agent container's HTTP traffic through its
 * proxy. A service on the Docker host that the agent reaches as
 * `host.docker.internal` — a remote MCP sidecar, a local model server — is not
 * something the gateway should carry: it holds no vault credential for it, and
 * the proxy may not be able to reach a host-only address at all. Such traffic
 * must go direct.
 *
 * This merges `host.docker.internal` into whatever NO_PROXY the contributed
 * environment already carries (never replacing it), in each spelling present,
 * and sets `NO_PROXY` when neither is there.
 */
const HOST_GATEWAY = 'host.docker.internal';
const NO_PROXY_KEYS = ['NO_PROXY', 'no_proxy'] as const;

export function withHostGatewayNoProxy(env: Record<string, string>): Record<string, string> {
  const out = { ...env };
  let found = false;
  for (const key of NO_PROXY_KEYS) {
    const current = out[key];
    if (current === undefined) continue;
    found = true;
    const entries = current ? current.split(',') : [];
    if (!entries.includes(HOST_GATEWAY)) out[key] = [...entries, HOST_GATEWAY].join(',');
  }
  if (!found) out.NO_PROXY = HOST_GATEWAY;
  return out;
}
