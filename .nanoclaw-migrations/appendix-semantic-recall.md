# Appendix (OPTIONAL) — semantic mnemon recall via host Ollama

**Not applied by default.** The migration adopts upstream `/add-mnemon`
(keyword/graph recall). This appendix restores Kevin's original enhancement:
ranking recalled memories by **meaning** using an embedding model on the host
Ollama. Apply only if keyword recall feels noticeably worse.

**Tradeoffs (why it's off by default):** adds a live per-turn dependency on host
Ollama being loadable; Ollama contends with ComfyUI for 16GB VRAM; it fails open
to keyword scoring when Ollama is busy — so half the time it degrades to the
default anyway.

**Prereq:** upstream `/add-mnemon` installed, and the `mnemon` binary supports
`MNEMON_EMBED_ENDPOINT` (check the installed mnemon version). Host-side keeps
stored vectors current with a periodic `mnemon embed` (cron/manual).

## How the original worked

The fork ran `mnemon recall <prompt>` inside the container's `UserPromptSubmit`
hook, pointing the embedder at host Ollama on the docker gateway, then injected
the top matches. Because we now inject helper directives from a programmatic
`UserPromptSubmit` hook (customizations.md §1b), the recall call can be added to
that same hook.

Add inside `helperUserPromptSubmitHook`, after computing `helperBlocks` and
before building `additionalContext`:

```typescript
  // Semantic recall (optional): rank stored memories by meaning via host Ollama.
  let recalled = '';
  if (process.env.MNEMON_DATA_DIR && prompt.length >= 3) {
    try {
      const { stdout } = await execFileAsync('mnemon', ['recall', prompt], {
        timeout: 8000,
        maxBuffer: 4 * 1024 * 1024,
        // mnemon's Ollama client ignores HTTP(S)_PROXY, so it reaches the gateway
        // directly despite the OneCLI proxy. If Ollama is unreachable, recall
        // transparently falls back to keyword/graph scoring.
        env: {
          ...process.env,
          MNEMON_EMBED_ENDPOINT: process.env.MNEMON_EMBED_ENDPOINT || 'http://host.docker.internal:11434',
        },
      });
      const results = (JSON.parse(stdout)?.results ?? []) as Array<{ content?: string; score?: number }>;
      const lines = results
        .filter((r) => typeof r.content === 'string' && (r.score ?? 0) >= 0.25)
        .slice(0, 8)
        .map((r) => `- ${r.content}`);
      if (lines.length > 0) {
        recalled = `Relevant long-term memory (from your persistent memory store; use what's relevant, ignore what isn't):\n${lines.join('\n')}`;
      }
    } catch (err) {
      log(`mnemon recall skipped: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
```

Then include `recalled` in the join (helper directives first, then recall):

```typescript
  const additionalContext = [...helperBlocks, recalled].filter(Boolean).join('\n\n');
```

Requires `import { execFile } from 'child_process'` + `const execFileAsync =
promisify(execFile)` (from `util`) at the top of claude.ts.

## The remember directive (also dropped by default)

The fork additionally nudged the model to persist durable facts via `mnemon
remember`. **Check whether upstream `/add-mnemon` already provides a
remember/write path** (its native memory hook likely does) before re-adding this
— don't double-instruct. If upstream does NOT prompt writes, the original nudge
was:

```typescript
const MNEMON_REMEMBER_DIRECTIVE = [
  'Persistent memory — writing: after you finish handling this message, judge whether the user shared anything durable worth keeping long-term (a stable preference, a fact about them or the people/projects in their life, a decision, or lasting context). If so, store it — silently, via the Bash tool, without telling the user — by running:',
  "  mnemon remember '<one concise sentence>' --cat <preference|fact|decision|context|insight> --source agent --entities '<comma-separated names, if any>'",
  "Store at most the one or two most important items. Do NOT store: small talk, transient or operational state (what is/isn't running right now, errors, one-off task status), anything already in memory, or anything the user asked you not to keep. Run nothing when nothing durable came up.",
].join('\n');
```

Append it to the `additionalContext` join if used.
