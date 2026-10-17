import { checkProviderHost } from './hosts.js';
import {
  ChatCompletionsTextGenerator,
  type ChatEndpoint,
  type OpenAiModuleLoader,
  type OpenAiOptions,
} from './openai.js';

/**
 * Text from services that speak OpenAI's Chat Completions protocol, through
 * the optional peer package `openai`: OpenRouter (hosted), and local servers
 * (LM Studio, vLLM, llama.cpp server, or any other). Local hosts go through
 * `checkProviderHost` like Ollama's: this machine unless listed in
 * `allowedHosts`.
 */

export const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1';
/** OpenRouter's own router picks a model for the request. */
export const DEFAULT_OPENROUTER_TEXT_MODEL = 'openrouter/auto';
export const DEFAULT_LM_STUDIO_HOST = 'http://127.0.0.1:1234';
export const DEFAULT_VLLM_HOST = 'http://127.0.0.1:8000';
export const DEFAULT_LLAMA_CPP_HOST = 'http://127.0.0.1:8080';
export const DEFAULT_OPENAI_COMPATIBLE_API_PATH = '/v1';

export interface OpenRouterOptions extends OpenAiOptions {
  /** Your app's URL, sent as OpenRouter's HTTP-Referer attribution header. */
  readonly appUrl?: string;
  /** Your app's name, sent as OpenRouter's X-Title attribution header. */
  readonly appName?: string;
}

/**
 * Text from OpenRouter, one key for many models. Defaults to its
 * `openrouter/auto` router; pass `model` (e.g. `anthropic/claude-sonnet-5-5`)
 * to pick one.
 */
export class OpenRouterTextGenerator extends ChatCompletionsTextGenerator {
  constructor(options: OpenRouterOptions) {
    const headers: Record<string, string> = {};
    const appUrl: string | undefined = options.appUrl?.trim();
    const appName: string | undefined = options.appName?.trim();
    if (appUrl !== undefined && appUrl !== '') headers['HTTP-Referer'] = appUrl;
    if (appName !== undefined && appName !== '') headers['X-Title'] = appName;
    super(
      {
        provider: 'openrouter',
        label: 'OpenRouter',
        baseUrl: OPENROUTER_API_URL,
        defaultTextModel: DEFAULT_OPENROUTER_TEXT_MODEL,
        keyHelp: 'create one at openrouter.ai/keys',
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
      options
    );
  }
}

export interface LocalServerOptions {
  /** The model name the server serves (LM Studio shows it; vLLM's `--served-model-name`). */
  readonly model: string;
  /** The server's address as an origin, e.g. http://127.0.0.1:1234. Defaults to the server's usual port. */
  readonly host?: string;
  /** Hosts allowed besides loopback (see parseAllowedHosts). */
  readonly allowedHosts?: readonly string[];
  /** What to call the allow list in messages, e.g. an env variable name. */
  readonly allowedHostsLabel?: string;
  /** Where the API lives on the host. Default `/v1`. */
  readonly apiPath?: string;
  /** Sent as the bearer key when the server was started with one; most local servers take none. */
  readonly apiKey?: string;
  readonly timeoutMs?: number;
  /** Loads the `openai` peer package; replace it in tests. */
  readonly loadModule?: OpenAiModuleLoader;
}

interface LocalServerKind {
  readonly provider: string;
  readonly label: string;
  readonly defaultHost: string;
}

/** `/v1`, `v1/` and `/openai/v1` are fine; anything with a query, dots or odd characters is not. */
function normalizeApiPath(apiPath: string): string | null {
  const trimmed: string = apiPath.trim().replace(/^\/+|\/+$/g, '');
  if (trimmed === '') return '';
  return /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(trimmed)
    ? `/${trimmed}`
    : null;
}

function localEndpoint(
  kind: LocalServerKind,
  options: LocalServerOptions
): ChatEndpoint {
  const base = {
    provider: kind.provider,
    label: kind.label,
    defaultTextModel: '',
    keyHelp: 'set the key your server was started with',
    keyOptional: true,
  } as const;
  const path: string | null = normalizeApiPath(
    options.apiPath ?? DEFAULT_OPENAI_COMPATIBLE_API_PATH
  );
  const host = checkProviderHost(
    `The ${kind.label} host`,
    options.host?.trim() || kind.defaultHost,
    {
      ...(options.allowedHosts !== undefined
        ? { allowedHosts: options.allowedHosts }
        : {}),
      ...(options.allowedHostsLabel !== undefined
        ? { allowedHostsLabel: options.allowedHostsLabel }
        : {}),
    }
  );
  if (!host.ok) {
    return { ...base, baseUrl: kind.defaultHost, setupError: host.error };
  }
  if (path === null) {
    return {
      ...base,
      baseUrl: host.value,
      setupError: `The ${kind.label} apiPath must be letters, digits, "-", "_" and "/" only, e.g. /v1`,
    };
  }
  return { ...base, baseUrl: `${host.value}${path}` };
}

function localOptions(options: LocalServerOptions): OpenAiOptions {
  return {
    apiKey: options.apiKey ?? '',
    model: options.model,
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
    ...(options.loadModule !== undefined
      ? { loadModule: options.loadModule }
      : {}),
  };
}

/** Text from LM Studio's local server (default http://127.0.0.1:1234). */
export class LmStudioTextGenerator extends ChatCompletionsTextGenerator {
  constructor(options: LocalServerOptions) {
    super(
      localEndpoint(
        {
          provider: 'lmstudio',
          label: 'LM Studio',
          defaultHost: DEFAULT_LM_STUDIO_HOST,
        },
        options
      ),
      localOptions(options)
    );
  }
}

/** Text from a vLLM server (default http://127.0.0.1:8000). */
export class VllmTextGenerator extends ChatCompletionsTextGenerator {
  constructor(options: LocalServerOptions) {
    super(
      localEndpoint(
        { provider: 'vllm', label: 'vLLM', defaultHost: DEFAULT_VLLM_HOST },
        options
      ),
      localOptions(options)
    );
  }
}

/** Text from llama.cpp's `llama-server` (default http://127.0.0.1:8080). */
export class LlamaCppTextGenerator extends ChatCompletionsTextGenerator {
  constructor(options: LocalServerOptions) {
    super(
      localEndpoint(
        {
          provider: 'llamacpp',
          label: 'llama.cpp server',
          defaultHost: DEFAULT_LLAMA_CPP_HOST,
        },
        options
      ),
      localOptions(options)
    );
  }
}

export interface OpenAiCompatibleOptions extends LocalServerOptions {
  /** What to call the service in results and messages. Default `openai-compatible`. */
  readonly name?: string;
}

/**
 * Text from any other local server that speaks the OpenAI protocol (Jan,
 * LocalAI, text-generation-webui, …). `host` is required: there is no
 * usual port to assume.
 */
export class OpenAiCompatibleTextGenerator extends ChatCompletionsTextGenerator {
  constructor(options: OpenAiCompatibleOptions & { readonly host: string }) {
    const name: string = options.name?.trim() || 'openai-compatible';
    super(
      localEndpoint(
        { provider: name, label: name, defaultHost: options.host },
        options
      ),
      localOptions(options)
    );
  }
}
