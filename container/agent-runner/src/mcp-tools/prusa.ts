/**
 * Prusa printer MCP tools (read-only).
 * Queries a local PrusaLink instance (MK3S OctoPrint-compatible API).
 * Credentials read from PRUSA_URL and PRUSA_API_KEY environment variables.
 */
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const PRUSA_URL = (process.env.PRUSA_URL || '').replace(/\/$/, '');
const PRUSA_API_KEY = process.env.PRUSA_API_KEY || '';

async function prusaGet(path: string): Promise<unknown> {
  if (!PRUSA_URL || !PRUSA_API_KEY) {
    throw new Error('PRUSA_URL and PRUSA_API_KEY must be set');
  }
  const resp = await fetch(`${PRUSA_URL}${path}`, {
    headers: { 'X-Api-Key': PRUSA_API_KEY },
  });
  if (!resp.ok) {
    throw new Error(`PrusaLink API error ${resp.status}: ${await resp.text()}`);
  }
  return resp.json();
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

const prusaStatus: McpToolDefinition = {
  tool: {
    name: 'prusa_status',
    description:
      'Get current Prusa printer state and temperatures (nozzle, bed). Returns operational state (Printing, Idle, Paused, Error, etc.) and actual vs. target temperatures.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    try {
      const data = (await prusaGet('/api/printer')) as {
        temperature?: {
          tool0?: { actual?: number; target?: number };
          bed?: { actual?: number; target?: number };
        };
        state?: { text?: string };
      };
      const state = data.state?.text ?? 'Unknown';
      const nozzleActual = data.temperature?.tool0?.actual ?? null;
      const nozzleTarget = data.temperature?.tool0?.target ?? null;
      const bedActual = data.temperature?.bed?.actual ?? null;
      const bedTarget = data.temperature?.bed?.target ?? null;

      const lines = [
        `State: ${state}`,
        `Nozzle: ${nozzleActual !== null ? `${nozzleActual.toFixed(1)}°C` : 'N/A'}${nozzleTarget ? ` (target ${nozzleTarget.toFixed(1)}°C)` : ''}`,
        `Bed: ${bedActual !== null ? `${bedActual.toFixed(1)}°C` : 'N/A'}${bedTarget ? ` (target ${bedTarget.toFixed(1)}°C)` : ''}`,
      ];
      return ok(lines.join('\n'));
    } catch (e) {
      return errResult(String(e));
    }
  },
};

const prusaJob: McpToolDefinition = {
  tool: {
    name: 'prusa_job',
    description:
      'Get the current Prusa print job: filename, progress percentage, time elapsed, and estimated time remaining. Returns a message if no job is active.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    try {
      const data = (await prusaGet('/api/job')) as {
        state?: string;
        job?: { file?: { name?: string }; estimatedPrintTime?: number };
        progress?: { completion?: number; printTime?: number; printTimeLeft?: number };
      };

      if (!data.job?.file?.name || data.state === 'Operational') {
        return ok('No active print job.');
      }

      const filename = data.job.file.name;
      const completion = data.progress?.completion;
      const elapsed = data.progress?.printTime;
      const remaining = data.progress?.printTimeLeft;

      const fmt = (secs: number | undefined): string => {
        if (secs == null) return 'N/A';
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        return h > 0 ? `${h}h ${m}m` : `${m}m`;
      };

      const lines = [
        `File: ${filename}`,
        `State: ${data.state ?? 'Unknown'}`,
        `Progress: ${completion != null ? `${(completion * 100).toFixed(1)}%` : 'N/A'}`,
        `Elapsed: ${fmt(elapsed)}`,
        `Remaining: ${fmt(remaining)}`,
      ];
      return ok(lines.join('\n'));
    } catch (e) {
      return errResult(String(e));
    }
  },
};

const prusaFiles: McpToolDefinition = {
  tool: {
    name: 'prusa_files',
    description:
      'List files available on the Prusa printer storage (local SD/USB). Returns filenames and sizes.',
    inputSchema: { type: 'object' as const, properties: {} },
  },
  async handler() {
    try {
      const data = (await prusaGet('/api/files?recursive=true')) as {
        files?: Array<{ name?: string; size?: number; type?: string }>;
      };

      const files = (data.files ?? []).filter((f) => f.type !== 'folder');
      if (files.length === 0) {
        return ok('No files found on printer storage.');
      }

      const lines = files.map((f) => {
        const size = f.size != null ? ` (${(f.size / 1024).toFixed(0)} KB)` : '';
        return `${f.name ?? 'unknown'}${size}`;
      });
      return ok(lines.join('\n'));
    } catch (e) {
      return errResult(String(e));
    }
  },
};

registerTools([prusaStatus, prusaJob, prusaFiles]);
