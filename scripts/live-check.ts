/**
 * Live-API check: runs each provider once against its real service, to
 * confirm the endpoint paths, field names and reply shapes the library
 * was written against. Most providers were only ever tested against a fake
 * `fetch`.
 *
 *   bun run live-check                    usage
 *   bun run live-check --list             what would run, and what is missing
 *   bun run live-check --run              run every provider that has its settings
 *   bun run live-check --run --only=fal,bfl,stability
 *
 * Settings come from the environment (Bun also reads a git-ignored `.env`).
 * A provider with no settings is skipped. Paid providers cost real money:
 * one text call or one image edit each, nothing else. Nothing is retried.
 * Keys are never printed. Outputs are saved in `live-check-output/`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

import { sniffImageType } from '../src/images.js';
import type { AiImage, ImageRequest } from '../src/port.js';
import { listOllamaModels } from '../src/ollama.js';
import {
  createImageGenerator,
  createTextGenerator,
  type ImageProviderConfig,
  type TextProviderConfig,
} from '../src/providers.js';
import { describeUnknownError, err, ok, type Result } from '../src/result.js';
import { directoryWorkflowSource } from '../src/node.js';

type Cost = 'free' | 'paid';

interface Check {
  readonly id: string;
  readonly label: string;
  readonly cost: Cost;
  /** Environment variables that must be set; the provider is skipped without them. */
  readonly needs: readonly string[];
  /** Runs the call and returns a short description of what came back. */
  readonly run: (context: RunContext) => Promise<Result<string>>;
}

interface RunContext {
  readonly testImage: AiImage;
  readonly outputDir: string;
  readonly signal: AbortSignal;
}

const TEXT_INSTRUCTIONS = 'Reply with one short sentence and nothing else.';
const TEXT_PROMPT = 'Say hello and mention the weather.';
const IMAGE_INSTRUCTIONS = 'Keep the composition. Change nothing else.';
const IMAGE_PROMPT = 'Make the sky orange, like a sunset.';

function readEnv(name: string): string {
  return (process.env[name] ?? '').trim();
}

/** `{ model }` when the variable is set, else nothing (the provider's default applies). */
function modelFrom(name: string): { model: string } | Record<string, never> {
  const model: string = readEnv(name);
  return model === '' ? {} : { model };
}

/** The settings of a local server: its address, allowed because you named it. */
function localHostSettings(hostVariable: string): {
  host: string;
  allowedHosts: string[];
} {
  const host: string = readEnv(hostVariable);
  try {
    return { host, allowedHosts: [new URL(host).hostname] };
  } catch {
    // A bad address is reported by the provider's own host check.
    return { host, allowedHosts: [] };
  }
}

function excerpt(text: string): string {
  const oneLine: string = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > 80 ? `${oneLine.slice(0, 80)}…` : oneLine;
}

function textCheck(
  id: string,
  label: string,
  cost: Cost,
  needs: readonly string[],
  config: () => TextProviderConfig
): Check {
  return {
    id,
    label,
    cost,
    needs,
    run: async (context: RunContext): Promise<Result<string>> => {
      const generator = createTextGenerator(config());
      if (!generator.ok) return generator;
      const result = await generator.value.generateText({
        instructions: TEXT_INSTRUCTIONS,
        prompt: TEXT_PROMPT,
        signal: context.signal,
      });
      if (!result.ok) return result;
      return ok(
        `model ${generator.value.model}: "${excerpt(result.value.text)}"`
      );
    },
  };
}

