# technitium-mcp

An [MCP](https://modelcontextprotocol.io) server that lets Claude (or any other MCP client) work with one or more
[Technitium DNS Server](https://technitium.com/dns/) instances through their HTTP API — reading stats, zones, records
and query logs, and optionally making changes.

It ships as a ready-to-run Docker image — no need to clone or build anything:

```
ghcr.io/phillipunzen/technitium-mcp:latest
```

Multi-arch (`linux/amd64`, `linux/arm64`). Tags: `latest`, `main`, `sha-<commit>` and semver tags for releases.

## Features

- **Multi-server:** configure any number of servers; most tools accept `server: "all"` and run in parallel, so one
  server being down never blocks the others.
- **Zone diff:** `compare_zone` shows records that exist on only one server and TTL differences — handy for keeping
  a primary/secondary pair or two independent resolvers in sync.
- **Safe by default:** the endpoint refuses to start without authentication, write tools can be hidden globally
  or locked per server, and Technitium API tokens are never placed in URLs.
- **Two transports:** stateless Streamable HTTP (`/mcp`) for running as a service, or stdio for local clients.

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

### 2. Create `docker-compose.yml`

```yaml
services:
  technitium-mcp:
    image: ghcr.io/phillipunzen/technitium-mcp:latest
    container_name: technitium-mcp
    restart: unless-stopped
    env_file: .env
    ports:
      - "8787:8787"
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    mem_limit: 256m
```

### 3. Create `.env`

```dotenv
# Technitium servers (any number, numbered consecutively)
TDNS_1_NAME=dns1
TDNS_1_URL=https://dns1.example.lan:53443
TDNS_1_TOKEN=<technitium api token>

TDNS_2_NAME=dns2
TDNS_2_URL=https://dns2.example.lan:53443
TDNS_2_TOKEN=<technitium api token>

# Endpoint protection – generate with: openssl rand -hex 32
MCP_AUTH_TOKEN=<random>
MCP_PATH_SECRET=<random>
```

### 4. Start

```bash
docker compose up -d
curl http://localhost:8787/healthz
```

Update later with `docker compose pull && docker compose up -d`.

## Configuration

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

**Local stdio** (e.g. Claude Desktop), using the same image:

```json
{
  "mcpServers": {
    "technitium": {
      "command": "docker",
      "args": ["run", "-i", "--rm", "--env-file", "/path/to/.env",
               "ghcr.io/phillipunzen/technitium-mcp:latest", "node", "dist/index.js", "--stdio"]
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

## License

MIT
