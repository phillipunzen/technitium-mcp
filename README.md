# technitium-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any other MCP client) work with one or more
[Technitium DNS Server](https://technitium.com/dns/) instances through their HTTP API — reading stats, zones, records
and query logs, and optionally making changes.

- **Multi-server:** configure any number of servers; most tools accept `server: "all"` and run in parallel, so one
  server being down never blocks the others.
- **Zone diff:** `compare_zone` shows records that exist on only one server and TTL differences — handy for keeping
  a primary/secondary pair or two independent resolvers in sync.
- **Safe by default:** the HTTP endpoint refuses to start without authentication, write tools can be hidden globally
  or locked per server, and Technitium API tokens are never placed in URLs.
- **Two transports:** stateless Streamable HTTP (`/mcp`) for running as a container, or stdio for local use.

## Tools

| Read | Write (hidden with `MCP_READ_ONLY=true`) |
|---|---|
| `list_servers` – reachability, version, cluster state, token permissions | `add_record`, `update_record`, `delete_record` |
| `get_stats`, `get_top_stats` – dashboard figures and top clients/domains | `create_zone`, `set_zone_enabled`, `delete_zone` (requires `confirm: true`) |
| `list_zones`, `get_records` | `manage_block_or_allow` – block or allow a domain |
| `compare_zone` – diff a zone between two servers | `flush_cache` – whole cache or a single name |
| `resolve` – query through the server or any upstream | `disable_blocking_temporarily` |
| `query_logs` – filter query logs (logger app is auto-detected) | `update_blocklists` |
| `list_cache`, `list_block_or_allow`, `list_dhcp_leases`, `get_cluster_state`, `get_settings` | |

Record tools take the common fields directly and pass type-specific fields through `fields`, using Technitium's own
parameter names — e.g. `{ ipAddress: "192.168.1.10", ptr: true }` for an A record. For updates, the old value
identifies the record and the new value uses the `new` prefix (`newIpAddress`, `newCname`, `newValue`, …).

## Quick start

### 1. Create an API token on each Technitium server

Ideally create a dedicated user (e.g. `claude`) under **Administration → Users** with only the permissions it needs —
*View* only if Claude should never change anything. Then sign in as that user and use **Create API Token** from the
user menu (or, as an admin, **Administration → Sessions → Create Token**).

### 2. Configure

```bash
git clone https://github.com/phillipunzen/technitium-mcp.git
cd technitium-mcp
cp .env.example .env
openssl rand -hex 32   # use for MCP_AUTH_TOKEN
openssl rand -hex 32   # use for MCP_PATH_SECRET
```

| Variable | Description |
|---|---|
| `TDNS_<n>_NAME` | Short name used in tool calls (default `dns<n>`) |
| `TDNS_<n>_URL` | Web console URL, e.g. `https://dns1.example.lan:53443` |
| `TDNS_<n>_TOKEN` | Technitium API token |
| `TDNS_<n>_VERIFY_TLS` | `false` to accept self-signed certificates (default `true`) |
| `TDNS_<n>_READ_ONLY` | `true` to block write tools for this server only, e.g. a cluster secondary |
| `MCP_AUTH_TOKEN` | Bearer token clients must send (`Authorization: Bearer …`) |
| `MCP_PATH_SECRET` | Optional secret path `/mcp/<secret>` for clients that cannot set headers (min. 24 chars) |
| `MCP_READ_ONLY` | `true` hides all write tools |
| `PORT` / `HOST` | Listen address (default `0.0.0.0:8787`) |
| `TDNS_TIMEOUT_MS` | Timeout per Technitium API call (default `15000`) |

At least one of `MCP_AUTH_TOKEN` and `MCP_PATH_SECRET` is required in HTTP mode.

### 3. Run with Docker

```bash
docker compose up -d
curl http://localhost:8787/healthz
```

The image `ghcr.io/phillipunzen/technitium-mcp` is built for `linux/amd64` and `linux/arm64` on every push to `main`
(tags `latest`, `main`, `sha-…`, and semver for `v*` tags). To build locally instead, replace `image:` with
`build: .` in `docker-compose.yml`.

## Connecting a client

**Claude Code** (or any client that can send headers):

```bash
claude mcp add --scope user --transport http technitium https://dns-mcp.example.com/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

**claude.ai custom connector:** Settings → Connectors → *Add custom connector* with the URL
`https://dns-mcp.example.com/mcp/<MCP_PATH_SECRET>`. claude.ai calls connectors from Anthropic's cloud, so this
endpoint must be reachable over HTTPS from the internet (e.g. behind a reverse proxy). The Technitium servers
themselves stay on your LAN — only the container needs to reach them.

**Local stdio** (no container, e.g. Claude Desktop):

```json
{
  "mcpServers": {
    "technitium": {
      "command": "node",
      "args": ["/path/to/technitium-mcp/dist/index.js", "--stdio"],
      "env": {
        "TDNS_1_NAME": "dns1", "TDNS_1_URL": "https://dns1.example.lan:53443", "TDNS_1_TOKEN": "…",
        "TDNS_2_NAME": "dns2", "TDNS_2_URL": "https://dns2.example.lan:53443", "TDNS_2_TOKEN": "…"
      }
    }
  }
}
```

## Notes

- **Cluster or independent servers?** If your servers form a Technitium cluster, only write to the primary (and set
  the secondary to `TDNS_<n>_READ_ONLY=true`). If they run independently, write to both with `server: "all"` and
  verify with `compare_zone`.
- Technitium v15+ expects the token as a bearer header; it is also sent as a form field so older versions keep working.
  All calls are `POST` with form data, so tokens never appear in URLs or access logs.
- `query_logs` needs a query logger app installed on the server, such as *Query Logs (Sqlite)* from the app store.
- Deleting zones requires `confirm: true`, and the server instructions tell the model to ask the user first.

## Development

```bash
npm install
npm run build
npm test   # end-to-end test against two mocked Technitium servers
```

Requires Node.js 20 or newer. Built with the official
[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk).

## License

MIT
