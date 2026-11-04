import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Code,
  CopyButton,
  Group,
  Modal,
  Paper,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core";
import { useModals } from "@mantine/modals";
import moment from "moment";
import { useEffect, useState } from "react";
import {
  TbCheck,
  TbCopy,
  TbKey,
  TbPlus,
  TbRobot,
  TbTrash,
} from "react-icons/tb";
import agentTokenService, {
  AgentTokenItem,
} from "../../services/agentToken.service";
import toast from "../../utils/toast.util";

export const AgentTokensCard = () => {
  const [tokens, setTokens] = useState<AgentTokenItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [tokenName, setTokenName] = useState("");
  const [tokenExpiresAt, setTokenExpiresAt] = useState("");
  const [revealedToken, setRevealedToken] = useState<string | null>(null);

  const modals = useModals();

  const fetchTokens = async () => {
    setLoading(true);
    try {
      const data = await agentTokenService.list();
      setTokens(data);
    } catch (e: any) {
      toast.axiosError(e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTokens();
  }, []);

  const handleCreate = async () => {
    if (!tokenName.trim()) return;
    try {
      const created = await agentTokenService.create(
        tokenName.trim(),
        tokenExpiresAt.trim()
          ? new Date(tokenExpiresAt).toISOString()
          : undefined,
      );
      toast.success("Agent token created");
      setRevealedToken(created.token);
      setTokenName("");
      setTokenExpiresAt("");
      setCreateModalOpen(false);
      fetchTokens();
    } catch (e: any) {
      toast.axiosError(e);
    }
  };

  const handleRevoke = (id: string, name: string) => {
    modals.openConfirmModal({
      title: "Revoke Agent Token",
      children: (
        <Text size="sm">
          Are you sure you want to revoke the agent token <b>{name}</b>? Any AI
          agent or script using this token will immediately lose access.
        </Text>
      ),
      labels: { confirm: "Revoke", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await agentTokenService.revoke(id);
          toast.success("Token revoked");
          fetchTokens();
        } catch (e: any) {
          toast.axiosError(e);
        }
      },
    });
  };

  const mcpEndpointUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/api/mcp`
      : "/api/mcp";

  return (
    <Paper withBorder p="xl" mt="lg">
      <Group position="apart" mb="xs">
        <Group spacing="xs">
          <TbRobot size={22} />
          <Title order={5}>AI Agent Tokens (MCP)</Title>
        </Group>
        <Button
          leftIcon={<TbPlus size={16} />}
          size="xs"
          onClick={() => setCreateModalOpen(true)}
        >
          Create Token
        </Button>
      </Group>

      <Text size="sm" color="dimmed" mb="md">
        Dedicated revocable tokens for AI agents (Claude Desktop, Cursor, MCP
        clients) to upload files and generate public share links.
      </Text>

      <Paper
        p="sm"
        withBorder
        mb="md"
        sx={(theme) => ({
          backgroundColor:
            theme.colorScheme === "dark"
              ? theme.colors.dark[6]
              : theme.colors.gray[0],
        })}
      >
        <Group position="apart">
          <Stack spacing={2}>
            <Text size="xs" color="dimmed" weight={500}>
              REMOTE MCP ENDPOINT (Streamable HTTP):
            </Text>
            <Code sx={{ fontSize: 13 }}>{mcpEndpointUrl}</Code>
          </Stack>
          <CopyButton value={mcpEndpointUrl}>
            {({ copied, copy }) => (
              <Tooltip label={copied ? "Copied" : "Copy endpoint URL"}>
                <ActionIcon
                  color={copied ? "teal" : "gray"}
                  onClick={copy}
                  variant="subtle"
                >
                  {copied ? <TbCheck size={16} /> : <TbCopy size={16} />}
                </ActionIcon>
              </Tooltip>
            )}
          </CopyButton>
        </Group>
      </Paper>

      {tokens.length === 0 ? (
        <Text size="sm" color="dimmed" align="center" py="md">
          No agent tokens created yet.
        </Text>
      ) : (
        <Table verticalSpacing="xs">
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Created</th>
              <th>Expires</th>
              <th>Last Used</th>
              <th style={{ width: 60 }}>Action</th>
            </tr>
          </thead>
          <tbody>
            {tokens.map((tok) => (
              <tr key={tok.id}>
                <td>
                  <Group spacing="xs">
                    <TbKey size={14} />
                    <Text size="sm" weight={500}>
                      {tok.name}
                    </Text>
                  </Group>
                </td>
                <td>
                  <Code>{tok.tokenPrefix}</Code>
                </td>
                <td>
                  <Text size="xs" color="dimmed">
                    {moment(tok.createdAt).format("MMM D, YYYY")}
                  </Text>
                </td>
                <td>
                  {tok.expiresAt ? (
                    <Badge
                      color={moment(tok.expiresAt).isBefore() ? "red" : "gray"}
                      size="xs"
                    >
                      {moment(tok.expiresAt).format("MMM D, YYYY")}
                    </Badge>
                  ) : (
                    <Text size="xs" color="dimmed">
                      Never
                    </Text>
                  )}
                </td>
                <td>
                  <Text size="xs" color="dimmed">
                    {tok.lastUsedAt
                      ? moment(tok.lastUsedAt).fromNow()
                      : "Never"}
                  </Text>
                </td>
                <td>
                  <ActionIcon
                    color="red"
                    variant="subtle"
                    size="sm"
                    onClick={() => handleRevoke(tok.id, tok.name)}
                    title="Revoke token"
                  >
                    <TbTrash size={16} />
                  </ActionIcon>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      {/* Modal: Create Token */}
      <Modal
        opened={createModalOpen}
        onClose={() => setCreateModalOpen(false)}
        title="Create AI Agent Token"
      >
        <Stack spacing="md">
          <TextInput
            label="Token Name"
            placeholder="e.g. Claude Desktop, Cursor, CI Agent"
            required
            value={tokenName}
            onChange={(e) => setTokenName(e.currentTarget.value)}
          />
          <TextInput
            label="Optional Expiry Date"
            placeholder="YYYY-MM-DD"
            type="date"
            value={tokenExpiresAt}
            onChange={(e) => setTokenExpiresAt(e.currentTarget.value)}
          />
          <Group position="right" mt="sm">
            <Button variant="default" onClick={() => setCreateModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleCreate} disabled={!tokenName.trim()}>
              Generate Token
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Modal: One-time token display */}
      <Modal
        opened={!!revealedToken}
        onClose={() => setRevealedToken(null)}
        title="Agent Token Created"
        closeOnClickOutside={false}
      >
        <Stack spacing="md">
          <Alert color="yellow" title="Important Security Notice">
            Make sure to copy your agent token now. You will not be able to view
            it again!
          </Alert>

          <Paper
            p="sm"
            withBorder
            sx={(theme) => ({
              backgroundColor:
                theme.colorScheme === "dark"
                  ? theme.colors.dark[7]
                  : theme.colors.gray[1],
              wordBreak: "break-all",
            })}
          >
            <Code sx={{ fontSize: 13 }}>{revealedToken}</Code>
          </Paper>

          <Group position="apart">
            <CopyButton value={revealedToken || ""}>
              {({ copied, copy }) => (
                <Button
                  leftIcon={
                    copied ? <TbCheck size={16} /> : <TbCopy size={16} />
                  }
                  color={copied ? "teal" : "blue"}
                  onClick={copy}
                >
                  {copied ? "Copied Token" : "Copy Token"}
                </Button>
              )}
            </CopyButton>
            <Button variant="default" onClick={() => setRevealedToken(null)}>
              Done
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Paper>
  );
};
export default AgentTokensCard;
