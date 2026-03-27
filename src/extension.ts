import * as vscode from "vscode";
import * as http from "http";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

let outputChannel: vscode.OutputChannel;
let httpServer: http.Server | undefined;
let serverPort: number = 3846; // Default port, will be overridden by config
let portFilePath: string | undefined;

/**
 * Extension activation - WITH HTTP SERVER
 */
export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("Diagnostics MCP Server");
  outputChannel.appendLine("✅ EXTENSION ACTIVATED!");
  outputChannel.show();

  // Derive a stable port-file path based on the workspace root
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "default";
  const workspaceId = Buffer.from(workspaceRoot).toString("base64").replace(/[/+=]/g, "_").slice(0, 32);
  portFilePath = path.join(os.tmpdir(), `diagnostics-mcp-${workspaceId}.port`);
  outputChannel.appendLine(`📁 Port file: ${portFilePath}`);

  // Read configuration
  const config = vscode.workspace.getConfiguration("diagnostics-mcp-server");
  const autoStart = config.get<boolean>("autoStart", true);
  serverPort = config.get<number>("port", 3846);

  outputChannel.appendLine(
    `📋 Config - AutoStart: ${autoStart}, Port: ${serverPort}`
  );

  // Start HTTP server for MCP if autoStart is enabled
  if (autoStart) {
    startHttpServer();
  } else {
    outputChannel.appendLine(
      "⏸️ AutoStart disabled - use 'Start HTTP MCP Server' command to start manually"
    );
  }

  // Register commands
  const startCommand = vscode.commands.registerCommand(
    "diagnostics-mcp.start",
    () => {
      if (!httpServer || !httpServer.listening) {
        // Re-read port from config so changes to settings.json take effect
        serverPort = vscode.workspace.getConfiguration("diagnostics-mcp-server").get<number>("port", 3846);
        startHttpServer();
        vscode.window.showInformationMessage(
          `🚀 HTTP MCP Server started on port ${serverPort}`
        );
        outputChannel.appendLine(
          `🚀 HTTP MCP Server manually started on port ${serverPort}`
        );
      } else {
        vscode.window.showInformationMessage(
          `✅ HTTP MCP Server already running on port ${serverPort}`
        );
        outputChannel.appendLine("✅ HTTP MCP Server already running");
      }
    }
  );

  const stopCommand = vscode.commands.registerCommand(
    "diagnostics-mcp.stop",
    () => {
      if (httpServer && httpServer.listening) {
        stopHttpServer();
        vscode.window.showInformationMessage("🛑 HTTP MCP Server stopped");
        outputChannel.appendLine("🛑 HTTP MCP Server stopped");
      } else {
        vscode.window.showInformationMessage("⚠️ HTTP MCP Server not running");
        outputChannel.appendLine("⚠️ HTTP MCP Server not running");
      }
    }
  );

  const statusCommand = vscode.commands.registerCommand(
    "diagnostics-mcp.status",
    () => {
      const isRunning = httpServer && httpServer.listening;
      const status = isRunning ? "RUNNING" : "STOPPED";
      const port = isRunning ? serverPort.toString() : "N/A";
      const url = isRunning ? `http://127.0.0.1:${serverPort}/mcp` : "N/A";

      const diagnosticsResult = getAllDiagnostics();
      const healthResult = getWorkspaceHealth();

      const message = `HTTP MCP Server Status:
📡 Status: ${status}
🌐 Port: ${port}
🔗 URL: ${url}
🛠️ Tools: 5 (all diagnostics, errors, warnings, info, health)
📊 Current Diagnostics: ${diagnosticsResult.total}
💚 Health Score: ${healthResult.healthScore}%`;

      vscode.window.showInformationMessage(message, { modal: true });
      outputChannel.appendLine(
        `Status check: ${status} - Diagnostics: ${diagnosticsResult.total} - Health: ${healthResult.healthScore}%`
      );
    }
  );

  const restartCommand = vscode.commands.registerCommand(
    "diagnostics-mcp.restart",
    () => {
      // Always re-read port from config so settings.json changes take effect
      serverPort = vscode.workspace.getConfiguration("diagnostics-mcp-server").get<number>("port", 3846);
      if (httpServer && httpServer.listening) {
        outputChannel.appendLine("🔄 Restarting HTTP MCP Server...");
        stopHttpServer();
        // Wait a bit before restarting
        setTimeout(() => {
          startHttpServer();
          vscode.window.showInformationMessage(
            `🔄 HTTP MCP Server restarted on port ${serverPort}`
          );
          outputChannel.appendLine(
            `✅ HTTP MCP Server restarted on port ${serverPort}`
          );
        }, 500);
      } else {
        startHttpServer();
        vscode.window.showInformationMessage(
          `🚀 HTTP MCP Server started on port ${serverPort}`
        );
        outputChannel.appendLine(
          `🚀 HTTP MCP Server started on port ${serverPort}`
        );
      }
    }
  );

  // Add commands to context
  context.subscriptions.push(
    startCommand,
    stopCommand,
    statusCommand,
    restartCommand
  );

  vscode.window.showInformationMessage("✅ Diagnostics MCP - ACTIVATED!");
  console.log("✅ DIAGNOSTICS MCP: ACTIVATED");
}

