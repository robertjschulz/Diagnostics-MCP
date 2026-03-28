#!/usr/bin/env node
/**
 * stdio-bridge.ts
 *
 * Connects to the VS Code diagnostics extension's named pipe and forwards
 * bytes between the pipe and this process's stdin/stdout. Because both sides
 * speak the MCP stdio protocol (Content-Length-framed JSON-RPC), no protocol
 * parsing is needed — this is a pure byte bridge.
 *
 * Pipe path is derived from the workspace root, which must be supplied via:
 *   - DIAGNOSTICS_MCP_WORKSPACE env var  (preferred — set in mcp.json)
 *   - --workspace <path> CLI argument
 *
 * Example .vscode/mcp.json entry:
 *   {
 *     "diagnostics-mcp-server": {
 *       "type": "stdio",
 *       "command": "node",
 *       "args": [
 *         "${userHome}/.vscode/extensions/maaz-tajammul.diagnostics-mcp-server-<version>/dist/stdio-bridge.js"
 *       ],
 *       "env": { "DIAGNOSTICS_MCP_WORKSPACE": "${workspaceFolder}" }
 *     }
 *   }
 */

import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";

const RETRY_INTERVAL_MS = 500;
const MAX_RETRIES = 30; // 15 s
const PIPE_PREFIX = "diagnostics-mcp-";

function getPipePath(workspaceRoot: string): string {
  // Normalize drive letter case on Windows so the path matches what the extension computes
  // via vscode.workspace.workspaceFolders[0].uri.fsPath (which returns lowercase drive letter).
  const normalized = process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot;
  const id = Buffer.from(normalized)
    .toString("base64")
    .replace(/[/+=]/g, "_")
    .slice(0, 32);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\${PIPE_PREFIX}${id}`;
  }
  return path.join(os.tmpdir(), `${PIPE_PREFIX}${id}.sock`);
}

/** Scan for any running diagnostics-mcp pipe (fallback when workspace unknown). */
function discoverPipe(): string | undefined {
  try {
    if (process.platform === "win32") {
      const scanPath = "\\\\.\\pipe\\";
      log(`discoverPipe: scanning ${scanPath}`);
      const pipes = fs.readdirSync(scanPath);
      log(`discoverPipe: found ${pipes.length} pipes total`);
      const match = pipes.find((p) => p.startsWith(PIPE_PREFIX));
      if (match) {
        log(`discoverPipe: matched ${match}`);
        return `\\\\.\\pipe\\${match}`;
      }
      log(`discoverPipe: no pipe starting with '${PIPE_PREFIX}' found`);
    } else {
      const scanPath = os.tmpdir();
      log(`discoverPipe: scanning ${scanPath}`);
      const files = fs.readdirSync(scanPath);
      const match = files.find(
        (f) => f.startsWith(PIPE_PREFIX) && f.endsWith(".sock")
      );
      if (match) {
        log(`discoverPipe: matched ${match}`);
        return path.join(scanPath, match);
      }
      log(`discoverPipe: no matching .sock file found`);
    }
  } catch (err) {
    log(`discoverPipe: scan failed with error: ${err}`);
  }
  return undefined;
}

const log = (msg: string) => process.stderr.write(`[diagnostics-mcp stdio-bridge] ${msg}\n`);

function resolvePipePath(): string {
  const envWs = process.env.DIAGNOSTICS_MCP_WORKSPACE;
  const argIdx = process.argv.indexOf("--workspace");
  const argWs = argIdx !== -1 ? process.argv[argIdx + 1] : undefined;
  const cwd = process.cwd();

  log(`DIAGNOSTICS_MCP_WORKSPACE = ${JSON.stringify(envWs)}`);
  log(`--workspace arg           = ${JSON.stringify(argWs)}`);
  log(`process.cwd()             = ${JSON.stringify(cwd)}`);

  // Prefer explicit workspace; ignore unresolved template variables (${...})
  const explicit = envWs || argWs;
  const ws = explicit && !explicit.startsWith("${") ? explicit : cwd;

  if (explicit?.startsWith("${")) {
    log(`workspace value is an unresolved template variable: ${explicit} — falling back to cwd`);
  }

  const pipePath = getPipePath(ws);
  log(`workspace = ${ws}`);
  log(`pipe path = ${pipePath}`);
  return pipePath;
}

function tryConnect(pipePath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(pipePath);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function waitAndConnect(pipePath: string): Promise<net.Socket> {
  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      return await tryConnect(pipePath);
    } catch {
      await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS));
    }
  }
  throw new Error(
    `Could not connect to pipe ${pipePath} after ${(MAX_RETRIES * RETRY_INTERVAL_MS) / 1000}s. ` +
      `Is the VS Code diagnostics extension running?`
  );
}

async function main(): Promise<void> {
  const pipePath = resolvePipePath();

  let socket: net.Socket;
  try {
    socket = await waitAndConnect(pipePath);
  } catch {
    log(`failed to connect to derived path — attempting auto-discovery fallback`);
    const discovered = discoverPipe();
    if (!discovered) {
      throw new Error(`No pipe found via derived path or auto-discovery. Is the Diagnostics MCP extension running in VS Code?`);
    }
    log(`fallback: connecting to discovered pipe ${discovered}`);
    socket = await waitAndConnect(discovered);
  }

  log(`connected`);

  // Byte-forward: stdin → pipe, pipe → stdout
  process.stdin.pipe(socket);
  socket.pipe(process.stdout);

  socket.on("close", () => {
    process.stderr.write(`[diagnostics-mcp stdio-bridge] disconnected\n`);
    process.exit(0);
  });

  socket.on("error", (err) => {
    process.stderr.write(`[diagnostics-mcp stdio-bridge] error: ${err.message}\n`);
    process.exit(1);
  });
}

main().catch((err) => {
  process.stderr.write(`[diagnostics-mcp stdio-bridge] fatal: ${err.message}\n`);
  process.exit(1);
});
