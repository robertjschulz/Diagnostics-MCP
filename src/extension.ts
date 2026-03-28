import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { DiagnosticsMCPServer } from "./mcp-server";

let outputChannel: vscode.OutputChannel;
let mcpServer: DiagnosticsMCPServer | undefined;
let currentPort: number = 3846;
let currentPipePath: string | undefined;

/**
 * Derive a workspace-scoped named pipe / Unix socket path.
 *
 * Windows : \\.\pipe\diagnostics-mcp-<id>
 * Unix    : <tmpdir>/diagnostics-mcp-<id>.sock
 */
function getPipePath(workspaceRoot: string): string {
  // Normalize drive letter to lowercase on Windows so bridge and extension agree on the pipe name.
  const normalized = process.platform === "win32" ? workspaceRoot.toLowerCase() : workspaceRoot;
  const id = Buffer.from(normalized)
    .toString("base64")
    .replace(/[/+=]/g, "_")
    .slice(0, 32);
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\diagnostics-mcp-${id}`;
  }
  return path.join(os.tmpdir(), `diagnostics-mcp-${id}.sock`);
}

function readConfig() {
  const config = vscode.workspace.getConfiguration("diagnostics-mcp-server");
  return {
    autoStart: config.get<boolean>("autoStart", true),
    port:      config.get<number>("port", 3846),
    transport: config.get<string>("transport", "both"),
  };
}

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Diagnostics MCP Server");
  outputChannel.appendLine("✅ EXTENSION ACTIVATED!");
  outputChannel.show();

  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "default";
  currentPipePath = getPipePath(workspaceRoot);

  const { autoStart, port, transport } = readConfig();
  currentPort = port;

  outputChannel.appendLine(
    `📋 Config — AutoStart: ${autoStart}, Port: ${port}, Transport: ${transport}`
  );
  outputChannel.appendLine(`📁 Pipe path: ${currentPipePath}`);

  if (autoStart) {
    startServers();
  } else {
    outputChannel.appendLine(
      "⏸️ AutoStart disabled — use 'Start MCP Server' command to start manually"
    );
  }

  const startCommand = vscode.commands.registerCommand(
    "diagnostics-mcp.start",
    () => {
      const running = mcpServer?.isHttpListening || mcpServer?.isPipeListening;
      if (!running) {
        startServers();
        vscode.window.showInformationMessage("🚀 Diagnostics MCP Server started");
      } else {
        vscode.window.showInformationMessage(
          "✅ Diagnostics MCP Server already running"
        );
      }
    }
  );

  const stopCommand = vscode.commands.registerCommand(
    "diagnostics-mcp.stop",
    async () => {
      if (mcpServer?.isHttpListening || mcpServer?.isPipeListening) {
        await stopServers();
        vscode.window.showInformationMessage("🛑 Diagnostics MCP Server stopped");
      } else {
        vscode.window.showInformationMessage(
          "⚠️ Diagnostics MCP Server not running"
        );
      }
    }
  );

  const statusCommand = vscode.commands.registerCommand(
    "diagnostics-mcp.status",
    () => {
      const lines: string[] = ["Diagnostics MCP Server Status:"];
      if (mcpServer?.isHttpListening)
        lines.push(`📡 HTTP:  http://localhost:${currentPort}/mcp`);
      if (mcpServer?.isPipeListening)
        lines.push(`🔌 Pipe: ${currentPipePath}`);
      if (!mcpServer?.isHttpListening && !mcpServer?.isPipeListening)
        lines.push("⚠️ Not running");
      vscode.window.showInformationMessage(lines.join("\n"), { modal: true });
    }
  );

  const restartCommand = vscode.commands.registerCommand(
    "diagnostics-mcp.restart",
    async () => {
      outputChannel.appendLine("🔄 Restarting Diagnostics MCP Server...");
      await stopServers();
      startServers();
      vscode.window.showInformationMessage("🔄 Diagnostics MCP Server restarted");
    }
  );

  context.subscriptions.push(
    startCommand,
    stopCommand,
    statusCommand,
    restartCommand
  );

  vscode.window.showInformationMessage("✅ Diagnostics MCP - ACTIVATED!");
}

function startServers(): void {
  const { port, transport } = readConfig();
  currentPort = port;

  mcpServer = new DiagnosticsMCPServer(outputChannel, {} as vscode.ExtensionContext);

  if (transport === "http" || transport === "both") {
    mcpServer
      .startHttp(port)
      .then(() => {
        outputChannel.appendLine(`🚀 HTTP server started on http://localhost:${port}/mcp`);
        vscode.window.showInformationMessage(
          `🚀 Diagnostics MCP HTTP server running on port ${port}`
        );
      })
      .catch((err) => {
        outputChannel.appendLine(`❌ HTTP server failed: ${err.message}`);
        vscode.window.showErrorMessage(
          `Diagnostics MCP HTTP: ${err.message}`
        );
      });
  }

  if (transport === "pipe" || transport === "both") {
    if (!currentPipePath) return;
    mcpServer
      .startPipe(currentPipePath)
      .then(() => {
        outputChannel.appendLine(`🚀 Pipe server started on ${currentPipePath}`);
      })
      .catch((err) => {
        outputChannel.appendLine(`❌ Pipe server failed: ${err.message}`);
        vscode.window.showErrorMessage(
          `Diagnostics MCP pipe: ${err.message}`
        );
      });
  }
}

async function stopServers(): Promise<void> {
  if (mcpServer) {
    await mcpServer.stopAll();
    mcpServer = undefined;
  }
}

export function deactivate(): Thenable<void> {
  return stopServers();
}
