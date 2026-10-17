import { ClaudeTextGenerator, type ClaudeOptions } from './claude.js';
import { BflImageGenerator, type BflImageOptions } from './bfl.js';
import { ComfyUiImageGenerator, type ComfyUiImageOptions } from './comfyui.js';
import { FalImageGenerator, type FalImageOptions } from './fal.js';
import {
  GeminiImageGenerator,
  GeminiTextGenerator,
  type GeminiOptions,
} from './gemini.js';
import {
  GrokImageGenerator,
  GrokTextGenerator,
  type GrokImageOptions,
  type GrokOptions,
} from './grok.js';
import {
  OpenAiImageGenerator,
  OpenAiTextGenerator,
  type OpenAiImageOptions,
  type OpenAiOptions,
} from './openai.js';
import {
  LlamaCppTextGenerator,
  LmStudioTextGenerator,
  OpenAiCompatibleTextGenerator,
  OpenRouterTextGenerator,
  VllmTextGenerator,
  type LocalServerOptions,
  type OpenAiCompatibleOptions,
  type OpenRouterOptions,
} from './openai-compatible.js';
import { OllamaTextGenerator, type OllamaTextOptions } from './ollama.js';
import type { ImageGenerator, TextGenerator } from './port.js';
import {
  ReplicateImageGenerator,
  type ReplicateImageOptions,
} from './replicate.js';
import { SdWebUiImageGenerator, type SdWebUiOptions } from './sdwebui.js';
import { StabilityImageGenerator, type StabilityOptions } from './stability.js';
import { describeUnknownError, err, ok, type Result } from './result.js';

/**
 * Plain-object settings for each provider: `provider` names it and the
 * rest are that provider's own options, so a settings file or form can
 * become a generator without the app writing the same switch. Keys are
 * passed in, never read from the environment.
 */
export type TextProviderConfig =
  | ({ readonly provider: 'ollama' } & OllamaTextOptions)
  | ({ readonly provider: 'gemini' } & GeminiOptions)
  | ({ readonly provider: 'claude' } & ClaudeOptions)
  | ({ readonly provider: 'openai' } & OpenAiOptions)
  | ({ readonly provider: 'grok' } & GrokOptions)
  | ({ readonly provider: 'openrouter' } & OpenRouterOptions)
  | ({ readonly provider: 'lmstudio' } & LocalServerOptions)
  | ({ readonly provider: 'vllm' } & LocalServerOptions)
  | ({ readonly provider: 'llamacpp' } & LocalServerOptions)
  | ({ readonly provider: 'openai-compatible' } & OpenAiCompatibleOptions & {
        readonly host: string;
      });

export type ImageProviderConfig =
  | ({ readonly provider: 'comfyui' } & ComfyUiImageOptions)
  | ({ readonly provider: 'gemini' } & GeminiOptions)
  | ({ readonly provider: 'openai' } & OpenAiImageOptions)
  | ({ readonly provider: 'grok' } & GrokImageOptions)
  | ({ readonly provider: 'replicate' } & ReplicateImageOptions)
  | ({ readonly provider: 'fal' } & FalImageOptions)
  | ({ readonly provider: 'bfl' } & BflImageOptions)
  | ({ readonly provider: 'stability' } & StabilityOptions)
  | ({ readonly provider: 'sdwebui' } & SdWebUiOptions);

/** The `provider` values createTextGenerator accepts, e.g. for a settings dropdown. */
export const TEXT_PROVIDERS: readonly TextProviderConfig['provider'][] = [
  'ollama',
  'gemini',
  'claude',
  'openai',
  'grok',
  'openrouter',
  'lmstudio',
  'vllm',
  'llamacpp',
  'openai-compatible',
];

/** The `provider` values createImageGenerator accepts. */
export const IMAGE_PROVIDERS: readonly ImageProviderConfig['provider'][] = [
  'comfyui',
  'gemini',
  'openai',
  'grok',
  'replicate',
  'fal',
  'bfl',
  'stability',
  'sdwebui',
];