function imageCheck(
  id: string,
  label: string,
  cost: Cost,
  needs: readonly string[],
  config: () => ImageProviderConfig,
  mode: () => string | null = () => null
): Check {
  return {
    id,
    label,
    cost,
    needs,
    run: async (context: RunContext): Promise<Result<string>> => {
      const generator = createImageGenerator(config());
      if (!generator.ok) return generator;
      const request: ImageRequest = {
        instructions: IMAGE_INSTRUCTIONS,
        prompt: IMAGE_PROMPT,
        images: [context.testImage],
        mode: mode(),
        signal: context.signal,
      };
      const result = await generator.value.generateImage(request);
      if (!result.ok) return result;
      const extension: string =
        result.value.image.mimeType.split('/')[1] ?? 'bin';
      const file: string = join(context.outputDir, `${id}.${extension}`);
      await writeFile(file, result.value.image.data);
      const kilobytes: string = (result.value.image.data.length / 1024).toFixed(
        0
      );
      return ok(
        `${result.value.image.mimeType}, ${kilobytes} KB, saved to ${file}` +
          (result.value.notes === null ? '' : ` (${result.value.notes})`)
      );
    },
  };
}

const CHECKS: readonly Check[] = [
  {
    id: 'ollama-models',
    label: 'Ollama: list models',
    cost: 'free',
    needs: ['OLLAMA_MODEL'],
    run: async (context: RunContext): Promise<Result<string>> => {
      const settings =
        readEnv('OLLAMA_HOST') === '' ? {} : localHostSettings('OLLAMA_HOST');
      const models = await listOllamaModels(settings, context.signal);
      if (!models.ok) return models;
      const wanted: string = readEnv('OLLAMA_MODEL');
      const found: boolean = models.value.some(
        (name: string) => name === wanted || name === `${wanted}:latest`
      );
      return found
        ? ok(`${models.value.length} models, including ${wanted}`)
        : err(
            `${models.value.length} models listed, but not "${wanted}": ${models.value.slice(0, 10).join(', ')}`
          );
    },
  },
  textCheck('ollama-text', 'Ollama: text', 'free', ['OLLAMA_MODEL'], () => ({
    provider: 'ollama',
    model: readEnv('OLLAMA_MODEL'),
    ...(readEnv('OLLAMA_HOST') === '' ? {} : localHostSettings('OLLAMA_HOST')),
  })),
  textCheck(
    'lmstudio-text',
    'LM Studio: text',
    'free',
    ['LMSTUDIO_HOST', 'LMSTUDIO_MODEL'],
    () => ({
      provider: 'lmstudio',
      model: readEnv('LMSTUDIO_MODEL'),
      ...localHostSettings('LMSTUDIO_HOST'),
    })
  ),
  textCheck(
    'vllm-text',
    'vLLM: text',
    'free',
    ['VLLM_HOST', 'VLLM_MODEL'],
    () => ({
      provider: 'vllm',
      model: readEnv('VLLM_MODEL'),
      ...localHostSettings('VLLM_HOST'),
    })
  ),
  textCheck(
    'llamacpp-text',
    'llama.cpp server: text',
    'free',
    ['LLAMACPP_HOST', 'LLAMACPP_MODEL'],
    () => ({
      provider: 'llamacpp',
      model: readEnv('LLAMACPP_MODEL'),
      ...localHostSettings('LLAMACPP_HOST'),
    })
  ),
  textCheck(
    'openrouter-text',
    'OpenRouter: text',
    'paid',
    ['OPENROUTER_API_KEY'],
    () => ({
      provider: 'openrouter',
      apiKey: readEnv('OPENROUTER_API_KEY'),
      ...modelFrom('OPENROUTER_MODEL'),
    })
  ),
  textCheck('gemini-text', 'Gemini: text', 'paid', ['GEMINI_API_KEY'], () => ({
    provider: 'gemini',
    apiKey: readEnv('GEMINI_API_KEY'),
    ...modelFrom('GEMINI_TEXT_MODEL'),
  })),
  textCheck(
    'claude-text',
    'Claude: text',
    'paid',
    ['ANTHROPIC_API_KEY'],
    () => ({
      provider: 'claude',
      apiKey: readEnv('ANTHROPIC_API_KEY'),
      ...modelFrom('CLAUDE_TEXT_MODEL'),
    })
  ),
  textCheck('openai-text', 'OpenAI: text', 'paid', ['OPENAI_API_KEY'], () => ({
    provider: 'openai',
    apiKey: readEnv('OPENAI_API_KEY'),
    ...modelFrom('OPENAI_TEXT_MODEL'),
  })),
  textCheck('grok-text', 'Grok: text', 'paid', ['XAI_API_KEY'], () => ({
    provider: 'grok',
    apiKey: readEnv('XAI_API_KEY'),
    ...modelFrom('GROK_TEXT_MODEL'),
  })),
  imageCheck(
    'gemini-image',
    'Gemini: image edit',
    'paid',
    ['GEMINI_API_KEY'],
    () => ({
      provider: 'gemini',
      apiKey: readEnv('GEMINI_API_KEY'),
      ...modelFrom('GEMINI_IMAGE_MODEL'),
    })
  ),
  imageCheck(
    'openai-image',
    'OpenAI: image edit',
    'paid',
    ['OPENAI_API_KEY'],
    () => ({
      provider: 'openai',
      apiKey: readEnv('OPENAI_API_KEY'),
      ...modelFrom('OPENAI_IMAGE_MODEL'),
    })
  ),
  imageCheck('grok-image', 'Grok: image edit', 'paid', ['XAI_API_KEY'], () => ({
    provider: 'grok',
    apiKey: readEnv('XAI_API_KEY'),
    ...modelFrom('GROK_IMAGE_MODEL'),
  })),
  imageCheck(
    'replicate-image',
    'Replicate: image edit',
    'paid',
    ['REPLICATE_API_TOKEN'],
    () => ({
      provider: 'replicate',
      apiKey: readEnv('REPLICATE_API_TOKEN'),
      ...modelFrom('REPLICATE_MODEL'),
    })
  ),
  imageCheck('fal-image', 'fal: image edit', 'paid', ['FAL_KEY'], () => ({
    provider: 'fal',
    apiKey: readEnv('FAL_KEY'),
    ...modelFrom('FAL_MODEL'),
  })),
  imageCheck(
    'bfl-image',
    'Black Forest Labs: image edit',
    'paid',
    ['BFL_API_KEY'],
    () => ({
      provider: 'bfl',
      apiKey: readEnv('BFL_API_KEY'),
      ...modelFrom('BFL_MODEL'),
    })
  ),
  imageCheck(
    'stability-image',
    'Stability AI: image-to-image',
    'paid',
    ['STABILITY_API_KEY'],
    () => ({
      provider: 'stability',
      apiKey: readEnv('STABILITY_API_KEY'),
      ...modelFrom('STABILITY_MODEL'),
    })
  ),
  imageCheck(
    'stability-remove-background',
    'Stability AI: remove-background',
    'paid',
    ['STABILITY_API_KEY'],
    () => ({ provider: 'stability', apiKey: readEnv('STABILITY_API_KEY') }),
    () => 'remove-background'
  ),
  imageCheck(
    'sdwebui-image',
    'Stable Diffusion web UI: img2img',
    'free',
    ['SDWEBUI_HOST'],
    () => ({
      provider: 'sdwebui',
      ...localHostSettings('SDWEBUI_HOST'),
      ...modelFrom('SDWEBUI_MODEL'),
    })
  ),
  {
    id: 'comfyui-image',
    label: 'ComfyUI: workflow run',
    cost: 'free',
    needs: ['COMFYUI_WORKFLOWS'],
    run: async (context: RunContext): Promise<Result<string>> => {
      const workflows = directoryWorkflowSource(readEnv('COMFYUI_WORKFLOWS'));
      const chosen: string = readEnv('COMFYUI_MODE');
      let mode: string | null = chosen === '' ? null : chosen;
      if (mode === null) {
        const modes = await workflows.list();
        if (!modes.ok) return modes;
        mode = modes.value[0] ?? null;
        if (mode === null)
          return err('The workflows folder has no .json files.');
      }
      const check: Check = imageCheck(
        'comfyui-image',
        'ComfyUI',
        'free',
        [],
        () => ({
          provider: 'comfyui',
          workflows,
          ...(readEnv('COMFYUI_HOST') === ''
            ? {}
            : localHostSettings('COMFYUI_HOST')),
        }),
        () => mode
      );
      const result = await check.run(context);
      return result.ok ? ok(`workflow "${mode}": ${result.value}`) : result;
    },
  },
];