/**
 * Start HTTP server for MCP protocol
 */
function startHttpServer() {
  httpServer = http.createServer((req, res) => {
    // Handle CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    if (req.url === "/health") {
      // Health check endpoint
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", server: "diagnostics-mcp" }));
      return;
    }

    if (req.url === "/mcp") {
      // MCP Protocol endpoint - Server-Sent Events
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });

      // Handle incoming MCP messages
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });

      req.on("end", () => {
        if (body) {
          try {
            const message = JSON.parse(body);
            handleMCPMessage(message, res);
          } catch (error) {
            outputChannel.appendLine(`Error parsing MCP message: ${error}`);
          }
        } else {
          // Send initial connection response
          res.write(`: connected\n\n`);
        }
      });

      // Keep connection alive
      const keepAlive = setInterval(() => {
        res.write(`: keepalive\n\n`);
      }, 30000);

      req.on("close", () => {
        clearInterval(keepAlive);
        outputChannel.appendLine("MCP client disconnected");
      });

      return;
    }

    // 404 for other paths
    res.writeHead(404);
    res.end("Not Found");
  });

  httpServer.listen(serverPort, () => {
    outputChannel.appendLine(
      `🚀 HTTP Server started on http://localhost:${serverPort}`
    );
    outputChannel.appendLine(
      `   - Health: http://localhost:${serverPort}/health`
    );
    outputChannel.appendLine(`   - MCP: http://localhost:${serverPort}/mcp`);
    // Write active port to temp file so external tools (proxy scripts) can discover it
    if (portFilePath) {
      fs.writeFileSync(portFilePath, String(serverPort), "utf8");
      outputChannel.appendLine(`📝 Port written to ${portFilePath}`);
    }
    vscode.window.showInformationMessage(
      `🚀 Diagnostics MCP Server running on http://localhost:${serverPort}`
    );
  });

  httpServer.on("error", (error) => {
    outputChannel.appendLine(`❌ HTTP Server error: ${error.message}`);
    vscode.window.showErrorMessage(`HTTP Server error: ${error.message}`);
  });
}

/**
 * Stop HTTP server
 */
function stopHttpServer() {
  if (httpServer && httpServer.listening) {
    httpServer.close(() => {
      outputChannel.appendLine("🛑 HTTP Server stopped");
    });
    httpServer = undefined;
    // Remove the port file so external tools know the server is no longer running
    if (portFilePath && fs.existsSync(portFilePath)) {
      fs.unlinkSync(portFilePath);
    }
  }
}

/**
 * Extension deactivation
 */
export function deactivate() {
  stopHttpServer();
  console.log("👋 DIAGNOSTICS MCP: DEACTIVATED");
}

/**
 * Handle MCP protocol messages with enhanced error handling and connection stability
 */
