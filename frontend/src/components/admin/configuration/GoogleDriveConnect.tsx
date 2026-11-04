import { Alert, Button, Code, Group, Stack, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { useRouter } from "next/router";
import { FormattedMessage } from "react-intl";
import configService from "../../../services/config.service";
import toast from "../../../utils/toast.util";

type DriveStatus = {
  enabled: boolean;
  configured: boolean;
  connected: boolean;
  email: string | null;
  folderId: string | null;
  folderName: string | null;
  redirectUri: string;
};

const DRIVE_ERRORS: Record<string, string> = {
  access_denied: "Google denied Drive access",
  invalid_request: "Google rejected the OAuth request",
  invalid_client: "Google rejected the client ID or secret",
  invalid_grant: "Google rejected the authorization code. Connect again",
  unauthorized_client: "This OAuth client cannot use this grant",
  unsupported_grant_type: "Google rejected the OAuth grant type",
  invalid_scope: "Google rejected the Drive scope",
  redirect_uri_mismatch: "Redirect URI does not match the Google OAuth client",
  no_refresh_token:
    "Google did not return a refresh token. Connect again and allow offline access",
  not_configured: "Save the client ID and secret, then try again",
  state_missing: "Connect session expired. Try again",
  state_expired: "Connect session expired. Try again",
  state_mismatch: "Connect session did not match this admin. Try again",
  missing_code: "Google did not return an authorization code",
  folder_failed:
    "Drive folder could not be created. Enable the Drive API, then connect again",
  access_not_configured:
    "Enable the Google Drive API for this Cloud project, then connect again",
  insufficient_permissions: "Google account did not grant Drive file access",
  token_exchange: "Google token exchange failed",
};

const GoogleDriveConnect = () => {
  const router = useRouter();
  const [status, setStatus] = useState<DriveStatus | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = () =>
    configService
      .googleDriveStatus()
      .then(setStatus)
      .catch(() => setStatus(null));

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!router.isReady) return;
    if (router.query.drive === "connected") {
      toast.success("Google Drive connected");
      void refresh();
    }
    if (router.query.drive === "error") {
      const reason =
        typeof router.query.reason === "string" ? router.query.reason : "";
      toast.error(DRIVE_ERRORS[reason] || "Google Drive connection failed");
      void refresh();
    }
  }, [router.isReady, router.query.drive, router.query.reason]);

  return (
    <Stack spacing="xs" mb="md">
      <Alert variant="light">
        <Text size="sm">
          <FormattedMessage
            id="admin.config.googledrive.notice"
            defaultMessage="Files stay private in Drive. Recipients download through Pingvin. Register this redirect URI in the Google OAuth client:"
          />
        </Text>
        <Code block mt="xs">
          {status?.redirectUri || ""}
        </Code>
      </Alert>
      <Text size="sm">
        {status?.connected
          ? `Connected${status.email ? ` as ${status.email}` : ""}${
              status.folderName ? ` · ${status.folderName}` : ""
            }`
          : "Not connected"}
      </Text>
      <Group>
        <Button
          variant="light"
          loading={loading}
          disabled={!status?.configured}
          onClick={async () => {
            setLoading(true);
            try {
              const { url } = await configService.googleDriveConnectUrl();
              window.location.href = url;
            } catch {
              toast.error("Save the client ID and secret, then try again");
              setLoading(false);
            }
          }}
        >
          <FormattedMessage
            id="admin.config.googledrive.connect"
            defaultMessage="Connect Google Drive"
          />
        </Button>
        {status?.connected && (
          <Button
            variant="subtle"
            color="red"
            loading={loading}
            onClick={async () => {
              setLoading(true);
              try {
                await configService.googleDriveDisconnect();
                await refresh();
              } finally {
                setLoading(false);
              }
            }}
          >
            <FormattedMessage
              id="admin.config.googledrive.disconnect"
              defaultMessage="Disconnect"
            />
          </Button>
        )}
      </Group>
    </Stack>
  );
};

export default GoogleDriveConnect;
