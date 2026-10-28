// Ende-zu-Ende-Test: zwei simulierte Technitium-Server + echter MCP-Server über HTTP.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const ENTRY = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const AUTH = "test-bearer-token-0123456789";
const SECRET = "path-secret-abcdefghijklmnopqrstuvwxyz";

function mockTechnitium(name, token, records) {
  const calls = [];
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const path = req.url.replace(/^\/api\//, "").split("?")[0];
      const params = Object.fromEntries(new URLSearchParams(body));
      calls.push({ path, params, auth: req.headers.authorization });
      const send = (o) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(o));
      };
      if (req.headers.authorization !== `Bearer ${token}`) return send({ status: "invalid-token" });
      switch (path) {
        case "user/session/get":
          return send({
            status: "ok",
            username: "claude",
            info: {
              version: "15.0",
              dnsServerDomain: `${name}.home.lan`,
              clusterInitialized: false,
              permissions: { Zones: { canView: true, canModify: true, canDelete: false } },
            },
          });
        case "dashboard/stats/get":
          return send({
            status: "ok",
            response: { stats: { totalQueries: 100 }, mainChartData: { huge: true }, topClients: Array(20).fill({ name: "x" }) },
          });
        case "zones/list":
          return send({ status: "ok", response: { zones: [{ name: "home.lan", type: "Primary" }, { name: "localhost", internal: true }] } });
        case "zones/records/get":
          return send({ status: "ok", response: { zone: { name: "home.lan" }, records } });
        case "zones/records/add":
          return send({ status: "ok", response: { addedRecord: params } });
        case "zones/delete":
          return send({ status: "error", errorMessage: "Zone does not exist" });
        case "apps/list":
          return send({ status: "ok", response: { apps: [{ name: "Query Logs (Sqlite)", dnsApps: [{ classPath: "QueryLogsSqlite.App", isQueryLogger: true }] }] } });
        case "logs/query":
          return send({ status: "ok", response: { pageNumber: 1, totalEntries: 1, entries: [{ qname: "a.de" }] } });
        case "dnsClient/resolve":
          return send({ status: "ok", response: { result: { RCODE: "NoError", Answer: [{ Name: params.domain, RDATA: { IPAddress: "1.2.3.4" } }], Metadata: {} } } });
        default:
          return send({ status: "error", errorMessage: `mock: ${path} not implemented` });
      }
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, calls, port: srv.address().port })));
}

const rec = (name, type, rData, ttl = 3600) => ({ name, type, ttl, disabled: false, rData });
let dns1, dns2, proc, port;

before(async () => {
  dns1 = await mockTechnitium("dns1", "tok1", [
    rec("home.lan", "SOA", { serial: 5 }),
    rec("nas.home.lan", "A", { ipAddress: "192.168.1.10" }),
    rec("pi.home.lan", "A", { ipAddress: "192.168.1.20" }),
  ]);
  dns2 = await mockTechnitium("dns2", "tok2", [
    rec("home.lan", "SOA", { serial: 4 }),
    rec("nas.home.lan", "A", { ipAddress: "192.168.1.10" }, 300),
    rec("old.home.lan", "A", { ipAddress: "192.168.1.99" }),
  ]);
  port = 18000 + Math.floor(Math.random() * 1000);
  proc = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      MCP_AUTH_TOKEN: AUTH,
      MCP_PATH_SECRET: SECRET,
      TDNS_1_NAME: "dns1",
      TDNS_1_URL: `http://127.0.0.1:${dns1.port}`,
      TDNS_1_TOKEN: "tok1",
      TDNS_2_NAME: "dns2",
      TDNS_2_URL: `http://127.0.0.1:${dns2.port}/`,
      TDNS_2_TOKEN: "tok2",
      TDNS_2_READ_ONLY: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on("data", (d) => d.toString().includes("lauscht") && resolve());
    proc.stderr.on("data", (d) => reject(new Error(d.toString())));
  });
});

after(() => {
  proc?.kill();
  dns1?.srv.close();
  dns2?.srv.close();
});

async function connect(url, headers = {}) {
  const client = new Client({ name: "test", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } }));
  return client;
}
const json = (r) => JSON.parse(r.content[0].text);

test("lehnt Anfragen ohne gültigen Bearer ab", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(r.status, 401);
  const r2 = await fetch(`http://127.0.0.1:${port}/mcp/falsch`, { method: "POST", body: "{}" });
  assert.equal(r2.status, 404);
});

