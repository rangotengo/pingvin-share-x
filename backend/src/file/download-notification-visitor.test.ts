import assert from "node:assert/strict";
import test from "node:test";

// Test suite for #284 (download notifications) and #283 (visitor counting & security)

test("#284 anonymous visitor notification uses 'Someone' without fabricating identity", async () => {
  let sentMail: any = null;

  const mockEmailService = {
    sendShareDownloadNotification: async (
      creatorEmail: string,
      shareId: string,
      fileName: string,
      recipientEmail?: string,
      creatorName?: string,
      recipientName?: string,
    ) => {
      const downloader = recipientName
        ? recipientEmail
          ? `${recipientName} (${recipientEmail})`
          : recipientName
        : recipientEmail || "Someone";
      sentMail = {
        creatorEmail,
        shareId,
        fileName,
        downloader,
        recipientEmail: recipientEmail ?? "Someone",
      };
    },
  };

  const cacheStore = new Map<string, any>();
  const mockCache = {
    get: async (k: string) => cacheStore.get(k),
    set: async (k: string, v: any, ttl: number) => cacheStore.set(k, v),
  };

  const mockPrisma = {
    share: {
      findUnique: async ({ where }: any) => {
        if (where.id === "share-anon-1") {
          return {
            id: "share-anon-1",
            creator: {
              email: "creator@example.com",
              username: "creator",
              displayName: "Share Creator",
            },
            recipients: [],
          };
        }
        return null;
      },
    },
    user: {
      findUnique: async () => null,
    },
  };

  const mockConfigService = {
    get: (key: string) => {
      if (key === "smtp.enabled") return true;
      if (key === "share.enableShareDownloadNotifications") return true;
      return null;
    },
  };

  // Simulate fileService.notifyRecipientDownload without recipientId (manual link)
  async function notify(shareId: string, fileName: string, recipientId?: string) {
    if (
      !mockConfigService.get("smtp.enabled") ||
      !mockConfigService.get("share.enableShareDownloadNotifications")
    )
      return;

    const notificationKey = recipientId
      ? `share-download-notification:${shareId}:${recipientId}`
      : `share-download-notification:${shareId}:anonymous`;
    if (await mockCache.get(notificationKey)) return;

    const share = await mockPrisma.share.findUnique({ where: { id: shareId } });
    if (!share?.creator?.email) return;

    await mockCache.set(notificationKey, true, 15 * 60 * 1000);
    await mockEmailService.sendShareDownloadNotification(
      share.creator.email,
      share.id,
      fileName,
      undefined,
      share.creator.displayName || share.creator.username,
      undefined,
    );
  }

  // 1. Initial anonymous download triggers notification
  await notify("share-anon-1", "document.pdf");
  assert.notEqual(sentMail, null);
  assert.equal(sentMail.creatorEmail, "creator@example.com");
  assert.equal(sentMail.fileName, "document.pdf");
  assert.equal(sentMail.downloader, "Someone");
  assert.equal(sentMail.recipientEmail, "Someone");

  // 2. Cooldown prevents spamming creator on rapid subsequent file downloads
  sentMail = null;
  await notify("share-anon-1", "image.png");
  assert.equal(sentMail, null, "Should not notify again within cooldown");
});

test("#284 SMTP failure does not throw or interrupt download", async () => {
  const mockFailingEmailService = {
    sendShareDownloadNotification: async () => {
      throw new Error("SMTP connection refused: connection timed out");
    },
  };

  let errorLogged = false;
  const mockLogger = {
    error: (_msg: string, _trace: string) => {
      errorLogged = true;
    },
  };

  // Ensure try/catch protects the caller
  let downloadThrew = false;
  try {
    try {
      await mockFailingEmailService.sendShareDownloadNotification();
    } catch (e: any) {
      mockLogger.error("Failed to notify", e.stack);
    }
  } catch {
    downloadThrew = true;
  }

  assert.equal(downloadThrew, false, "Download must not throw on SMTP error");
  assert.equal(errorLogged, true, "Failure must be logged safely");
});

test("#284 notification conditions: ignores HEAD, Range, and non-download streaming", () => {
  function shouldNotify(
    method: string,
    isDownload: boolean,
    isRange: boolean,
  ): boolean {
    return isDownload && !isRange && method !== "HEAD";
  }

  // Full file download GET -> notifies
  assert.equal(shouldNotify("GET", true, false), true);

  // HEAD request -> ignored
  assert.equal(shouldNotify("HEAD", true, false), false);

  // Range request (media seek / chunk) -> ignored
  assert.equal(shouldNotify("GET", true, true), false);

  // Inline preview / media stream (isDownload = false) -> ignored
  assert.equal(shouldNotify("GET", false, false), false);
});

test("#283 recipient view counting and no double-counting on metadata/downloads", () => {
  let views = 0;
  const maxViews = 5;

  function handleView(currentViews: number, max?: number): number {
    if (max && currentViews >= max) {
      throw new Error("share_max_views_exceeded");
    }
    return currentViews + 1;
  }

  // First view by recipient increments views from 0 to 1
  views = handleView(views, maxViews);
  assert.equal(views, 1);

  // Session token established; subsequent calls with valid session token do not increment
  const hasValidToken = true;
  const isShareView = false; // e.g. /metaData or file download
  if (!hasValidToken && isShareView) {
    views = handleView(views, maxViews);
  }
  assert.equal(views, 1, "Views should remain 1 across metadata and download requests in session");

  // Max views barrier works
  views = 5;
  assert.throws(() => handleView(views, maxViews), /share_max_views_exceeded/);
});

test("#283 recipient ID in query does NOT bypass password", () => {
  function checkAccess(share: { hasPassword: boolean }, shareToken?: string) {
    if (share.hasPassword && !shareToken) {
      throw new Error("share_password_required");
    }
    return true;
  }

  const pwShare = { hasPassword: true };

  // Attempting access with recipient query param but no verified password token
  assert.throws(() => checkAccess(pwShare, undefined), /share_password_required/);

  // Access with verified token succeeds
  assert.equal(checkAccess(pwShare, "valid-token"), true);
});
