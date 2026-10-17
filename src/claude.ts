import type Anthropic from '@anthropic-ai/sdk';

import {
  DEFAULT_AI_TIMEOUT_MS,
  describeSdkError,
  isAborted,
  loadOptionalPackage,
  toBase64,
} from './http.js';
import { IMAGE_TYPES, checkImageInput } from './images.js';
import type {
  AiImage,
  TextGenerator,
  TextRequest,
  TextResult,
} from './port.js';
import { err, ok, type Result } from './result.js';

/** The optional peer package the Claude provider is built on. */
export const CLAUDE_PACKAGE = '@anthropic-ai/sdk';
export const DEFAULT_CLAUDE_TEXT_MODEL = 'claude-opus-5-5';

/**
 * Models that accept the server-side refusal fallback (`fallbacks:
 * "default"`): if a safety classifier declines, the API re-runs the
 * request on a suitable model in the same call. Others (e.g. Haiku) send
 * no fallback, so a decline comes back as a refusal error.
 */
const FALLBACK_MODELS: ReadonlySet<string> = new Set([
  'claude-fable-5-1',
  'claude-opus-5-5',
  'claude-opus-5',
  'claude-sonnet-5-5',
]);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const CLAUDE_IMAGE_TYPES: ReadonlySet<string> = new Set([
  ...IMAGE_TYPES,
  'image/gif',
]);

/** Short replies only: captions and the like. */
const MAX_TOKENS = 16_000;

export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The SDK module, as `import('@anthropic-ai/sdk')` returns it; inject a fake in tests. */
export type ClaudeModule = typeof import('@anthropic-ai/sdk');
export type ClaudeModuleLoader = () => Promise<ClaudeModule>;

export interface ClaudeOptions {
  /** An Anthropic API key (Claude Console). Passed in, never read from the environment. */
  readonly apiKey: string;
  /** Defaults to DEFAULT_CLAUDE_TEXT_MODEL. */
  readonly model?: string;
  /** output_config.effort; left out, the model's own default applies. */
  readonly effort?: ClaudeEffort;
  /** Re-run a declined request on a fallback model (models that support it). Default true. */
  readonly refusalFallback?: boolean;
  readonly timeoutMs?: number;
  /** Loads the peer package; replace it in tests. */
  readonly loadModule?: ClaudeModuleLoader;
}

const loadClaudePackage: ClaudeModuleLoader = () => import('@anthropic-ai/sdk');

function loadModule(loader: ClaudeModuleLoader): Promise<Result<ClaudeModule>> {
  return loadOptionalPackage(loader, 'Claude', CLAUDE_PACKAGE);
}

function toImageBlock(
  image: AiImage,
  index: number
): Result<Anthropic.Beta.BetaImageBlockParam> {
  const label = `Image ${index + 1}`;
  const checked: Result<AiImage> = checkImageInput(
    image,
    label,
    'Claude',
    CLAUDE_IMAGE_TYPES
  );
  if (!checked.ok) return checked;
  return ok({
    type: 'image',
    source: {
      type: 'base64',
      media_type: image.mimeType as 'image/png',
      data: toBase64(image.data),
    },
  });
}

/**
 * Text from Claude through the Anthropic SDK's Messages API. The
 * request's instructions are the system prompt; images go before the
 * prompt. A refusal (stop_reason "refusal") is an error naming the
 * category, after the server-side fallback, where enabled, also declined.
 */
export class ClaudeTextGenerator implements TextGenerator {
  readonly provider = 'claude';
  readonly model: string;
  // Runtime-private, so the key stays out of JSON, spreads and logs.
  readonly #apiKey: string;
  readonly #effort: ClaudeEffort | undefined;
  readonly #refusalFallback: boolean;
  readonly #timeoutMs: number;
  readonly #loader: ClaudeModuleLoader;

  constructor(options: ClaudeOptions) {
    this.#apiKey = options.apiKey;
    this.model = options.model?.trim() || DEFAULT_CLAUDE_TEXT_MODEL;
    this.#effort = options.effort;
    this.#refusalFallback = options.refusalFallback ?? true;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.#loader = options.loadModule ?? loadClaudePackage;
  }

  async generateText(request: TextRequest): Promise<Result<TextResult>> {
    const what = `Claude (model "${this.model}")`;
    const apiKey: string = this.#apiKey.trim();
    if (apiKey === '') {
      return err(
        'No Anthropic API key is set; create one in the Claude Console and pass it as apiKey.'
      );
    }
    if (isAborted(request.signal)) return err(`${what} was cancelled`);

    const content: Anthropic.Beta.BetaContentBlockParam[] = [];
    for (const [index, image] of (request.images ?? []).entries()) {
      const block = toImageBlock(image, index);
      if (!block.ok) return block;
      content.push(block.value);
    }
    content.push({ type: 'text', text: request.prompt });

    const sdk = await loadModule(this.#loader);
    if (!sdk.ok) return sdk;
    // Credentials come only from apiKey: authToken null stops the SDK
    // picking up ANTHROPIC_AUTH_TOKEN from the environment.
    const client = new sdk.value.default({
      apiKey,
      authToken: null,
      maxRetries: 1,
    });
    const fallback: boolean =
      this.#refusalFallback && FALLBACK_MODELS.has(this.model);
    const instructions: string = request.instructions.trim();

    let message: Anthropic.Beta.BetaMessage;
    try {
      message = await client.beta.messages.create(
        {
          model: this.model,
          max_tokens: MAX_TOKENS,
          ...(instructions !== '' ? { system: instructions } : {}),
          messages: [{ role: 'user', content }],
          ...(this.#effort !== undefined
            ? { output_config: { effort: this.#effort } }
            : {}),
          ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
        },
        { timeout: this.#timeoutMs, signal: request.signal ?? null }
      );
    } catch (cause: unknown) {
      if (isAborted(request.signal)) return err(`${what} was cancelled`);
      if (cause instanceof sdk.value.default.APIConnectionTimeoutError) {
        return err(
          `${what} took longer than ${Math.round(this.#timeoutMs / 1000)} s and was stopped`,
          cause
        );
      }
      return err(
        describeSdkError(
          sdk.value.default,
          what,
          cause,
          'create one in the Claude Console'
        ),
        cause
      );
    }

    if (message.stop_reason === 'refusal') {
      const details = message.stop_details;
      const category =
        details?.type === 'refusal' && details.category !== null
          ? ` (${details.category})`
          : '';
      return err(
        `${what} declined the request${category}${fallback ? ', and so did the fallback model' : ''}.`
      );
    }
    const text: string = message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();
    if (text === '') {
      return err(
        `${what} returned no text (stop reason: ${message.stop_reason ?? 'none'})`
      );
    }
    return ok({ text });
  }
}
