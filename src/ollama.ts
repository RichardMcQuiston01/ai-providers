import { checkProviderHost } from './hosts.js';
import {
  DEFAULT_AI_TIMEOUT_MS,
  callProvider,
  readJson,
  toBase64,
} from './http.js';
import type {
  FetchLike,
  TextGenerator,
  TextRequest,
  TextResult,
} from './port.js';
import { err, ok, type Result } from './result.js';

export const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434';

export interface OllamaListOptions {
  /**
   * Base URL, checked with checkProviderHost: this machine unless the host
   * is in `allowedHosts`. Default 127.0.0.1:11434. A bad host makes
   * generateText and listOllamaModels return an error.
   */
  readonly host?: string;
  /** Hosts allowed besides loopback (see parseAllowedHosts). */
  readonly allowedHosts?: readonly string[];
  /** What to call the allow list in messages, e.g. an env variable name. */
  readonly allowedHostsLabel?: string;
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export interface OllamaTextOptions extends OllamaListOptions {
  /** The model, as `ollama list` shows it, e.g. llama3.2. */
  readonly model: string;
}

function checkOllamaHost(options: OllamaListOptions): Result<string> {
  return checkProviderHost(
    'The Ollama host',
    options.host?.trim() || DEFAULT_OLLAMA_HOST,
    {
      ...(options.allowedHosts !== undefined
        ? { allowedHosts: options.allowedHosts }
        : {}),
      ...(options.allowedHostsLabel !== undefined
        ? { allowedHostsLabel: options.allowedHostsLabel }
        : {}),
    }
  );
}

/**
 * The models Ollama has pulled (`GET /api/tags`), as `ollama list` names
 * them (e.g. `llama3.2:latest`), sorted, for a settings dropdown. It needs
 * no model, so it works before one is chosen; the host is checked like
 * the generator's.
 */
export async function listOllamaModels(
  options: OllamaListOptions = {},
  signal?: AbortSignal
): Promise<Result<readonly string[]>> {
  const what = 'Ollama (listing models)';
  const host: Result<string> = checkOllamaHost(options);
  if (!host.ok) return host;
  const response = await callProvider(
    options.fetch ?? ((input, init) => fetch(input, init)),
    `${host.value}/api/tags`,
    { method: 'GET' },
    what,
    options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS,
    signal
  );
  if (!response.ok) return response;
  const body = await readJson(response.value, what);
  if (!body.ok) return body;
  const models: unknown = (body.value as { models?: unknown }).models;
  if (!Array.isArray(models)) return err(`${what} returned no model list`);
  const names = new Set<string>();
  for (const entry of models as unknown[]) {
    const name: unknown = (entry as { name?: unknown } | null)?.name;
    if (typeof name === 'string' && name.trim() !== '') names.add(name);
  }
  return ok([...names].sort());
}

/**
 * Text from a local Ollama model (`POST /api/chat`, not streamed). Images,
 * when given, go to the user message for vision models. A reasoning model's
 * `<think>` block is removed from the reply.
 */
export class OllamaTextGenerator implements TextGenerator {
  readonly provider = 'ollama';
  readonly model: string;
  private readonly host: string;
  private readonly hostCheck: Result<string>;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly listOptions: OllamaListOptions;

  constructor(options: OllamaTextOptions) {
    this.model = options.model;
    this.hostCheck = checkOllamaHost(options);
    this.host = this.hostCheck.ok ? this.hostCheck.value : '';
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_AI_TIMEOUT_MS;
    this.listOptions = options;
  }

  /** The models this host has pulled; see listOllamaModels. */
  listModels(signal?: AbortSignal): Promise<Result<readonly string[]>> {
    return listOllamaModels(this.listOptions, signal);
  }

  async generateText(request: TextRequest): Promise<Result<TextResult>> {
    const what = `Ollama (model "${this.model}")`;
    if (!this.hostCheck.ok) return this.hostCheck;
    if (this.model.trim() === '') {
      return err(
        'No Ollama model is set; use one you have pulled (`ollama list`).'
      );
    }
    const response = await callProvider(
      this.fetchImpl,
      `${this.host}/api/chat`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            { role: 'system', content: request.instructions },
            {
              role: 'user',
              content: request.prompt,
              ...(request.images !== undefined && request.images.length > 0
                ? {
                    images: request.images.map((image) => toBase64(image.data)),
                  }
                : {}),
            },
          ],
        }),
      },
      what,
      this.timeoutMs,
      request.signal
    );
    if (!response.ok) return response;
    const body = await readJson(response.value, what);
    if (!body.ok) return body;
    const content: unknown = (body.value as { message?: { content?: unknown } })
      .message?.content;
    if (typeof content !== 'string') {
      return err(`${what} returned no message text`);
    }
    const text: string = stripThinking(content);
    if (text === '') return err(`${what} returned an empty reply`);
    return ok({ text });
  }
}

const THINK_OPEN = /<think\b[^>]*>/i;
/** A `<think>` block with no `<think>` inside it: the innermost kind. */
const INNERMOST_BLOCK = /<think\b[^>]*>(?:(?!<think\b)[\s\S])*?<\/think>/gi;

/**
 * Drops a reasoning model's `<think>…</think>` blocks and surrounding space.
 * Nested blocks are removed from the inside out. A block that is never
 * closed (a truncated reply) is dropped from its tag to the end, since
 * everything after it is still reasoning.
 */
export function stripThinking(text: string): string {
  let result: string = text;
  for (;;) {
    const next: string = result.replace(INNERMOST_BLOCK, '');
    if (next === result) break;
    result = next;
  }
  const open: number = result.search(THINK_OPEN);
  if (open >= 0) result = result.slice(0, open);
  return result.trim();
}
