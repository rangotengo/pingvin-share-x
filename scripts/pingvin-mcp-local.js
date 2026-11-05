#!/usr/bin/env node

/**
 * Pingvin Share Local MCP Companion & CLI Upload Helper
 *
 * Provides:
 * 1. Stdio MCP Server for Claude Desktop / Cursor / AI agents
 *    - `upload_files` (stream local files to Pingvin Share with crash recovery)
 *    - `pingvin_list_shares` (forwarded)
 *    - `pingvin_update_share` (forwarded)
 *    - `pingvin_revoke_share` (forwarded)
 *    - `pingvin_delete_share` (forwarded)
 *    - `pingvin_get_share_status` (forwarded)
 *    - `pingvin_get_upload_status` (forwarded)
 *    - `pingvin_cancel_share` (forwarded)
 * 2. Standalone CLI tool (`node scripts/pingvin-mcp-local.js upload <files...>`)
 *
 * Zero external npm dependencies: runs on Node.js >= 18 built-ins.
 */

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const readline = require("node:readline");

function getCheckpointDir() {
  const dir =
    process.env.PINGVIN_CHECKPOINT_DIR ||
    path.join(
      process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
      "pingvin-share",
      "checkpoints",
    );
  if (!fs.existsSync(dir)) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // ignore
    }
  }
  return dir;
}

function getFileFingerprint(filePath) {
  const stat = fs.statSync(filePath);
  const fd = fs.openSync(filePath, "r");
  try {
    const headBuf = Buffer.alloc(Math.min(65536, stat.size));
    const bytesRead = fs.readSync(fd, headBuf, 0, headBuf.length, 0);
    const headHash = crypto
      .createHash("sha256")
      .update(headBuf.subarray(0, bytesRead))
      .digest("hex");
    return {
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      headHash,
    };
  } finally {
    fs.closeSync(fd);
  }
}

function getBatchKey(serverUrl, files) {
  const normalizedUrl = serverUrl.replace(/\/$/, "");
  const descriptor = files
    .map((f) => `${f.shareName}:${f.size}:${f.mtimeMs}`)
    .sort()
    .join("|");
  return crypto
    .createHash("sha256")
    .update(`${normalizedUrl}::${descriptor}`)
    .digest("hex");
}

function loadCheckpoint(serverUrl, files) {
  try {
    const key = getBatchKey(serverUrl, files);
    const file = path.join(getCheckpointDir(), `${key}.json`);
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (data && data.shareId) return data;
  } catch {
    // ignore
  }
  return null;
}

function saveCheckpoint(serverUrl, files, shareId, fileProgress) {
  try {
    const key = getBatchKey(serverUrl, files);
    const file = path.join(getCheckpointDir(), `${key}.json`);
    const checkpointData = {
      version: 1,
      serverUrl: serverUrl.replace(/\/$/, ""),
      shareId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      files: files.map((f) => ({
        shareName: f.shareName,
        size: f.size,
        mtimeMs: f.mtimeMs,
        headHash: f.headHash,
        fileId: f.fileId,
        lastConfirmedChunk:
          fileProgress?.[f.shareName]?.lastConfirmedChunk ?? -1,
      })),
    };
    fs.writeFileSync(file, JSON.stringify(checkpointData, null, 2), {
      mode: 0o600,
    });
  } catch {
    // ignore
  }
}

function clearCheckpoint(serverUrl, files) {
  try {
    const key = getBatchKey(serverUrl, files);
    const file = path.join(getCheckpointDir(), `${key}.json`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
    }
  } catch {
    // ignore
  }
}

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
                const fp = getFileFingerprint(realEntryPath);
                result.push({
                  absolutePath: realEntryPath,
                  shareName: relPath.replace(/\\/g, "/"),
                  size: fp.size,
                  mtimeMs: fp.mtimeMs,
                  headHash: fp.headHash,
                });
              }
            } catch {
              continue;
            }
          } else if (entry.isDirectory()) {
            walkDir(entryPath, relPath);
          } else if (entry.isFile()) {
            const fp = getFileFingerprint(entryPath);
            result.push({
              absolutePath: entryPath,
              shareName: relPath.replace(/\\/g, "/"),
              size: fp.size,
              mtimeMs: fp.mtimeMs,
              headHash: fp.headHash,
            });
          }
        }
      }
      walkDir(resolved, path.basename(resolved));
    } else if (rootStat.isFile()) {
      const fp = getFileFingerprint(resolved);
      result.push({
        absolutePath: resolved,
        shareName: path.basename(resolved),
        size: fp.size,
        mtimeMs: fp.mtimeMs,
        headHash: fp.headHash,
      });
    }
  }
  return result;
}

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
    const err = new Error(`MCP HTTP error ${response.status}: ${errText}`);
    err.status = response.status;
    err.headers = response.headers;
    throw err;
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
    const err = new Error(
      `MCP protocol error: ${resJson.error.message || JSON.stringify(resJson.error)}`,
    );
    err.code = resJson.error.code;
    throw err;
  }

  return { result: resJson.result, sessionId: nextSessionId };
}

