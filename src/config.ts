/**
 * Konfiguration aus Umgebungsvariablen.
 *
 * Server werden durchnummeriert angegeben (beliebig viele):
 *   TDNS_1_NAME=dns1
 *   TDNS_1_URL=https://dns1.example.lan:53443
 *   TDNS_1_TOKEN=<API-Token aus Technitium>
 *   TDNS_1_VERIFY_TLS=true        (optional, Standard true; false für selbstsignierte Zertifikate)
 *   TDNS_1_READ_ONLY=false        (optional, sperrt schreibende Tools nur für diesen Server)
 */

export interface ServerConfig {
  name: string;
  url: string;
  token: string;
  verifyTls: boolean;
  readOnly: boolean;
}

export interface AppConfig {
  servers: ServerConfig[];
  /** Blendet alle schreibenden Tools aus. */
  readOnly: boolean;
  /** Bearer-Token, das MCP-Clients mitschicken müssen. */
  authToken?: string;
  /** Optionales Geheimnis im Pfad (/mcp/<secret>) für Clients ohne eigene Header, z. B. claude.ai. */
  pathSecret?: string;
  port: number;
  host: string;
  requestTimeoutMs: number;
}

function bool(v: string | undefined, fallback: boolean): boolean {
  if (v === undefined || v.trim() === "") return fallback;
  return ["1", "true", "yes", "ja", "on"].includes(v.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const servers: ServerConfig[] = [];
  const indices = new Set<number>();
  for (const key of Object.keys(env)) {
    const m = /^TDNS_(\d+)_URL$/.exec(key);
    if (m) indices.add(Number(m[1]));
  }

  for (const i of [...indices].sort((a, b) => a - b)) {
    const url = env[`TDNS_${i}_URL`]?.trim().replace(/\/+$/, "");
    const token = env[`TDNS_${i}_TOKEN`]?.trim();
    const name = (env[`TDNS_${i}_NAME`]?.trim() || `dns${i}`).toLowerCase();
    if (!url) continue;
    if (!token) throw new Error(`TDNS_${i}_TOKEN fehlt für Server "${name}"`);
    if (!/^https?:\/\//.test(url)) throw new Error(`TDNS_${i}_URL muss mit http:// oder https:// beginnen`);
    if (name === "all") throw new Error(`"all" ist als Servername reserviert (TDNS_${i}_NAME)`);
    if (servers.some((s) => s.name === name)) throw new Error(`Servername "${name}" ist doppelt vergeben`);
    servers.push({
      name,
      url,
      token,
      verifyTls: bool(env[`TDNS_${i}_VERIFY_TLS`], true),
      readOnly: bool(env[`TDNS_${i}_READ_ONLY`], false),
    });
  }

  if (servers.length === 0) {
    throw new Error("Kein Technitium-Server konfiguriert. Mindestens TDNS_1_URL und TDNS_1_TOKEN setzen.");
  }

  const authToken = env.MCP_AUTH_TOKEN?.trim() || undefined;
  const pathSecret = env.MCP_PATH_SECRET?.trim() || undefined;
  if (pathSecret && pathSecret.length < 24) {
    throw new Error("MCP_PATH_SECRET muss mindestens 24 Zeichen lang sein");
  }

  return {
    servers,
    readOnly: bool(env.MCP_READ_ONLY, false),
    authToken,
    pathSecret,
    port: Number(env.PORT || 8787),
    host: env.HOST || "0.0.0.0",
    requestTimeoutMs: Number(env.TDNS_TIMEOUT_MS || 15000),
  };
}
