/**
 * Integration-point test: the Claude provider registers the lookup-helper hook
 * under UserPromptSubmit. Captures the options the real provider hands the SDK
 * and runs the registered hook; goes red if the registration line is removed
 * from providers/claude.ts.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type HookFn = (input: unknown, toolUseId: undefined, opts: { signal: AbortSignal }) => Promise<unknown>;
interface CapturedOptions {
  hooks?: Record<string, Array<{ hooks: HookFn[] }>>;
}

const captured: CapturedOptions[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: CapturedOptions }) => {
    captured.push(options);
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: 'ok' };
    })();
  },
}));

const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
await import('../providers/index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('../providers/factory.js');
const { resetHelperDirectivesForTest } = await import('./directives.js');
const { setCurrentTurn } = await import('./trigger-match.js');

let dir: string | undefined;

afterEach(() => {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  resetHelperDirectivesForTest();
  setCurrentTurn(null);
});

describe('lookup-helper hook wiring in the Claude provider', () => {
  it('registers a UserPromptSubmit hook that injects the matching directive', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lookup-claude-hook-'));
    fs.mkdirSync(path.join(dir, 'kdm'));
    fs.writeFileSync(path.join(dir, 'kdm', 'helper.json'), JSON.stringify({ trigger: 'kdm', directive: 'KDM RULES' }));
    resetHelperDirectivesForTest(dir);
    setCurrentTurn(null);

    captured.length = 0;
    const provider = createProvider('claude', {});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    provider.query({ prompt: 'first', cwd: '/workspace/agent' });

    expect(captured).toHaveLength(1);
    const registered = captured[0]!.hooks?.UserPromptSubmit ?? [];
    const hooks = registered.flatMap((entry) => entry.hooks);
    expect(hooks.length).toBeGreaterThan(0);

    const outputs = await Promise.all(
      hooks.map((hook) =>
        hook({ hook_event_name: 'UserPromptSubmit', prompt: '<message sender="a">kdm white lion</message>' }, undefined, {
          signal: new AbortController().signal,
        }),
      ),
    );
    const contexts = outputs.map(
      (o) => (o as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext,
    );
    expect(contexts).toContain('KDM RULES');
  });
});