async function sendMcpRequestWithRetry(
  serverUrl,
  token,
  sessionId,
  method,
  params,
  maxAttempts = 5,
) {
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      return await sendMcpRequest(serverUrl, token, sessionId, method, params);
    } catch (err) {
      attempt++;
      const isTransient =
        err.status === 429 ||
        (err.status >= 500 && err.status <= 504) ||
        /ECONNRESET|ETIMEDOUT|fetch failed/i.test(err.message);

      if (!isTransient || attempt >= maxAttempts) {
        throw err;
      }

      let delayMs = 300 * Math.pow(2, attempt) + Math.random() * 200;
      if (err.headers && err.headers.get("retry-after")) {
        const retryHeader = parseInt(err.headers.get("retry-after"), 10);
        if (!isNaN(retryHeader) && retryHeader > 0) {
          delayMs = retryHeader * 1000;
        }
      }
      delayMs = Math.min(delayMs, 15000);
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }
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

  // Check for existing checkpoint
  const checkpoint = loadCheckpoint(url, files);
  if (checkpoint) {
    // Validate that local files have not changed mid-upload
    for (const f of files) {
      const currentFp = getFileFingerprint(f.absolutePath);
      if (currentFp.size !== f.size || currentFp.headHash !== f.headHash) {
        clearCheckpoint(url, files);
        throw new Error(
          `Local file '${f.shareName}' was modified during interrupted upload. Resume collision rejected to avoid corrupt upload. Clean retry required.`,
        );
      }
    }
  }

  let shareId = checkpoint?.shareId || null;
  let sessionId = null;
  const fileProgress = {};

  try {
    // 1. Initialize MCP session with retry
    const initRes = await sendMcpRequestWithRetry(
      url,
      token,
      null,
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pingvin-mcp-local-helper", version: "2.1.0" },
      },
    );
    sessionId = initRes.sessionId;

    let chunkSize = 5 * 1024 * 1024;
    let completedFileNames = new Set();
    const pendingOffsets = new Map();

    if (shareId) {
      // Query authoritative server upload status for existing share
      try {
        const statusRes = await sendMcpRequestWithRetry(
          url,
          token,
          sessionId,
          "tools/call",
          {
            name: "pingvin_get_upload_status",
            arguments: { shareId },
          },
        );
        const statusText = parseToolResponse(statusRes, "pingvin_get_upload_status");
        const statusData = JSON.parse(statusText);

        if (statusData.isCompleted) {
          clearCheckpoint(url, files);
          const appUrl = url.replace(/\/$/, "");
          return {
            shareId,
            url: `${appUrl}/share/${shareId}`,
            filesCount: statusData.files.length,
            message: "Share was already completed.",
          };
        }

        chunkSize = statusData.chunkSize || chunkSize;
        for (const cf of statusData.files || []) {
          completedFileNames.add(cf.name);
        }
        for (const pf of statusData.pendingFiles || []) {
          pendingOffsets.set(pf.name, pf.expectedChunkIndex);
        }
      } catch (err) {
        // If share not found on server or expired, restart fresh
        shareId = null;
        clearCheckpoint(url, files);
      }
    }

    if (!shareId) {
      // Create new share via remote tool
      const createRes = await sendMcpRequestWithRetry(
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
      chunkSize = shareData.chunkSize || chunkSize;
      saveCheckpoint(url, files, shareId, fileProgress);
    }

    // 2. Upload each file in streaming chunks
    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex];
      const fileId = getStableFileId(shareId, file.shareName, file.size);
      file.fileId = fileId;

      if (completedFileNames.has(file.shareName)) {
        if (onProgress) {
          onProgress({
            fileIndex,
            totalFiles: files.length,
            fileName: file.shareName,
            chunkIndex: Math.ceil(file.size / chunkSize) - 1,
            totalChunks: Math.ceil(file.size / chunkSize),
            resumed: true,
          });
        }
        continue;
      }

      const totalChunks = Math.max(1, Math.ceil(file.size / chunkSize));
      let startChunkIndex = pendingOffsets.get(file.shareName) || 0;
      if (startChunkIndex >= totalChunks && file.size > 0) {
        startChunkIndex = Math.max(0, totalChunks - 1);
      }

      const fd = fs.openSync(file.absolutePath, "r");
      try {
        for (
          let chunkIndex = startChunkIndex;
          chunkIndex < totalChunks;
          chunkIndex++
        ) {
          const buffer = Buffer.alloc(
            Math.min(chunkSize, file.size - chunkIndex * chunkSize),
          );
          fs.readSync(fd, buffer, 0, buffer.length, chunkIndex * chunkSize);
          const dataBase64 = buffer.toString("base64");

          const chunkRes = await sendMcpRequestWithRetry(
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
          fileProgress[file.shareName] = { lastConfirmedChunk: chunkIndex };
          saveCheckpoint(url, files, shareId, fileProgress);

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

    // 3. Complete share and get ready public link
    const completeRes = await sendMcpRequestWithRetry(
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
    clearCheckpoint(url, files);
    return JSON.parse(completeText);
  } catch (err) {
    // If explicit cancel or fatal non-transient, preserve or cleanup appropriately
    throw err;
  }
}

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
        const clientVersion = params?.protocolVersion || "2024-11-05";
        sendLine({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: clientVersion,
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
                  "Upload local files or folders from the agent machine to Pingvin Share with automatic resume and return ready public link.",
                inputSchema: {
                  type: "object",
                  properties: {
                    paths: {
                      type: "array",
                      items: { type: "string" },
                      description: "List of local file or directory paths",
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
              {
                name: "pingvin_list_shares",
                description:
                  "List and search shares owned by the current agent user with pagination.",
                inputSchema: {
                  type: "object",
                  properties: {
                    limit: {
                      type: "number",
                      description: "Max items to return (1-100, default 20)",
                    },
                    cursor: {
                      type: "string",
                      description: "Pagination cursor",
                    },
                    query: {
                      type: "string",
                      description: "Substring query to match name or description",
                    },
                    includeExpired: {
                      type: "boolean",
                      description: "Include expired or revoked shares",
                    },
                  },
                },
              },
              {
                name: "pingvin_update_share",
                description:
                  "Update an existing owned share's name, description, expiration, password, or max views limit.",
                inputSchema: {
                  type: "object",
                  properties: {
                    shareId: { type: "string", description: "ID of share to update" },
                    name: { type: "string", description: "Updated name" },
                    description: { type: "string", description: "Updated description" },
                    expiration: { type: "string", description: "Updated expiration" },
                    password: { type: "string", description: "Updated password" },
                    maxViews: { type: "number", description: "Updated max views" },
                  },
                  required: ["shareId"],
                },
              },
              {
                name: "pingvin_revoke_share",
                description:
                  "Immediately revoke public access to a share, invalidating all links, tokens, and cookies.",
                inputSchema: {
                  type: "object",
                  properties: {
                    shareId: { type: "string", description: "ID of share to revoke" },
                  },
                  required: ["shareId"],
                },
              },
              {
                name: "pingvin_delete_share",
                description:
                  "Permanently delete an owned share and all its files. Requires confirm: true.",
                inputSchema: {
                  type: "object",
                  properties: {
                    shareId: { type: "string", description: "ID of share to delete" },
                    confirm: {
                      type: "boolean",
                      description: "Confirmation flag (must be true)",
                    },
                  },
                  required: ["shareId"],
                },
              },
              {
                name: "pingvin_get_share_status",
                description:
                  "Get status of an owned share including completed files and locked state.",
                inputSchema: {
                  type: "object",
                  properties: {
                    shareId: { type: "string", description: "ID of share to inspect" },
                  },
                  required: ["shareId"],
                },
              },
              {
                name: "pingvin_get_upload_status",
                description:
                  "Get detailed resumable upload progress and in-progress chunk offsets.",
                inputSchema: {
                  type: "object",
                  properties: {
                    shareId: { type: "string", description: "ID of share to inspect" },
                  },
                  required: ["shareId"],
                },
              },
              {
                name: "pingvin_cancel_share",
                description:
                  "Cancel an in-progress share and discard partial uploads.",
                inputSchema: {
                  type: "object",
                  properties: {
                    shareId: { type: "string", description: "ID of share to cancel" },
                  },
                  required: ["shareId"],
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
        } else if (
          [
            "pingvin_list_shares",
            "pingvin_update_share",
            "pingvin_revoke_share",
            "pingvin_delete_share",
            "pingvin_get_share_status",
            "pingvin_get_upload_status",
            "pingvin_cancel_share",
          ].includes(params.name)
        ) {
          try {
            const remoteRes = await sendMcpRequestWithRetry(
              serverUrl,
              token,
              null,
              "tools/call",
              {
                name: params.name,
                arguments: params.arguments || {},
              },
            );
            sendLine({
              jsonrpc: "2.0",
              id,
              result: remoteRes.result,
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
                    text: `Tool call failed: ${err.message || String(err)}`,
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
    } catch {
      // ignore
    }
  });
}

async function runCli(options) {
  if (options.command === "upload" || options.paths.length > 0) {
    try {
      console.log(
        `Uploading ${options.paths.length} path(s) to ${options.url}...`,
      );
      const result = await uploadFilesToPingvin({
        ...options,
        onProgress: (p) => {
          if (p.resumed) {
            process.stderr.write(
              `\rResumed [${p.fileIndex + 1}/${p.totalFiles}] ${p.fileName} (already completed)\n`,
            );
          } else {
            process.stderr.write(
              `\rUploading [${p.fileIndex + 1}/${p.totalFiles}] ${p.fileName} - chunk ${p.chunkIndex + 1}/${p.totalChunks}`,
            );
          }
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
  sendMcpRequestWithRetry,
  loadCheckpoint,
  saveCheckpoint,
  clearCheckpoint,
  getFileFingerprint,
  getCheckpointDir,
};
