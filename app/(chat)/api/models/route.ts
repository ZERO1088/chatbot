import { getAllGatewayModels, getCapabilities, isDemo } from "@/lib/ai/models";
import { isDeepSeekDirectEnabled } from "@/lib/ai/providers";

export async function GET() {
  const headers = {
    "Cache-Control": "public, max-age=86400, s-maxage=86400",
  };

  const curatedCapabilities = await getCapabilities();
  // Whether DeepSeek is reached through its own API instead of the AI Gateway.
  // Surfaced so the model selector can label those entries.
  const deepseekDirect = isDeepSeekDirectEnabled();

  if (isDemo) {
    const models = await getAllGatewayModels();
    const capabilities = Object.fromEntries(
      models.map((m) => [m.id, curatedCapabilities[m.id] ?? m.capabilities])
    );

    return Response.json({ capabilities, deepseekDirect, models }, { headers });
  }

  return Response.json(
    { capabilities: curatedCapabilities, deepseekDirect },
    { headers }
  );
}