function handleMCPMessage(message: any, res: http.ServerResponse) {
  try {
    outputChannel.appendLine(`Received MCP message: ${message.method}`);

    if (message.method === "initialize") {
      // Initialize request
      const response = {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "diagnostics-mcp-server",
            version: "1.0.10",
          },
        },
      };
      res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
      outputChannel.appendLine("Sent initialize response");
    } else if (message.method === "tools/list") {
      // List available tools
      const response = {
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [
            {
              name: "get_all_diagnostics",
              description: "Get all diagnostics from the workspace",
              inputSchema: {
                type: "object",
                properties: {},
              },
            },
            {
              name: "get_workspace_health",
              description: "Get workspace health score based on diagnostics",
              inputSchema: {
                type: "object",
                properties: {},
              },
            },
            {
              name: "get_errors",
              description:
                "Get only error-level diagnostics from the workspace",
              inputSchema: {
                type: "object",
                properties: {},
              },
            },
            {
              name: "get_warnings",
              description:
                "Get only warning-level diagnostics from the workspace",
              inputSchema: {
                type: "object",
                properties: {},
              },
            },
            {
              name: "get_info",
              description: "Get only info-level diagnostics from the workspace",
              inputSchema: {
                type: "object",
                properties: {},
              },
            },
          ],
        },
      };
      res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
      outputChannel.appendLine("Sent tools/list response with 5 tools");
    } else if (message.method === "tools/call") {
      // Handle tool calls with enhanced error handling
      const toolName = message.params?.name;
      outputChannel.appendLine(`Executing tool: ${toolName}`);

      let toolResult: any = {};

      try {
        if (toolName === "get_all_diagnostics") {
          toolResult = getAllDiagnostics();
        } else if (toolName === "get_workspace_health") {
          toolResult = getWorkspaceHealth();
        } else if (toolName === "get_errors") {
          toolResult = getDiagnosticsBySeverity(
            vscode.DiagnosticSeverity.Error
          );
        } else if (toolName === "get_warnings") {
          toolResult = getDiagnosticsBySeverity(
            vscode.DiagnosticSeverity.Warning
          );
        } else if (toolName === "get_info") {
          toolResult = getDiagnosticsBySeverity(
            vscode.DiagnosticSeverity.Information
          );
        } else {
          // Return proper error response for unknown tools
          const errorResponse = {
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32601,
              message: `Unknown tool: ${toolName}`,
            },
          };
          res.write(
            `event: message\ndata: ${JSON.stringify(errorResponse)}\n\n`
          );
          outputChannel.appendLine(`Unknown tool requested: ${toolName}`);
          return;
        }

        // Ensure result is valid even if empty
        if (toolResult === null || toolResult === undefined) {
          toolResult = { message: "No data available", status: "empty" };
        }

        outputChannel.appendLine(
          `Tool ${toolName} executed successfully, result count: ${
            JSON.stringify(toolResult).length
          } characters`
        );

        const response = {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(toolResult, null, 2),
              },
            ],
          },
        };
        res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
        outputChannel.appendLine(`Sent response for tool: ${toolName}`);
      } catch (toolError) {
        const errorMessage =
          toolError instanceof Error ? toolError.message : String(toolError);
        outputChannel.appendLine(
          `Tool execution error for ${toolName}: ${errorMessage}`
        );
        const errorResponse = {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: `Tool execution failed: ${errorMessage}`,
            data: String(toolError),
          },
        };
        res.write(`event: message\ndata: ${JSON.stringify(errorResponse)}\n\n`);
      }
    } else {
      // Handle unknown methods
      outputChannel.appendLine(`Unknown method: ${message.method}`);
      const errorResponse = {
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: -32601,
          message: "Method not found",
        },
      };
      res.write(`event: message\ndata: ${JSON.stringify(errorResponse)}\n\n`);
    }
  } catch (error) {
    outputChannel.appendLine(`Critical error handling MCP message: ${error}`);
    const errorResponse = {
      jsonrpc: "2.0",
      id: message.id || null,
      error: {
        code: -32603,
        message: "Internal server error",
        data: String(error),
      },
    };

    try {
      res.write(`event: message\ndata: ${JSON.stringify(errorResponse)}\n\n`);
    } catch (writeError) {
      outputChannel.appendLine(`Failed to write error response: ${writeError}`);
    }
  }
}

