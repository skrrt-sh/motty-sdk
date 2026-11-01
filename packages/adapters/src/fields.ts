import type { chatCompletionsIn } from '@mottyjs/serve';

type Fields = NonNullable<Parameters<typeof chatCompletionsIn>[0]['fields']>;

// What each provider takes of the options that only help, each read from its
// own reference on 2026-11-01, one list per provider however many codecs it
// has. An entry says what the option goes out as: `true` under OpenAI's name, or
// the provider's own. An option not listed is one its reference ignores or
// refuses, or is silent on, and is not sent, and the caller is told, since a field
// the docs are silent on is sent only where a provider states it ignores what it
// does not know. OpenAI has no list since it takes them all:
// https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create

// OpenRouter.
// Its documents say its providers ignore what they do not know, so sending the
// three it is silent on is safe, and dropping `cacheRetention` may cost
// cache hits on its OpenAI routes.
// https://openrouter.ai/openapi.json
// https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion
// https://openrouter.ai/docs/api_reference/parameters
// https://openrouter.ai/docs/api_reference/overview
// https://openrouter.ai/docs/guides/routing/provider-selection
// https://openrouter.ai/docs/guides/overview/multimodal/audio
export const openrouterFields: Fields = {
  metadata: true,
  store: true,
  serviceTier: true,
  safetyIdentifier: true,
  cacheKey: true,
  cacheOptions: true,
  cacheRetention: true,
  prediction: true,
  verbosity: true,
  seed: true,
  user: true,
  presencePenalty: true,
  frequencyPenalty: true,
  streamOptions: true,
  maxTokens: true,
};

// Fireworks.
// https://docs.fireworks.ai/api-reference/post-chatcompletions
// https://docs.fireworks.ai/api-reference/post-chatcompletions.md
// https://docs.fireworks.ai/tools-sdks/openai-compatibility
// https://docs.fireworks.ai/guides/prompt-caching.md
// https://docs.fireworks.ai/guides/predicted-outputs.md
// https://docs.fireworks.ai/guides/querying-text-models.md
export const fireworksFields: Fields = {
  metadata: true,
  serviceTier: true,
  cacheKey: true,
  prediction: true,
  seed: true,
  user: true,
  presencePenalty: true,
  frequencyPenalty: true,
  streamOptions: true,
  maxTokens: true,
};

// Mistral.
// Its request is a closed schema, and usage comes unasked, so `streamOptions` is
// the one field the SDK writes that goes unsent here.
// https://docs.mistral.ai/openapi.yaml
// https://docs.mistral.ai/api/endpoint/chat
// https://docs.mistral.ai/studio/conversations/reasoning
// https://docs.mistral.ai/studio/conversations/chat-completion
// https://docs.mistral.ai/studio/conversations/function-calling
// https://docs.mistral.ai/studio/conversations/advanced/predicted-outputs.md
// https://docs.mistral.ai/studio/conversations/advanced/prompt-caching.md
// https://docs.mistral.ai/inference/priority-tier.md
// https://docs.mistral.ai/inference/sampling.md
// https://docs.mistral.ai/resources/migration-guides
// https://docs.mistral.ai/studio/audio/audio-in-chat
export const mistralFields: Fields = {
  metadata: true,
  serviceTier: true,
  cacheKey: true,
  prediction: true,
  seed: 'random_seed',
  presencePenalty: true,
  frequencyPenalty: true,
  maxTokens: 'max_tokens',
};

// Moonshot, for every model of Kimi.
// https://platform.kimi.ai/docs/openapi.json
// https://platform.kimi.ai/docs/api/chat
// https://platform.kimi.ai/docs/api/chat.md
// https://platform.kimi.ai/docs/api/models-overview
// https://platform.kimi.ai/docs/api/overview.md
// https://platform.kimi.ai/docs/api/errors.md
// https://platform.kimi.ai/docs/models.md
// https://platform.kimi.ai/docs/guide/use-thinking-models.md
// https://platform.kimi.ai/docs/guide/kimi-k3-1-pro-quickstart.md
// https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart.md
// https://platform.kimi.ai/docs/guide/troubleshooting.md
// https://platform.kimi.ai/docs/guide/use-kimi-api-to-complete-tool-calls.md
// https://platform.kimi.ai/docs/guide/use-tool-choice.md
export const moonshotFields: Fields = {
  safetyIdentifier: true,
  cacheKey: true,
  cacheOptions: true,
  prediction: true,
  streamOptions: true,
  maxTokens: true,
};

