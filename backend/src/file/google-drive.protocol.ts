export const DRIVE_ALIGN = 256 * 1024;
export const DRIVE_FLUSH = 8 * 1024 * 1024;

const UPLOAD_SESSION_PREFIX = "https://www.googleapis.com/upload/";

export type Slice = { body: Buffer; final: boolean };

export function planSlices(
  pending: Buffer,
  incoming: Buffer,
  isLast: boolean,
): { slices: Slice[]; remainder: Buffer } {
  const combined =
    pending.length === 0
      ? incoming
      : incoming.length === 0
        ? pending
        : Buffer.concat([pending, incoming]);

  if (!isLast) {
    const flushBytes = combined.length - (combined.length % DRIVE_FLUSH);
    const slices: Slice[] = [];
    for (let offset = 0; offset < flushBytes; offset += DRIVE_FLUSH) {
      slices.push({
        body: combined.subarray(offset, offset + DRIVE_FLUSH),
        final: false,
      });
    }
    return { slices, remainder: combined.subarray(flushBytes) };
  }

  const slices: Slice[] = [];
  let offset = 0;
  while (combined.length - offset > DRIVE_FLUSH) {
    slices.push({
      body: combined.subarray(offset, offset + DRIVE_FLUSH),
      final: false,
    });
    offset += DRIVE_FLUSH;
  }
  if (combined.length > offset) {
    slices.push({ body: combined.subarray(offset), final: true });
  }
  return { slices, remainder: Buffer.alloc(0) };
}

export function contentRange(
  start: number,
  length: number,
  total: number | null,
): string {
  if (length <= 0) return total == null ? "bytes */*" : `bytes */${total}`;
  const end = start + length - 1;
  return total == null
    ? `bytes ${start}-${end}/*`
    : `bytes ${start}-${end}/${total}`;
}

export function expectedChunkIndex(accepted: number, chunkSize: number): number {
  if (chunkSize <= 0) throw new Error("invalid chunk size");
  return Math.ceil(accepted / chunkSize);
}

export function classifyChunk(args: {
  index: number;
  chunkSize: number;
  byteLength: number;
  accepted: number;
}): "process" | "duplicate" | "unexpected" {
  const start = args.index * args.chunkSize;
  const end = start + args.byteLength;
  const expected = expectedChunkIndex(args.accepted, args.chunkSize);
  if (args.accepted >= end && args.index < expected) return "duplicate";
  if (args.index === expected) return "process";
  if (start <= args.accepted && args.accepted < end) return "process";
  return "unexpected";
}

export function bytesFromRangeHeader(header: string | null): number {
  if (!header) return 0;
  const match = /bytes=(\d+)-(\d+)/.exec(header);
  if (!match) return 0;
  return Number(match[2]) + 1;
}

export function assertUploadSessionUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid upload session");
  }
  if (parsed.protocol !== "https:" || !url.startsWith(UPLOAD_SESSION_PREFIX)) {
    throw new Error("invalid upload session");
  }
}

export function assertDriveFileId(id: string) {
  if (!/^[a-zA-Z0-9_-]{10,}$/.test(id)) {
    throw new Error("invalid drive file id");
  }
}

export function redactSecrets(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/upload_id=[^&\s"]+/gi, "upload_id=[redacted]")
    .replace(/https:\/\/www\.googleapis\.com\/upload\/[^\s"]+/gi, "[upload-session]")
    .replace(/refresh_token=[^&\s"]+/gi, "refresh_token=[redacted]")
    .replace(/client_secret=[^&\s"]+/gi, "client_secret=[redacted]");
}

export type DriveStatus = {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  email: string | null;
  folderId: string | null;
  folderName: string | null;
  redirectUri: string;
};

export function publicDriveStatus(input: {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  email: string;
  folderId: string;
  folderName: string;
  redirectUri: string;
}): DriveStatus {
  return {
    enabled: input.enabled,
    configured: Boolean(input.clientId && input.clientSecret),
    connected: Boolean(input.refreshToken),
    email: input.email || null,
    folderId: input.folderId || null,
    folderName: input.folderName || null,
    redirectUri: input.redirectUri,
  };
}

/** Browser redirects only for S3. Drive downloads stay behind Pingvin auth. */
export function usesBrowserRedirect(provider: string): boolean {
  return provider === "S3";
}

export function deletionTargets(
  files: { providerFileId: string | null }[],
): string[] {
  const ids: string[] = [];
  for (const file of files) {
    if (file.providerFileId) ids.push(file.providerFileId);
  }
  return ids;
}

export function chunkBytes(data: string | Buffer): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Buffer.from(data, "base64");
}