test("Tools über Bearer und Pfad-Secret", async () => {
  for (const c of [
    await connect(`http://127.0.0.1:${port}/mcp`, { Authorization: `Bearer ${AUTH}` }),
    await connect(`http://127.0.0.1:${port}/mcp/${SECRET}`),
  ]) {
    const { tools } = await c.listTools();
    const names = tools.map((t) => t.name);
    for (const n of ["list_servers", "get_stats", "compare_zone", "add_record", "delete_zone", "query_logs"]) assert.ok(names.includes(n), n);
    await c.close();
  }
});

test("Lesen über beide Server, Token nie in URL", async () => {
  const c = await connect(`http://127.0.0.1:${port}/mcp`, { Authorization: `Bearer ${AUTH}` });
  const servers = json(await c.callTool({ name: "list_servers", arguments: {} }));
  assert.equal(servers.dns1.result.version, "15.0");
  assert.equal(servers.dns2.result.readOnly, true);
  assert.equal(servers.dns1.result.permissions.Zones, "view/modify");

  const stats = json(await c.callTool({ name: "get_stats", arguments: { top: 3 } }));
  assert.equal(stats.dns1.result.stats.totalQueries, 100);
  assert.equal(stats.dns1.result.topClients.length, 3);
  assert.equal(stats.dns1.result.mainChartData, undefined);

  const zones = json(await c.callTool({ name: "list_zones", arguments: { server: "dns1" } }));
  assert.deepEqual(Object.keys(zones), ["dns1"]);
  assert.equal(zones.dns1.result.count, 1);

  const resolve = json(await c.callTool({ name: "resolve", arguments: { server: "dns2", domain: "nas.home.lan" } }));
  assert.equal(resolve.dns2.result.rcode, "NoError");

  const logs = json(await c.callTool({ name: "query_logs", arguments: { server: "dns1", qname: "a.de" } }));
  assert.equal(logs.dns1.result.app, "Query Logs (Sqlite)");
  const logCall = dns1.calls.find((x) => x.path === "logs/query");
  assert.equal(logCall.params.classPath, "QueryLogsSqlite.App");
  assert.equal(logCall.params.qname, "a.de");

  for (const call of [...dns1.calls, ...dns2.calls]) assert.ok(!call.path.includes("token"));
  await c.close();
});

test("compare_zone findet Abweichungen", async () => {
  const c = await connect(`http://127.0.0.1:${port}/mcp`, { Authorization: `Bearer ${AUTH}` });
  const d = json(await c.callTool({ name: "compare_zone", arguments: { zone: "home.lan" } }));
  assert.equal(d.inSync, false);
  assert.equal(d.only_on_dns1[0].name, "pi.home.lan");
  assert.equal(d.only_on_dns2[0].name, "old.home.lan");
  assert.equal(d.ttlDifferences[0].dns1, 3600);
  assert.equal(d.ttlDifferences[0].dns2, 300);
  await c.close();
});

test("Schreiben: Felder werden durchgereicht, Schreibschutz greift, Fehler sauber", async () => {
  const c = await connect(`http://127.0.0.1:${port}/mcp`, { Authorization: `Bearer ${AUTH}` });
  const add = json(
    await c.callTool({
      name: "add_record",
      arguments: { server: "dns1", domain: "new.home.lan", type: "A", ttl: 600, fields: { ipAddress: "192.168.1.50", ptr: true } },
    }),
  );
  assert.equal(add.dns1.ok, true);
  const p = dns1.calls.find((x) => x.path === "zones/records/add").params;
  assert.equal(p.ipAddress, "192.168.1.50");
  assert.equal(p.ptr, "true");
  assert.equal(p.ttl, "600");
  assert.equal(p.overwrite, "false");

  const ro = await c.callTool({ name: "add_record", arguments: { server: "all", domain: "x.home.lan", type: "A", fields: { ipAddress: "1.1.1.1" } } });
  assert.equal(ro.isError, true);
  assert.match(ro.content[0].text, /schreibgeschützt.*dns2/);

  const del = json(await c.callTool({ name: "delete_zone", arguments: { server: "dns1", zone: "nope.lan", confirm: true } }));
  assert.equal(del.dns1.ok, false);
  assert.match(del.dns1.error, /Zone does not exist/);

  const noConfirm = await c.callTool({ name: "delete_zone", arguments: { server: "dns1", zone: "home.lan" } });
  assert.equal(noConfirm.isError, true);
  await c.close();
});
