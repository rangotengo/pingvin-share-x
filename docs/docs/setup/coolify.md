---
id: coolify
---

# Coolify

Use the existing Coolify service. Do not add a second app for the same share host.

## Image

Upstream `ghcr.io/smp46/pingvin-share-x:v2.1.0` has no Drive provider. A Coolify Dockerfile build of this branch tags the image `{applicationUuid}:{commitSha}` on the Coolify host. Point the service image at that tag. Docker Compose uses a local tag when it is already present. Do not `pull` it.

`ghcr.io/rangotengo/pingvin-share-x:drive` exists, but an anonymous pull returns 401 and the saved Coolify token cannot read packages. Do not depend on that tag until the token has `read:packages`.

After a new commit, rebuild the Dockerfile app with no public domain, then set the service image to `{applicationUuid}:{newCommit}` and start the service again. The service does not rebuild from git by itself.

## Required env

Coolify may set `PORT=3000`. Caddy already listens on 3000. Set:

- `BACKEND_PORT=8080`
- `TRUST_PROXY=true` when Cloudflare or Coolify's proxy is in front

Without `BACKEND_PORT`, Nest binds `PORT` and the health check fails.

## Volumes

Keep these mounts. Replacing the image must not create new volume names.

- `/opt/app/backend/data`
- `/opt/app/frontend/public/img`

Start uses Compose without `--yes`, so a volume prompt keeps existing data. Do not delete the service or its volumes to retire a duplicate. Stop the duplicate and turn auto-deploy off.

## Do not publish first

The first account to sign up becomes the administrator. Leave the service domain empty until that account exists. Then set the domain and confirm `GET /api/health` before sharing the URL.

OAuth redirect, once the host is public:

`https://<your-domain>/api/admin/google-drive/callback`

## This host

Service `txnjb01ucx5erhq80eebu5um`, application `gdp0vscmihxisg5pi4szziwj`, project `vwbgciy2b8t1jmdcj3awidfr`. Live image `bjtdxp0v36eltg1ril84bghx:4bae96c620a22e6f36f5910aedb99b9e1eb22717`. Domain is unset. Duplicate app `bjtdxp0v36eltg1ril84bghx` is stopped, auto-deploy off, its volumes left in place.

## Not verified here

Google OAuth client id and secret are not configured. No live Drive upload, range, ZIP, or cleanup has been run. No administrator password has been set, so the public host stays unpublished.
