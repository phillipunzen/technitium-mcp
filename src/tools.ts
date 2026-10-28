import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { fanOut, ServerRegistry, type Params, type TechnitiumClient } from "./technitium.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 2) }],
});
const fail = (err: unknown): ToolResult => ({
  content: [{ type: "text", text: `Fehler: ${err instanceof Error ? err.message : String(err)}` }],
  isError: true,
});

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    return fail(err);
  }
}

const RECORD_TYPES = [
  "A", "AAAA", "NS", "CNAME", "PTR", "MX", "TXT", "SRV", "DNAME", "DS", "SSHFP", "TLSA",
  "SVCB", "HTTPS", "URI", "CAA", "NAPTR", "ANAME", "FWD", "APP", "SOA",
] as const;

const ZONE_TYPES = ["Primary", "Secondary", "Stub", "Forwarder", "SecondaryForwarder", "Catalog", "SecondaryCatalog"] as const;
const PERIODS = ["LastHour", "LastDay", "LastWeek", "LastMonth", "LastYear"] as const;
const PROTOCOLS = ["Udp", "Tcp", "Tls", "Https", "Quic"] as const;

const RECORD_FIELDS_HELP =
  "Typabhängige Felder der Technitium-API, z. B. A/AAAA: {ipAddress, ptr?}; CNAME: {cname}; " +
  "MX: {exchange, preference}; TXT: {text}; PTR: {ptrName}; NS: {nameServer}; " +
  "SRV: {priority, weight, port, target}; CAA: {flags, tag, value}; ANAME: {aname}; " +
  "FWD: {protocol, forwarder}. Beim Aktualisieren den neuen Wert mit 'new'-Präfix angeben " +
  "(newIpAddress, newCname, newExchange, newPreference, newText, newTarget, newValue …).";

const fieldsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
  .optional()
  .describe(RECORD_FIELDS_HELP);

/** Nur die Kennzahlen eines Dashboards, ohne Chart-Rohdaten. */
function summarizeStats(r: any, top: number) {
  const pick = (arr: any[] | undefined) => (Array.isArray(arr) ? arr.slice(0, top) : undefined);
  return {
    stats: r?.stats,
    topClients: pick(r?.topClients),
    topDomains: pick(r?.topDomains),
    topBlockedDomains: pick(r?.topBlockedDomains),
  };
}

function recordKey(r: any): string {
  return `${String(r.name).toLowerCase()}|${r.type}|${JSON.stringify(r.rData ?? {})}|disabled=${!!r.disabled}`;
}

