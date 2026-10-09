# extalia-vo

The `extalia` command runs [Extalia](https://github.com/Extalia-VO/extalia-virtual-agent),
the open-source spatial AI-agent workspace, on your computer. It starts a local
Bridge that serves the Extalia web UI in your browser and runs agents on this
machine, with your files and your model connections.

## Install

Requires Node.js 22.12 or newer.

```bash
npm i -g extalia-vo
```

## Run

```bash
extalia
```

This starts the Bridge on `http://127.0.0.1:4310/` and opens it in your
browser. Press Ctrl+C to stop it.

| Option | Effect |
| --- | --- |
| `--port <number>` | Use another port (default 4310) |
| `--no-open` | Do not open a browser |
| `--no-update-check` | Skip the update check (`EXTALIA_NO_UPDATE_CHECK=1` does the same) |

Other commands: `extalia doctor` (versions, platform, data location),
`extalia validate <file>` (check Extalia Protocol events or portable sessions),
`extalia version` and `extalia help`.

## Update

```bash
extalia update          # install the latest version
extalia update --check  # only report whether a newer version exists
```

`extalia update` runs `npm i -g extalia-vo@latest --prefer-online`. Restart a
running `extalia` afterwards. The web UI can also install an update; the
Bridge then restarts itself in the same terminal and the open tab reconnects.
It waits for running agents to finish first.

## Data

Settings, sessions and caches live in your user-data directory
(`extalia doctor` prints it; `EXTALIA_HOME` overrides it). Extalia collects no
telemetry. The only request it makes by itself is the update check against
`registry.npmjs.org`, at most every 12 hours.

## Security

- The Bridge listens on `127.0.0.1` only and never on the network.
- It answers only requests addressed to `127.0.0.1:<port>` or
  `localhost:<port>`, which blocks DNS-rebinding attacks from websites.
- API calls need a random token created at each start and given only to the
  page the Bridge serves. Other websites cannot read it, and the Bridge sends
  no CORS headers, so they cannot call the API.
- Agents act with your user account. Programs and other users on the same
  computer can reach `127.0.0.1` too, so run the Bridge only on a computer
  whose local users you trust.

Report vulnerabilities as described in
[SECURITY.md](https://github.com/Extalia-VO/extalia-virtual-agent/blob/main/SECURITY.md).

## License

MIT
