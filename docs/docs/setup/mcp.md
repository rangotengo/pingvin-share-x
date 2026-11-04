---
id: mcp
---

# Model Context Protocol (MCP)

Pingvin Share X provides first-class support for AI agents (Claude Desktop, Cursor, Cline, custom agent frameworks) via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io).

Agents can upload files or directories in bounded streaming chunks and receive a ready, public shareable link upon successful completion.

## Architecture: Remote vs Local Companion

### 1. Remote MCP Endpoint (`/api/mcp`)
- **Transport**: Official MCP **Streamable HTTP** transport.
- **Location**: `https://<your-pingvin-domain>/api/mcp`
- **Authentication**: Dedicated per-user revocable agent tokens via `Authorization: Bearer psa_...` header. Query parameter token authentication is strictly disabled to prevent credential leakage in URLs, server logs, and proxies.
- **Security**: Tokens are hashed (SHA-256) in the database, displayed only once upon creation, and strictly scoped to the owner's shares and quotas.
- **Tools**:
  - `pingvin_create_share`: creates an uncompleted share with optional name, description, expiration, password, and download view limits.
  - `pingvin_upload_chunk`: receives a bounded binary chunk (base64) for a file.
  - `pingvin_complete_share`: finalizes the share and returns the ready public URL.
  - `pingvin_get_share_status`: inspects upload progress and file list.
  - `pingvin_cancel_share`: aborts and cleans up uncompleted shares.

### 2. Local Companion Helper (`scripts/pingvin-mcp-local.js`)
When an AI agent runs on your local machine and needs to share local files:
- Remote MCP endpoints cannot read your local filesystem paths.
- Sending huge base64 files directly through LLM context is slow and consumes massive token budgets.
- The **local companion helper** runs locally (via stdio or CLI) and exposes an `upload_files(paths)` tool. It streams file chunks from your local disk directly to the Pingvin server and returns the public link in a single tool call.
- **Zero npm dependencies**: Uses Node.js >= 18 built-ins (`node:fs`, `node:crypto`, `node:readline`, global `fetch`). No `npm install` is required on a clean checkout.

---

## Host Compatibility & Bearer Authentication

While the Model Context Protocol standard defines an OAuth 2.0 authorization framework for remote servers, several MCP client hosts (such as Claude Desktop) currently only support Stdio transports or remote HTTP servers without allowing arbitrary static HTTP bearer headers in their configuration.

For clients with this static bearer limit, use **Option A (Local Companion)** below. The companion runs as a local Stdio MCP server, reads the local files directly, and sends authenticated bearer HTTP requests to your Pingvin Share server.

---

## Getting an Agent Token

1. Sign in to your Pingvin Share account.
2. Navigate to **Account** (`/account`).
3. Scroll to the **AI Agent Tokens (MCP)** section.
4. Click **Create Token**, specify a name (e.g. `Claude Desktop`), and optionally an expiry date.
5. Copy the generated token (`psa_...`). It is shown only once and cannot be retrieved again.

---

## Client Setup Examples

### Claude Desktop (`claude_desktop_config.json`)

#### Option A: Local Companion (Recommended for local file sharing)
```json
{
  "mcpServers": {
    "pingvin-share": {
      "command": "node",
      "args": ["/path/to/pingvin-share-x/scripts/pingvin-mcp-local.js"],
      "env": {
        "PINGVIN_URL": "https://share.yourdomain.com",
        "PINGVIN_TOKEN": "psa_your_agent_token_here"
      }
    }
  }
}
```

#### Option B: Remote MCP Streamable HTTP Endpoint
For MCP hosts supporting Streamable HTTP transports with bearer authentication:
```json
{
  "mcpServers": {
    "pingvin-share-remote": {
      "url": "https://share.yourdomain.com/api/mcp",
      "headers": {
        "Authorization": "Bearer psa_your_agent_token_here"
      }
    }
  }
}
```

---

## CLI Upload Helper

You can also use the local helper directly from your terminal on any machine with Node.js >= 18:

```bash
# Set credentials
export PINGVIN_URL="https://share.yourdomain.com"
export PINGVIN_TOKEN="psa_your_token_here"

# Upload files or entire folders
node scripts/pingvin-mcp-local.js upload ./report.pdf ./screenshots/ --expiration="3d" --password="optionalSecret"
```

Output:
```text
Uploading 3 path(s) to https://share.yourdomain.com...
Uploading [3/3] screenshots/app.png - chunk 1/1
Success!
Share ID: x8f2a1b9c0de
Public Link: https://share.yourdomain.com/share/x8f2a1b9c0de
Files count: 3
Total bytes: 14205810
```

---

## Security & Storage

- **Revocation**: Tokens can be revoked anytime in your Account settings. Revocation takes effect immediately on subsequent requests.
- **Quota & Limits**: Uploads via agent tokens strictly inherit the user's storage quota, share size limits, and max shares limit.
- **Path Traversal Protection**: All file paths and chunk names are strictly validated; directory traversal (`..`) and absolute paths are rejected. The local helper ignores symlinks that escape the target directory.
- **Storage Providers**: Chunked streaming is supported across Local filesystem, Google Drive, and S3 backend storage providers via server-side streaming.
