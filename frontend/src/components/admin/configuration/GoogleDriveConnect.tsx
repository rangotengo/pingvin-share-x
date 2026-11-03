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
      toast.error("Google Drive connection failed");
    }
  }, [router.isReady, router.query.drive]);

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
