---
name: add-google-mcp-tools
description: Add Gmail and Google Calendar as MCP tools for an agent group. Installs the two MCP servers in the agent image and documents the per-group wiring; the credential gateway injects the real Google tokens, so the container only ever holds placeholders. Use when an agent should read or send mail, or read or change calendar events.
---

# Add Gmail and Google Calendar tools

Two stdio MCP servers give an agent Google tools:

| Server | Package | Binary |
|---|---|---|
| Gmail | `@gongrzhe/server-gmail-autoauth-mcp` | `gmail-mcp` |
| Google Calendar | `@cocal/google-calendar-mcp` | `google-calendar-mcp` |

Each server reads OAuth files from disk at startup. Those files hold the placeholder `onecli-managed`, never a real token: the credential gateway swaps in the real Google token on each request to Google's APIs.

This skill has two parts. **Apply** installs the servers in the agent image; that is the only change to the source tree. **Wire a group** is runtime configuration on the install, repeated for each group that should have the tools.

## Apply

### 1. Add the servers to the CLI manifest

Check what is already there:

```bash
grep -c -E '"@gongrzhe/server-gmail-autoauth-mcp"|"zod-to-json-schema"|"@cocal/google-calendar-mcp"' container/cli-tools.json
```

If it prints `3`, skip to step 2. Otherwise append the missing entries to the array in `container/cli-tools.json`, each pinned to an exact version:

```json
{ "name": "@gongrzhe/server-gmail-autoauth-mcp", "version": "1.1.11" },
{ "name": "zod-to-json-schema", "version": "3.22.5" },
{ "name": "@cocal/google-calendar-mcp", "version": "2.6.1" }
```

`zod-to-json-schema` is pinned beside the Gmail server on purpose. Resolved freely it takes a release that imports `zod/v3`, which the `zod` the Gmail server resolves to does not have, and the server dies at import with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Revisit the pin whenever the Gmail server's version changes.

### 2. Copy the test and run it

```bash
cp .claude/skills/add-google-mcp-tools/google-mcp-tools.test.ts src/google-mcp-tools.test.ts
pnpm exec vitest run src/google-mcp-tools.test.ts
```

The test goes red if an entry is dropped or loses its exact pin. A globally installed CLI cannot be imported or type-checked, so this structural test is its guard.

### 3. Rebuild the agent image

```bash
./container/build.sh
```

Confirm the binaries are in the image (the build prints the tag it produced):

```bash
docker run --rm --entrypoint sh <image-tag> -c 'command -v gmail-mcp google-calendar-mcp'
```

## Wire a group

These steps change the install, not the source tree, so no test in the tree can cover them.

### 1. Create the placeholder OAuth files

If `~/.gmail-mcp/credentials.json` exists and does not contain `onecli-managed`, stop: it holds real credentials from an older setup. Back the directory up and remove it first. The same goes for `~/.calendar-mcp`.

```bash
mkdir -p ~/.gmail-mcp
cat > ~/.gmail-mcp/gcp-oauth.keys.json <<'JSON'
{
  "installed": {
    "client_id": "onecli-managed.apps.googleusercontent.com",
    "client_secret": "onecli-managed",
    "redirect_uris": ["http://localhost:3000/oauth2callback"]
  }
}
JSON
cat > ~/.gmail-mcp/credentials.json <<'JSON'
{
  "access_token": "onecli-managed",
  "refresh_token": "onecli-managed",
  "token_type": "Bearer",
  "expiry_date": 99999999999999,
  "scope": "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/gmail.send"
}
JSON

mkdir -p ~/.calendar-mcp
cat > ~/.calendar-mcp/gcp-oauth.keys.json <<'JSON'
{
  "installed": {
    "client_id": "onecli-managed.apps.googleusercontent.com",
    "client_secret": "onecli-managed",
    "redirect_uris": ["http://localhost:3000/oauth2callback"]
  }
}
JSON
cat > ~/.calendar-mcp/credentials.json <<'JSON'
{
  "access_token": "onecli-managed",
  "refresh_token": "onecli-managed",
  "token_type": "Bearer",
  "expiry_date": 99999999999999,
  "scope": "https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/calendar.events"
}
JSON

chmod 600 ~/.gmail-mcp/*.json ~/.calendar-mcp/*.json
```

### 2. Mount them into the group

The parent of both directories must be in the mount allowlist (`/manage-mounts`). Then:

```bash
ncl groups config add-mount --id <group-id> --host "$HOME/.gmail-mcp" --container .gmail-mcp
ncl groups config add-mount --id <group-id> --host "$HOME/.calendar-mcp" --container .calendar-mcp
```

A relative container path lands under `/workspace/extra/`.

### 3. Register the MCP servers

```bash
ncl groups config add-mcp-server --id <group-id> --name gmail --command gmail-mcp \
  --env '{"GMAIL_OAUTH_PATH":"/workspace/extra/.gmail-mcp/gcp-oauth.keys.json","GMAIL_CREDENTIALS_PATH":"/workspace/extra/.gmail-mcp/credentials.json"}'
ncl groups config add-mcp-server --id <group-id> --name calendar --command google-calendar-mcp \
  --env '{"GOOGLE_OAUTH_CREDENTIALS":"/workspace/extra/.calendar-mcp/gcp-oauth.keys.json","GOOGLE_CALENDAR_MCP_TOKEN_PATH":"/workspace/extra/.calendar-mcp/credentials.json"}'
```

### 4. Connect Google in the gateway and restart the group

Connect Gmail and Google Calendar in the credential gateway and grant them to this group's agent; the installed gateway's skill explains how. Then:

```bash
ncl groups restart --id <group-id>
```

Ask the agent to list your Gmail labels and your calendars. Both answers come from Google, so both prove the tokens are being injected.

## Troubleshooting

- **`ERR_PACKAGE_PATH_NOT_EXPORTED` when the Gmail server starts.** The `zod-to-json-schema` pin is missing from the manifest, or the image was not rebuilt after it was added.
- **`ENOENT … /workspace/extra/.gmail-mcp/credentials.json`.** The mount was rejected. The host log shows `Additional mount REJECTED` with the reason; the usual one is a parent directory missing from the mount allowlist.
- **`401` or `invalid_grant` from Google.** The gateway is not injecting a token for this agent. Check the Google connection is granted to this group's agent in the gateway.