// ---- a test image, so no file is needed ----

const CRC_TABLE: readonly number[] = Array.from(
  { length: 256 },
  (_unused, n: number) => {
    let value: number = n;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  }
);

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)));
  return chunk;
}

/** A 512 x 512 landscape: blue sky, green ground, a yellow sun and a white house. */
function makeTestImage(): AiImage {
  const size = 512;
  const horizon = 300;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < size; y += 1) {
    const row = new Uint8Array(1 + size * 3);
    for (let x = 0; x < size; x += 1) {
      let color: [number, number, number] =
        y < horizon
          ? [110 + (y >> 2), 170 + (y >> 3), 235]
          : [60, 150 - ((y - horizon) >> 2), 70];
      if ((x - 400) ** 2 + (y - 90) ** 2 < 45 ** 2) color = [250, 220, 60];
      if (x > 150 && x < 300 && y > 210 && y < 340) color = [245, 245, 240];
      // A triangular roof, apex at (225, 170).
      if (y > 170 && y <= 210 && Math.abs(x - 225) < (y - 170) * 1.875) {
        color = [180, 60, 50];
      }
      row.set(color, 1 + x * 3);
    }
    rows.push(row);
  }
  const raw = new Uint8Array(rows.length * (1 + size * 3));
  rows.forEach((row: Uint8Array, index: number) =>
    raw.set(row, index * row.length)
  );
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array()),
  ];
  const data = new Uint8Array(
    parts.reduce((total: number, part: Uint8Array) => total + part.length, 0)
  );
  let offset = 0;
  for (const part of parts) {
    data.set(part, offset);
    offset += part.length;
  }
  return { mimeType: 'image/png', data };
}

