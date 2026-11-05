import api from "./api.service";

export interface AgentTokenItem {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export interface CreatedAgentToken extends AgentTokenItem {
  token: string;
}

const list = async (): Promise<AgentTokenItem[]> => {
  const response = await api.get("agent-tokens");
  return response.data;
};

const create = async (
  name: string,
  expiresAt?: string,
): Promise<CreatedAgentToken> => {
  const response = await api.post("agent-tokens", { name, expiresAt });
  return response.data;
};

const revoke = async (id: string): Promise<void> => {
  await api.delete(`agent-tokens/${id}`);
};

export default {
  list,
  create,
  revoke,
};
