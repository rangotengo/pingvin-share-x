/** Remote 2xx, 404, and 410 mean the object is gone. Other statuses are real failures. */
export function isAlreadyGoneStatus(status: number): boolean {
  return (status >= 200 && status < 300) || status === 404 || status === 410;
}

export function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function isRecordMissing(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    (error as { code?: string }).code === "P2025"
  );
}

export function isMissingObject(error: unknown): boolean {
  if (isEnoent(error)) return true;
  if (!error || typeof error !== "object") return false;
  const body = error as {
    name?: string;
    Code?: string;
    code?: string;
    $metadata?: { httpStatusCode?: number };
  };
  const code = body.Code || body.code || body.name || "";
  if (code === "NoSuchKey" || code === "NotFound" || code === "ENOENT") {
    return true;
  }
  return body.$metadata?.httpStatusCode === 404;
}

export function isMissingObjectCode(code: string | undefined): boolean {
  return code === "NoSuchKey" || code === "NotFound";
}

/**
 * Delete the DB row only after the remote object is gone.
 * A missing row is already done — do not delete it again.
 */
export function shouldDeleteDbRow(args: {
  rowExists: boolean;
  remote: "absent" | "gone" | "failed";
}): boolean {
  if (!args.rowExists || args.remote === "failed") return false;
  return true;
}
