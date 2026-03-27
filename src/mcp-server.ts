import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as http from "http";
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
 * MCP Server for VS Code Diagnostics.
 *
 * Supports two transports that can run simultaneously:
 *   - HTTP  (SSE) via startHttp(port)  — backward-compatible
 *   - Named pipe / Unix socket via startPipe(pipePath) — stdio-friendly, no port conflicts
 *
 * Each client connection to the pipe gets its own MCP Server instance;
 * all instances share the same live diagnostics cache.
 */
export class DiagnosticsMCPServer {
  private diagnosticsCache: Map<string, vscode.Diagnostic[]> = new Map();
  private disposables: vscode.Disposable[] = [];
  private httpServer?: http.Server;
  private pipeServer?: net.Server;

  constructor(
    private outputChannel: vscode.OutputChannel,
    private context: vscode.ExtensionContext
  ) {
    this.setupDiagnosticsListener();
    this.log("DiagnosticsMCPServer initialized");
  }

  // ── HTTP transport ────────────────────────────────────────────────────────

  async startHttp(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer(async (req, res) => {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type");

        if (req.method === "OPTIONS") {
          res.writeHead(200);
          res.end();
          return;
        }

        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "ok", server: "diagnostics-mcp" }));
          return;
        }

        if (req.url === "/mcp") {
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            Connection: "keep-alive",
          });

          let body = "";
          req.on("data", (chunk) => (body += chunk.toString()));
          req.on("end", () => {
            if (body) {
              try {
                this.handleHttpMCPMessage(JSON.parse(body), res);
              } catch (err) {
                this.log(`Error parsing MCP message: ${err}`);
              }
            } else {
              res.write(`: connected\n\n`);
            }
          });

          const keepAlive = setInterval(() => res.write(`: keepalive\n\n`), 30000);
          req.on("close", () => {
            clearInterval(keepAlive);
            this.log("HTTP MCP client disconnected");
          });
          return;
        }

        res.writeHead(404);
        res.end("Not Found");
      });

      this.httpServer.on("error", reject);
      this.httpServer.listen(port, () => {
        this.log(`HTTP server listening on http://localhost:${port}`);
        resolve();
      });
    });
  }

  async stopHttp(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => this.httpServer!.close(() => resolve()));
      this.httpServer = undefined;
    }
  }

  get isHttpListening(): boolean {
    return this.httpServer?.listening ?? false;
  }

  // ── Pipe transport ────────────────────────────────────────────────────────

  /**
   * Start listening on a named pipe / Unix domain socket.
   * Each incoming connection gets its own MCP Server + StdioServerTransport.
   */
  async startPipe(pipePath: string): Promise<void> {
    // Remove stale socket file on Unix before binding
    if (process.platform !== "win32") {
      try { fs.unlinkSync(pipePath); } catch { /* ignore */ }
    }

    return new Promise((resolve, reject) => {
      this.pipeServer = net.createServer((socket) => {
        this.log("MCP client connected via pipe");
        const server = this.buildServer();
        // StdioServerTransport accepts any Readable/Writable; net.Socket is a Duplex
        const transport = new StdioServerTransport(socket as any, socket as any);
        server.connect(transport).catch((err) => this.log(`Transport error: ${err}`));
        socket.on("close", () => this.log("MCP client disconnected from pipe"));
      });

      this.pipeServer.on("error", reject);
      this.pipeServer.listen(pipePath, () => {
        this.log(`Pipe server listening on ${pipePath}`);
        resolve();
      });
    });
  }

  async stopPipe(): Promise<void> {
    if (this.pipeServer) {
      await new Promise<void>((resolve) => this.pipeServer!.close(() => resolve()));
      this.pipeServer = undefined;
    }
  }

  get isPipeListening(): boolean {
    return this.pipeServer?.listening ?? false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async stopAll(): Promise<void> {
    await Promise.all([this.stopHttp(), this.stopPipe()]);
    for (const d of this.disposables) d.dispose();
    this.disposables = [];
    this.log("All servers stopped");
  }

  // ── MCP Server factory (one per pipe connection) ──────────────────────────

  private buildServer(): Server {
    const server = new Server(
      { name: "diagnostics-mcp-server", version: "1.0.0" },
      { capabilities: { tools: {} } }
    );

    const tools: Tool[] = [
      {
        name: "get_all_diagnostics",
        description: "Get all diagnostics (errors, warnings, info) from all files in the workspace",
        inputSchema: { type: "object", properties: {} },
      },
      {
        name: "get_file_diagnostics",
        description: "Get diagnostics for a specific file path",
        inputSchema: {
          type: "object",
          properties: {
            filePath: { type: "string", description: "Absolute path to the file" },
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
          case "get_all_diagnostics":       return this.getAllDiagnostics();
          case "get_file_diagnostics":      return this.getFileDiagnostics(args?.filePath as string);
          case "get_diagnostics_by_severity": return this.getDiagnosticsBySeverity(args?.severity as string);
          case "get_diagnostics_summary":   return this.getDiagnosticsSummary();
          case "get_workspace_health":      return this.getWorkspaceHealth();
          default: throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: JSON.stringify({ error: msg }) }] };
      }
    });

    return server;
  }

  // ── HTTP MCP message handler (SSE style) ──────────────────────────────────

  private handleHttpMCPMessage(message: any, res: http.ServerResponse): void {
    const send = (obj: object) =>
      res.write(`event: message\ndata: ${JSON.stringify(obj)}\n\n`);

    if (message.method === "initialize") {
      send({
        jsonrpc: "2.0", id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "diagnostics-mcp-server", version: "1.0.0" },
        },
      });
    } else if (message.method === "tools/list") {
      this.buildServer(); // reuse tool list from buildServer
      send({
        jsonrpc: "2.0", id: message.id,
        result: {
          tools: [
            { name: "get_all_diagnostics",       description: "Get all diagnostics from the workspace",                inputSchema: { type: "object", properties: {} } },
            { name: "get_file_diagnostics",       description: "Get diagnostics for a specific file path",             inputSchema: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } },
            { name: "get_diagnostics_by_severity",description: "Get diagnostics filtered by severity level",           inputSchema: { type: "object", properties: { severity: { type: "string", enum: ["error","warning","information","hint"] } }, required: ["severity"] } },
            { name: "get_diagnostics_summary",    description: "Get a summary of diagnostic counts by severity",       inputSchema: { type: "object", properties: {} } },
            { name: "get_workspace_health",       description: "Get overall workspace health score based on diagnostics", inputSchema: { type: "object", properties: {} } },
          ],
        },
      });
    } else if (message.method === "tools/call") {
      const name = message.params?.name;
      const args = message.params?.arguments;
      try {
        let result: any;
        switch (name) {
          case "get_all_diagnostics":        result = this.getAllDiagnostics(); break;
          case "get_file_diagnostics":       result = this.getFileDiagnostics(args?.filePath); break;
          case "get_diagnostics_by_severity":result = this.getDiagnosticsBySeverity(args?.severity); break;
          case "get_diagnostics_summary":    result = this.getDiagnosticsSummary(); break;
          case "get_workspace_health":       result = this.getWorkspaceHealth(); break;
          default: throw new Error(`Unknown tool: ${name}`);
        }
        send({ jsonrpc: "2.0", id: message.id, result });
      } catch (err) {
        send({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: String(err) } });
      }
    } else {
      send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
    }
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────

  private setupDiagnosticsListener(): void {
    this.refreshAllDiagnostics();
    const disposable = vscode.languages.onDidChangeDiagnostics((e) => {
      for (const uri of e.uris) {
        this.diagnosticsCache.set(uri.toString(), vscode.languages.getDiagnostics(uri));
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

  private convertDiagnostic(uri: string, diagnostic: vscode.Diagnostic): DiagnosticInfo {
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
    for (const [uri, items] of this.diagnosticsCache)
      for (const d of items) diagnostics.push(this.convertDiagnostic(uri, d));
    return { content: [{ type: "text", text: JSON.stringify({ total: diagnostics.length, diagnostics }, null, 2) }] };
  }

  private getFileDiagnostics(filePath: string) {
    if (!filePath) throw new Error("filePath is required");
    const uri = vscode.Uri.file(filePath);
    const diagnostics = vscode.languages.getDiagnostics(uri).map((d) => this.convertDiagnostic(uri.toString(), d));
    return { content: [{ type: "text", text: JSON.stringify({ file: filePath, total: diagnostics.length, diagnostics }, null, 2) }] };
  }

  private getDiagnosticsBySeverity(severity: string) {
    const valid = ["error", "warning", "information", "hint"];
    if (!valid.includes(severity)) throw new Error(`severity must be one of: ${valid.join(", ")}`);
    const filtered: DiagnosticInfo[] = [];
    for (const [uri, items] of this.diagnosticsCache)
      for (const d of items) {
        const c = this.convertDiagnostic(uri, d);
        if (c.severity === severity) filtered.push(c);
      }
    return { content: [{ type: "text", text: JSON.stringify({ severity, total: filtered.length, diagnostics: filtered }, null, 2) }] };
  }

  private getDiagnosticsSummary() {
    const s = { error: 0, warning: 0, information: 0, hint: 0, total: 0, filesWithIssues: 0 };
    for (const [, items] of this.diagnosticsCache) {
      if (items.length > 0) s.filesWithIssues++;
      for (const d of items) {
        s.total++;
        if (d.severity === vscode.DiagnosticSeverity.Error) s.error++;
        else if (d.severity === vscode.DiagnosticSeverity.Warning) s.warning++;
        else if (d.severity === vscode.DiagnosticSeverity.Information) s.information++;
        else s.hint++;
      }
    }
    return { content: [{ type: "text", text: JSON.stringify(s, null, 2) }] };
  }

  private getWorkspaceHealth() {
    let errors = 0, warnings = 0, information = 0, hint = 0;
    for (const [, items] of this.diagnosticsCache)
      for (const d of items) {
        if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
        else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
        else if (d.severity === vscode.DiagnosticSeverity.Information) information++;
        else hint++;
      }
    const penalty = errors * 10 + warnings * 3 + information * 1 + hint * 0.5;
    const healthScore = Math.round(Math.max(0, Math.min(100, 100 - penalty)));
    const status = healthScore >= 90 ? "excellent" : healthScore >= 70 ? "good" : healthScore >= 50 ? "fair" : healthScore >= 30 ? "poor" : "critical";
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          healthScore, status,
          breakdown: { errors, warnings, information, hint },
          recommendation: healthScore < 50 ? "Address errors and warnings to improve code quality"
            : healthScore < 90 ? "Good progress! Consider addressing remaining warnings"
            : "Excellent! Workspace is in great shape",
        }, null, 2),
      }],
    };
  }

  private log(message: string): void {
    this.outputChannel.appendLine(`[${new Date().toISOString()}] ${message}`);
  }
}
