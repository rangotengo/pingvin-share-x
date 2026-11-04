---
id: upgrading
---

# Upgrading

### Google Drive storage

Fork builds that add Google Drive keep existing local and S3 shares. The container runs `prisma migrate deploy` on start, which adds `File.providerFileId` and the `DriveUpload` table. Do not enable Google Drive and S3 together. See [Google Drive](./google-drive.md).

### Upgrade to a new version

As Pingvin Share X is in active development, see the release notes for breaking changes before upgrading.

#### Docker

```bash
docker compose pull
docker compose up -d
```

### Portainer

1. In your container page, click on Recreate.
2. Check the Re-Pull image toggle.
3. Click on Recreate.

#### Stand-alone

1. Stop the running app

   ```bash
   pm2 stop pingvin-share-x-backend pingvin-share-x-frontend
   ```

2. Repeat the steps from the [installation guide](#stand-alone-installation) except the `git clone` step.

   ```bash
   cd pingvin-share

   # Checkout the latest version
   git fetch --tags && git checkout $(git describe --tags `git rev-list --tags --max-count=1`)

   # Start the backend
   cd backend
   npm install
   npm run build
   pm2 restart pingvin-share-x-backend

   # Start the frontend
   cd ../frontend
   npm install
   npm run build
   pm2 restart pingvin-share-x-frontend
   ```

   Note that environment variables are not picked up when using pm2 restart, if you actually want to change configs, you need to run `pm2 --update-env restart`