/**
 * Get all diagnostics from VS Code with enhanced error handling
 */
function getAllDiagnostics() {
  try {
    const diagnostics = vscode.languages.getDiagnostics();
    let totalDiagnostics = 0;
    const diagnosticsList: any[] = [];

    for (const [uri, fileDiagnostics] of diagnostics) {
      totalDiagnostics += fileDiagnostics.length;
      for (const diagnostic of fileDiagnostics) {
        diagnosticsList.push({
          file: uri.fsPath,
          line: diagnostic.range.start.line + 1,
          column: diagnostic.range.start.character + 1,
          severity:
            diagnostic.severity === 0
              ? "error"
              : diagnostic.severity === 1
              ? "warning"
              : "info",
          message: diagnostic.message || "No message",
          source: diagnostic.source || "unknown",
        });
      }
    }

    return {
      total: totalDiagnostics,
      diagnostics: diagnosticsList,
      status: totalDiagnostics > 0 ? "found" : "empty",
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    outputChannel.appendLine(`Error getting diagnostics: ${error}`);
    return {
      total: 0,
      diagnostics: [],
      status: "error",
      error: String(error),
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Get workspace health score with enhanced error handling
 */
function getWorkspaceHealth() {
  try {
    const diagnostics = vscode.languages.getDiagnostics();
    let errors = 0;
    let warnings = 0;
    let infos = 0;

    for (const [, fileDiagnostics] of diagnostics) {
      for (const diagnostic of fileDiagnostics) {
        if (diagnostic.severity === 0) errors++;
        else if (diagnostic.severity === 1) warnings++;
        else infos++;
      }
    }

    // Simple health score calculation
    const totalIssues = errors + warnings + infos;
    const errorPenalty = errors * 10;
    const warningPenalty = warnings * 3;
    const infoPenalty = infos * 1;
    const healthScore = Math.max(
      0,
      Math.min(100, 100 - (errorPenalty + warningPenalty + infoPenalty))
    );

    return {
      healthScore: Math.round(healthScore),
      status:
        healthScore >= 90
          ? "excellent"
          : healthScore >= 70
          ? "good"
          : healthScore >= 50
          ? "fair"
          : "poor",
      summary: { errors, warnings, infos, total: totalIssues },
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    outputChannel.appendLine(`Error calculating workspace health: ${error}`);
    return {
      healthScore: 0,
      status: "error",
      summary: { errors: 0, warnings: 0, infos: 0, total: 0 },
      error: String(error),
      timestamp: new Date().toISOString(),
    };
  }
}

/**
 * Get diagnostics filtered by severity level with enhanced error handling
 */
function getDiagnosticsBySeverity(severity: vscode.DiagnosticSeverity) {
  try {
    const diagnostics = vscode.languages.getDiagnostics();
    let totalDiagnostics = 0;
    const diagnosticsList: any[] = [];

    for (const [uri, fileDiagnostics] of diagnostics) {
      for (const diagnostic of fileDiagnostics) {
        if (diagnostic.severity === severity) {
          totalDiagnostics++;
          diagnosticsList.push({
            file: uri.fsPath,
            line: diagnostic.range.start.line + 1,
            column: diagnostic.range.start.character + 1,
            severity:
              severity === 0 ? "error" : severity === 1 ? "warning" : "info",
            message: diagnostic.message || "No message",
            source: diagnostic.source || "unknown",
          });
        }
      }
    }

    const severityName =
      severity === 0 ? "errors" : severity === 1 ? "warnings" : "info";

    return {
      count: totalDiagnostics,
      diagnostics: diagnosticsList,
      severityLevel: severityName,
      status: totalDiagnostics > 0 ? "found" : "empty",
      timestamp: new Date().toISOString(),
    };
  } catch (error) {
    const severityName =
      severity === 0 ? "errors" : severity === 1 ? "warnings" : "info";
    outputChannel.appendLine(`Error getting ${severityName}: ${error}`);
    return {
      count: 0,
      diagnostics: [],
      severityLevel: severityName,
      status: "error",
      error: String(error),
      timestamp: new Date().toISOString(),
    };
  }
}
