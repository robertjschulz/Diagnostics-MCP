import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as net from "net";
import * as vscode from "vscode";

/**
 * Diagnostic information structure
 */
interface DiagnosticInfo {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  severity: string;
  message: string;
  source?: string;
  code?: string | number;
}

/**
 * MCP Server for VS Code Diagnostics — named pipe transport.
 *
 * Each client connection to the pipe gets its own MCP Server instance;
 * all instances share the same live diagnostics cache.
 */
export class DiagnosticsMCPServer {
  private diagnosticsCache: Map<string, vscode.Diagnostic[]> = new Map();
  private disposables: vscode.Disposable[] = [];
  private pipeServer?: net.Server;

  constructor(
    private outputChannel: vscode.OutputChannel,
    private context: vscode.ExtensionContext
  ) {
    this.setupDiagnosticsListener();
    this.log("DiagnosticsMCPServer initialized");
  }

  // ── Pipe server ──────────────────────────────────────────────────────────

  /**
   * Start listening on a named pipe / Unix domain socket.
   * Each incoming connection gets its own MCP Server + StdioServerTransport.
   */
  async startPipe(pipePath: string): Promise<void> {
    // Remove stale socket file on Unix before binding
    if (process.platform !== "win32") {
      try {
        fs.unlinkSync(pipePath);
      } catch {
        /* ignore — file may not exist */
      }
    }

    return new Promise((resolve, reject) => {
      this.pipeServer = net.createServer((socket) => {
        this.log("MCP client connected via pipe");
        const server = this.buildServer();
        // StdioServerTransport accepts any Readable/Writable; net.Socket is a Duplex
        const transport = new StdioServerTransport(socket as any, socket as any);
        server.connect(transport).catch((err) =>
          this.log(`Transport error: ${err}`)
        );
        socket.on("close", () => this.log("MCP client disconnected"));
      });

      this.pipeServer.on("error", reject);
      this.pipeServer.listen(pipePath, () => {
        this.log(`Pipe server listening on ${pipePath}`);
        resolve();
      });
    });
  }

  async stopPipe(): Promise<void> {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];

    if (this.pipeServer) {
      await new Promise<void>((resolve) =>
        this.pipeServer!.close(() => resolve())
      );
      this.pipeServer = undefined;
    }

