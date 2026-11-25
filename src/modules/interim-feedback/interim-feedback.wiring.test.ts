/**
 * Integration-point test: the modules barrel loads interim feedback, which
 * puts its start and stop on the host lifecycle. Imports only the real barrel;
 * goes red if the barrel line is removed.
 */
import { describe, expect, it } from 'vitest';

import { getHostShutdownCallbacks, getHostStartCallbacks } from '../../host-lifecycle.js';
// The real barrel, and nothing from this module directly.
import '../index.js';

describe('interim feedback registration', () => {
  it('starts with the host', () => {
    expect(getHostStartCallbacks().map((cb) => cb.name)).toContain('startInterimFeedbackModule');
  });

  it('stops on host shutdown', () => {
    expect(getHostShutdownCallbacks().map((cb) => cb.name)).toContain('stopInterimFeedback');
  });
});
