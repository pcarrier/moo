import { truncate } from "../lib";

// Compact when the next prompt would consume more than half the model's
// context window by default. Text token count is a chars-÷-4 estimate;
// calibration tuned to English-with-code prose. Image parts are different:
// providers charge by pixels/tiles, not by data-URL byte length.
const FALLBACK_IMAGE_ATTACHMENT_TOKENS = 1_024;
const IMAGE_ATTACHMENT_LOW_DETAIL_TOKENS = 85;
const OPENAI_IMAGE_BASE_TOKENS = 85;
const OPENAI_IMAGE_TILE_TOKENS = 170;
const OPENAI_IMAGE_TILE_SIZE = 512;
const OPENAI_IMAGE_MAX_SIDE = 2_048;
const OPENAI_IMAGE_SHORT_SIDE = 768;
const ANTHROPIC_IMAGE_PIXELS_PER_TOKEN = 750;
const MAX_IMAGE_DIMENSION_FOR_ESTIMATE = 100_000;

type ImageDimensions = { width: number; height: number };

function isImageContentPart(value: any): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return (
    value.type === "image_url" ||
    value.type === "input_image" ||
    value.type === "image" ||
    value.image_url != null ||
    value.source?.type === "base64"
  );
}

function positiveImageDimension(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_IMAGE_DIMENSION_FOR_ESTIMATE, Math.max(1, Math.floor(n)));
}

function imagePartDimensions(value: any): ImageDimensions | null {
  const width = positiveImageDimension(
    value?.width ?? value?.image_url?.width ?? value?.source?.width,
  );
  const height = positiveImageDimension(
    value?.height ?? value?.image_url?.height ?? value?.source?.height,
  );
  return width && height ? { width, height } : null;
}

function imagePartDetail(value: any): string | null {
  const detail = value?.detail ?? value?.image_url?.detail;
  return typeof detail === "string" ? detail.toLowerCase() : null;
}

function scaleImageToFit(
  dims: ImageDimensions,
  maxSide: number,
): ImageDimensions {
  const side = Math.max(dims.width, dims.height);
  if (side <= maxSide) return dims;
  const scale = maxSide / side;
  return {
    width: Math.max(1, Math.floor(dims.width * scale)),
    height: Math.max(1, Math.floor(dims.height * scale)),
  };
}

function openAIHighDetailImageTokens(dims: ImageDimensions): number {
  let scaled = scaleImageToFit(dims, OPENAI_IMAGE_MAX_SIDE);
  const shortSide = Math.min(scaled.width, scaled.height);
  if (shortSide > OPENAI_IMAGE_SHORT_SIDE) {
    const scale = OPENAI_IMAGE_SHORT_SIDE / shortSide;
    scaled = {
      width: Math.max(1, Math.floor(scaled.width * scale)),
      height: Math.max(1, Math.floor(scaled.height * scale)),
    };
  }
  const tiles =
    Math.ceil(scaled.width / OPENAI_IMAGE_TILE_SIZE) *
    Math.ceil(scaled.height / OPENAI_IMAGE_TILE_SIZE);
  return OPENAI_IMAGE_BASE_TOKENS + OPENAI_IMAGE_TILE_TOKENS * tiles;
}

function anthropicImageTokens(dims: ImageDimensions): number {
  return Math.ceil((dims.width * dims.height) / ANTHROPIC_IMAGE_PIXELS_PER_TOKEN);
}

export function estimateImageAttachmentTokens(value: any): number {
  if (imagePartDetail(value) === "low") return IMAGE_ATTACHMENT_LOW_DETAIL_TOKENS;
  const dims = imagePartDimensions(value);
  if (!dims) return FALLBACK_IMAGE_ATTACHMENT_TOKENS;
  return Math.max(
    IMAGE_ATTACHMENT_LOW_DETAIL_TOKENS,
    openAIHighDetailImageTokens(dims),
    anthropicImageTokens(dims),
  );
}

function estimateTokenChars(value: any): number {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "boolean") return String(value).length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + estimateTokenChars(item), 0);
  if (isImageContentPart(value)) return estimateImageAttachmentTokens(value) * 4;
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
}