/** Checks `config` is an object whose `provider` is one of `names`. */
function checkConfig(
  config: unknown,
  names: readonly string[],
  kind: string
): Result<string> {
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return err(
      `The ${kind} provider settings must be an object with a "provider" (${names.join(', ')}).`
    );
  }
  const name: unknown = (config as { provider?: unknown }).provider;
  if (typeof name !== 'string' || !names.includes(name)) {
    return err(
      `Unknown ${kind} provider ${JSON.stringify(name)}; use one of ${names.join(', ')}.`
    );
  }
  return ok(name);
}

/** Builds a text generator from settings; an unknown provider is an error, not an exception. */
export function createTextGenerator(
  config: TextProviderConfig
): Result<TextGenerator> {
  const checked: Result<string> = checkConfig(config, TEXT_PROVIDERS, 'text');
  if (!checked.ok) return checked;
  try {
    switch (config.provider) {
      case 'ollama':
        return ok(new OllamaTextGenerator(config));
      case 'gemini':
        return ok(new GeminiTextGenerator(config));
      case 'claude':
        return ok(new ClaudeTextGenerator(config));
      case 'openai':
        return ok(new OpenAiTextGenerator(config));
      case 'grok':
        return ok(new GrokTextGenerator(config));
      case 'openrouter':
        return ok(new OpenRouterTextGenerator(config));
      case 'lmstudio':
        return ok(new LmStudioTextGenerator(config));
      case 'vllm':
        return ok(new VllmTextGenerator(config));
      case 'llamacpp':
        return ok(new LlamaCppTextGenerator(config));
      case 'openai-compatible':
        return ok(new OpenAiCompatibleTextGenerator(config));
    }
  } catch (cause: unknown) {
    return err(
      `Could not set up the ${checked.value} text provider: ${describeUnknownError(cause)}`,
      cause
    );
  }
}

/** Builds an image generator from settings; an unknown provider is an error, not an exception. */
export function createImageGenerator(
  config: ImageProviderConfig
): Result<ImageGenerator> {
  const checked: Result<string> = checkConfig(config, IMAGE_PROVIDERS, 'image');
  if (!checked.ok) return checked;
  try {
    switch (config.provider) {
      case 'comfyui':
        return ok(new ComfyUiImageGenerator(config));
      case 'gemini':
        return ok(new GeminiImageGenerator(config));
      case 'openai':
        return ok(new OpenAiImageGenerator(config));
      case 'grok':
        return ok(new GrokImageGenerator(config));
      case 'replicate':
        return ok(new ReplicateImageGenerator(config));
      case 'fal':
        return ok(new FalImageGenerator(config));
      case 'bfl':
        return ok(new BflImageGenerator(config));
      case 'stability':
        return ok(new StabilityImageGenerator(config));
      case 'sdwebui':
        return ok(new SdWebUiImageGenerator(config));
    }
  } catch (cause: unknown) {
    return err(
      `Could not set up the ${checked.value} image provider: ${describeUnknownError(cause)}`,
      cause
    );
  }
}

export interface ProvidersConfig {
  readonly text?: TextProviderConfig;
  readonly image?: ImageProviderConfig;
}

export interface Providers {
  /** Null when no text provider was configured. */
  readonly text: TextGenerator | null;
  /** Null when no image provider was configured. */
  readonly image: ImageGenerator | null;
}

/** Builds the configured text and image generators; the first bad setting is the error. */
export function createProviders(config: ProvidersConfig): Result<Providers> {
  let text: TextGenerator | null = null;
  let image: ImageGenerator | null = null;
  if (config.text !== undefined) {
    const built = createTextGenerator(config.text);
    if (!built.ok) return built;
    text = built.value;
  }
  if (config.image !== undefined) {
    const built = createImageGenerator(config.image);
    if (!built.ok) return built;
    image = built.value;
  }
  return ok({ text, image });
}
