/**
 * Dependency guard for the Gmail and Google Calendar MCP servers (host tree,
 * vitest).
 *
 * add-google-mcp-tools installs both servers into the agent image by adding
 * entries to `container/cli-tools.json`. A globally installed CLI is not
 * importable or typed, so neither `tsc` nor a runtime import can catch its
 * removal; only an image build would. This structural test stands in for that
 * leg: it goes red if an entry is dropped or loses its exact pin.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

/** Repo root: the dir holding container/, wherever this file is copied to. */
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'container', 'cli-tools.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('container/cli-tools.json not found walking up from ' + __dirname);
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

describe('the Gmail and Google Calendar MCP servers are installed in the agent image', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'container', 'cli-tools.json'), 'utf8')) as Array<{
    name: string;
    version: string;
  }>;
  const entry = (name: string) => manifest.find((t) => t.name === name);

  it.each(['@gongrzhe/server-gmail-autoauth-mcp', '@cocal/google-calendar-mcp'])(
    '%s is in the CLI manifest, pinned to an exact version',
    (name) => {
      expect(entry(name)?.version).toMatch(EXACT_VERSION);
    },
  );

  it('pins zod-to-json-schema beside the Gmail server', () => {
    // The Gmail server declares `zod-to-json-schema: ^3.22.1` and `zod: ^3.22.4`.
    // Left to resolve freely, zod-to-json-schema takes a 3.25 release that
    // imports `zod/v3`, a subpath only zod >= 3.25 has, while zod resolves to
    // 3.24: the server dies at import with ERR_PACKAGE_PATH_NOT_EXPORTED. One
    // install command covers the whole manifest, so listing the pin here holds it.
    expect(entry('zod-to-json-schema')?.version).toBe('3.22.5');
  });
});
