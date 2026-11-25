/**
 * Integration-point test: every agent container's contributed environment
 * exempts `host.docker.internal` from the gateway's proxy. Drives the real
 * `composeSessionSpec`; goes red if the `withHostGatewayNoProxy` call is
 * removed from container-runner.ts.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ContainerConfig } from './container-config.js';
import { composeSessionSpec } from './container-runner.js';
import { resetGatewayProvider } from './gateway-providers/index.js';
import { withHostGatewayNoProxy } from './host-gateway-no-proxy.js';
import type { VolumeMount } from './providers/provider-container-registry.js';
import type { AgentGroup, Session } from './types.js';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

afterEach(() => resetGatewayProvider());

const agentGroup = {
  id: 'agent-1',
  name: 'Agent One',
  folder: 'agent-one',
  agent_provider: null,
  created_at: '2026-07-22T00:00:00.000Z',
} as AgentGroup;

const session = {
  id: 'session-1',
  agent_group_id: 'agent-1',
  messaging_group_id: 'messaging-1',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-07-22T00:00:00.000Z',
} as Session;

const containerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: [],
} as unknown as ContainerConfig;

const mounts: VolumeMount[] = [
  {
    hostPath: '/install/data/v2-sessions/agent-1/session-1',
    containerPath: '/workspace',
    readonly: false,
    mountClass: 'group-state',
    scope: 'agent-1',
  },
];

function contributedEnv(gatewayEnv?: Record<string, string>, contributionEnv?: Record<string, string>) {
  const spec = composeSessionSpec({
    agentGroup,
    session,
    containerName: 'nanoclaw-v2-agent-one-1700000000000',
    mounts,
    containerConfig,
    mailboxEnvironment: { NANOCLAW_MAILBOX_BACKEND: 'sqlite' },
    contribution: { env: contributionEnv } as never,
    gateway: {
      networkAccess: { endpoint: 'localhost', target: { kind: 'host' } },
      env: gatewayEnv,
    } as never,
  });
  const agent = spec.containers.find((c) => c.role === 'agent');
  if (!agent) throw new Error('no agent container in the composed spec');
  return agent.contributedEnv ?? {};
}

describe('host-gateway proxy exemption in the composed session spec', () => {
  it("merges host.docker.internal into the gateway's NO_PROXY without replacing it", () => {
    const env = contributedEnv({ HTTPS_PROXY: 'http://gateway:10255', NO_PROXY: 'localhost,127.0.0.1' });
    expect(env.NO_PROXY).toBe('localhost,127.0.0.1,host.docker.internal');
    expect(env.HTTPS_PROXY).toBe('http://gateway:10255');
  });

  it('sets NO_PROXY when the gateway contributes a proxy and no exemption list', () => {
    const env = contributedEnv({ HTTPS_PROXY: 'http://gateway:10255' });
    expect(env.NO_PROXY).toBe('host.docker.internal');
  });

  it('extends a lowercase no_proxy in place', () => {
    const env = contributedEnv({ no_proxy: 'localhost' });
    expect(env.no_proxy).toBe('localhost,host.docker.internal');
    expect(env.NO_PROXY).toBeUndefined();
  });

  it("applies to the model provider's contribution as well", () => {
    const env = contributedEnv(undefined, { NO_PROXY: 'internal.example' });
    expect(env.NO_PROXY).toBe('internal.example,host.docker.internal');
  });
});

describe('withHostGatewayNoProxy', () => {
  it('does not duplicate an entry that is already there', () => {
    expect(withHostGatewayNoProxy({ NO_PROXY: 'a,host.docker.internal' }).NO_PROXY).toBe('a,host.docker.internal');
  });

  it('handles an empty exemption list', () => {
    expect(withHostGatewayNoProxy({ NO_PROXY: '' }).NO_PROXY).toBe('host.docker.internal');
  });

  it('does not mutate its input', () => {
    const input = { NO_PROXY: 'a' };
    withHostGatewayNoProxy(input);
    expect(input.NO_PROXY).toBe('a');
  });
});
