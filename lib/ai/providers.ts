import { customProvider, gateway } from "ai";
import { isTestEnvironment } from "../constants";
import { createDeepSeekModel } from "./deepseek-provider";
import { chatModels, titleModel } from "./models";

export const myProvider = isTestEnvironment
  ? (() => {
      const {
        chatModel,
        titleModel: mockTitleModel,
      } = require("./models.mock");
      return customProvider({
        languageModels: {
          "chat-model": chatModel,
          "title-model": mockTitleModel,
        },
      });
    })()
  : null;

/**
 * DeepSeek's OpenAI-compatible endpoint. Override with `DEEPSEEK_BASE_URL` for
 * a proxy or a self-hosted gateway.
 */
const DEEPSEEK_BASE_URL =
  process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com/v1";

/** The official DeepSeek model used for short utility calls (chat titles). */
const DEEPSEEK_TITLE_MODEL_ID = "deepseek-chat";

function getDeepSeekApiKey(): string | undefined {
  const key = process.env.DEEPSEEK_API_KEY?.trim();

  return key && key.length > 0 ? key : undefined;
}

/** True when `DEEPSEEK_API_KEY` is set, i.e. DeepSeek can be called directly. */
export function isDeepSeekDirectEnabled(): boolean {
  return Boolean(getDeepSeekApiKey());
}

/**
 * DeepSeek model ids in the UI are Gateway ids (`deepseek/deepseek-v3.2`); the
 * official API uses different names, so the mapping lives in `models.ts`.
 */
function findDeepSeekApiId(modelId: string): string | undefined {
  return chatModels.find((model) => model.id === modelId)?.deepseekApiId;
}

function directDeepSeekModel(apiKey: string, apiId: string) {
  return createDeepSeekModel({
    apiKey,
    baseURL: DEEPSEEK_BASE_URL,
    modelId: apiId,
  });
}

/**
 * Resolves the model behind a UI model id.
 *
 * Order: the test mock, then the direct DeepSeek API (when
 * `DEEPSEEK_API_KEY` is configured and the model is a DeepSeek one), then the
 * Vercel AI Gateway. Keeping the Gateway as the final fallback means nothing
 * changes for the other providers.
 */
export function getLanguageModel(modelId: string) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel(modelId);
  }

  const apiKey = getDeepSeekApiKey();
  const deepseekApiId = findDeepSeekApiId(modelId);

  if (apiKey && deepseekApiId) {
    return directDeepSeekModel(apiKey, deepseekApiId);
  }

  return gateway.languageModel(modelId);
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }

  // Titles are a tiny, latency-sensitive call. With direct DeepSeek access they
  // run on DeepSeek, so title generation does not depend on Gateway credit.
  const apiKey = getDeepSeekApiKey();

  if (apiKey) {
    return directDeepSeekModel(apiKey, DEEPSEEK_TITLE_MODEL_ID);
  }

  return gateway.languageModel(titleModel.id);
}
