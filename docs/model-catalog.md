# Model catalog

Reviewed **2026-09-16**. The catalog in `harness/src/llm_models.ts` covers the seven supported providers: OpenAI, Anthropic, Qwen, Z.AI/GLM, xAI, DeepSeek, and Kimi. It records model IDs, aliases, context/output limits, tool and image support, availability, and USD prices per million tokens. The picker includes models usable with Moo's tool-calling interface; restricted, retired, and incompatible models retain metadata where useful for existing chats and cost estimates.

## Pricing conventions

- Prices are standard direct API rates for each provider's configured default endpoint. Qwen uses **International/Singapore** rates and implicit cache reads. Other regions, reseller endpoints, negotiated discounts, taxes, batch/Flex processing, and provider-hosted tool charges require separate accounting or `MOO_LLM_PRICING` overrides.
- Regular input, cache reads, cache writes, and output are additive. Anthropic cache writes use the five-minute TTL used by Moo. An omitted cache-read rate means unavailable or unpublished; if such usage is reported, the UI marks the estimate incomplete while retaining the known subtotal.
- OpenAI Fast mode has explicit rates rather than a universal multiplier. GPT-6 Astra and GPT-5.6 support published long-context Fast rates. GPT-5.5 and GPT-5.4 only publish short-context Fast rates. Models without published Fast rates do not offer that picker option. Fast billing follows the requested service tier; an API-side downgrade may differ from the estimate.
- OpenAI long-context rates apply above 272,000 input tokens. xAI long-context rates apply at or above 200,000 input tokens. Qwen tiers use decimal K (1,000); the applicable rate covers all tokens in that request, including output. The usage store retains the selected tier instead of pricing a chat's accumulated tokens as one request.
- DeepSeek peak hours are Monday–Friday, **01:00–04:00 and 06:00–10:00 UTC**; other hours use the published off-peak rates. Moo chooses the tier when usage is recorded. Requests crossing a billing boundary may differ from the provider invoice.
- Qwen Plus and Turbo have different output rates with thinking enabled; usage retains that mode. Temporary Qwen promotions are excluded. GPT-5.6 Sol's published promotional rates, valid through at least November 21, 2026, are included.
- Subscription access (OpenAI OAuth/Codex, Kimi Code) is not a per-token invoice. API-equivalent rates, when known, are estimates of usage value. Kimi Code's subscription-only model remains explicitly unpriced.
- Existing usage is not rewritten. Older chats without context, thinking, Fast, or time-of-day distinctions cannot recover those distinctions retroactively. Prices are a current catalog snapshot, not a historical invoice ledger.
- Unknown model families do not inherit a nearby model's rate. Exact aliases and documented versioned IDs resolve through catalog metadata. `MOO_LLM_PRICING` still accepts custom substring overrides.

## Primary sources

| Provider | Catalog and capabilities | Pricing and billing details |
| --- | --- | --- |
| OpenAI | [Model catalog](https://developers.openai.com/api/docs/models/all), individual model pages linked there, [Fast mode](https://developers.openai.com/api/docs/guides/fast-mode) | [API pricing](https://developers.openai.com/api/docs/pricing) |
| Anthropic | [Models overview](https://platform.claude.com/docs/en/models/overview), [Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/overview), [effort](https://platform.claude.com/docs/en/build-with-claude/effort) | [Claude pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Qwen | [Model list](https://www.alibabacloud.com/help/en/model-studio/models), [Qwen 3.8 Max](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max), [3.8 Flash](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-flash), [3.8 2.4T](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-2-4t-a95b), [3.8 27B](https://www.alibabacloud.com/help/en/model-studio/qwen3-8-27b) | [Model pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing), [context caching](https://www.alibabacloud.com/help/en/model-studio/context-cache); individual 3.8 pages supply newer rates absent from the overview |
| Z.AI / GLM | [GLM 5.3](https://docs.z.ai/guides/llm/glm-5.3), [5.3 Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash), [4.6V](https://docs.z.ai/guides/vlm/glm-4.6v) | [Pricing](https://docs.z.ai/guides/overview/pricing) |
| xAI | [Grok 4.6](https://docs.x.ai/developers/models/grok-4.6), [retired-model redirects](https://docs.x.ai/developers/migration/may-15-retirement), [reasoning](https://docs.x.ai/developers/model-capabilities/text/reasoning) | [Pricing](https://docs.x.ai/developers/pricing) |
| DeepSeek | [Models, limits, aliases, and pricing](https://api-docs.deepseek.com/quick_start/pricing/) | Same source includes the peak/off-peak schedule and cache rates |
| Kimi | [Kimi K3](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart), [Kimi K2.7 Code](https://platform.kimi.ai/docs/guide/kimi-k2-7-code-quickstart) | [Model pricing](https://platform.kimi.ai/docs/pricing/chat) |

Qwen 3 VL metadata follows the [Plus](https://www.alibabacloud.com/help/en/model-studio/qwen3-vl-plus) and [Flash](https://www.alibabacloud.com/help/en/model-studio/qwen3-vl-flash) pages: tool calling is unavailable on the default International endpoint, so these models are not offered in Moo's picker.

Retired xAI names now resolve to the documented replacement prices (Grok 4.3 or Grok Build 0.1). Legacy DeepSeek Chat/Reasoner IDs remain recognizable but unpriced because the current tariff does not list them. Anthropic's retired Opus 4, Opus 4.1, and Sonnet 4 are excluded from default choices. Restricted Daybreak and Glasswing models retain prices and availability notes without appearing by default.

## Updating

Check each provider's current model list, individual model pages, and pricing page together. Keep endpoint/region, alias routing, reasoning controls, context limits, and cache prices aligned. Add regression coverage for new billing boundaries or request parameters in `harness/tests/model_catalog.test.ts`. Do not invent a cache rate or a blanket price for an unknown model family.