async function loadTestImage(path: string | null): Promise<Result<AiImage>> {
  if (path === null) return ok(makeTestImage());
  try {
    const data = new Uint8Array(await readFile(path));
    const mimeType: string | null = sniffImageType(data);
    return mimeType === null
      ? err(`${path} is not a PNG, JPEG or WebP image.`)
      : ok({ mimeType, data });
  } catch (cause: unknown) {
    return err(`Could not read ${path}: ${describeUnknownError(cause)}`);
  }
}

// ---- running ----

interface Options {
  readonly run: boolean;
  readonly list: boolean;
  readonly only: readonly string[] | null;
  readonly imagePath: string | null;
  readonly outputDir: string;
  readonly timeoutSeconds: number;
}

function parseArguments(args: readonly string[]): Options {
  const valueOf = (name: string): string | null => {
    const prefix = `--${name}=`;
    const found: string | undefined = args.find((arg: string) =>
      arg.startsWith(prefix)
    );
    return found === undefined ? null : found.slice(prefix.length);
  };
  const only: string | null = valueOf('only');
  const timeout = Number(valueOf('timeout') ?? 300);
  return {
    run: args.includes('--run'),
    list: args.includes('--list'),
    only:
      only === null
        ? null
        : only
            .split(',')
            .map((id: string) => id.trim())
            .filter((id: string) => id !== ''),
    imagePath: valueOf('image'),
    outputDir: valueOf('out') ?? 'live-check-output',
    timeoutSeconds: Number.isFinite(timeout) && timeout > 0 ? timeout : 300,
  };
}

function missingSettings(check: Check): string[] {
  return check.needs.filter((name: string) => readEnv(name) === '');
}

function selected(options: Options): Check[] {
  return CHECKS.filter(
    (check: Check) =>
      options.only === null ||
      options.only.some(
        (id: string) => check.id === id || check.id.startsWith(`${id}-`)
      )
  );
}

