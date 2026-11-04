#!/usr/bin/env node

/**
 * Pingvin Share Local MCP Companion & CLI Upload Helper
 *
 * Provides:
 * 1. Stdio MCP Server for Claude Desktop / Cursor / AI agents (`upload_files` tool)
 * 2. Standalone CLI tool (`node scripts/pingvin-mcp-local.js upload <files...>`)
 *
 * Reads local agent-side files from disk and streams bounded chunks to remote Pingvin Share,
 * returning the ready share link without loading whole multi-GB files into the LLM context.
 *
 * Zero external npm dependencies: runs on clean checkout with Node.js >= 18 built-ins.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const readline = require("node:readline");

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    command: "",
    paths: [],
    url: process.env.PINGVIN_URL || "",
    token: process.env.PINGVIN_TOKEN || "",
    name: "",
    description: "",
    expiration: "",
    password: "",
    maxViews: undefined,
  };

  let i = 0;
  if (args[0] && !args[0].startsWith("-")) {
    options.command = args[0];
    i = 1;
  }

  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--url=")) {
      options.url = arg.slice(6);
    } else if (arg.startsWith("--token=")) {
      options.token = arg.slice(8);
    } else if (arg.startsWith("--name=")) {
      options.name = arg.slice(7);
    } else if (arg.startsWith("--description=")) {
      options.description = arg.slice(14);
    } else if (arg.startsWith("--expiration=")) {
      options.expiration = arg.slice(13);
    } else if (arg.startsWith("--password=")) {
      options.password = arg.slice(11);
    } else if (arg.startsWith("--max-views=")) {
      options.maxViews = parseInt(arg.slice(12), 10);
    } else if (!arg.startsWith("-")) {
      options.paths.push(arg);
    }
  }

  return options;
}

function collectFiles(inputPaths) {
  const result = [];
  for (const inputPath of inputPaths) {
    const resolved = path.resolve(process.cwd(), inputPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Path does not exist: ${inputPath}`);
    }
    const realRoot = fs.realpathSync(resolved);
    const rootStat = fs.statSync(resolved);

    if (rootStat.isDirectory()) {
      function walkDir(currentDir, relativePrefix) {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const entryPath = path.join(currentDir, entry.name);
          const relPath = path.join(relativePrefix, entry.name);
          const lstat = fs.lstatSync(entryPath);

          if (lstat.isSymbolicLink()) {
            try {
              const realEntryPath = fs.realpathSync(entryPath);
              // Disallow symlinks escaping the directory root
              const relativeToRoot = path.relative(realRoot, realEntryPath);
              if (
                relativeToRoot.startsWith("..") ||
                path.isAbsolute(relativeToRoot)
              ) {
                continue;
              }
              const targetStat = fs.statSync(realEntryPath);
              if (targetStat.isDirectory()) {
                walkDir(realEntryPath, relPath);
              } else if (targetStat.isFile()) {
                result.push({
                  absolutePath: realEntryPath,
                  shareName: relPath.replace(/\\/g, "/"),
                  size: targetStat.size,
                });
              }
            } catch {
              continue; // Broken symlink, ignore
            }
          } else if (entry.isDirectory()) {
            walkDir(entryPath, relPath);
          } else if (entry.isFile()) {
            const fstat = fs.statSync(entryPath);
            result.push({
              absolutePath: entryPath,
              shareName: relPath.replace(/\\/g, "/"),
              size: fstat.size,
            });
          }
        }
      }
      walkDir(resolved, path.basename(resolved));
    } else if (rootStat.isFile()) {
      result.push({
        absolutePath: resolved,
        shareName: path.basename(resolved),
        size: rootStat.size,
      });
    }
  }
  return result;
}

// Generate stable deterministic UUID derived from shareId, relative name, and file size
function getStableFileId(shareId, shareName, size) {
  const hash = crypto
    .createHash("sha256")
    .update(`${shareId}:${shareName}:${size}`)
    .digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

async function sendMcpRequest(serverUrl, token, sessionId, method, params) {
  const endpoint = `${serverUrl.replace(/\/$/, "")}/api/mcp`;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
  };
  if (sessionId) {
    headers["Mcp-Session-Id"] = sessionId;
  }

  const id = Math.floor(Math.random() * 1000000);
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params,
  });

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body,
  });

  const nextSessionId = response.headers.get("mcp-session-id") || sessionId;

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`MCP HTTP error ${response.status}: ${errText}`);
  }

  const contentType = response.headers.get("content-type") || "";
  const rawText = await response.text();

  let resJson;
  if (contentType.includes("text/event-stream")) {
    const match = rawText.match(/^data:\s*(.+)$/m);
    if (!match) {
      throw new Error(`Invalid SSE response from MCP server: ${rawText}`);
    }
    resJson = JSON.parse(match[1]);
  } else {
    resJson = JSON.parse(rawText);
  }
  if (resJson.error) {
    throw new Error(
      `MCP protocol error: ${resJson.error.message || JSON.stringify(resJson.error)}`,
    );
  }

  return { result: resJson.result, sessionId: nextSessionId };
}

function parseToolResponse(toolRes, actionName) {
  if (!toolRes || !toolRes.result) {
    throw new Error(`${actionName} returned empty or invalid response`);
  }
  const content = toolRes.result.content;
  const text =
    Array.isArray(content) && content[0]?.text ? content[0].text : "";
  if (toolRes.result.isError) {
    throw new Error(`${actionName} failed: ${text || "Unknown error"}`);
  }
  return text;
}

async function uploadFilesToPingvin(config) {
  const {
    url,
    token,
    paths,
    name,
    description,
    expiration,
    password,
    maxViews,
    onProgress,
  } = config;

  if (!url)
    throw new Error(
      "Pingvin server URL required (set PINGVIN_URL or pass --url)",
    );
  if (!token)
    throw new Error(
      "Pingvin agent token required (set PINGVIN_TOKEN or pass --token)",
    );
  if (!paths || paths.length === 0)
    throw new Error("At least one file path is required");

  const files = collectFiles(paths);
  if (files.length === 0) {
    throw new Error("No files found to upload");
  }

  let shareId = null;
  let sessionId = null;

  try {
    // 1. Initialize MCP session
    const initRes = await sendMcpRequest(url, token, null, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "pingvin-mcp-local-helper", version: "2.1.0" },
    });
    sessionId = initRes.sessionId;

    // 2. Create share via remote tool
    const createRes = await sendMcpRequest(
      url,
      token,
      sessionId,
      "tools/call",
      {
        name: "pingvin_create_share",
        arguments: {
          name: name || undefined,
          description: description || undefined,
          expiration: expiration || undefined,
          password: password || undefined,
          maxViews: maxViews || undefined,
        },
      },
    );

    const createText = parseToolResponse(createRes, "pingvin_create_share");
    const shareData = JSON.parse(createText);

    shareId = shareData.shareId;
    const chunkSize = shareData.chunkSize || 5 * 1024 * 1024; // 5MB default

    // 3. Upload each file in streaming chunks
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const fileId = getStableFileId(shareId, file.shareName, file.size);
      const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));

      const fd = fs.openSync(file.absolutePath, "r");
      try {
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          const buffer = Buffer.alloc(
            Math.min(chunkSize, file.size - chunkIndex * chunkSize),
          );
          fs.readSync(fd, buffer, 0, buffer.length, chunkIndex * chunkSize);
          const dataBase64 = buffer.toString("base64");

          const chunkRes = await sendMcpRequest(
            url,
            token,
            sessionId,
            "tools/call",
            {
              name: "pingvin_upload_chunk",
              arguments: {
                shareId,
                name: file.shareName,
                fileId,
                chunkIndex,
                totalChunks,
                dataBase64,
              },
            },
          );

          parseToolResponse(chunkRes, "pingvin_upload_chunk");

          if (onProgress) {
            onProgress({
              fileIndex,
              totalFiles: files.length,
              fileName: file.shareName,
              chunkIndex,
              totalChunks,
            });
          }
        }
      } finally {
        fs.closeSync(fd);
      }
    }

    // 4. Complete share and get public shareable link
    const completeRes = await sendMcpRequest(
      url,
      token,
      sessionId,
      "tools/call",
      {
        name: "pingvin_complete_share",
        arguments: { shareId },
      },
    );

    const completeText = parseToolResponse(
      completeRes,
      "pingvin_complete_share",
    );
    return JSON.parse(completeText);
  } catch (err) {
    if (shareId && sessionId) {
      // Clean up incomplete remote share on failure
      try {
        await sendMcpRequest(url, token, sessionId, "tools/call", {
          name: "pingvin_cancel_share",
          arguments: { shareId },
        });
      } catch {
        // Ignore error during cancellation unwind
      }
    }
    throw err;
  }
}

// Stdio MCP Server mode
function runStdioServer(serverUrl, token) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  function sendLine(obj) {
    process.stdout.write(JSON.stringify(obj) + "\n");
  }

  rl.on("line", async (line) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line);
      const { id, method, params } = msg;

      if (method === "initialize") {
        sendLine({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "pingvin-local-companion", version: "2.1.0" },
          },
        });
      } else if (method === "notifications/initialized") {
        // Notification - no reply
      } else if (method === "tools/list") {
        sendLine({
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                name: "upload_files",
                description:
                  "Upload local files or folders from the agent machine to Pingvin Share and return the ready public shareable link.",
                inputSchema: {
                  type: "object",
                  properties: {
                    paths: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "List of local file or directory paths on this machine",
                    },
                    name: {
                      type: "string",
                      description: "Optional share name",
                    },
                    description: {
                      type: "string",
                      description: "Optional description",
                    },
                    expiration: {
                      type: "string",
                      description:
                        "Optional expiration timespan (e.g. '1d', '7d', 'never')",
                    },
                    password: {
                      type: "string",
                      description: "Optional password for the share",
                    },
                    maxViews: {
                      type: "number",
                      description: "Optional download/view count limit",
                    },
                  },
                  required: ["paths"],
                },
              },
            ],
          },
        });
      } else if (method === "tools/call") {
        if (params.name === "upload_files") {
          try {
            const uploadResult = await uploadFilesToPingvin({
              url: serverUrl,
              token,
              paths: params.arguments.paths,
              name: params.arguments.name,
              description: params.arguments.description,
              expiration: params.arguments.expiration,
              password: params.arguments.password,
              maxViews: params.arguments.maxViews,
            });
            sendLine({
              jsonrpc: "2.0",
              id,
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(uploadResult, null, 2),
                  },
                ],
              },
            });
          } catch (err) {
            sendLine({
              jsonrpc: "2.0",
              id,
              result: {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `Upload failed: ${err.message || String(err)}`,
                  },
                ],
              },
            });
          }
        } else {
          sendLine({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Tool not found: ${params.name}` },
          });
        }
      } else {
        if (id !== undefined) {
          sendLine({
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          });
        }
      }
    } catch (parseErr) {
      // ignore
    }
  });
}

// CLI Mode
async function runCli(options) {
  if (options.command === "upload" || options.paths.length > 0) {
    try {
      console.log(
        `Uploading ${options.paths.length} path(s) to ${options.url}...`,
      );
      const result = await uploadFilesToPingvin({
        ...options,
        onProgress: (p) => {
          process.stderr.write(
            `\rUploading [${p.fileIndex + 1}/${p.totalFiles}] ${p.fileName} - chunk ${p.chunkIndex + 1}/${p.totalChunks}`,
          );
        },
      });
      process.stderr.write("\n");
      console.log(`Success!`);
      console.log(`Share ID: ${result.shareId}`);
      console.log(`Public Link: ${result.url}`);
      console.log(`Files count: ${result.filesCount}`);
      console.log(`Total bytes: ${result.totalBytes}`);
      process.exit(0);
    } catch (err) {
      console.error(`Upload error:`, err.message);
      process.exit(1);
    }
  } else {
    // Stdio MCP mode
    runStdioServer(options.url, options.token);
  }
}

if (require.main === module) {
  const options = parseArgs();
  runCli(options);
}

module.exports = {
  collectFiles,
  getStableFileId,
  parseToolResponse,
  uploadFilesToPingvin,
  sendMcpRequest,
};
