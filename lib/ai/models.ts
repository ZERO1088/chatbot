export const DEFAULT_CHAT_MODEL = "deepseek/deepseek-v3.2";

/**
 * Bounded wait for the Gateway metadata endpoints. They are a nice-to-have
 * (live capabilities, endpoint health); a slow or unreachable Gateway must not
 * stall a chat request, so the curated capabilities below are used instead.
 */
const GATEWAY_LOOKUP_TIMEOUT_MS = 2500;

export const titleModel = {
  description: "Fast model for title generation",
  gatewayOrder: ["fireworks", "bedrock"],
  id: "moonshotai/kimi-k2.5",
  name: "Kimi K2.5",
  provider: "moonshotai",
};

export type ModelCapabilities = {
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
};

export type ChatModel = {
  id: string;
  name: string;
  provider: string;
  description: string;
  gatewayOrder?: string[];
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
  /**
   * Declared capabilities, used when the Gateway metadata lookup fails or has
   * no endpoints for the model. Without this a chat request would silently run
   * with tools and reasoning disabled whenever the Gateway is unreachable.
   */
  capabilities?: ModelCapabilities;
  /**
   * DeepSeek's own model name. Set only on models that DeepSeek's API can serve
   * directly (see `lib/ai/providers.ts`); the Gateway id is not a valid name
   * there.
   */
  deepseekApiId?: string;
};

export const chatModels: ChatModel[] = [
  {
    capabilities: { reasoning: true, tools: true, vision: false },
    deepseekApiId: "deepseek-chat",
    description: "Fast and capable model with tool use",
    gatewayOrder: ["bedrock", "deepinfra"],
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek V3.2",
    provider: "deepseek",
  },
  {
    // DeepSeek does not guarantee function calling for its thinking model, and a
    // rejected tool schema fails the whole turn, so tools stay off for it unless
    // the Gateway metadata (which wins when reachable) reports support. Flip
    // `tools` to true if your account handles tool calls in thinking mode.
    capabilities: { reasoning: true, tools: false, vision: false },
    deepseekApiId: "deepseek-reasoner",
    description: "DeepSeek thinking mode, shows its reasoning",
    id: "deepseek/deepseek-reasoner",
    name: "DeepSeek Reasoner",
    provider: "deepseek",
  },
  {
    capabilities: { reasoning: false, tools: true, vision: false },
    deepseekApiId: "deepseek-chat",
    description: "DeepSeek non-thinking mode, fastest replies",
    id: "deepseek/deepseek-chat",
    name: "DeepSeek Chat",
    provider: "deepseek",
  },
  {
    capabilities: { reasoning: false, tools: true, vision: false },
    description: "Moonshot AI flagship model",
    gatewayOrder: ["fireworks", "bedrock"],
    id: "moonshotai/kimi-k2.5",
    name: "Kimi K2.5",
    provider: "moonshotai",
  },
  {
    capabilities: { reasoning: true, tools: true, vision: false },
    description: "Compact reasoning model",
    gatewayOrder: ["groq", "bedrock"],
    id: "openai/gpt-oss-20b",
    name: "GPT OSS 20B",
    provider: "openai",
    reasoningEffort: "low",
  },
  {
    capabilities: { reasoning: true, tools: true, vision: false },
    description: "Open-source 120B parameter model",
    gatewayOrder: ["fireworks", "bedrock"],
    id: "openai/gpt-oss-120b",
    name: "GPT OSS 120B",
    provider: "openai",
    reasoningEffort: "low",
  },
  {
    capabilities: { reasoning: false, tools: true, vision: false },
    description: "Fast non-reasoning model with tool use",
    gatewayOrder: ["xai"],
    id: "xai/grok-4.1-fast-non-reasoning",
    name: "Grok 4.1 Fast",
    provider: "xai",
  },
];

const NO_CAPABILITIES: ModelCapabilities = {
  reasoning: false,
  tools: false,
  vision: false,
};

function getDeclaredCapabilities(model: ChatModel): ModelCapabilities {
  return model.capabilities ?? NO_CAPABILITIES;
}

export async function getCapabilities(): Promise<
  Record<string, ModelCapabilities>
