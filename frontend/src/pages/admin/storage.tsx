import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Card,
  Group,
  Paper,
  Progress,
  SimpleGrid,
  Stack,
  Table,
  Text,
  ThemeIcon,
  Title,
} from "@mantine/core";
import { useModals } from "@mantine/modals";
import Link from "next/link";
import { useEffect, useState } from "react";
import {
  TbArrowLeft,
  TbBucket,
  TbCloud,
  TbDatabase,
  TbFolder,
  TbRefresh,
  TbTrash,
  TbX,
} from "react-icons/tb";
import { FormattedMessage } from "react-intl";
import Meta from "../../components/Meta";
import CenterLoader from "../../components/core/CenterLoader";
import { HoverTip } from "../../components/core/HoverTip";
import useTranslate from "../../hooks/useTranslate.hook";
import storageService, {
  StorageDashboardData,
} from "../../services/storage.service";
import { byteToHumanSizeString } from "../../utils/fileSize.util";
import toast from "../../utils/toast.util";
import moment from "moment";

const StorageDashboard = () => {
  const [data, setData] = useState<StorageDashboardData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRetrying, setIsRetrying] = useState(false);
  const modals = useModals();
  const t = useTranslate();

  const loadData = () => {
    setIsLoading(true);
    storageService
      .getDashboard()
      .then((res) => {
        setData(res);
        setIsLoading(false);
      })
      .catch((err) => {
        toast.axiosError(err);
        setIsLoading(false);
      });
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleRetryCleanup = async (id: string) => {
    try {
      const res = await storageService.retryCleanup(id);
      if (res.success) {
        toast.success(res.message);
      } else {
        toast.error(res.message);
      }
      loadData();
    } catch (err) {
      toast.axiosError(err);
    }
  };

  const handleRetryAll = async () => {
    setIsRetrying(true);
    try {
      const res = await storageService.retryAllCleanups();
      toast.success(
        `Retried ${res.total} cleanup items: ${res.succeeded} succeeded, ${res.failed} failed.`,
      );
      loadData();
    } catch (err) {
      toast.axiosError(err);
    } finally {
      setIsRetrying(false);
    }
  };

  const handleDismissCleanup = async (id: string) => {
    try {
      await storageService.dismissCleanup(id);
      toast.success(t("common.notify.deleted"));
      loadData();
    } catch (err) {
      toast.axiosError(err);
    }
  };

  const handleAbortUpload = (fileId: string, name: string) => {
    modals.openConfirmModal({
      title: t("admin.storage.abort"),
      children: (
        <Text size="sm">
          {t("admin.storage.confirmAbort")} ({name})
        </Text>
      ),
      labels: {
        confirm: t("admin.storage.abort"),
        cancel: t("common.button.cancel"),
      },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await storageService.abortActiveUpload(fileId);
          toast.success(t("common.notify.deleted"));
          loadData();
        } catch (err) {
          toast.axiosError(err);
        }
      },
    });
  };

  if (isLoading || !data) {
    return <CenterLoader />;
  }

  const diskUsedPct =
    data.localDisk.totalBytes > 0
      ? (data.localDisk.usedBytes / data.localDisk.totalBytes) * 100
      : 0;

  return (
    <>
      <Meta title={t("admin.storage.title")} />
      <Group position="apart" align="center" mb={24}>
        <Group spacing="sm">
          <ActionIcon component={Link} href="/admin" variant="light" size="lg">
            <TbArrowLeft size={18} />
          </ActionIcon>
          <Title order={3}>
            <FormattedMessage id="admin.storage.title" />
          </Title>
        </Group>
        <Button
          variant="light"
          leftIcon={<TbRefresh size={16} />}
          onClick={loadData}
        >
          {t("common.button.refresh")}
        </Button>
      </Group>

      {/* Provider Overview Cards */}
      <Title order={4} mb={12}>
        <FormattedMessage id="admin.storage.providers" />
      </Title>
      <SimpleGrid cols={3} breakpoints={[{ maxWidth: "sm", cols: 1 }]} mb={24}>
        {/* Local Provider */}
        <Card withBorder radius="md" p="md">
          <Group position="apart" mb="xs">
            <Group spacing="xs">
              <ThemeIcon size="md" variant="light" color="blue">
                <TbFolder size={18} />
              </ThemeIcon>
              <Text weight={600}>Local Disk</Text>
            </Group>
            {data.defaultProvider === "LOCAL" && (
              <Badge color="blue" size="sm">
                Default
              </Badge>
            )}
          </Group>
          <Badge color="green" size="xs" mb="sm">
            Connected
          </Badge>
          <Stack spacing={4}>
            <Text size="sm">
              Shares: <b>{data.providers.LOCAL.sharesCount}</b>
            </Text>
            <Text size="sm">
              Files: <b>{data.providers.LOCAL.filesCount}</b>
            </Text>
            <Text size="sm">
              Stored: <b>{byteToHumanSizeString(data.providers.LOCAL.logicalBytes)}</b>
            </Text>
          </Stack>
        </Card>

        {/* S3 Provider */}
        <Card withBorder radius="md" p="md">
          <Group position="apart" mb="xs">
            <Group spacing="xs">
              <ThemeIcon size="md" variant="light" color="orange">
                <TbBucket size={18} />
              </ThemeIcon>
              <Text weight={600}>Amazon S3</Text>
            </Group>
            {data.defaultProvider === "S3" && (
              <Badge color="blue" size="sm">
                Default
              </Badge>
            )}
          </Group>
          <Group spacing="xs" mb="sm">
            <Badge
              color={
                data.providers.S3.connected
                  ? "green"
                  : data.providers.S3.enabled
                    ? "red"
                    : "gray"
              }
              size="xs"
            >
              {data.providers.S3.connected
                ? "Connected"
                : data.providers.S3.enabled
                  ? "Disconnected"
                  : "Disabled"}
            </Badge>
            {data.providers.S3.connectionError && (
              <Text size="xs" color="red" lineClamp={1}>
                {data.providers.S3.connectionError}
              </Text>
            )}
          </Group>
          <Stack spacing={4}>
            <Text size="sm">
              Shares: <b>{data.providers.S3.sharesCount}</b>
            </Text>
            <Text size="sm">
              Files: <b>{data.providers.S3.filesCount}</b>
            </Text>
            <Text size="sm">
              Stored: <b>{byteToHumanSizeString(data.providers.S3.logicalBytes)}</b>
            </Text>
          </Stack>
        </Card>

        {/* Google Drive Provider */}
        <Card withBorder radius="md" p="md">
          <Group position="apart" mb="xs">
            <Group spacing="xs">
              <ThemeIcon size="md" variant="light" color="teal">
                <TbCloud size={18} />
              </ThemeIcon>
              <Text weight={600}>Google Drive</Text>
            </Group>
            {data.defaultProvider === "GOOGLE_DRIVE" && (
              <Badge color="blue" size="sm">
                Default
              </Badge>
            )}
          </Group>
          <Group spacing="xs" mb="sm">
            <Badge
              color={
                data.providers.GOOGLE_DRIVE.connected
                  ? "green"
                  : data.providers.GOOGLE_DRIVE.enabled
                    ? "yellow"
                    : "gray"
              }
              size="xs"
            >
              {data.providers.GOOGLE_DRIVE.connected
                ? "Connected"
                : data.providers.GOOGLE_DRIVE.enabled
                  ? "Configured"
                  : "Disabled"}
            </Badge>
            {data.providers.GOOGLE_DRIVE.connectedEmail && (
              <Text size="xs" color="dimmed" lineClamp={1}>
                {data.providers.GOOGLE_DRIVE.connectedEmail}
              </Text>
            )}
          </Group>
          <Stack spacing={4}>
            <Text size="sm">
              Shares: <b>{data.providers.GOOGLE_DRIVE.sharesCount}</b>
            </Text>
            <Text size="sm">
              Files: <b>{data.providers.GOOGLE_DRIVE.filesCount}</b>
            </Text>
            <Text size="sm">
              Stored:{" "}
              <b>{byteToHumanSizeString(data.providers.GOOGLE_DRIVE.logicalBytes)}</b>
            </Text>
            {data.providers.GOOGLE_DRIVE.quota?.usage !== undefined && (
              <Text size="xs" color="dimmed">
                Drive Quota:{" "}
                {byteToHumanSizeString(data.providers.GOOGLE_DRIVE.quota.usage)}{" "}
                {data.providers.GOOGLE_DRIVE.quota.limit
                  ? `/ ${byteToHumanSizeString(data.providers.GOOGLE_DRIVE.quota.limit)}`
                  : ""}
              </Text>
            )}
          </Stack>
        </Card>
      </SimpleGrid>

      {/* Local Disk Usage Details */}
      <Card withBorder radius="md" p="md" mb={24}>
        <Group position="apart" mb="xs">
          <Group spacing="xs">
            <ThemeIcon size="sm" variant="light">
              <TbDatabase size={16} />
            </ThemeIcon>
            <Text weight={600}>
              <FormattedMessage id="admin.storage.diskUsage" />
            </Text>
          </Group>
          <Text size="xs" color="dimmed">
            {byteToHumanSizeString(data.localDisk.usedBytes)} /{" "}
            {byteToHumanSizeString(data.localDisk.totalBytes)} ({diskUsedPct.toFixed(1)}%)
          </Text>
        </Group>
        <Progress
          value={diskUsedPct}
          size="md"
          radius="xl"
          mb="md"
          color={diskUsedPct > 90 ? "red" : diskUsedPct > 70 ? "yellow" : "blue"}
        />
        <SimpleGrid cols={3} breakpoints={[{ maxWidth: "xs", cols: 1 }]}>
          <div>
            <Text size="xs" color="dimmed">
              Persistent Files
            </Text>
            <Text weight={600} size="sm">
              {byteToHumanSizeString(data.localDisk.persistentBytes)}
            </Text>
          </div>
          <div>
            <Text size="xs" color="dimmed">
              Temporary / Incomplete
            </Text>
            <Text weight={600} size="sm">
              {byteToHumanSizeString(data.localDisk.temporaryBytes)}
            </Text>
          </div>
          <div>
            <Text size="xs" color="dimmed">
              Total Logical Tracked
            </Text>
            <Text weight={600} size="sm">
              {byteToHumanSizeString(data.localDisk.trackedLogicalQuota)}
            </Text>
          </div>
        </SimpleGrid>
      </Card>

      {/* Active / Recoverable Uploads Table */}
      <Paper withBorder radius="md" p="md" mb={24}>
        <Title order={4} mb={12}>
          <FormattedMessage id="admin.storage.activeUploads" /> (
          {data.activeUploads.length})
        </Title>
        {data.activeUploads.length === 0 ? (
          <Text size="sm" color="dimmed">
            <FormattedMessage id="admin.storage.noActiveUploads" />
          </Text>
        ) : (
          <Box sx={{ overflowX: "auto" }}>
            <Table verticalSpacing="xs">
              <thead>
                <tr>
                  <th>Share ID</th>
                  <th>File Name</th>
                  <th>Provider</th>
                  <th>Committed</th>
                  <th>Chunk</th>
                  <th>Status</th>
                  <th>Last Activity</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.activeUploads.map((upload) => (
                  <tr key={upload.id}>
                    <td>
                      <Text size="xs" component={Link} href={`/share/${upload.shareId}`}>
                        {upload.shareId}
                      </Text>
                    </td>
                    <td>
                      <Text size="xs" weight={500}>
                        {upload.name}
                      </Text>
                    </td>
                    <td>
                      <Badge size="xs" variant="outline">
                        {upload.provider}
                      </Badge>
                    </td>
                    <td>
                      <Text size="xs">
                        {byteToHumanSizeString(upload.committedBytes)}
                      </Text>
                    </td>
                    <td>
                      <Text size="xs">
                        {upload.expectedChunkIndex}
                        {upload.totalChunks ? ` / ${upload.totalChunks}` : ""}
                      </Text>
                    </td>
                    <td>
                      <Badge
                        size="xs"
                        color={
                          upload.status === "active"
                            ? "blue"
                            : upload.status === "interrupted"
                              ? "yellow"
                              : "red"
                        }
                      >
                        {upload.status}
                      </Badge>
                    </td>
                    <td>
                      <Text size="xs" color="dimmed">
                        {moment(upload.updatedAt).fromNow()}
                      </Text>
                    </td>
                    <td>
                      <HoverTip label={t("admin.storage.abort")}>
                        <ActionIcon
                          color="red"
                          size="sm"
                          onClick={() => handleAbortUpload(upload.id, upload.name)}
                        >
                          <TbX size={14} />
                        </ActionIcon>
                      </HoverTip>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Box>
        )}
      </Paper>

      {/* Cleanup Failures Table */}
      <Paper withBorder radius="md" p="md">
        <Group position="apart" mb={12}>
          <Title order={4}>
            <FormattedMessage id="admin.storage.cleanupFailures" /> (
            {data.cleanupFailures.length})
          </Title>
          {data.cleanupFailures.length > 0 && (
            <Button
              size="xs"
              variant="outline"
              color="red"
              leftIcon={<TbRefresh size={14} />}
              loading={isRetrying}
              onClick={handleRetryAll}
            >
              <FormattedMessage id="admin.storage.retryAll" />
            </Button>
          )}
        </Group>
        {data.cleanupFailures.length === 0 ? (
          <Text size="sm" color="dimmed">
            <FormattedMessage id="admin.storage.noCleanupFailures" />
          </Text>
        ) : (
          <Box sx={{ overflowX: "auto" }}>
            <Table verticalSpacing="xs">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Action</th>
                  <th>Target ID</th>
                  <th>Error</th>
                  <th>Attempts</th>
                  <th>Last Attempt</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.cleanupFailures.map((failure) => (
                  <tr key={failure.id}>
                    <td>
                      <Badge size="xs" color="orange">
                        {failure.provider}
                      </Badge>
                    </td>
                    <td>
                      <Text size="xs">{failure.action}</Text>
                    </td>
                    <td>
                      <Text size="xs" lineClamp={1} sx={{ maxWidth: 200 }}>
                        {failure.targetId}
                      </Text>
                    </td>
                    <td>
                      <Text size="xs" color="red" lineClamp={1} sx={{ maxWidth: 250 }}>
                        {failure.error || "Unknown error"}
                      </Text>
                    </td>
                    <td>
                      <Text size="xs">{failure.attempts}</Text>
                    </td>
                    <td>
                      <Text size="xs" color="dimmed">
                        {moment(failure.lastAttemptAt).fromNow()}
                      </Text>
                    </td>
                    <td>
                      <Group spacing="xs">
                        <HoverTip label={t("admin.storage.retry")}>
                          <ActionIcon
                            color="blue"
                            size="sm"
                            onClick={() => handleRetryCleanup(failure.id)}
                          >
                            <TbRefresh size={14} />
                          </ActionIcon>
                        </HoverTip>
                        <HoverTip label={t("admin.storage.dismiss")}>
                          <ActionIcon
                            color="gray"
                            size="sm"
                            onClick={() => handleDismissCleanup(failure.id)}
                          >
                            <TbTrash size={14} />
                          </ActionIcon>
                        </HoverTip>
                      </Group>
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Box>
        )}
      </Paper>
    </>
  );
};

export default StorageDashboard;
