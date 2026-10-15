import { callProvider, readBytes, readJson } from './http.js';
import type {
  AiImage,
  FetchLike,
  ImageGenerator,
  ImageRequest,
  ImageResult,
} from './port.js';
import { describeUnknownError, err, ok, type Result } from './result.js';

/**
 * Image edits with your own ComfyUI workflows, through ComfyUI's HTTP API:
 * upload the image, queue the workflow, wait for its history, then download
 * the output. With ComfyUI on your machine, the image never leaves it.
 *
 * Each mode is a workflow exported with ComfyUI's *Export (API)*, with
 * tokens where values are filled in (see WORKFLOW_TOKENS). Tokens are
 * replaced in the parsed JSON, never by pasting into the JSON text, so a
 * prompt can't break the workflow.
 */

export const WORKFLOW_TOKENS = {
  inputImage: '{{INPUT_IMAGE}}',
  prompt: '{{PROMPT}}',
  seed: '{{SEED}}',
} as const;

/** How long one workflow may run; local GPUs vary a lot. */
export const COMFYUI_RUN_TIMEOUT_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
export const DEFAULT_COMFYUI_HOST = 'http://127.0.0.1:8188';
/** Largest output image accepted. */
export const MAX_COMFYUI_OUTPUT_BYTES = 25 * 1024 * 1024;

/**
 * Where the workflows come from: memoryWorkflowSource here, or
 * directoryWorkflowSource from the `./node` subpath for a folder of files.
 */
export interface WorkflowSource {
  /** Mode names (file names without `.json`), sorted. */
  list(): Promise<Result<readonly string[]>>;
  read(mode: string): Promise<Result<string>>;
}

/** Workflows held in memory, e.g. bundled with an app or for tests. */
export function memoryWorkflowSource(
  workflows: Readonly<Record<string, string>>
): WorkflowSource {
  return {
    list() {
      return Promise.resolve(
        ok(Object.keys(workflows).sort((a, b) => a.localeCompare(b)))
      );
    },
    read(mode: string) {
      const text: string | undefined = Object.hasOwn(workflows, mode)
        ? workflows[mode]
        : undefined;
      return Promise.resolve(
        text === undefined
          ? err(`No ComfyUI workflow named "${mode}"`)
          : ok(text)
      );
    },
  };
}

type WorkflowNode = { class_type: string; inputs: Record<string, unknown> };
export type ApiWorkflow = Record<string, WorkflowNode>;

/**
 * Parses an API-format workflow and checks it has the input image token.
 * A UI-format save (it has a `nodes` array) gets the export hint.
 */
export function parseWorkflow(text: string, mode: string): Result<ApiWorkflow> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause: unknown) {
    return err(
      `ComfyUI workflow "${mode}" isn't valid JSON: ${describeUnknownError(cause)}`
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return err(`ComfyUI workflow "${mode}" isn't a JSON object`);
  }
  if (Array.isArray((parsed as { nodes?: unknown }).nodes)) {
    return err(
      `ComfyUI workflow "${mode}" is a UI save, not the API format. In ComfyUI use Workflow → Export (API) and save that file instead.`
    );
  }
  const nodes = Object.entries(parsed as Record<string, unknown>);
  if (nodes.length === 0) return err(`ComfyUI workflow "${mode}" has no nodes`);
  for (const [id, node] of nodes) {
    const candidate = node as { class_type?: unknown; inputs?: unknown };
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof candidate.class_type !== 'string' ||
      typeof candidate.inputs !== 'object' ||
      candidate.inputs === null
    ) {
      return err(
        `ComfyUI workflow "${mode}" node ${id} has no class_type/inputs; export it with Export (API).`
      );
    }
  }
  if (!JSON.stringify(parsed).includes(WORKFLOW_TOKENS.inputImage)) {
    return err(
      `ComfyUI workflow "${mode}" has no ${WORKFLOW_TOKENS.inputImage}. Put "${WORKFLOW_TOKENS.inputImage}" as the image name in its LoadImage node, so it can be given the image.`
    );
  }
  return ok(parsed as ApiWorkflow);
}

/**
 * The workflow with tokens filled in: `{{INPUT_IMAGE}}` and `{{SEED}}` must
 * be a whole string value (the seed becomes a number); `{{PROMPT}}` may sit
 * inside a longer prompt string.
 */
export function fillWorkflow(
  workflow: ApiWorkflow,
  values: { inputImage: string; prompt: string; seed: number }
): ApiWorkflow {
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (value === WORKFLOW_TOKENS.inputImage) return values.inputImage;
      if (value === WORKFLOW_TOKENS.seed) return values.seed;
      return value.split(WORKFLOW_TOKENS.prompt).join(values.prompt);
    }
    if (Array.isArray(value)) return value.map(fill);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, fill(inner)])
      );
    }
    return value;
  };
  return fill(workflow) as ApiWorkflow;
}