> {
  const results = await Promise.all(
    chatModels.map(async (model) => {
      const fallback = getDeclaredCapabilities(model);

      try {
        const res = await fetch(
          `https://ai-gateway.vercel.sh/v1/models/${model.id}/endpoints`,
          {
            next: { revalidate: 86_400 },
            signal: AbortSignal.timeout(GATEWAY_LOOKUP_TIMEOUT_MS),
          }
        );
        if (!res.ok) {
          return [model.id, fallback];
        }

        const json = await res.json();
        const endpoints = json.data?.endpoints ?? [];

        // The Gateway does not know this model (or has no endpoint for it):
        // keep the curated answer rather than reporting "no capabilities".
        if (endpoints.length === 0) {
          return [model.id, fallback];
        }

        const params = new Set(
          endpoints.flatMap(
            (e: { supported_parameters?: string[] }) =>
              e.supported_parameters ?? []
          )
        );
        const inputModalities = new Set(
          json.data?.architecture?.input_modalities ?? []
        );

        return [
          model.id,
          {
            reasoning: params.has("reasoning"),
            tools: params.has("tools"),
            vision: inputModalities.has("image"),
          },
        ];
      } catch {
        return [model.id, fallback];
      }
    })
  );

  return Object.fromEntries(results);
}

export const isDemo = process.env.IS_DEMO === "1";

type GatewayModel = {
  id: string;
  name: string;
  type?: string;
  tags?: string[];
};

export type GatewayModelWithCapabilities = ChatModel & {
  capabilities: ModelCapabilities;
};

export async function getAllGatewayModels(): Promise<
  GatewayModelWithCapabilities[]
> {
  try {
    const res = await fetch("https://ai-gateway.vercel.sh/v1/models", {
      next: { revalidate: 86_400 },
    });
    if (!res.ok) {
      return [];
    }

    const json = await res.json();
    return (json.data ?? [])
      .filter((m: GatewayModel) => m.type === "language")
      .map((m: GatewayModel) => ({
        capabilities: {
          reasoning: m.tags?.includes("reasoning") ?? false,
          tools: m.tags?.includes("tool-use") ?? false,
          vision: m.tags?.includes("vision") ?? false,
        },
        description: "",
        id: m.id,
        name: m.name,
        provider: m.id.split("/")[0],
      }));
  } catch {
    return [];
  }
}

export function getActiveModels(): ChatModel[] {
  return chatModels;
}

export const allowedModelIds = new Set(chatModels.map((m) => m.id));

export const modelsByProvider = chatModels.reduce(
  (acc, model) => {
    if (!acc[model.provider]) {
      acc[model.provider] = [];
    }
    acc[model.provider].push(model);
    return acc;
  },
  {} as Record<string, ChatModel[]>
);

export type ModelAvailability = "healthy" | "impacted" | "unknown";

type GatewayEndpoint = {
  provider_name?: string;
  status?: number;
  uptime_last_15m?: number;
  uptime_last_1h?: number;
  latency_last_1h?: {
    p50?: number;
    p95?: number;
  };
};

const PROVIDER_IMPACTED_UPTIME_THRESHOLD = 99;
const PROVIDER_IMPACTED_P50_MS = 10_000;
const PROVIDER_IMPACTED_P95_MS = 30_000;

function isEndpointImpacted(endpoint: GatewayEndpoint) {
  return (
    (endpoint.status !== undefined && endpoint.status !== 0) ||
    (endpoint.uptime_last_15m !== undefined &&
      endpoint.uptime_last_15m < PROVIDER_IMPACTED_UPTIME_THRESHOLD) ||
    (endpoint.uptime_last_1h !== undefined &&
      endpoint.uptime_last_1h < PROVIDER_IMPACTED_UPTIME_THRESHOLD) ||
    (endpoint.latency_last_1h?.p50 !== undefined &&
      endpoint.latency_last_1h.p50 > PROVIDER_IMPACTED_P50_MS) ||
    (endpoint.latency_last_1h?.p95 !== undefined &&
      endpoint.latency_last_1h.p95 > PROVIDER_IMPACTED_P95_MS)
  );
}

export async function getModelAvailability(
  modelId: string
): Promise<ModelAvailability> {
  const model = chatModels.find((item) => item.id === modelId);

  if (!model) {
    return "unknown";
  }

  try {
    const res = await fetch(
      `https://ai-gateway.vercel.sh/v1/models/${model.id}/endpoints`,
      {
        next: { revalidate: 60 },
        signal: AbortSignal.timeout(GATEWAY_LOOKUP_TIMEOUT_MS),
      }
    );
    if (!res.ok) {
      return "unknown";
    }

    const json = await res.json();
    const endpoints = (json.data?.endpoints ?? []) as GatewayEndpoint[];

    if (endpoints.length === 0) {
      return "unknown";
    }

    return endpoints.some(isEndpointImpacted) ? "impacted" : "healthy";
  } catch {
    return "unknown";
  }
}
