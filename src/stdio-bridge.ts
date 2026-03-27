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

import * as net from "net";
import * as os from "os";
import * as path from "path";

const RETRY_INTERVAL_MS = 500;
const MAX_RETRIES = 30; // 15 s

function getPipePath(workspaceRoot: string): string {
  const id = Buffer.from(workspaceRoot)
    .toString("base64")
    .replace(/[/+=]/g, "_")
    .slice(0, 32);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\diagnostics-mcp-${id}`;
  }
  return path.join(os.tmpdir(), `diagnostics-mcp-${id}.sock`);
}

function resolveWorkspaceRoot(): string {
  if (process.env.DIAGNOSTICS_MCP_WORKSPACE) {
    return process.env.DIAGNOSTICS_MCP_WORKSPACE;
  }
  const idx = process.argv.indexOf("--workspace");
  if (idx !== -1 && process.argv[idx + 1]) {
    return process.argv[idx + 1];
  }
  throw new Error(
    "Workspace root required. Set DIAGNOSTICS_MCP_WORKSPACE env var or pass --workspace <path>."
  );
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
  const workspaceRoot = resolveWorkspaceRoot();
  const pipePath = getPipePath(workspaceRoot);

  process.stderr.write(
    `[diagnostics-mcp stdio-bridge] connecting to ${pipePath}\n`
  );

  const socket = await waitAndConnect(pipePath);

  process.stderr.write(`[diagnostics-mcp stdio-bridge] connected\n`);

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