/** Secrets the checks use, so an unexpected message can be scrubbed before printing. */
function secretValues(): string[] {
  const names = new Set<string>(
    CHECKS.flatMap((check: Check) => check.needs).filter((name: string) =>
      /KEY|TOKEN/.test(name)
    )
  );
  return [...names].map(readEnv).filter((value: string) => value.length >= 8);
}

function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (clean: string, secret: string) => clean.split(secret).join('***'),
    text
  );
}

function printUsage(): void {
  console.log(
    [
      'Live-API check: one real call per provider that has its settings.',
      '',
      '  bun run live-check --list                 what would run, and what is missing',
      '  bun run live-check --run                  run them (paid providers cost real money)',
      '  bun run live-check --run --only=fal,bfl   only these (ids or prefixes, see --list)',
      '',
      'Options: --image=path.png (use your own test image)  --out=dir  --timeout=seconds (default 300)',
      'Settings are environment variables (a git-ignored .env works); see --list for the names.',
    ].join('\n')
  );
}

function printList(checks: readonly Check[]): void {
  for (const check of checks) {
    const missing: string[] = missingSettings(check);
    const status: string = missing.length === 0 ? 'ready  ' : 'skipped';
    const note: string =
      missing.length === 0 ? '' : `  needs ${missing.join(', ')}`;
    console.log(
      `${status}  ${check.cost === 'paid' ? 'paid' : 'free'}  ${check.id.padEnd(28)} ${check.label}${note}`
    );
  }
}

async function main(): Promise<number> {
  const options: Options = parseArguments(process.argv.slice(2));
  if (!options.run && !options.list) {
    printUsage();
    return 0;
  }
  const checks: Check[] = selected(options);
  if (options.only !== null && checks.length === 0) {
    console.error(
      `No check matches ${options.only.join(', ')}. Use --list to see the ids.`
    );
    return 1;
  }
  if (options.list) {
    printList(checks);
    return 0;
  }

  const testImage = await loadTestImage(options.imagePath);
  if (!testImage.ok) {
    console.error(testImage.error);
    return 1;
  }
  await mkdir(options.outputDir, { recursive: true });
  const secrets: string[] = secretValues();
  const runnable: Check[] = checks.filter(
    (check: Check) => missingSettings(check).length === 0
  );
  const paid: number = runnable.filter(
    (check: Check) => check.cost === 'paid'
  ).length;
  console.log(
    `Running ${runnable.length} checks (${paid} on paid APIs, one call each)…\n`
  );

  let failed = 0;
  let passed = 0;
  for (const check of checks) {
    const missing: string[] = missingSettings(check);
    if (missing.length > 0) {
      console.log(`SKIP  ${check.id.padEnd(28)} needs ${missing.join(', ')}`);
      continue;
    }
    const started: number = Date.now();
    let outcome: Result<string>;
    try {
      outcome = await check.run({
        testImage: testImage.value,
        outputDir: options.outputDir,
        signal: AbortSignal.timeout(options.timeoutSeconds * 1000),
      });
    } catch (cause: unknown) {
      outcome = err(
        `threw instead of returning an error: ${describeUnknownError(cause)}`
      );
    }
    const seconds: string = ((Date.now() - started) / 1000).toFixed(1);
    if (outcome.ok) {
      passed += 1;
      console.log(
        `PASS  ${check.id.padEnd(28)} ${seconds}s  ${redact(outcome.value, secrets)}`
      );
    } else {
      failed += 1;
      console.log(
        `FAIL  ${check.id.padEnd(28)} ${seconds}s  ${redact(outcome.error, secrets)}`
      );
    }
  }
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.log(
      'A failure naming an HTTP status or a missing field usually means the request or reply shape\n' +
        'the library assumes is wrong for that provider: send the FAIL lines back to fix them.\n' +
        '(A "request blocked" 403 comes from a network allowlist, not the provider.)'
    );
  }
  return failed > 0 ? 1 : 0;
}

process.exitCode = await main();