    this.log("Pipe server stopped");
  }

  get isListening(): boolean {
    return this.pipeServer?.listening ?? false;
  }

  // ── MCP Server factory ───────────────────────────────────────────────────

  /** Create a fresh MCP Server instance wired to the shared diagnostics cache. */
  private buildServer(): Server {
    const server = new Server(
      { name: "diagnostics-mcp-server", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    const tools: Tool[] = [
      {
        name: "get_all_diagnostics",
        description:
          "Get all diagnostics (errors, warnings, info) from all files in the workspace",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_file_diagnostics",
        description: "Get diagnostics for a specific file path",
        inputSchema: {
          type: "object",
          properties: {
            filePath: {
              type: "string",
              description: "Absolute path to the file",
            },
          },
          required: ["filePath"],
        },
      },
      {
        name: "get_diagnostics_by_severity",
        description: "Get diagnostics filtered by severity level",
        inputSchema: {
          type: "object",
          properties: {
            severity: {
              type: "string",
              enum: ["error", "warning", "information", "hint"],
              description: "Severity level to filter by",
            },
          },
          required: ["severity"],
        },
      },
      {
        name: "get_diagnostics_summary",
        description: "Get a summary of diagnostic counts by severity",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_workspace_health",
        description: "Get overall workspace health score based on diagnostics",
        inputSchema: { type: "object", properties: {} },
      },
    ];

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        switch (name) {
          case "get_all_diagnostics":
            return this.getAllDiagnostics();
          case "get_file_diagnostics":
            return this.getFileDiagnostics(args?.filePath as string);
          case "get_diagnostics_by_severity":
            return this.getDiagnosticsBySeverity(args?.severity as string);
          case "get_diagnostics_summary":
            return this.getDiagnosticsSummary();
          case "get_workspace_health":
            return this.getWorkspaceHealth();
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: JSON.stringify({ error: msg }) }],
        };
      }
    });

    return server;
  }

  // ── Diagnostics listener ─────────────────────────────────────────────────

  private setupDiagnosticsListener(): void {
    this.refreshAllDiagnostics();
    const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
      for (const uri of e.uris) {
        this.diagnosticsCache.set(
          uri.toString(),
          vscode.languages.getDiagnostics(uri)
        );
      }
    });
    this.disposables.push(disposable);
  }

  private refreshAllDiagnostics(): void {
    this.diagnosticsCache.clear();
    for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
      this.diagnosticsCache.set(uri.toString(), diagnostics);
    }
  }

  // ── Tool implementations ─────────────────────────────────────────────────

  private convertDiagnostic(
    uri: string,
    diagnostic: vscode.Diagnostic
  ): DiagnosticInfo {
    const severityMap: Record<number, string> = {
      [vscode.DiagnosticSeverity.Error]: "error",
      [vscode.DiagnosticSeverity.Warning]: "warning",
      [vscode.DiagnosticSeverity.Information]: "information",
      [vscode.DiagnosticSeverity.Hint]: "hint",
    };
    return {
      file: vscode.Uri.parse(uri).fsPath,
      line: diagnostic.range.start.line + 1,
      column: diagnostic.range.start.character + 1,
      endLine: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.character + 1,
      severity: severityMap[diagnostic.severity],
      message: diagnostic.message,
      source: diagnostic.source,
      code: diagnostic.code ? String(diagnostic.code) : undefined,
    };
  }

  private getAllDiagnostics() {
    const diagnostics: DiagnosticInfo[] = [];
    for (const [uri, items] of this.diagnosticsCache) {
      for (const d of items) diagnostics.push(this.convertDiagnostic(uri, d));
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ total: diagnostics.length, diagnostics }, null, 2),
        },
      ],
    };
  }

  private getFileDiagnostics(filePath: string) {
    if (!filePath) throw new Error("filePath is required");
    const uri = vscode.Uri.file(filePath);
    const items = vscode.languages.getDiagnostics(uri);
    const diagnostics = items.map((d) =>
      this.convertDiagnostic(uri.toString(), d)
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { file: filePath, total: diagnostics.length, diagnostics },
            null,
            2
          ),
        },
      ],
    };
  }

  private getDiagnosticsBySeverity(severity: string) {
    const valid = ["error", "warning", "information", "hint"];
    if (!valid.includes(severity))
      throw new Error(`severity must be one of: ${valid.join(", ")}`);

    const filtered: DiagnosticInfo[] = [];
    for (const [uri, items] of this.diagnosticsCache) {
      for (const d of items) {
        const converted = this.convertDiagnostic(uri, d);
        if (converted.severity === severity) filtered.push(converted);
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            { severity, total: filtered.length, diagnostics: filtered },
            null,
            2
          ),
        },
      ],
    };
  }

  private getDiagnosticsSummary() {
    const summary = {
      error: 0,
      warning: 0,
      information: 0,
      hint: 0,
      total: 0,
      filesWithIssues: 0,
    };
    for (const [, items] of this.diagnosticsCache) {
      if (items.length > 0) summary.filesWithIssues++;
      for (const d of items) {
        summary.total++;
        if (d.severity === vscode.DiagnosticSeverity.Error) summary.error++;
        else if (d.severity === vscode.DiagnosticSeverity.Warning)
          summary.warning++;
        else if (d.severity === vscode.DiagnosticSeverity.Information)
          summary.information++;
        else summary.hint++;
      }
    }
    return {
      content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
    };
  }

  private getWorkspaceHealth() {
    let errors = 0,
      warnings = 0,
      information = 0,
      hint = 0;
    for (const [, items] of this.diagnosticsCache) {
      for (const d of items) {
        if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
        else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
        else if (d.severity === vscode.DiagnosticSeverity.Information)
          information++;
        else hint++;
      }
    }
    const penalty = errors * 10 + warnings * 3 + information * 1 + hint * 0.5;
    const healthScore = Math.round(Math.max(0, Math.min(100, 100 - penalty)));
    const status =
      healthScore >= 90
        ? "excellent"
        : healthScore >= 70
        ? "good"
        : healthScore >= 50
        ? "fair"
        : healthScore >= 30
        ? "poor"
        : "critical";
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              healthScore,
              status,
              breakdown: { errors, warnings, information, hint },
              recommendation:
                healthScore < 50
                  ? "Address errors and warnings to improve code quality"
                  : healthScore < 90
                  ? "Good progress! Consider addressing remaining warnings"
                  : "Excellent! Workspace is in great shape",
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private log(message: string): void {
    this.outputChannel.appendLine(
      `[${new Date().toISOString()}] ${message}`
    );
  }
}