interface OutputImage {
  readonly filename: string;
  readonly subfolder: string;
  readonly type: string;
}

/**
 * Reads one prompt's history entry: still running (null), failed (an error
 * with ComfyUI's message), or the first saved output image.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readHistory(
  body: unknown,
  promptId: string
): Result<OutputImage | null> {
  const entry = (body as Record<string, unknown> | null)?.[promptId] as
    | {
        status?: {
          status_str?: unknown;
          completed?: unknown;
          messages?: unknown;
        };
        outputs?: Record<string, unknown>;
      }
    | undefined;
  if (entry === undefined) return ok(null);
  if (!isRecord(entry)) {
    return err('ComfyUI returned a history entry that is not an object');
  }
  if (entry.status?.status_str === 'error') {
    const messages: unknown = entry.status.messages;
    const detail: string = Array.isArray(messages)
      ? messages
          .filter(
            (item): item is [string, unknown] =>
              Array.isArray(item) && item[0] === 'execution_error'
          )
          .map(([, data]) => {
            const fields: Record<string, unknown> = isRecord(data) ? data : {};
            return `${String(fields['node_type'] ?? 'a node')}: ${String(fields['exception_message'] ?? 'failed')}`;
          })
          .join('; ')
      : '';
    return err(
      `ComfyUI couldn't run the workflow${detail === '' ? '' : ` (${detail.trim()})`}`
    );
  }
  const images: OutputImage[] = [];
  for (const output of Object.values(entry.outputs ?? {})) {
    if (!isRecord(output) || !Array.isArray(output['images'])) continue;
    for (const image of output['images'] as unknown[]) {
      if (isRecord(image) && typeof image['filename'] === 'string') {
        images.push({
          filename: image['filename'],
          subfolder:
            typeof image['subfolder'] === 'string' ? image['subfolder'] : '',
          type: typeof image['type'] === 'string' ? image['type'] : 'output',
        });
      }
    }
  }
  const saved: OutputImage | undefined =
    images.find((image) => image.type === 'output') ?? images[0];
  if (saved !== undefined) return ok(saved);
  if (entry.status?.completed === true) {
    return err(
      'ComfyUI finished the workflow but it produced no image; add a SaveImage node.'
    );
  }
  return ok(null);
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

export interface ComfyUiImageOptions {
  readonly workflows: WorkflowSource;
  /** Base URL; check it with checkProviderHost first. Default 127.0.0.1:8188. */
  readonly host?: string;
  /** Shown as the generator's `model`, e.g. "workflows in ./comfyui". */
  readonly label?: string;
  /** Start of uploaded file names in ComfyUI's input folder. */
  readonly uploadPrefix?: string;
  /** How long one workflow may run. Default 5 minutes. */
  readonly runTimeoutMs?: number;
  readonly fetch?: FetchLike;
  /** For tests. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly randomSeed?: () => number;
}

export class ComfyUiImageGenerator implements ImageGenerator {
  readonly provider = 'comfyui';
  readonly model: string;
  private readonly host: string;
  private readonly workflows: WorkflowSource;
  private readonly uploadPrefix: string;
  private readonly runTimeoutMs: number;
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly randomSeed: () => number;

  constructor(options: ComfyUiImageOptions) {
    this.workflows = options.workflows;
    this.host = (options.host ?? DEFAULT_COMFYUI_HOST).replace(/\/+$/, '');
    this.model = options.label ?? 'ComfyUI workflows';
    this.uploadPrefix = options.uploadPrefix ?? 'ai-providers';
    this.runTimeoutMs = options.runTimeoutMs ?? COMFYUI_RUN_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.randomSeed =
      options.randomSeed ?? (() => Math.floor(Math.random() * 2 ** 31));
  }

  listModes(): Promise<Result<readonly string[]>> {
    return this.workflows.list();
  }

  async generateImage(request: ImageRequest): Promise<Result<ImageResult>> {
    const photo: AiImage | undefined = request.images[0];
    if (photo === undefined) return err('No image was given to ComfyUI');
    const modes = await this.workflows.list();
    if (!modes.ok) return modes;
    const mode: string | undefined = request.mode ?? modes.value[0];
    if (mode === undefined || !modes.value.includes(mode)) {
      return err(
        mode === undefined
          ? 'No ComfyUI workflows found; add one exported with Export (API).'
          : `No ComfyUI workflow named "${mode}"; there are: ${modes.value.join(', ') || 'none'}.`
      );
    }
    const text = await this.workflows.read(mode);
    if (!text.ok) return text;
    const workflow = parseWorkflow(text.value, mode);
    if (!workflow.ok) return workflow;

    const uploaded = await this.upload(photo, request.signal);
    if (!uploaded.ok) return uploaded;
    const filled: ApiWorkflow = fillWorkflow(workflow.value, {
      inputImage: uploaded.value,
      prompt: request.prompt,
      seed: this.randomSeed(),
    });

    const queued = await this.queue(filled, mode, request.signal);
    if (!queued.ok) return queued;
    const output = await this.waitForOutput(queued.value, mode, request.signal);
    if (!output.ok) return output;
    const image = await this.download(output.value, request.signal);
    if (!image.ok) return image;
    return ok({ image: image.value, notes: `ComfyUI workflow "${mode}"` });
  }

  /** Uploads the image as an input; returns the name LoadImage expects. */
  private async upload(
    photo: AiImage,
    signal?: AbortSignal
  ): Promise<Result<string>> {
    const form = new FormData();
    const name = `${this.uploadPrefix}-${crypto.randomUUID()}.${EXTENSIONS[photo.mimeType] ?? 'png'}`;
    // Copied so the Blob gets a plain ArrayBuffer whatever backs `data`.
    const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(photo.data);
    form.set('image', new Blob([bytes], { type: photo.mimeType }), name);
    form.set('type', 'input');
    form.set('overwrite', 'true');
    const what = 'ComfyUI image upload';
    const response = await callProvider(
      this.fetchImpl,
      `${this.host}/upload/image`,
      { method: 'POST', body: form },
      what,
      REQUEST_TIMEOUT_MS,
      signal
    );
    if (!response.ok) return response;
    const body = await readJson(response.value, what);
    if (!body.ok) return body;
    const { name: stored, subfolder } = body.value as {
      name?: unknown;
      subfolder?: unknown;
    };
    if (typeof stored !== 'string' || stored === '')
      return err(`${what} returned no file name`);
    return ok(
      typeof subfolder === 'string' && subfolder !== ''
        ? `${subfolder}/${stored}`
        : stored
    );
  }

  private async queue(
    workflow: ApiWorkflow,
    mode: string,
    signal?: AbortSignal
  ): Promise<Result<string>> {
    const what = `Queuing ComfyUI workflow "${mode}"`;
    const response = await callProvider(
      this.fetchImpl,
      `${this.host}/prompt`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          prompt: workflow,
          client_id: crypto.randomUUID(),
        }),
      },
      what,
      REQUEST_TIMEOUT_MS,
      signal
    );
    if (!response.ok) return response;
    const body = await readJson(response.value, what);
    if (!body.ok) return body;
    const promptId: unknown = (body.value as { prompt_id?: unknown }).prompt_id;
    if (typeof promptId !== 'string' || promptId === '')
      return err(`${what} returned no prompt_id`);
    return ok(promptId);
  }

  private async waitForOutput(
    promptId: string,
    mode: string,
    signal?: AbortSignal
  ): Promise<Result<OutputImage>> {
    const deadline: number = this.now() + this.runTimeoutMs;
    const what = `ComfyUI workflow "${mode}"`;
    while (this.now() < deadline) {
      if (signal?.aborted === true) return err(`${what} was cancelled`);
      const response = await callProvider(
        this.fetchImpl,
        `${this.host}/history/${encodeURIComponent(promptId)}`,
        { method: 'GET' },
        `Reading ${what}'s progress`,
        REQUEST_TIMEOUT_MS,
        signal
      );
      if (!response.ok) return response;
      const body = await readJson(response.value, what);
      if (!body.ok) return body;
      const state = readHistory(body.value, promptId);
      if (!state.ok) return err(`${what}: ${state.error}`);
      if (state.value !== null) return ok(state.value);
      await this.sleep(POLL_INTERVAL_MS);
    }
    return err(
      `${what} didn't finish within ${Math.round(this.runTimeoutMs / 1000)} s; it may still be running in ComfyUI.`
    );
  }

  private async download(
    output: OutputImage,
    signal?: AbortSignal
  ): Promise<Result<AiImage>> {
    const query = new URLSearchParams({
      filename: output.filename,
      subfolder: output.subfolder,
      type: output.type,
    });
    const what = `Downloading ComfyUI output ${output.filename}`;
    const response = await callProvider(
      this.fetchImpl,
      `${this.host}/view?${query.toString()}`,
      { method: 'GET' },
      what,
      REQUEST_TIMEOUT_MS,
      signal
    );
    if (!response.ok) return response;
    const bytes = await readBytes(
      response.value,
      what,
      MAX_COMFYUI_OUTPUT_BYTES
    );
    if (!bytes.ok) return bytes;
    const data: Uint8Array = bytes.value;
    if (data.length === 0) return err(`${what}: the image is empty`);
    const contentType: string =
      response.value.headers.get('content-type') ?? '';
    const mimeType: string = (contentType.split(';')[0] ?? '').trim();
    return ok({
      mimeType: mimeType.startsWith('image/')
        ? mimeType
        : guessMime(output.filename),
      data,
    });
  }
}

function guessMime(filename: string): string {
  const lower: string = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}
