---
id: google-drive
---

# Google Drive

Store new shares in one private Google Drive folder. Recipients still open Pingvin links. Password, expiration, download limits, previews, ranges, and ZIP downloads stay in Pingvin. Drive files are not shared publicly.

Do not enable Google Drive and S3 at the same time. Existing local and S3 shares keep the provider stored on the share.

## Google Cloud

1. Create an OAuth client of type Web application.
2. Enable the Google Drive API.
3. Add this redirect URI, using your app URL:

   `https://your-pingvin-share-domain/api/admin/google-drive/callback`

4. Scope used by the app: `openid email https://www.googleapis.com/auth/drive.file`

`drive.file` only sees files this app creates. Expiration cleanup deletes stored file IDs. It does not list or delete the rest of the Drive.

## App setup

1. Set General → App URL to the public HTTPS origin.
2. Open Administration → Configuration → Google Drive.
3. Set the client ID and client secret. Save.
4. Leave folder ID blank unless reconnecting a folder this app already created.
5. Connect Google Drive and approve access.
6. Enable Google Drive.

The refresh token is stored as a locked server config value. It is not returned by the public config API, the admin status payload, or logs. Resumable upload URLs stay in the `DriveUpload` table.

## Uploads and downloads

The share UI is unchanged. The server forwards chunks to a Drive resumable session in 8 MiB aligned slices, keeps only the unsent remainder, and resumes after a restart by asking Drive how many bytes it already has. Downloads, ranges, and ZIP streams are proxied by Pingvin after the normal share checks.

## Update

Keep the data volume. On start, `prisma migrate deploy` adds `File.providerFileId` and `DriveUpload`. Old shares are not moved.

A foreign folder ID fails under `drive.file`. Clear it and connect again to create a dedicated folder.

Coolify must set `BACKEND_PORT=8080` and keep the data volumes. Do not publish the domain before the first administrator exists. See [Coolify](./coolify.md).
