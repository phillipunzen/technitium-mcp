import { Agent } from "undici";
import type { ServerConfig } from "./config.js";

export type Params = Record<string, string | number | boolean | undefined | null>;

export class TechnitiumError extends Error {
  constructor(
    public readonly server: string,
    public readonly endpoint: string,
    message: string,
  ) {
    super(`[${server}] ${endpoint}: ${message}`);
  }
}

const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

/**
 * Schlanker Client für die Technitium-HTTP-API.
 * Alle Aufrufe gehen als POST mit Formulardaten raus, damit das Token nie in einer URL
 * (und damit in Proxy- oder Zugriffslogs) landet. Das Token wird als Bearer-Header (ab v15)
 * und zusätzlich als Formularfeld (ältere Versionen) gesendet.
 */
export class TechnitiumClient {
  constructor(
    public readonly cfg: ServerConfig,
    private readonly timeoutMs: number,
  ) {}

  get name(): string {
    return this.cfg.name;
  }

  async call<T = any>(endpoint: string, params: Params = {}, opts: { auth?: boolean } = {}): Promise<T> {
    const auth = opts.auth !== false;
    const body = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === "") continue;
      body.set(k, String(v));
    }
    if (auth) body.set("token", this.cfg.token);

    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if (auth) headers.Authorization = `Bearer ${this.cfg.token}`;

    let res: Response;
    try {
      res = await fetch(`${this.cfg.url}/api/${endpoint}`, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
        // @ts-expect-error undici-spezifische Option von Node-fetch
        dispatcher: this.cfg.verifyTls ? undefined : insecureAgent,
      });
    } catch (err: any) {
      const cause = err?.cause?.code || err?.cause?.message || err?.message || String(err);
      throw new TechnitiumError(this.name, endpoint, `Server nicht erreichbar (${cause})`);
    }

    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      throw new TechnitiumError(
        this.name,
        endpoint,
        `Keine JSON-Antwort (HTTP ${res.status}): ${text.slice(0, 200)}`,
      );
    }

    switch (json?.status) {
      case "ok":
        return (json.response ?? json) as T;
      case "invalid-token":
        throw new TechnitiumError(this.name, endpoint, "API-Token ungültig oder abgelaufen");
      case "2fa-required":
        throw new TechnitiumError(this.name, endpoint, "2FA erforderlich – bitte ein API-Token statt Benutzerlogin verwenden");
      case "error":
        throw new TechnitiumError(this.name, endpoint, json.errorMessage || "Unbekannter Fehler");
      default:
        if (!res.ok) throw new TechnitiumError(this.name, endpoint, `HTTP ${res.status}`);
        return (json.response ?? json) as T;
    }
  }
}

export class ServerRegistry {
  private readonly clients = new Map<string, TechnitiumClient>();

  constructor(servers: ServerConfig[], timeoutMs: number) {
    for (const s of servers) this.clients.set(s.name, new TechnitiumClient(s, timeoutMs));
  }

  names(): string[] {
    return [...this.clients.keys()];
  }

  all(): TechnitiumClient[] {
    return [...this.clients.values()];
  }

  get(name: string): TechnitiumClient {
    const c = this.clients.get(name.toLowerCase());
    if (!c) throw new Error(`Unbekannter Server "${name}". Verfügbar: ${this.names().join(", ")}`);
    return c;
  }

  /** Löst "all" oder einen einzelnen Namen in eine Client-Liste auf. */
  resolve(target: string): TechnitiumClient[] {
    return target.toLowerCase() === "all" ? this.all() : [this.get(target)];
  }
}

/** Führt eine Aktion auf mehreren Servern parallel aus; Fehler einzelner Server brechen den Rest nicht ab. */
export async function fanOut<T>(
  clients: TechnitiumClient[],
  fn: (c: TechnitiumClient) => Promise<T>,
): Promise<Record<string, { ok: true; result: T } | { ok: false; error: string }>> {
  const entries = await Promise.all(
    clients.map(async (c) => {
      try {
        return [c.name, { ok: true as const, result: await fn(c) }] as const;
      } catch (err: any) {
        return [c.name, { ok: false as const, error: err?.message ?? String(err) }] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
