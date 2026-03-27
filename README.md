# Diagnostics MCP Server

> **MCP server with 5 diagnostic tools providing real-time access to ALL VS Code diagnostics (TypeScript, ESLint, Prettier, and all installed extensions)**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.0.15-blue.svg)](https://github.com/Maaz0313-png/Diagnostics-MCP)

## 🎯 Overview

This Model Context Protocol (MCP) server provides AI agents with real-time access to all diagnostics from your VS Code workspace, including:

- ✅ **TypeScript/JavaScript** errors and warnings
- ✅ **ESLint** linting issues
- ✅ **Prettier** formatting issues
- ✅ **All Language Servers** (Python, Go, Rust, etc.)
- ✅ **All VS Code Extensions** diagnostics
- ✅ **Real-time updates** as you code

## ⚙️ Configuration

### `diagnostics-mcp-server.autoStart`

- **Type**: `boolean`
- **Default**: `true`
- **Description**: Automatically start the MCP server(s) when VS Code opens

**To disable auto-start:**

1. Open VS Code Settings (Ctrl+,)
2. Search for "diagnostics-mcp-server"
3. Uncheck "Auto Start"
4. Use the "Start MCP Server" command to start manually

### `diagnostics-mcp-server.transport`

- **Type**: `string` — `"http"` | `"pipe"` | `"both"`
- **Default**: `"both"`
- **Description**: Which transport(s) to start

| Value | Description |
|-------|-------------|
| `"http"` | HTTP server only (port-based, backward-compatible) |
| `"pipe"` | Named pipe / Unix socket only (no port conflicts, stdio-friendly) |
| `"both"` | Both transports simultaneously *(default)* |

### `diagnostics-mcp-server.port`

- **Type**: `number`
- **Default**: `3846`
- **Description**: Port for the HTTP MCP server (only used when transport is `"http"` or `"both"`)

## 📋 Installation

### Step 1: Install VS Code Extension

Install from VS Code Marketplace:

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search for "Diagnostics MCP Server"
4. Click Install

**Latest Version: 1.0.12** - Complete HTTP MCP implementation with 5 diagnostic tools, enhanced error handling, and working commands

### Step 2: Extension Auto-Start

The extension automatically starts when VS Code opens (if `autoStart` is enabled). No port configuration needed — it uses a workspace-scoped named pipe.

**Transport details:**

- **Protocol**: Named pipe / Unix domain socket (no TCP port)
- **Path**: Derived automatically from the workspace root — unique per VS Code instance
- **Startup**: Automatic with VS Code

### Step 3: Configure MCP Client — stdio transport (recommended)

The preferred way to connect is via the bundled `stdio-bridge.js`, which requires no port and works across multiple simultaneous VS Code instances.

Add this to your `.vscode/mcp.json` (or equivalent MCP client config):

```json
{
  "servers": {
    "diagnostics-mcp-server": {
      "type": "stdio",
      "command": "node",
      "args": [
        "${userHome}/.vscode/extensions/maaz-tajammul.diagnostics-mcp-server-<version>/dist/stdio-bridge.js"
      ],
      "env": {
        "DIAGNOSTICS_MCP_WORKSPACE": "${workspaceFolder}"
      }
    }
  }
}
```

Replace `<version>` with the installed extension version (e.g. `1.0.15`).

> **`${workspaceFolder}`** binds the bridge to the correct VS Code instance automatically.
> When you have multiple VS Code windows open (e.g. different git worktrees), each
> `mcp.json` entry connects to its own pipe — no conflicts, no manual port management.

### Verify Connection

1. **View logs**: VS Code Output panel → "Diagnostics MCP Server"
2. **Check pipe path**: Logged on startup, e.g. `\\.\pipe\diagnostics-mcp-<id>` (Windows) or `/tmp/diagnostics-mcp-<id>.sock` (Unix)
3. **Run a tool**: Ask your AI agent to call `get_workspace_health`

### Usage

Once configured, AI agents (like Claude, GitHub Copilot) can use these **5 MCP tools**:

1. **`get_all_diagnostics`** - Get complete diagnostic information from workspace
2. **`get_errors`** - Get only error-level diagnostics
3. **`get_warnings`** - Get only warning-level diagnostics
4. **`get_info`** - Get only info-level diagnostics
5. **`get_workspace_health`** - Get workspace health score (0-100)

## 🔧 How It Works

The extension uses a **named pipe** (Windows) or **Unix domain socket** (macOS/Linux) instead of a TCP port. The pipe path is derived from the workspace root, so each VS Code window gets its own unique pipe — no port conflicts when you have multiple projects open simultaneously.

```text
┌──────────────────────────────────────────────────────────────┐
│  AI Agent (Claude, GitHub Copilot, …)                        │
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

**Why a named pipe instead of HTTP?**

- No TCP port to configure or conflict with other instances
- Each workspace gets a deterministic, unique pipe path — just set `DIAGNOSTICS_MCP_WORKSPACE` once
- `stdio-bridge.js` is a pure byte-forwarder; no `mcp-proxy` dependency required

**Why Extension Required?**

- VS Code diagnostics are only accessible inside VS Code via the `vscode` module
- The extension provides the bridge between VS Code APIs and the MCP server
- This ensures you get **ALL** diagnostics from **ALL** sources, not just TypeScript

## 📦 What's Included

- **Named pipe MCP Server** — workspace-scoped, no port management
- **`stdio-bridge.js`** — bundled bridge script, connects MCP clients directly via stdio
- **5 Diagnostic Tools** — comprehensive workspace diagnostic access
- **4 VS Code Commands** — Start/Stop/Restart/Status server control
- **Real-time Updates** — live diagnostic monitoring
- **Health Scoring** — workspace quality metrics (0-100)

## 🛠️ Development

### Build from Source

```bash
git clone https://github.com/Maaz0313-png/Diagnostics-MCP.git
cd "Diagnostics MCP"
npm install
npm run compile
```

### Test Locally

```bash
# Test the launcher
node index.js --help

# Test with a workspace
node index.js
```

## 📖 API Reference - 5 MCP Tools

### 1. Tool: `get_all_diagnostics`

Get complete diagnostic information from workspace.

**Returns:**

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
  ],
  "status": "found",
  "timestamp": "2025-10-02T10:30:00.000Z"
}
```

### 2. Tool: `get_errors`

Get only error-level diagnostics.

**Returns:**

```json
{
  "count": 5,
  "diagnostics": [...],
  "severityLevel": "errors",
  "status": "found",
  "timestamp": "2025-10-02T10:30:00.000Z"
}
```

### 3. Tool: `get_warnings`

Get only warning-level diagnostics.

**Returns:**

```json
{
  "count": 3,
  "diagnostics": [...],
  "severityLevel": "warnings",
  "status": "found",
  "timestamp": "2025-10-02T10:30:00.000Z"
}
```

### 4. Tool: `get_info`

Get only info-level diagnostics.

**Returns:**

```json
{
  "count": 2,
  "diagnostics": [...],
  "severityLevel": "info",
  "status": "found",
  "timestamp": "2025-10-02T10:30:00.000Z"
}
```

### 5. Tool: `get_workspace_health`

Get workspace health score (0-100) based on diagnostics.

**Returns:**

```json
{
  "healthScore": 85,
  "status": "good",
  "summary": {
    "errors": 2,
    "warnings": 5,
    "infos": 3,
    "total": 10
  },
  "timestamp": "2025-10-02T10:30:00.000Z"
}
```

**Health Score Calculation:**

- Errors: -10 points each
- Warnings: -3 points each
- Info: -1 point each
- Scale: 0-100 (100 = perfect health)
- Status: excellent (90+), good (70+), fair (50+), poor (<50)

## 🎮 VS Code Commands

Four commands available in Command Palette (Ctrl+Shift+P):

1. **🚀 Diagnostics MCP: Start HTTP MCP Server**
   - Manually start the MCP server
   - Use if server didn't auto-start or autoStart is disabled

2. **🛑 Diagnostics MCP: Stop HTTP MCP Server**
   - Stop the running MCP server

3. **🔄 Diagnostics MCP: Restart HTTP MCP Server**
   - Restart the MCP server (stop + start)

4. **📊 Diagnostics MCP: MCP Server Status (5 Tools + Health)**
   - Shows whether the server is running and the pipe path it is listening on

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details

## 🔗 Links

- [GitHub Repository](https://github.com/Maaz0313-png/Diagnostics-MCP)
- [Model Context Protocol](https://modelcontextprotocol.io)

## ⚠️ Troubleshooting

### "MCP server not connecting"

1. View logs: VS Code Output panel → "Diagnostics MCP Server" — check the pipe path logged on startup
2. Ensure `DIAGNOSTICS_MCP_WORKSPACE` in your `mcp.json` matches the folder VS Code has open
3. Restart server: Command Palette → "Diagnostics MCP: Restart HTTP MCP Server"
4. Reload VS Code window: Ctrl+Shift+P → "Reload Window"

### "Could not connect to pipe … after 15s"

The `stdio-bridge.js` could not reach the extension pipe:

1. Confirm the extension is installed and active (Output panel → "Diagnostics MCP Server")
2. If `autoStart` is disabled, run the "Start" command manually before connecting
3. Check that `DIAGNOSTICS_MCP_WORKSPACE` points to the correct workspace root

### "No diagnostics returned"

1. Open a workspace with code files
2. Wait for language servers to initialize (check VS Code's Problems tab)
3. Call `get_workspace_health` — it returns `0` total if no diagnostics are loaded yet

## 📝 Version History

### 1.0.14 (Current)

- ✅ Configuration settings support (autoStart, port)
- ✅ Restart command for easy server restart
- ✅ Configurable port number
- ✅ Optional auto-start disable

### 1.0.12-1.0.13

- ✅ Complete HTTP MCP server implementation
- ✅ 5 specialized diagnostic tools
- ✅ Enhanced error handling and connection stability
- ✅ Working VS Code commands (Start/Stop/Status)
- ✅ Comprehensive tool documentation in metadata
- ✅ Beautiful diagnostic icon
- ✅ Full workspace health scoring

### 1.0.11

- ✅ Enhanced connection stability for empty diagnostics
- ✅ HTTP transport implementation

### 1.0.10

- ✅ Added severity-specific tools (get_errors, get_warnings, get_info)

### 1.0.0 (Initial Release)

- ✅ Basic VS Code diagnostics integration
- ✅ Support for all language servers and extensions

## 💡 Use Cases

- **AI-Powered Code Review**: Let AI agents analyze all code issues
- **Automated Quality Checks**: Monitor workspace health in real-time
- **Smart Refactoring**: AI can see all diagnostics before suggesting changes
- **Learning Assistant**: Help users understand and fix code issues
- **CI/CD Integration**: Pre-commit diagnostic analysis

---

Made with ❤️ by Maaz Tajammul
