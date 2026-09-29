import http from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const basePort = Number(process.env.PORT || 9188);
const versions = [
  {
    label: "workerd@1.20260928.1",
    bin: process.env.WORKERD_20260928_BIN || join(root, "node_modules/workerd-20260928/bin/workerd"),
  },
  {
    label: "workerd@1.20260929.1",
    bin: process.env.WORKERD_20260929_BIN || join(root, "node_modules/workerd-20260929/bin/workerd"),
  },
];

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForPort(child, port) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const attempt = () => {
      if (child.spawnError) return reject(child.spawnError);
      if (child.exitCode !== null) return reject(new Error("workerd exited during startup"));
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", (error) => {
        socket.destroy();
        if (Date.now() >= deadline) reject(error);
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

function request(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/", agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve(`HTTP ${res.statusCode} ${JSON.stringify(body)}`));
    });
    req.setTimeout(3000, () => req.destroy(new Error("timeout")));
    req.on("error", (error) => resolve(`request failed (${error.code || error.message})`));
  });
}

function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", resolve));
}

async function run({ label, bin }, index) {
  // Separate ports per version so a previous run can never answer this one.
  const port = basePort + index * 2;
  const bystanderPort = port + 1;
  // bin/workerd is a Node wrapper that spawns the native binary; run it in its
  // own process group so cleanup also stops the native child.
  const child = spawn(bin, [
    "serve",
    "config.capnp",
    `--socket-addr=http=127.0.0.1:${port}`,
    `--socket-addr=bystander=127.0.0.1:${bystanderPort}`,
  ], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.once("error", (error) => {
    child.spawnError = error;
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  try {
    await waitForPort(child, port);
    await waitForPort(child, bystanderPort);
    const bystanderBefore = await request(bystanderPort);
    const response = await request(port);
    await wait(300);
    const bystanderAfter = await request(bystanderPort);
    const alive = child.exitCode === null;
    const fatal = output.match(/\*\*\* Fatal uncaught [^\n]*/)?.[0] ?? null;
    return { label, response, bystanderBefore, bystanderAfter, alive, exitCode: child.exitCode, fatal };
  } finally {
    if (!child.spawnError) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      await waitForExit(child);
    }
  }
}

let failed = false;
for (const [index, version] of versions.entries()) {
  let result;
  try {
    result = await run(version, index);
  } catch (error) {
    failed = true;
    console.log(`- ${version.label}: FAIL (could not start workerd: ${error.message})`);
    continue;
  }
  const pass = result.alive && result.response.startsWith("HTTP 200") &&
    result.bystanderAfter.startsWith("HTTP 200");
  failed ||= !pass;
  console.log(`- ${result.label}: ${pass ? "PASS" : "FAIL"}`);
  console.log(`    bystander before: ${result.bystanderBefore}`);
  console.log(`    console worker:   ${result.response}`);
  console.log(`    bystander after:  ${result.bystanderAfter}`);
  console.log(`    process:          ${result.alive ? "still running" : `exited with code ${result.exitCode}`}`);
  if (result.fatal) console.log(`    log:              ${result.fatal}`);
}
process.exitCode = failed ? 1 : 0;
