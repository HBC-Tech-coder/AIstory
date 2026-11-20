import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createIndependentOwnerClaimHandler } from "@/lib/admin/independentOwnerClaimServer";

let handlerCalls = 0;
const forbidden = () => { handlerCalls++; throw Error("retired handler called"); };
const server = createServer(createIndependentOwnerClaimHandler({}, {
  login: forbidden, change: forbidden, logout: forbidden, me: forbidden,
}));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address(); assert.ok(address && typeof address !== "string");
const port = address.port; assert.ok(![3000,4200,4107,5679,8188].includes(port));
async function local(url: string, method = "GET") {
  return new Promise<{ status: number; body: string; cookie?: string[]; cache?: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: url, method,
      headers: { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`,
        "content-type": "application/json" } }, res => {
      let body = ""; res.on("data", chunk => body += chunk);
      res.on("end", () => resolve({ status: res.statusCode!, body, cookie: res.headers["set-cookie"], cache: res.headers["cache-control"] }));
    });
    req.on("error", reject); req.end(method === "POST" ? "{}" : undefined);
  });
}
try {
  for (const route of ["/", "/session", "/password-change", "/admin", "/api/admin/snapshot"]) {
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await local(route, method);
      assert.equal(response.status, 410); assert.equal(response.cache, "no-store");
      assert.equal(response.cookie, undefined); assert.doesNotMatch(response.body, /roles|super_admin|admin888|token/);
    }
  }
  assert.equal(handlerCalls, 0);
  const source = await readFile("scripts/serve-independent-admin-owner-claim.ts", "utf8");
  assert.doesNotMatch(source, /process\.env|node:http|child_process|\.listen\(|setTimeout\s*\(|spawn(?:Sync)?\s*\(|600000/);
  for (const args of [[], ["--port", "19527"], ["--owner-claim-react-server-child-v1", "--port", "19527"]]) {
    const child = spawnSync(process.execPath, ["--import=tsx", "scripts/serve-independent-admin-owner-claim.ts", ...args],
      { encoding: "utf8", timeout: 30000, windowsHide: true,
        env: { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TSX_DISABLE_CACHE: "1", NODE_ENV: "test" } });
    assert.equal(child.status, 1); assert.equal(child.stdout, "");
    assert.equal(child.stderr, "OWNER_CLAIM_SUPERSEDED_PENDING_ACTIVATION_V2\n");
  }
  console.log("PASS retired owner-window handler=410, CLI stopped before config/socket/child, auth calls=0; only isolated test HTTP");
} finally {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