export function registerTools(server: McpServer, cfg: AppConfig, reg: ServerRegistry): void {
  const names = reg.names();
  const target = z
    .string()
    .default("all")
    .describe(`Servername (${names.join(", ")}) oder "all" für alle Server`);
  const single = z.string().describe(`Servername (${names.join(", ")})`);

  const writable = (clients: TechnitiumClient[]) => {
    const blocked = clients.filter((c) => c.cfg.readOnly).map((c) => c.name);
    if (blocked.length) throw new Error(`Server ist schreibgeschützt konfiguriert: ${blocked.join(", ")}`);
    return clients;
  };

  // ---------------------------------------------------------------- Lesen

  server.registerTool(
    "list_servers",
    {
      title: "Server-Übersicht",
      description:
        "Listet die konfigurierten Technitium-Server mit Erreichbarkeit, Version, Hostname, Laufzeit, Cluster-Status und Rechten des API-Tokens. Guter Einstieg.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () =>
      run(() =>
        fanOut(reg.all(), async (c) => {
          const s = await c.call("user/session/get");
          const perms = Object.fromEntries(
            Object.entries(s?.info?.permissions ?? {}).map(([k, v]: [string, any]) => [
              k,
              [v.canView && "view", v.canModify && "modify", v.canDelete && "delete"].filter(Boolean).join("/"),
            ]),
          );
          return {
            url: c.cfg.url,
            readOnly: cfg.readOnly || c.cfg.readOnly,
            user: s?.username,
            version: s?.info?.version,
            dnsServerDomain: s?.info?.dnsServerDomain,
            upSince: s?.info?.uptimestamp,
            clusterInitialized: s?.info?.clusterInitialized,
            clusterDomain: s?.info?.clusterDomain,
            dnssecValidation: s?.info?.dnssecValidation,
            permissions: perms,
          };
        }),
      ),
  );

  server.registerTool(
    "get_stats",
    {
      title: "Dashboard-Statistik",
      description:
        "Kennzahlen vom Dashboard: Anfragen gesamt, NoError/NXDOMAIN/ServFail, geblockt, gecacht, rekursiv, Clients, Zonen, Cache- und Blocklisten-Größe sowie Top-Clients/-Domains/-Blockierte.",
      inputSchema: {
        server: target,
        period: z.enum(PERIODS).default("LastHour"),
        top: z.number().int().min(0).max(100).default(10).describe("Anzahl Einträge je Top-Liste"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ server: t, period, top }) =>
      run(() =>
        fanOut(reg.resolve(t), async (c) =>
          summarizeStats(await c.call("dashboard/stats/get", { type: period, utc: true }), top),
        ),
      ),
  );

  server.registerTool(
    "get_top_stats",
    {
      title: "Top-Listen",
      description: "Ausführliche Top-Liste (Clients, Domains oder blockierte Domains) für einen Zeitraum.",
      inputSchema: {
        server: target,
        statsType: z.enum(["TopClients", "TopDomains", "TopBlockedDomains"]),
        period: z.enum(PERIODS).default("LastDay"),
        limit: z.number().int().min(1).max(1000).default(50),
        onlyRateLimitedClients: z.boolean().optional().describe("Nur bei TopClients: nur rate-limitierte Clients"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ server: t, statsType, period, limit, onlyRateLimitedClients }) =>
      run(() =>
        fanOut(reg.resolve(t), (c) =>
          c.call("dashboard/stats/getTop", { type: period, statsType, limit, onlyRateLimitedClients }),
        ),
      ),
  );

  server.registerTool(
    "list_zones",
    {
      title: "Zonen auflisten",
      description: "Listet die autoritativen Zonen (Typ, DNSSEC, SOA-Serial, deaktiviert, Sync-Fehler). Filter mit * und ? möglich.",
      inputSchema: {
        server: target,
        filterName: z.string().optional().describe("z. B. *.lan oder example.*"),
        filterType: z.enum(ZONE_TYPES).optional(),
        includeInternal: z.boolean().default(false).describe("Interne Standardzonen (localhost, Reverse-Zonen) mit ausgeben"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ server: t, filterName, filterType, includeInternal }) =>
      run(() =>
        fanOut(reg.resolve(t), async (c) => {
          const r = await c.call("zones/list", { filterName, filterType });
          const zones = (r?.zones ?? []).filter((z: any) => includeInternal || !z.internal);
          return { count: zones.length, zones };
        }),
      ),
  );

  server.registerTool(
    "get_records",
    {
      title: "Records lesen",
      description:
        "Liest die Records eines Namens. Mit listZone=true werden alle Records der Zone ausgegeben.",
      inputSchema: {
        server: target,
        domain: z.string().describe("Name, z. B. host.example.lan, oder Zonenname bei listZone=true"),
        zone: z.string().optional().describe("Zone, falls nicht die nächstgelegene gemeint ist"),
        listZone: z.boolean().default(false),
        type: z.string().optional().describe("Nur diesen Record-Typ zurückgeben (clientseitig gefiltert)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ server: t, domain, zone, listZone, type }) =>
      run(() =>
        fanOut(reg.resolve(t), async (c) => {
          const r = await c.call("zones/records/get", { domain, zone, listZone });
          let records = r?.records ?? [];
          if (type) records = records.filter((x: any) => String(x.type).toUpperCase() === type.toUpperCase());
          return { zone: r?.zone, count: records.length, records };
        }),
      ),
  );

  server.registerTool(
    "compare_zone",
    {
      title: "Zone zwischen Servern vergleichen",
      description:
        "Vergleicht alle Records einer Zone zwischen zwei Servern und zeigt Abweichungen (nur auf A, nur auf B). Ideal, um zu prüfen, ob beide DNS-Server synchron sind.",
      inputSchema: {
        zone: z.string(),
        serverA: single.optional().describe("Standard: erster konfigurierter Server"),
        serverB: single.optional().describe("Standard: zweiter konfigurierter Server"),
        ignoreSoa: z.boolean().default(true).describe("SOA ignorieren (Serial weicht oft legitim ab)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ zone, serverA, serverB, ignoreSoa }) =>
      run(async () => {
        const a = reg.get(serverA ?? names[0]);
        const b = reg.get(serverB ?? names[1] ?? names[0]);
        if (a.name === b.name) throw new Error("Für einen Vergleich werden zwei unterschiedliche Server benötigt");
        const load = async (c: TechnitiumClient) => {
          const r = await c.call("zones/records/get", { domain: zone, zone, listZone: true });
          return (r?.records ?? []).filter((x: any) => !(ignoreSoa && x.type === "SOA"));
        };
        const [ra, rb] = await Promise.all([load(a), load(b)]);
        const ka = new Map(ra.map((r: any) => [recordKey(r), r]));
        const kb = new Map(rb.map((r: any) => [recordKey(r), r]));
        const onlyA = [...ka].filter(([k]) => !kb.has(k)).map(([, r]) => r);
        const onlyB = [...kb].filter(([k]) => !ka.has(k)).map(([, r]) => r);
        const ttlA = new Map(ra.map((r: any) => [recordKey(r), r.ttl]));
        const ttlDiff = rb
          .filter((r: any) => ttlA.has(recordKey(r)) && ttlA.get(recordKey(r)) !== r.ttl)
          .map((r: any) => ({ name: r.name, type: r.type, [a.name]: ttlA.get(recordKey(r)), [b.name]: r.ttl }));
        return {
          zone,
          inSync: onlyA.length === 0 && onlyB.length === 0 && ttlDiff.length === 0,
          recordCount: { [a.name]: ra.length, [b.name]: rb.length },
          [`only_on_${a.name}`]: onlyA,
          [`only_on_${b.name}`]: onlyB,
          ttlDifferences: ttlDiff,
        };
      }),
  );

  server.registerTool(
    "resolve",
    {
      title: "DNS-Abfrage",
      description:
        "Führt über den DNS-Client des Technitium-Servers eine Abfrage aus. nameServer: 'this-server' (der Server selbst, Standard), 'recursive-resolver', 'system-dns' oder eine Adresse wie 1.1.1.1 / https://cloudflare-dns.com/dns-query.",
      inputSchema: {
        server: target,
        domain: z.string(),
        type: z.string().default("A"),
        nameServer: z.string().default("this-server"),
        protocol: z.enum(PROTOCOLS).default("Udp"),
        dnssec: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ server: t, domain, type, nameServer, protocol, dnssec }) =>
      run(() =>
        fanOut(reg.resolve(t), async (c) => {
          const r = await c.call("dnsClient/resolve", { server: nameServer, domain, type, protocol, dnssec });
          const res = r?.result ?? r;
          return {
            rcode: res?.RCODE,
            authoritative: res?.AuthoritativeAnswer,
            authenticData: res?.AuthenticData,
            answer: res?.Answer,
            authority: res?.Authority?.length ? res.Authority : undefined,
            metadata: res?.Metadata,
          };
        }),
      ),
  );

  server.registerTool(
    "list_cache",
    {
      title: "Cache durchsuchen",
      description: "Zeigt gecachte Records bzw. Unterzonen für einen Namen im DNS-Cache.",
      inputSchema: { server: target, domain: z.string().default("") },
      annotations: { readOnlyHint: true },
    },
    async ({ server: t, domain }) =>
      run(() => fanOut(reg.resolve(t), (c) => c.call("cache/list", { domain }))),
  );

  server.registerTool(
    "list_block_or_allow",
    {
      title: "Block-/Allow-Liste lesen",
      description:
        "Durchsucht die manuell gepflegten Block- oder Allow-Listen (nicht die abonnierten Blocklisten). Ohne domain wird die Wurzel gelistet.",
      inputSchema: {
        server: target,
        list: z.enum(["blocked", "allowed"]),
        domain: z.string().default(""),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ server: t, list, domain }) =>
      run(() => fanOut(reg.resolve(t), (c) => c.call(`${list}/list`, { domain }))),
  );

  server.registerTool(
    "query_logs",
    {
      title: "Abfrage-Logs",
      description:
        "Durchsucht die Query-Logs (benötigt eine installierte Query-Logger-App, z. B. 'Query Logs (Sqlite)'; wird automatisch erkannt). Filter nach Client-IP, Name, Typ, Antworttyp (Blocked, Cached, Recursive …), RCODE und Zeitraum.",
      inputSchema: {
        server: target,
        clientIpAddress: z.string().optional(),
        qname: z.string().optional(),
        qtype: z.string().optional(),
        responseType: z.enum(["Authoritative", "Recursive", "Cached", "Blocked", "UpstreamBlocked", "CacheBlocked"]).optional(),
        rcode: z.string().optional().describe("z. B. NoError, NxDomain, ServerFailure, Refused"),
        protocol: z.enum(PROTOCOLS).optional(),
        start: z.string().optional().describe("ISO 8601, z. B. 2026-10-28T08:00:00"),
        end: z.string().optional(),
        entries: z.number().int().min(1).max(500).default(50),
        page: z.number().int().min(1).default(1),
        appName: z.string().optional().describe("Nur nötig, wenn mehrere Logger-Apps installiert sind"),
        classPath: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ server: t, entries, page, appName, classPath, ...filters }) =>
      run(() =>
        fanOut(reg.resolve(t), async (c) => {
          let name = appName;
          let cls = classPath;
          if (!name || !cls) {
            const apps = (await c.call("apps/list"))?.apps ?? [];
            const loggers = apps.flatMap((a: any) =>
              (a.dnsApps ?? []).filter((d: any) => d.isQueryLogger).map((d: any) => ({ name: a.name, classPath: d.classPath })),
            );
            const hit = loggers.find((l: any) => !name || l.name === name) ?? loggers[0];
            if (!hit) throw new Error("Keine Query-Logger-App installiert (z. B. 'Query Logs (Sqlite)' aus dem App-Store installieren)");
            name = hit.name;
            cls = hit.classPath;
          }
          const r = await c.call("logs/query", {
            name,
            classPath: cls,
            pageNumber: page,
            entriesPerPage: entries,
            descendingOrder: true,
            ...filters,
          } as Params);
          return { app: name, ...r };
        }),
      ),
  );

  server.registerTool(
    "list_dhcp_leases",
    {
      title: "DHCP-Leases",
      description: "Listet DHCP-Leases (falls der DHCP-Server von Technitium genutzt wird), optional gefiltert.",
      inputSchema: {
        server: target,
        search: z.string().optional().describe("Filter auf IP, MAC oder Hostname (Teilstring)"),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ server: t, search }) =>
      run(() =>
        fanOut(reg.resolve(t), async (c) => {
          let leases = (await c.call("dhcp/leases/list"))?.leases ?? [];
          if (search) {
            const s = search.toLowerCase();
            leases = leases.filter((l: any) =>
              [l.address, l.hardwareAddress, l.hostName].some((v) => String(v ?? "").toLowerCase().includes(s)),
            );
          }
          return { count: leases.length, leases };
        }),
      ),
  );

  server.registerTool(
    "get_cluster_state",
    {
      title: "Cluster-Status",
      description: "Zeigt den Technitium-Cluster-Status (Knoten, Primary/Secondary, Erreichbarkeit, letzte Synchronisation).",
      inputSchema: { server: target },
      annotations: { readOnlyHint: true },
    },
    async ({ server: t }) =>
      run(() => fanOut(reg.resolve(t), (c) => c.call("admin/cluster/state", { includeServerIpAddresses: true }))),
  );

  server.registerTool(
    "get_settings",
    {
      title: "Einstellungen lesen",
      description:
        "Liest die DNS-Einstellungen (Forwarder, Blocking, Recursion, Cache, Logging …). Mit 'keys' nur ausgewählte Felder, z. B. ['forwarders','enableBlocking','blockListUrls'].",
      inputSchema: { server: target, keys: z.array(z.string()).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ server: t, keys }) =>
      run(() =>
        fanOut(reg.resolve(t), async (c) => {
          const s = await c.call("settings/get");
          if (!keys?.length) return s;
          return Object.fromEntries(keys.map((k) => [k, s?.[k]]));
        }),
      ),
  );

  if (cfg.readOnly) return;

  // ---------------------------------------------------------------- Schreiben

  server.registerTool(
    "add_record",
    {
      title: "Record anlegen",
      description:
        "Legt einen Record an. Bei einem Technitium-Cluster nur auf dem Primary ausführen; bei zwei unabhängigen Servern mit server='all' auf beiden gleichzeitig. " +
        "Beispiel A: {domain:'nas.home.lan', type:'A', fields:{ipAddress:'192.168.1.10', ptr:true}}.",
      inputSchema: {
        server: target,
        domain: z.string(),
        type: z.enum(RECORD_TYPES),
        zone: z.string().optional(),
        ttl: z.number().int().min(0).optional(),
        overwrite: z.boolean().default(false).describe("Vorhandene Records gleichen Typs ersetzen"),
        comments: z.string().optional(),
        fields: fieldsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ server: t, domain, type, zone, ttl, overwrite, comments, fields }) =>
      run(() =>
        fanOut(writable(reg.resolve(t)), (c) =>
          c.call("zones/records/add", { domain, type, zone, ttl, overwrite, comments, ...(fields ?? {}) }),
        ),
      ),
  );

  server.registerTool(
    "update_record",
    {
      title: "Record ändern",
      description:
        "Ändert einen bestehenden Record. Der alte Wert identifiziert den Record, der neue steht im 'new'-Feld. " +
        "Beispiel: {domain:'nas.home.lan', type:'A', fields:{ipAddress:'192.168.1.10', newIpAddress:'192.168.1.11'}}.",
      inputSchema: {
        server: target,
        domain: z.string(),
        type: z.enum(RECORD_TYPES),
        zone: z.string().optional(),
        newDomain: z.string().optional().describe("Record umbenennen"),
        ttl: z.number().int().min(0).optional(),
        disable: z.boolean().optional().describe("true deaktiviert, false aktiviert den Record"),
        comments: z.string().optional(),
        fields: fieldsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ server: t, fields, ...rest }) =>
      run(() =>
        fanOut(writable(reg.resolve(t)), (c) => c.call("zones/records/update", { ...rest, ...(fields ?? {}) } as Params)),
      ),
  );

  server.registerTool(
    "delete_record",
    {
      title: "Record löschen",
      description:
        "Löscht einen Record. Der Wert muss angegeben werden, damit nur genau dieser Record entfernt wird, z. B. {ipAddress:'192.168.1.10'}.",
      inputSchema: {
        server: target,
        domain: z.string(),
        type: z.enum(RECORD_TYPES),
        zone: z.string().optional(),
        fields: fieldsSchema,
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ server: t, fields, ...rest }) =>
      run(() =>
        fanOut(writable(reg.resolve(t)), (c) => c.call("zones/records/delete", { ...rest, ...(fields ?? {}) } as Params)),
      ),
  );

  server.registerTool(
    "create_zone",
    {
      title: "Zone anlegen",
      description:
        "Legt eine Zone an. Für eine IP oder ein Netz in CIDR (z. B. 192.168.10.0/24) entsteht automatisch die Reverse-Zone. " +
        "Weitere Optionen in 'options', z. B. Secondary: {primaryNameServerAddresses:'192.168.1.2'}, Forwarder: {forwarder:'1.1.1.1', protocol:'Udp'}.",
      inputSchema: {
        server: target,
        zone: z.string(),
        type: z.enum(ZONE_TYPES).default("Primary"),
        options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ server: t, zone, type, options }) =>
      run(() => fanOut(writable(reg.resolve(t)), (c) => c.call("zones/create", { zone, type, ...(options ?? {}) }))),
  );

  server.registerTool(
    "set_zone_enabled",
    {
      title: "Zone aktivieren/deaktivieren",
      description: "Aktiviert oder deaktiviert eine Zone, ohne sie zu löschen.",
      inputSchema: { server: target, zone: z.string(), enabled: z.boolean() },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ server: t, zone, enabled }) =>
      run(() => fanOut(writable(reg.resolve(t)), (c) => c.call(enabled ? "zones/enable" : "zones/disable", { zone }))),
  );

  server.registerTool(
    "delete_zone",
    {
      title: "Zone löschen",
      description: "Löscht eine Zone samt aller Records unwiderruflich. Nur nach ausdrücklicher Bestätigung durch den Nutzer aufrufen.",
      inputSchema: {
        server: target,
        zone: z.string(),
        confirm: z.literal(true).describe("Muss true sein – Bestätigung, dass der Nutzer das Löschen ausdrücklich wünscht"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ server: t, zone }) =>
      run(() => fanOut(writable(reg.resolve(t)), (c) => c.call("zones/delete", { zone }))),
  );

  server.registerTool(
    "manage_block_or_allow",
    {
      title: "Domain blocken/erlauben",
      description:
        "Fügt eine Domain der manuellen Block- oder Allow-Liste hinzu oder entfernt sie. Gilt inkl. Subdomains.",
      inputSchema: {
        server: target,
        list: z.enum(["blocked", "allowed"]),
        action: z.enum(["add", "delete"]),
        domain: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ server: t, list, action, domain }) =>
      run(() => fanOut(writable(reg.resolve(t)), (c) => c.call(`${list}/${action}`, { domain }))),
  );

  server.registerTool(
    "flush_cache",
    {
      title: "Cache leeren",
      description: "Entfernt einen Namen (mit domain) oder den gesamten DNS-Cache (ohne domain).",
      inputSchema: { server: target, domain: z.string().optional() },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ server: t, domain }) =>
      run(() =>
        fanOut(writable(reg.resolve(t)), (c) => (domain ? c.call("cache/delete", { domain }) : c.call("cache/flush"))),
      ),
  );

  server.registerTool(
    "disable_blocking_temporarily",
    {
      title: "Blocking kurz pausieren",
      description: "Pausiert das Blocking für die angegebene Anzahl Minuten; danach schaltet es sich selbst wieder ein.",
      inputSchema: { server: target, minutes: z.number().int().min(1).max(1440) },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ server: t, minutes }) =>
      run(() => fanOut(writable(reg.resolve(t)), (c) => c.call("settings/temporaryDisableBlocking", { minutes }))),
  );

  server.registerTool(
    "update_blocklists",
    {
      title: "Blocklisten aktualisieren",
      description: "Erzwingt das sofortige Neuladen aller abonnierten Blocklisten.",
      inputSchema: { server: target },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ server: t }) =>
      run(() => fanOut(writable(reg.resolve(t)), (c) => c.call("settings/forceUpdateBlockLists"))),
  );
}
