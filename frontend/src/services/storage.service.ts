import api from "./api.service";

export interface ProviderStorageInfo {
  configured: boolean;
  enabled: boolean;
  connected: boolean;
  connectionError: string | null;
  connectedEmail?: string | null;
  folderName?: string | null;
  sharesCount: number;
  filesCount: number;
  logicalBytes: number;
  quota?: {
    limit?: number;
    usage?: number;
    usageInDrive?: number;
  } | null;
}

export interface ActiveUpload {
  id: string;
  shareId: string;
  name: string;
  provider: string;
  committedBytes: number;
  totalChunks: number | null;
  expectedChunkIndex: number;
  updatedAt: string;
  status: "active" | "interrupted" | "stale";
}

export interface CleanupFailure {
  id: string;
  provider: string;
  shareId: string | null;
  fileId: string | null;
  targetId: string;
  action: string;
  error: string | null;
  attempts: number;
  createdAt: string;
  lastAttemptAt: string;
}

export interface StorageDashboardData {
  defaultProvider: "LOCAL" | "S3" | "GOOGLE_DRIVE";
  providers: {
    LOCAL: ProviderStorageInfo;
    S3: ProviderStorageInfo;
    GOOGLE_DRIVE: ProviderStorageInfo;
  };
  localDisk: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    persistentBytes: number;
    temporaryBytes: number;
    trackedLogicalQuota: number;
  };
  activeUploads: ActiveUpload[];
  cleanupFailures: CleanupFailure[];
}

const getDashboard = async (): Promise<StorageDashboardData> => {
  return (await api.get("admin/storage")).data;
};

const retryCleanup = async (
  id: string,
): Promise<{ success: boolean; message: string }> => {
  return (await api.post(`admin/storage/cleanup-failures/${id}/retry`)).data;
};

const retryAllCleanups = async (): Promise<{
  total: number;
  succeeded: number;
  failed: number;
}> => {
  return (await api.post("admin/storage/cleanup-failures/retry-all")).data;
};

const dismissCleanup = async (id: string): Promise<void> => {
  await api.delete(`admin/storage/cleanup-failures/${id}`);
};

const abortActiveUpload = async (fileId: string): Promise<void> => {
  await api.post(`admin/storage/active-uploads/${fileId}/abort`);
};

export default {
  getDashboard,
  retryCleanup,
  retryAllCleanups,
  dismissCleanup,
  abortActiveUpload,
};