// Groq.
// https://console.groq.com/docs/api-reference
// https://console.groq.com/docs/openai
export const groqFields: Fields = {
  serviceTier: true,
  seed: true,
  user: true,
  streamOptions: true,
  maxTokens: true,
};

// DeepSeek.
// No document equates `user` with its own `user_id`, so it is not sent as that.
// Its reference names only `max_tokens`, so the limit goes by that name.
// https://api-docs.deepseek.com/api/create-chat-completion
// https://api-docs.deepseek.com/guides/thinking_mode
// https://api-docs.deepseek.com/quick_start/rate_limit
// https://api-docs.deepseek.com/quick_start/error_codes
export const deepseekFields: Fields = {
  streamOptions: true,
  maxTokens: 'max_tokens',
};

// MiniMax.
// https://platform.minimax.io/docs/api-reference/text-chat-openai.md
// https://platform.minimax.io/docs/api-reference/text-openai-api
// https://platform.minimax.io/docs/api-reference/text-post.md
// https://platform.minimax.io/docs/api-reference/errorcode.md
export const minimaxFields: Fields = {
  serviceTier: true,
  streamOptions: true,
  maxTokens: true,
};

// Z.ai.
// Usage is what a spend limit counts and its reference is silent on the field, so
// `streamOptions` stays. `user_id` is not `user`: it takes 6 to 128 characters, so
// a short user sent under it would turn a call into a 400.
// https://docs.z.ai/openapi.json
// https://docs.z.ai/api-reference/llm/chat-completion
// https://docs.z.ai/api-reference/llm/chat-completion.md
// https://docs.z.ai/guides/overview/concept-param.md
// https://docs.z.ai/guides/overview/migrate-to-glm-new.md
// https://docs.z.ai/api-reference/api-code.md
// https://docs.z.ai/guides/capabilities/cache.md
// https://docs.z.ai/guides/capabilities/struct-output.md
// https://docs.z.ai/guides/capabilities/thinking.md
// https://docs.z.ai/guides/capabilities/thinking-mode.md
// https://docs.z.ai/guides/capabilities/streaming.md
// https://docs.z.ai/guides/capabilities/stream-tool.md
// https://docs.z.ai/guides/llm/glm-5.3.md
// https://docs.z.ai/guides/llm/glm-5.2.md
// https://docs.z.ai/guides/vlm/glm-5.3-flash.md
// https://docs.z.ai/guides/develop/openai/python.md
export const zaiFields: Fields = {
  streamOptions: true,
  maxTokens: 'max_tokens',
};

// Together, for every family of model.
// Usage is what a spend limit counts and its reference is silent on the field, so
// `streamOptions` stays. Its reference names only `max_tokens` for the limit.
// https://docs.together.ai/openapi.yaml
// https://docs.together.ai/reference/chat-completions-1
// https://docs.together.ai/docs/inference/openai-compatibility
// https://docs.together.ai/docs/inference/chat/parameters.md
// https://docs.together.ai/docs/inference/chat/prompt-caching.md
// https://docs.together.ai/docs/inference/chat/logprobs.md
// https://docs.together.ai/docs/inference/function-calling/parallel.md
export const togetherFields: Fields = {
  cacheKey: true,
  seed: true,
  presencePenalty: true,
  frequencyPenalty: true,
  streamOptions: true,
  maxTokens: 'max_tokens',
};

// DashScope.
// https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions
// https://www.alibabacloud.com/help/en/model-studio/role-play
// https://www.alibabacloud.com/help/en/model-studio/context-cache
// https://www.alibabacloud.com/help/en/model-studio/error-code
export const dashscopeFields: Fields = {
  seed: true,
  presencePenalty: true,
  streamOptions: true,
  maxTokens: true,
};

// Ollama.
// Its documents name only `max_tokens` for the limit.
// https://docs.ollama.com/api/openai-compatibility
// https://raw.githubusercontent.com/ollama/ollama/main/openai/openai.go
// https://raw.githubusercontent.com/ollama/ollama/main/middleware/openai.go
export const ollamaFields: Fields = {
  seed: true,
  presencePenalty: true,
  frequencyPenalty: true,
  streamOptions: true,
  maxTokens: 'max_tokens',
};

// A server the host runs itself, whose own list is the host's to state. Until
// it does, it is sent what such servers share and not what only OpenAI has.
export const localFields: Fields = {
  seed: true,
  user: true,
  presencePenalty: true,
  frequencyPenalty: true,
  streamOptions: true,
  maxTokens: true,
};
