#!/usr/bin/env node
import { timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { loadConfig, type AppConfig } from "./config.js";
import { ServerRegistry } from "./technitium.js";
import { registerTools } from "./tools.js";

const VERSION = "1.0.0";

function buildServer(cfg: AppConfig, reg: ServerRegistry): McpServer {
  const server = new McpServer(
    { name: "technitium-dns", version: VERSION },
    {
      instructions:
        `Zugriff auf ${reg.names().length} Technitium DNS Server (${reg.names().join(", ")}). ` +
        "Lesende Tools akzeptieren server='all' und liefern das Ergebnis je Server. " +
        "Vor Änderungen mit list_servers/get_cluster_state klären, ob die Server einen Cluster bilden: " +
        "im Cluster nur auf dem Primary schreiben, bei unabhängigen Servern auf beiden (server='all') und danach mit compare_zone prüfen. " +
        "Löschen von Zonen und Records nur nach ausdrücklicher Bestätigung durch den Nutzer." +
        (cfg.readOnly ? " Dieser Server läuft im Nur-Lesen-Modus." : ""),
    },
  );
  registerTools(server, cfg, reg);
  return server;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

async function main() {
  const cfg = loadConfig();
  const reg = new ServerRegistry(cfg.servers, cfg.requestTimeoutMs);

  if (process.argv.includes("--stdio") || process.env.MCP_TRANSPORT === "stdio") {
    await buildServer(cfg, reg).connect(new StdioServerTransport());
    console.error(`technitium-mcp ${VERSION} (stdio) – Server: ${reg.names().join(", ")}`);
    return;
  }

  if (!cfg.authToken && !cfg.pathSecret) {
    throw new Error("HTTP-Modus braucht MCP_AUTH_TOKEN und/oder MCP_PATH_SECRET – ohne Absicherung wird nicht gestartet.");
  }

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);
  app.use(express.json({ limit: "1mb" }));

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok", version: VERSION, servers: reg.names(), readOnly: cfg.readOnly });
  });

  const bearerAuth = (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (cfg.authToken && token && safeEqual(token, cfg.authToken)) return next();
    res.status(401).set("WWW-Authenticate", 'Bearer realm="technitium-mcp"').json({
      jsonrpc: "2.0",
      error: { code: -32001, message: "Unauthorized" },
      id: null,
    });
  };

  const secretAuth = (req: Request, res: Response, next: NextFunction) => {
    const secret = String(req.params.secret ?? "");
    if (cfg.pathSecret && safeEqual(secret, cfg.pathSecret)) return next();
    res.status(404).end();
  };

  // Zustandslos: pro Anfrage ein eigener Server + Transport.
  const handle = async (req: Request, res: Response) => {
    const server = buildServer(cfg, reg);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("MCP-Fehler:", err);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    }
  };

  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).set("Allow", "POST").json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed (stateless server)" },
      id: null,
    });
  };

  app.post("/mcp", bearerAuth, handle);
  app.get("/mcp", bearerAuth, methodNotAllowed);
  app.delete("/mcp", bearerAuth, methodNotAllowed);

  if (cfg.pathSecret) {
    app.post("/mcp/:secret", secretAuth, handle);
    app.get("/mcp/:secret", secretAuth, methodNotAllowed);
    app.delete("/mcp/:secret", secretAuth, methodNotAllowed);
  }

  app.listen(cfg.port, cfg.host, () => {
    console.log(
      `technitium-mcp ${VERSION} lauscht auf http://${cfg.host}:${cfg.port}/mcp` +
        ` – Server: ${reg.names().join(", ")}${cfg.readOnly ? " (nur lesen)" : ""}` +
        `${cfg.authToken ? " – Bearer aktiv" : ""}${cfg.pathSecret ? " – Pfad-Secret aktiv" : ""}`,
    );
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
