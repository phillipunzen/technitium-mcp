# technitium-mcp

MCP-Server, über den Claude auf einen oder mehrere **Technitium DNS Server** zugreift – lesend und (optional) schreibend.
Streamable HTTP (zustandslos, Endpunkt `/mcp`) für den Betrieb als Container, alternativ stdio für den lokalen Start.

## Tools

| Lesen | Schreiben (ausblendbar mit `MCP_READ_ONLY=true`) |
|---|---|
| `list_servers` – Erreichbarkeit, Version, Cluster, Token-Rechte | `add_record` / `update_record` / `delete_record` |
| `get_stats`, `get_top_stats` – Dashboard-Kennzahlen, Top-Listen | `create_zone`, `set_zone_enabled`, `delete_zone` (nur mit `confirm: true`) |
| `list_zones`, `get_records` | `manage_block_or_allow` – Domain blocken/erlauben |
| `compare_zone` – Records einer Zone zwischen zwei Servern abgleichen | `flush_cache` – ganzer Cache oder einzelner Name |
| `resolve` – DNS-Abfrage über den Server (oder einen beliebigen Upstream) | `disable_blocking_temporarily` |
| `query_logs` – Query-Logs filtern (Logger-App wird automatisch erkannt) | `update_blocklists` |
| `list_cache`, `list_block_or_allow`, `list_dhcp_leases`, `get_cluster_state`, `get_settings` | |

Fast alle Tools nehmen `server: "dns1" | "dns2" | "all"`. Bei `all` wird parallel auf allen Servern ausgeführt; fällt einer aus, liefern die anderen trotzdem ihr Ergebnis.

## 1. API-Token in Technitium anlegen (auf beiden Servern)

1. Am besten einen eigenen Benutzer `claude` anlegen (Administration → Users) und ihm nur die nötigen Rechte geben – z. B. nur *View*, wenn Claude nichts ändern soll.
2. Als dieser Benutzer anmelden → Benutzermenü oben rechts → **Create API Token** (oder als Admin unter Administration → Sessions → *Create Token* für den Benutzer).
3. Token in `.env` eintragen.

Das Token wird nur als `Authorization: Bearer`-Header bzw. im POST-Body übertragen, nie in der URL.

## 2. Konfiguration

```bash
cp .env.example .env
openssl rand -hex 32   # für MCP_AUTH_TOKEN
openssl rand -hex 32   # für MCP_PATH_SECRET
```

Pro Server `TDNS_<n>_NAME`, `_URL`, `_TOKEN`, optional `_VERIFY_TLS=false` (selbstsigniertes Zertifikat) und `_READ_ONLY=true` (nur dieser Server schreibgeschützt – praktisch für einen Cluster-Secondary).

## 3. Starten

```bash
docker compose up -d
curl http://localhost:8787/healthz
```

Ohne GHCR-Image: in `docker-compose.yml` `image:` durch `build: .` ersetzen. Das Workflow-File `.github/workflows/docker.yml` baut bei Push auf `main` automatisch `ghcr.io/<owner>/technitium-mcp` (amd64 + arm64).

## 4. In Claude einbinden

**Claude Code / Desktop (Header möglich):**
```bash
claude mcp add --scope user --transport http technitium https://dns-mcp.example.de/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

**claude.ai Custom Connector:** Einstellungen → Connectors → *Add custom connector*, URL:
`https://dns-mcp.example.de/mcp/<MCP_PATH_SECRET>`
claude.ai ruft den Connector aus der Anthropic-Cloud auf – der Endpunkt muss also per HTTPS von außen erreichbar sein (Reverse-Proxy, z. B. HAProxy). Die Technitium-Server selbst bleiben im LAN; nur der MCP-Container braucht Zugriff auf sie.

**Lokal per stdio (ohne Container):**
```json
{ "command": "node", "args": ["/pfad/technitium-mcp/dist/index.js", "--stdio"],
  "env": { "TDNS_1_URL": "...", "TDNS_1_TOKEN": "...", "TDNS_2_URL": "...", "TDNS_2_TOKEN": "..." } }
```

## Hinweise

- **Cluster oder zwei Einzelserver?** Bilden die beiden Server einen Technitium-Cluster, Änderungen nur auf dem Primary vornehmen (Secondary am besten `TDNS_n_READ_ONLY=true`). Laufen sie unabhängig, Änderungen mit `server: "all"` auf beide schreiben und danach mit `compare_zone` prüfen.
- Ab Technitium v15 wird das Token per Bearer-Header erwartet; ältere Versionen werden über das zusätzliche `token`-Formularfeld weiter bedient.
- `query_logs` braucht eine installierte Query-Logger-App (z. B. *Query Logs (Sqlite)* aus dem App-Store).

## Entwicklung

```bash
npm install
npm run build
npm test        # Ende-zu-Ende-Test gegen zwei simulierte Technitium-Server
```
