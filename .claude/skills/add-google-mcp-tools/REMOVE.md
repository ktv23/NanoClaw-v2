# Remove the Gmail and Google Calendar tools

## 1. Unwire each group that has them

```bash
ncl groups config remove-mcp-server --id <group-id> --name gmail
ncl groups config remove-mcp-server --id <group-id> --name calendar
ncl groups config remove-mount --id <group-id> --host "$HOME/.gmail-mcp" --container .gmail-mcp
ncl groups config remove-mount --id <group-id> --host "$HOME/.calendar-mcp" --container .calendar-mcp
ncl groups restart --id <group-id>
```

## 2. Remove the servers from the image

Delete these three entries from `container/cli-tools.json`:

```json
{ "name": "@gongrzhe/server-gmail-autoauth-mcp", "version": "1.1.11" },
{ "name": "zod-to-json-schema", "version": "3.22.5" },
{ "name": "@cocal/google-calendar-mcp", "version": "2.6.1" }
```

Then remove the test and rebuild:

```bash
rm -f src/google-mcp-tools.test.ts
./container/build.sh
```

## 3. Clean up the install

```bash
rm -rf ~/.gmail-mcp ~/.calendar-mcp
```

Both directories hold only placeholders. Disconnect Gmail and Google Calendar in the credential gateway if no other agent uses them.
