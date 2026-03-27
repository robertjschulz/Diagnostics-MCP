import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { DiagnosticsMCPServer } from "./mcp-server";

let outputChannel: vscode.OutputChannel;
let mcpServer: DiagnosticsMCPServer | undefined;
let currentPipePath: string | undefined;

/**
 * Derive a workspace-scoped named pipe / Unix socket path.
 *
 * Windows : \\.\pipe\diagnostics-mcp-<id>
 * Unix    : <tmpdir>/diagnostics-mcp-<id>.sock
 */
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

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Diagnostics MCP Server");
  outputChannel.appendLine("✅ EXTENSION ACTIVATED!");
  outputChannel.show();

  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "default";
  currentPipePath = getPipePath(workspaceRoot);
  outputChannel.appendLine(`📁 Pipe path: ${currentPipePath}`);

  const config = vscode.workspace.getConfiguration("diagnostics-mcp-server");
  const autoStart = config.get<boolean>("autoStart", true);
  outputChannel.appendLine(`📋 Config - AutoStart: ${autoStart}`);

  if (autoStart) {
    startPipeServer();
  } else {
    outputChannel.appendLine(
      "⏸️ AutoStart disabled — use 'Start MCP Server' command to start manually"
    );
  }

  const startCommand = vscode.commands.registerCommand(
    "diagnostics-mcp.start",
    () => {
      if (!mcpServer?.isListening) {
        startPipeServer();
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
      if (mcpServer?.isListening) {
        await stopPipeServer();
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
      const running = mcpServer?.isListening ?? false;
      vscode.window.showInformationMessage(
        `Diagnostics MCP Server: ${running ? `RUNNING on ${currentPipePath}` : "STOPPED"}`,
        { modal: true }
      );
    }
  );

  const restartCommand = vscode.commands.registerCommand(
    "diagnostics-mcp.restart",
    async () => {
      outputChannel.appendLine("🔄 Restarting Diagnostics MCP Server...");
      await stopPipeServer();
      startPipeServer();
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

function startPipeServer(): void {
  if (!currentPipePath) return;
  mcpServer = new DiagnosticsMCPServer(outputChannel, {} as vscode.ExtensionContext);
  mcpServer
    .startPipe(currentPipePath)
    .then(() => {
      outputChannel.appendLine(`🚀 MCP Server listening on ${currentPipePath}`);
      outputChannel.appendLine(`   Connect with: DIAGNOSTICS_MCP_WORKSPACE=<workspaceRoot>`);
    })
    .catch((err) => {
      outputChannel.appendLine(`❌ Failed to start pipe server: ${err.message}`);
      vscode.window.showErrorMessage(
        `Diagnostics MCP: failed to start — ${err.message}`
      );
    });
}

async function stopPipeServer(): Promise<void> {
  if (mcpServer) {
    await mcpServer.stopPipe();
    mcpServer = undefined;
  }
}

export function deactivate(): Thenable<void> {
  return stopPipeServer();
}
