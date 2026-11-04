import {
  assertDriveFileId,
  assertUploadSessionUrl,
  bytesFromRangeHeader,
  contentRange,
  googleFailureReason,
  redactSecrets,
  safeGoogleDetail,
} from "./google-drive.protocol";
import { isAlreadyGoneStatus } from "./delete-plan";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const DRIVE_SCOPE =
  "openid email https://www.googleapis.com/auth/drive.file";

export class DriveError extends Error {
  readonly detail: string;

  constructor(
    message: string,
    readonly status?: number,
    detail = "",
  ) {
    super(redactSecrets(message));
    this.name = "DriveError";
    this.detail = redactSecrets(detail).slice(0, 160);
  }
}

type FetchFn = typeof fetch;

export class GoogleDriveClient {
  private accessToken?: { token: string; exp: number };
  private refreshLock: Promise<string> | null = null;

  constructor(
    private readonly fetchImpl: FetchFn,
    private readonly credentials: () => {
      clientId: string;
      clientSecret: string;
      refreshToken: string;
    },
  ) {}

  authUrl(redirectUri: string, state: string): string {
    const { clientId } = this.credentials();
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: DRIVE_SCOPE,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  }

  async exchangeCode(code: string, redirectUri: string) {
    const { clientId, clientSecret } = this.credentials();
    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    });
    const payload = await this.tokenRequest(body);
    if (!payload.refresh_token) {
      throw new DriveError("no_refresh_token");
    }
    return {
      refreshToken: payload.refresh_token,
      accessToken: payload.access_token,
      expiresIn: payload.expires_in,
    };
  }

  async userEmail(): Promise<string> {
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(USERINFO_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new DriveError("userinfo failed", response.status);
    const body = (await response.json()) as { email?: string };
    return body.email || "";
  }

  async createFolder(name: string): Promise<{ id: string; name: string }> {
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(`${DRIVE_API}/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: name || "Pingvin Share",
        mimeType: "application/vnd.google-apps.folder",
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await this.readJson(response);
    if (!response.ok || !payload.id) {
      throw new DriveError(
        googleFailureReason(payload, "folder_failed"),
        response.status,
        safeGoogleDetail(payload),
      );
    }
    return { id: String(payload.id), name: String(payload.name || name) };
  }

  async getFolder(id: string): Promise<{ id: string; name: string }> {
    assertDriveFileId(id);
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(
      `${DRIVE_API}/files/${id}?fields=id,name,mimeType,trashed`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const payload = await this.readJson(response);
    if (!response.ok) {
      throw new DriveError(
        googleFailureReason(payload, "folder_failed"),
        response.status,
        safeGoogleDetail(payload),
      );
    }
    if (
      payload.mimeType !== "application/vnd.google-apps.folder" ||
      payload.trashed
    ) {
      throw new DriveError("folder_failed", response.status);
    }
    return { id: String(payload.id), name: String(payload.name || "") };
  }

  async createEmptyFile(name: string, parentId: string, mime: string) {
    assertDriveFileId(parentId);
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(`${DRIVE_API}/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        parents: [parentId],
        mimeType: mime,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const payload = await this.readJson(response);
    if (!response.ok || !payload.id) {
      throw new DriveError("empty file create failed", response.status);
    }
    return String(payload.id);
  }

  async startUpload(name: string, parentId: string, mime: string) {
    assertDriveFileId(parentId);
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(
      `${DRIVE_UPLOAD}?uploadType=resumable`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": mime,
        },
        body: JSON.stringify({ name, parents: [parentId] }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (!response.ok) {
      throw new DriveError("upload session failed", response.status);
    }
    const location = response.headers.get("location");
    if (!location)
      throw new DriveError("upload session missing", response.status);
    assertUploadSessionUrl(location);
    return location;
  }

  async querySession(sessionUri: string): Promise<{
    complete: boolean;
    bytes: number;
    expired: boolean;
    fileId?: string;
    size?: number;
  }> {
    assertUploadSessionUrl(sessionUri);
    const response = await this.requestWithRetry(sessionUri, {
      method: "PUT",
      headers: {
        "Content-Length": "0",
        "Content-Range": "bytes */*",
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 308) {
      return {
        complete: false,
        expired: false,
        bytes: bytesFromRangeHeader(response.headers.get("range")),
      };
    }
    if (response.ok) {
      const payload = await this.readJson(response);
      return {
        complete: true,
        expired: false,
        bytes: Number(payload.size || 0),
        fileId: payload.id ? String(payload.id) : undefined,
        size: payload.size ? Number(payload.size) : undefined,
      };
    }
    if (response.status === 404 || response.status === 410) {
      return { complete: false, expired: true, bytes: 0 };
    }
    throw new DriveError("upload status failed", response.status);
  }

  async uploadSlice(
    sessionUri: string,
    start: number,
    body: Buffer,
    total: number | null,
  ): Promise<{ complete: boolean; fileId?: string; next?: number }> {
    assertUploadSessionUrl(sessionUri);
    const response = await this.requestWithRetry(sessionUri, {
      method: "PUT",
      headers: {
        "Content-Length": String(body.length),
        "Content-Range": contentRange(start, body.length, total),
      },
      body,
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status === 308) {
      const next = bytesFromRangeHeader(response.headers.get("range"));
      return { complete: false, next: next || start + body.length };
    }
    if (response.ok) {
      const payload = await this.readJson(response);
      if (!payload.id) throw new DriveError("upload finished without file id");
      return {
        complete: true,
        fileId: String(payload.id),
        next: start + body.length,
      };
    }
    throw new DriveError("upload slice failed", response.status);
  }

  async download(
    fileId: string,
    range?: { start: number; end: number },
  ): Promise<{ status: number; body: ReadableStream<Uint8Array> | null }> {
    assertDriveFileId(fileId);
    const token = await this.getAccessToken();
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };
    if (range) headers.Range = `bytes=${range.start}-${range.end}`;
    const response = await this.requestWithRetry(
      `${DRIVE_API}/files/${fileId}?alt=media`,
      { headers, signal: AbortSignal.timeout(120_000) },
    );
    if (
      response.status !== 200 &&
      response.status !== 206 &&
      response.status !== 416
    ) {
      throw new DriveError("download failed", response.status);
    }
    return { status: response.status, body: response.body };
  }

  async fileSize(fileId: string): Promise<number> {
    assertDriveFileId(fileId);
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(
      `${DRIVE_API}/files/${fileId}?fields=size`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(30_000),
      },
    );
    const payload = await this.readJson(response);
    if (!response.ok) throw new DriveError("file size failed", response.status);
    return Number(payload.size || 0);
  }

  async cancelSession(sessionUri: string) {
    assertUploadSessionUrl(sessionUri);
    const response = await this.fetchImpl(sessionUri, {
      method: "DELETE",
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (
      !response ||
      response.ok ||
      response.status === 404 ||
      response.status === 410
    ) {
      return;
    }
  }

  async revoke(token: string) {
    if (!token) return;
    const body = new URLSearchParams({ token });
    await this.fetchImpl("https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined);
  }

  async deleteFile(fileId: string) {
    assertDriveFileId(fileId);
    const token = await this.getAccessToken();
    const response = await this.fetchImpl(`${DRIVE_API}/files/${fileId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (isAlreadyGoneStatus(response.status)) return;
    throw new DriveError("delete failed", response.status);
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && this.accessToken.exp > Date.now() + 60_000) {
      return this.accessToken.token;
    }
    if (!this.refreshLock) {
      this.refreshLock = this.refresh().finally(() => {
        this.refreshLock = null;
      });
    }
    return this.refreshLock;
  }

  private async refresh(): Promise<string> {
    const { clientId, clientSecret, refreshToken } = this.credentials();
    if (!refreshToken) throw new DriveError("Google Drive is not connected");
    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    });
    const payload = await this.tokenRequest(body);
    this.accessToken = {
      token: payload.access_token,
      exp: Date.now() + payload.expires_in * 1000,
    };
    return payload.access_token;
  }

  private async tokenRequest(body: URLSearchParams) {
    const response = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!response.ok || !payload.access_token) {
      throw new DriveError(
        googleFailureReason(payload, "token_exchange"),
        response.status,
        safeGoogleDetail(payload),
      );
    }
    return {
      access_token: payload.access_token,
      refresh_token: payload.refresh_token,
      expires_in: payload.expires_in || 3600,
    };
  }

  private async requestWithRetry(url: string, init: RequestInit, attempt = 0) {
    try {
      const response = await this.fetchImpl(url, init);
      if (
        attempt < 2 &&
        (response.status === 408 ||
          response.status === 429 ||
          response.status === 500 ||
          response.status === 502 ||
          response.status === 503 ||
          response.status === 504)
      ) {
        await delay(500 * (attempt + 1));
        return this.requestWithRetry(url, init, attempt + 1);
      }
      return response;
    } catch (error) {
      if (attempt < 2) {
        await delay(500 * (attempt + 1));
        return this.requestWithRetry(url, init, attempt + 1);
      }
      throw new DriveError(
        error instanceof Error ? error.message : "drive request failed",
      );
    }
  }

  private async readJson(response: Response): Promise<Record<string, unknown>> {
    return (await response.json().catch(() => ({}))) as Record<string, unknown>;
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
