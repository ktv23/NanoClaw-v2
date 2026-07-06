/**
 * Unit tests for ensureNoProxyHostGateway — remote MCP sidecars (and other
 * host-local endpoints) must bypass the OneCLI credential proxy, without
 * clobbering any NO_PROXY the gateway itself injected.
 */
import { describe, it, expect } from 'vitest';

import { ensureNoProxyHostGateway } from './container-runner.js';

describe('ensureNoProxyHostGateway', () => {
  it('appends NO_PROXY when the gateway set none', () => {
    const args = ['run', '-e', 'HTTPS_PROXY=http://172.17.0.1:10255'];
    ensureNoProxyHostGateway(args);
    expect(args).toContain('NO_PROXY=host.docker.internal');
  });

  it('merges into an existing NO_PROXY instead of clobbering it', () => {
    const args = ['run', '-e', 'NO_PROXY=localhost,127.0.0.1'];
    ensureNoProxyHostGateway(args);
    expect(args[2]).toBe('NO_PROXY=localhost,127.0.0.1,host.docker.internal');
  });

  it('respects lowercase no_proxy entries', () => {
    const args = ['run', '-e', 'no_proxy=localhost'];
    ensureNoProxyHostGateway(args);
    expect(args[2]).toBe('no_proxy=localhost,host.docker.internal');
    // No duplicate uppercase entry appended.
    expect(args.filter((a) => a.startsWith('NO_PROXY='))).toHaveLength(0);
  });

  it('is idempotent when the host is already exempt', () => {
    const args = ['run', '-e', 'NO_PROXY=host.docker.internal'];
    ensureNoProxyHostGateway(args);
    expect(args[2]).toBe('NO_PROXY=host.docker.internal');
    expect(args).toHaveLength(3);
  });

  it('does not mistake non-env args for entries', () => {
    const args = ['run', '-v', 'NO_PROXY=weird:/mount'];
    ensureNoProxyHostGateway(args);
    expect(args).toContain('NO_PROXY=host.docker.internal');
    expect(args[2]).toBe('NO_PROXY=weird:/mount');
  });
});
