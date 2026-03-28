# Diagnostics MCP Server

> **MCP server with 5 diagnostic tools providing real-time access to ALL VS Code diagnostics (TypeScript, ESLint, Prettier, and all installed extensions)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.0.15-blue.svg)](https://github.com/Maaz0313-png/Diagnostics-MCP)

## Overview

This Model Context Protocol (MCP) server provides AI agents with real-time access to all diagnostics from your VS Code workspace, including:

- TypeScript/JavaScript errors and warnings
- ESLint linting issues
- Prettier formatting issues
- All Language Servers (Python, Go, Rust, etc.)
- All VS Code Extensions diagnostics
- Real-time updates as you code

## Configuration

### `diagnostics-mcp-server.autoStart`

- **Type**: `boolean`
- **Default**: `true`
- **Description**: Automatically start the MCP server(s) when VS Code opens

### `diagnostics-mcp-server.transport`

- **Type**: `string` — `"http"` | `"pipe"` | `"both"`
- **Default**: `"both"`
- **Description**: Which transport(s) to start

| Value | Description |
| ------- | ------------- |
| `"http"` | HTTP server only (port-based, backward-compatible) |
| `"pipe"` | Named pipe / Unix socket only (no port conflicts, stdio-friendly) |
| `"both"` | Both transports simultaneously *(default)* |

### `diagnostics-mcp-server.port`

- **Type**: `number`
- **Default**: `3846`
- **Description**: Port for the HTTP MCP server (only used when transport is `"http"` or `"both"`)

## Installation

### Step 1: Install VS Code Extension

Install from VS Code Marketplace:

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "Diagnostics MCP Server"
4. Click Install

Or install a local build:

```bash
code --install-extension diagnostics-mcp-server-1.0.15.vsix
```

### Step 2: Extension Auto-Start

The extension automatically starts when VS Code opens (if `autoStart` is enabled). The pipe path is logged in the Output panel under "Diagnostics MCP Server".

### Step 3: Configure Your MCP Client

The preferred transport is **stdio** via the bundled `stdio-bridge.js`. The bridge auto-discovers the correct named pipe for your workspace — no port configuration needed.

---

#### GitHub Copilot / VS Code (`.vscode/mcp.json`)

VS Code substitutes `${env:USERPROFILE}` and `${workspaceFolder}`:

```json
{
  "servers": {
    "diagnostics-mcp-server": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${env:USERPROFILE}/.vscode/extensions/maaz-tajammul.diagnostics-mcp-server-1.0.15/dist/stdio-bridge.js"
      ],
      "env": {
        "DIAGNOSTICS_MCP_WORKSPACE": "${workspaceFolder}"
      }
    }
  }
}
```

---

#### Claude Code (`.mcp.json`)

Claude Code uses `${VARNAME}` syntax (not `${env:VARNAME}`). The bridge falls back to `process.cwd()` if the workspace env var is not set:

```json
{
  "mcpServers": {
    "diagnostics-mcp-server": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${USERPROFILE}/.vscode/extensions/maaz-tajammul.diagnostics-mcp-server-1.0.15/dist/stdio-bridge.js"
      ],
      "env": {
        "DIAGNOSTICS_MCP_WORKSPACE": "${workspaceFolder}"
      }
    }
  }
}
```

> **Note**: Claude Code does not substitute `${workspaceFolder}`, so the bridge falls back to `process.cwd()` automatically. Claude Code must be launched from the workspace root for this to work correctly.

---

### Verify Connection

1. **View logs**: VS Code Output panel → "Diagnostics MCP Server"
2. **Check pipe path**: Logged on startup, e.g. `\\.\pipe\diagnostics-mcp-<id>` (Windows) or `/tmp/diagnostics-mcp-<id>.sock` (Unix)
3. **Run a tool**: Ask your AI agent to call `get_workspace_health`

## How It Works

The extension uses a **named pipe** (Windows) or **Unix domain socket** (macOS/Linux) instead of a TCP port. The pipe path is derived from the workspace root, so each VS Code window gets its own unique pipe — no port conflicts when you have multiple projects open simultaneously.

```text
┌──────────────────────────────────────────────────────────────┐
│  AI Agent (Claude Code, GitHub Copilot, …)                   │
│    ↕  MCP stdio protocol                                     │
│  stdio-bridge.js  (node process, started by MCP client)      │
│    ↕  byte-forward over named pipe / Unix socket             │
│  VS Code Extension  (DiagnosticsMCPServer)                   │
│    ↓                                                         │
│  vscode.languages.getDiagnostics() API                       │
│    ↓                                                         │
│  ALL Diagnostics  (TS, ESLint, Prettier, all LSPs, …)        │
└──────────────────────────────────────────────────────────────┘
```

The HTTP transport (port-based) is also available for backward compatibility with clients that don't support stdio.

## MCP Tools

### `get_all_diagnostics`

Get all diagnostics from all files in the workspace.

```json
{
  "total": 42,
  "diagnostics": [
    {
      "file": "src/app.ts",
      "line": 10,
      "column": 5,
      "severity": "error",
      "message": "Type 'string' is not assignable to type 'number'",
      "source": "ts"
    }
  ]
}
```

### `get_file_diagnostics`

Get diagnostics for a specific file path.

**Input**: `{ "filePath": "/absolute/path/to/file.ts" }`

### `get_diagnostics_by_severity`

Get diagnostics filtered by severity level.

**Input**: `{ "severity": "error" | "warning" | "information" | "hint" }`

### `get_diagnostics_summary`

Get a summary of diagnostic counts by severity.

```json
{
  "error": 2,
  "warning": 5,
  "information": 1,
  "hint": 0,
  "total": 8,
  "filesWithIssues": 3
}
```

### `get_workspace_health`

Get overall workspace health score (0–100) based on diagnostics.

```json
{
  "healthScore": 85,
  "status": "good",
  "breakdown": { "errors": 2, "warnings": 5, "information": 1, "hint": 0 },
  "recommendation": "Good progress! Consider addressing remaining warnings"
}
```

**Health score**: errors cost 10 pts each, warnings 3, information 1, hints 0.5.
**Status**: `excellent` (90+), `good` (70+), `fair` (50+), `poor` (30+), `critical` (<30).

## VS Code Commands

Available in Command Palette (Ctrl+Shift+P) under "Diagnostics MCP":

| Command | Description |
| --------- | ------------- |
| **Start MCP Server** | Manually start the server (if autoStart is off) |
| **Stop MCP Server** | Stop the running server |
| **Restart MCP Server** | Stop then start (re-reads config) |
| **MCP Server Status** | Show running state and pipe/port info |

## Build from Source

```bash
git clone https://github.com/Maaz0313-png/Diagnostics-MCP.git
cd Diagnostics-MCP
npm install
npm run bundle        # esbuild — bundles all dependencies into dist/
npx vsce package --no-dependencies
code --install-extension diagnostics-mcp-server-*.vsix
```

## Troubleshooting

### "Cannot find module … stdio-bridge.js"

The path substitution failed. Check which MCP client you are using:

- **VS Code / GitHub Copilot**: use `${env:USERPROFILE}` in `.vscode/mcp.json`
- **Claude Code**: use `${USERPROFILE}` (no `env:`) in `.mcp.json`

### "MCP error -32000: Connection closed"

1. Check Output panel → "Diagnostics MCP Server" for the pipe path
2. Ensure `transport` is `"pipe"` or `"both"` (not `"http"` only)
3. Reload VS Code window after installing a new extension version
4. Restart the server via Command Palette → "Diagnostics MCP: Restart MCP Server"

### "Could not connect to pipe … after 15s"

1. Confirm the extension is active (Output panel → "Diagnostics MCP Server")
2. If `autoStart` is disabled, run "Start MCP Server" manually before connecting
3. Verify the workspace path — on Windows, drive letter case matters; the bridge normalizes to lowercase automatically

### "No diagnostics returned"

1. Open a workspace with code files
2. Wait for language servers to initialize (check VS Code's Problems tab)
3. Call `get_diagnostics_summary` — returns zeros if no diagnostics are loaded yet

## Version History

### 1.0.15

- Named pipe transport (workspace-scoped, no port conflicts)
- `stdio-bridge.js` bundled — no `mcp-proxy` dependency
- `transport` config: `"http"` | `"pipe"` | `"both"`
- Drive letter case normalization on Windows for reliable pipe path matching
- `process.cwd()` fallback in stdio-bridge for Claude Code compatibility
- Renamed commands: removed "HTTP" from command titles
- esbuild bundling — all dependencies included, no missing module errors

### 1.0.14

- Configuration settings support (autoStart, port)
- Restart command
- Configurable port number

### 1.0.12–1.0.13

- Complete HTTP MCP server implementation
- 5 specialized diagnostic tools
- VS Code commands (Start/Stop/Status)
- Workspace health scoring

### 1.0.0

- Initial release
- Basic VS Code diagnostics integration

## License

MIT — see [LICENSE](LICENSE)

## Links

- [GitHub Repository](https://github.com/Maaz0313-png/Diagnostics-MCP)
- [Model Context Protocol](https://modelcontextprotocol.io)
