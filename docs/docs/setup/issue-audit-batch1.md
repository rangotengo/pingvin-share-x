---
id: issue-audit-batch1
---

# Upstream Issue Audit & Batch 1 Fixes

Audit and fixes for confirmed open upstream issues from [smp46/pingvin-share-x](https://github.com/smp46/pingvin-share-x/issues).

## 1. Fixed Applicable Bugs

### #284: Enable download notifications not working for manually shared links
- **Link**: https://github.com/smp46/pingvin-share-x/issues/284
- **Reproduction**: Create a share, enable download notifications in system settings. Copy the share link and send via external email client (no Pingvin recipient ID in URL). When an anonymous visitor opens and downloads, no download notification email is sent.
- **Root Cause**: `notifyRecipientDownload` in `backend/src/file/file.service.ts` had an early guard `if (!recipientId || ...)` requiring `recipientId` and `share.enableShareEmailRecipients`, ignoring download notification preferences for direct and anonymous visitors.
- **Fix**: Removed requirement for `recipientId` and `enableShareEmailRecipients`. When `recipientId` is missing, notification sends to share creator with downloader name `"Someone"` without fabricating any fake recipient DB identity. Filtered out HEAD, Range, and non-download streaming requests. Cooldown cache (`share-download-notification:${shareId}:anonymous`) prevents email spamming. Handled SMTP errors gracefully so downloads never fail if email sending fails.
- **Tests**: `backend/src/file/download-notification-visitor.test.ts` verifies anonymous visitor notifications, anti-spam cooldown, HEAD/Range exclusion, and failure isolation.

### #283: Visitors count stays 0 for recipient email links opened + downloaded
- **Link**: https://github.com/smp46/pingvin-share-x/issues/283
- **Reproduction**: Create a share with email recipients. Recipient opens the share and downloads files. Visitor count remains at 0.
- **Root Cause**: `ShareSecurityGuard.canActivate` returned `true` immediately when `isRecipient(share, user)` was verified, bypassing `getShareToken` and `handleViewCount`. Opening the share therefore never incremented `views`. Direct file download only invoked `handleViewCount` if no `shareToken` cookie existed, confusing file download counts with visitor session counts.
- **Fix**: Updated `ShareSecurityGuard` to count new recipient sessions on top-level share view (`GET /shares/:id`) and issue a session token cookie (`share_${id}_token`). Subsequent metadata requests (`/metaData`) and file downloads (`/files/:id`, `getZip`) recognize the active session and do not double-count. Ensured `?recipient=xxx` query params cannot bypass password protection. Direct file downloads without a session count once and set a cookie, while HEAD and Range requests do not increment visitor count.
- **Tests**: `backend/src/file/download-notification-visitor.test.ts` verifies recipient session increment, no double-counting on metadata/downloads, and password barrier preservation.

### #264: Preview buttons missing for files in folder uploads
- **Link**: https://github.com/smp46/pingvin-share-x/issues/264
- **Reproduction**: Upload a folder with subpaths (e.g. `Photos/Holiday/IMG_0001.jpg`). In the file list, the Preview button and "Copy text contents" buttons are missing.
- **Root Cause**: `mime.contentType` from npm package `mime-types` treats any string containing `/` as an already complete MIME type rather than looking up the file extension. `Photos/Holiday/IMG_0001.jpg` was interpreted as MIME type `"Photos/Holiday/IMG_0001.jpg"`.
- **Fix**: Added `getFileMimeType` helper that strips path segments using both `/` and `\` before querying `mime.contentType`. Applied in `frontend/src/services/share.service.ts`, `showFilePreviewModal.tsx`, `showTextEditorModal.tsx`, and backend `file.controller.ts`. Full file paths remain preserved in `Content-Disposition`, `title`, and metadata.
- **Tests**: `backend/src/file/file-mime.test.ts` validates nested forward-slash paths, backslash paths, mixed separators, SVGs, and unknown extensions.

### #143: Admin allows default share expiration > maximum expiration
- **Link**: https://github.com/smp46/pingvin-share-x/issues/143
- **Reproduction**: In Admin Configuration, set max expiration to 5 minutes and default expiration to 6 minutes. Users subsequently fail to create shares or reverse shares with default expiration because expiration exceeds the maximum.
- **Root Cause**: `validateConfigVariable` lacked cross-variable checks for timespan settings. `updateMany` in `config.service.ts` sequentially updated database rows without evaluating candidate batch state or running inside a transaction, making validation order-dependent and allowing partial saves.
- **Fix**: Created `validateCandidateBatch` in `backend/src/config/config.protocol.ts`. Validates candidate batch atomically before persistence, order-independently (whether default or max is first in the request). Enforces that when max is finite (`> 0`), default cannot be never (`0 days`) and duration (`moment.duration().asMilliseconds()`) cannot exceed max. All updates execute in a single Prisma transaction (`prisma.$transaction`). Added frontend field error highlighting and validation in `AdminConfigInput.tsx` and `[category].tsx`.
- **Tests**: `backend/src/config/config.protocol.test.ts` tests order independence, cross-unit comparisons (minutes vs hours vs days), unlimited/never semantics, and transaction safety.

---

## 2. Upstream Bug Triage

### #278: OIDC callback url uses plain http when behind reverse proxy
- **Link**: https://github.com/smp46/pingvin-share-x/issues/278
- **Status**: **Already Fixed Upstream on `main`**.
- **Evidence**: Fixed by commit `18414f14` (`PR #269: fix(oidc): correctly identify tls for redirect uri`). In `backend/src/oauth/oauth.controller.ts`, `if (host === new URL(appUrl).host.toLowerCase()) return appUrl;` ensures the scheme from `appUrl` is preserved when behind a reverse proxy. Upstream maintainer confirmed in issue comments that #269 resolved this.

### #127: Disk usage widget reports incorrect storage usage on Docker Desktop (macOS/Windows)
- **Link**: https://github.com/smp46/pingvin-share-x/issues/127
- **Status**: **Deferred / Platform-specific limitation**.
- **Evidence**: On native Linux, `statfs`/`df` correctly reports filesystem usage of bind mounts. On Docker Desktop (macOS / Windows), bind mounts pass through VM virtualization layers (virtiofs / 9p / gRPC FUSE) where `statfs` returns the Linux VM rootfs stats. PR #3 added our storage dashboard, but testing Docker Desktop VM virtualization requires macOS/Windows host environments. Not falsely claimed as resolved on Linux.

---

## 3. Compact Triage of Remaining Open Issues

All remaining open issues on upstream `smp46/pingvin-share-x` as of November 2026:

| Issue | Title | Type | Assessment |
|---|---|---|---|
| #274 | Share management - add "Create on" | Enhancement | UI addition; deferred |
| #270 | Prevent redirect to login after Reverse Share upload | Enhancement | UX flow tweak; deferred |
| #266 | Basic reverse share or user experience customization | Enhancement | Feature request; deferred |
| #262 | Quarantine Pending ClamAV Scans | Enhancement | Antivirus security enhancement; deferred |
| #260 | Allow Direct Sharing Between Users Without SMTP | Enhancement | Internal messaging feature; deferred |
| #244 | Configurable requirements for share name & password | Enhancement | Policy feature; deferred |
| #238 | Content Security Policy | Enhancement | Major architectural CSP change; deferred |
| #236 | Sync Name from OAuth | Enhancement | Identity provider attribute sync; deferred |
| #227 | Explicitly request fieldNameMemberOf | Enhancement | LDAP feature; deferred |
| #213 | Background uploads immediately upon file drop | Enhancement | Frontend upload pipeline rewrite; deferred |
| #195 | Protect data at rest with AES | Enhancement | At-rest encryption; out of scope |
| #191 | Organize / group shares | Enhancement | Categorization feature; deferred |
| #187 | Adding a more attractive folder display option | Enhancement | UI redesign; deferred |
| #185 | Add a feature explainer to the docs | Documentation | Documentation task; deferred |
| #173 | Enhance Reverse Shares with Regular Share Features | Enhancement | Feature request; deferred |
| #166 | Add username next to profile icon | Enhancement | Minor UI tweak; deferred |
| #161 | Sign out user when deactivated | Enhancement | Session invalidation; deferred |
| #160 | Sign out user after password change by admin | Enhancement | Session invalidation; deferred |
| #150 | Sorting, search and bulk delete for admin share list | Enhancement | Admin UI feature; deferred |
| #148 | Directly pasting images for upload | Enhancement | Clipboard paste handler; deferred |
| #141 | Add an audit log for administrative actions | Enhancement | Enterprise feature; deferred |
| #140 | Add user groups and role-based permissions (RBAC) | Enhancement | Heavy unrequested RBAC; deferred |
| #139 | Allow administrators to disable user accounts | Enhancement | User management; deferred |
| #137 | Reusable password generator | Enhancement | UI utility; deferred |
| #132 | Improve UI navigation | Enhancement | UI redesign; deferred |
| #131 | Cancel uploads in progress | Enhancement | Client abort signal; deferred |
| #130 | Configurable global storage quota | Enhancement | Storage management; deferred |
| #129 | Show share size in "My Shares" | Enhancement | UI addition; deferred |
| #128 | Remember trusted devices for OTP | Enhancement | MFA feature; deferred |
| #125 | "Recently Uploaded Shares" section | Enhancement | UI addition; deferred |
| #123 | ntfy push notifications alongside smtp | Enhancement | Notification provider; deferred |
| #118 | Multiple users collaboratively manage a share | Enhancement | Collaboration feature; deferred |
| #47 | Use newer file picker | Enhancement | Browser file picker API; deferred |