export function estimateTokens(messages: any[], tools?: any[] | null): number {
  let total = 0;
  for (const m of messages) {
    // Chat providers count more than plain message text: structured content
    // parts, tool-call JSON, tool results, names/ids, roles, and framing all
    // contribute to prompt tokens. Keep this estimate conservative so the live
    // header doesn't bounce between a low chars/4 guess and provider usage.
    total += 16; // per-message framing
    total += estimateTokenChars(m?.role);
    total += estimateTokenChars(m?.name);
    total += estimateTokenChars(m?.tool_call_id);
    total += estimateTokenChars(m?.content);
    total += estimateTokenChars(m?.tool_calls);
  }
  if (Array.isArray(tools) && tools.length) {
    total += 32; // request/tool-list framing
    total += estimateTokenChars(tools);
  }
  return Math.ceil(total / 4);
}
const COMPACTION_TRUNCATION_NOTE =
  "Compaction note: oversized transcript entries were truncated or, if necessary, older entries were omitted to fit the model context. Preserve uncertainty when details are missing.";

export function compactionRequestTokenLimit(budget: number, threshold?: number | null): number {
  const b = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : 0;
  const t = Number.isFinite(Number(threshold)) && Number(threshold) > 0
    ? Math.floor(Number(threshold))
    : (b ? Math.floor(b * 0.5) : 0);
  const fallback = b ? Math.max(1_000, Math.floor(b * 0.2)) : 64_000;
  const thresholdShare = t ? Math.max(1_000, Math.floor(t * 0.4)) : fallback;
  // Keep compaction requests well below advertised context windows. Providers
  // often reserve context for hidden reasoning/output or route nominally-long
  // models through smaller request limits, and a summary call does not need to
  // re-read hundreds of thousands of tokens in one shot.
  const hardCap = 160_000;
  const target = Math.min(fallback, thresholdShare, hardCap);
  return Math.max(1_000, target);
}

function basicContentText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => typeof part?.text === "string" ? part.text : "").filter(Boolean).join("\n");
  return content == null ? "" : String(content);
}

function compactionTextContent(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (part?.type === "text" && typeof part.text === "string") {
        if (part.text.trim()) parts.push(part.text);
        continue;
      }
      if (part?.type === "image_url" || part?.type === "input_image" || part?.image_url) {
        parts.push("[image attachment omitted from compaction request]");
        continue;
      }
      const text = basicContentText(part).trim();
      if (text) parts.push(text);
    }
    return parts.join("\n");
  }
  return content == null ? "" : String(content);
}

function sanitizeCompactionMessage(message: any): any {
  if (!message || typeof message !== "object") return message;
  return { ...message, content: compactionTextContent(message.content) };
}

function truncateCompactionContent(content: any, limit: number): any {
  const text = compactionTextContent(content);
  if (text.length <= limit) return text;
  return truncate(text, limit);
}

function noteCompactionMessages(messages: any[], extra = ""): any[] {
  if (!messages.length) return messages;
  const note = extra ? `${COMPACTION_TRUNCATION_NOTE} ${extra}` : COMPACTION_TRUNCATION_NOTE;
  if (messages.some((m) => m?.role === "system" && m?.content === note)) return messages;
  return [messages[0], { role: "system", content: note }, ...messages.slice(1)];
}

export function fitCompactionSummaryMessages(messages: any[], maxTokens: number): any[] {
  const list = Array.isArray(messages) ? messages.map(sanitizeCompactionMessage) : [];
  const limit = Math.floor(Number(maxTokens) || 0);
  if (!list.length || limit <= 0 || estimateTokens(list) <= limit) return list;

  const first = list[0];
  const last = list.length > 1 ? list[list.length - 1] : null;
  const middle = last ? list.slice(1, -1) : list.slice(1);
  for (const charLimit of [24_000, 12_000, 6_000, 3_000, 1_000]) {
    const fitted = [
      first,
      ...middle.map((m) => ({ ...m, content: truncateCompactionContent(m?.content, charLimit) })),
      ...(last ? [last] : []),
    ];
    const noted = noteCompactionMessages(fitted);
    if (estimateTokens(noted) <= limit) return noted;
  }

  const noteMsg = { role: "system", content: COMPACTION_TRUNCATION_NOTE };
  const tinyMiddle = middle.map((m) => ({ ...m, content: truncateCompactionContent(m?.content, 600) }));
  let kept: any[] = [];
  let omitted = 0;
  for (let i = tinyMiddle.length - 1; i >= 0; i -= 1) {
    const candidateMiddle = [tinyMiddle[i], ...kept];
    const candidate = [first, noteMsg, ...candidateMiddle, ...(last ? [last] : [])];
    if (estimateTokens(candidate) <= limit) kept = candidateMiddle;
    else omitted += 1;
  }
  const extra = omitted > 0 ? `Omitted ${omitted} older transcript ${omitted === 1 ? "entry" : "entries"}.` : "";
  return [
    first,
    { role: "system", content: extra ? `${COMPACTION_TRUNCATION_NOTE} ${extra}` : COMPACTION_TRUNCATION_NOTE },
    ...kept,
    ...(last ? [last] : []),
  ];
}
