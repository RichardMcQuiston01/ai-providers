# @richardmcquiston01/ai-providers

<!-- prettier-ignore-start -->
- Author:  Richard McQuiston
- Website:  https://richardmcquiston.com/
<!-- prettier-ignore-end -->

## Overview

Swappable AI providers for TypeScript. Your app codes against two small
interfaces: `TextGenerator` for text and `ImageGenerator` for image edits.
You then choose the provider for each task in configuration: a local model
today, a hosted API tomorrow, without changing the calling code.

- **Ollama** (`OllamaTextGenerator`): text from a local model.
- **ComfyUI** (`ComfyUiImageGenerator`): image edits with your own exported
  workflows.
- **Gemini** (`GeminiTextGenerator`, `GeminiImageGenerator`): text and
  photo edits with Google's Gemini API, using
  `@richardmcquiston01/gemini-icon-gen` as an optional peer dependency.
- **Claude** (`ClaudeTextGenerator`): text with Anthropic's Claude API,
  using the official `@anthropic-ai/sdk` as an optional peer dependency.

Design:

- **Results, not exceptions.** Every call returns
  `{ ok: true, value } | { ok: false, error }`. Errors are specific: they
  name the provider, the model or workflow, the HTTP status and the
  provider's own message.
- **Providers only generate.** Prompt rules, output checks and the decision
  to use a result stay in your app, so swapping providers can't weaken
  them.
- **Local by default.** `checkProviderHost` accepts only this machine,
  unless a host is on your allow list.
- **Runtime-neutral.** The main entry runs in Node 20.3+, Bun and browsers,
  and ships as ESM and CommonJS with types. The only Node-specific code,
  reading workflows from a folder, is in the `./node` subpath.

## Getting Started

```bash
bun add @richardmcquiston01/ai-providers
```

### Text with Ollama

```ts
import {
  checkProviderHost,
  OllamaTextGenerator,
  type TextGenerator,
} from '@richardmcquiston01/ai-providers';

const host = checkProviderHost('OLLAMA_HOST', 'http://127.0.0.1:11434');
if (!host.ok) throw new Error(host.error);

const text: TextGenerator = new OllamaTextGenerator({
  host: host.value,
  model: 'llama3.2',
});

const result = await text.generateText({
  instructions: 'Rewrite the caption. No emojis. Keep the link.',
  prompt: 'Handmade ink pad holder - $20 https://www.etsy.com/listing/1',
});
if (result.ok) console.log(result.value.text);
else console.error(result.error); // e.g. Ollama (model "llama3.2") failed (HTTP 404): model not found
```

A reasoning model's `<think>…</think>` block is removed from the reply.
Pass `images` to send pictures to a vision model.

### Image edits with ComfyUI

1. Build a workflow in ComfyUI with a **LoadImage** node and a
   **SaveImage** node.
2. Export it with **Workflow → Export (API)**. A normal Save writes the UI
   format, which is refused with a hint.
3. In the exported JSON, set these placeholders:

   | Placeholder         | Where                                      | Filled with                 |
   | ------------------- | ------------------------------------------ | --------------------------- |
   | `"{{INPUT_IMAGE}}"` | the LoadImage node's `image` (required)    | the uploaded image          |
   | `{{PROMPT}}`        | anywhere inside a text value               | `request.prompt`            |
   | `"{{SEED}}"`        | a sampler's `seed` (optional, whole value) | a random number on each run |

```ts
import { ComfyUiImageGenerator } from '@richardmcquiston01/ai-providers';
import { directoryWorkflowSource } from '@richardmcquiston01/ai-providers/node';

const image = new ComfyUiImageGenerator({
  workflows: directoryWorkflowSource('comfyui-workflows'), // touch-up.json → mode "touch-up"
  label: 'workflows in comfyui-workflows',
});

const modes = await image.listModes(); // ok(['touch-up', ...])
const edited = await image.generateImage({
  instructions: '',
  prompt: 'soft studio light, clean white background',
  images: [{ mimeType: 'image/jpeg', data: photoBytes }],
  mode: 'touch-up',
});
if (edited.ok) save(edited.value.image.data, edited.value.image.mimeType);
```

The image is uploaded and the workflow queued. Its history is then polled
(5-minute limit, `runTimeoutMs`) and the first saved output downloaded
(25 MB cap). Placeholders are filled in the parsed JSON, so a prompt can't
break the workflow. In a browser, or for workflows bundled with your app,
use `memoryWorkflowSource({ 'touch-up': jsonText })` instead.

### Text and image edits with Gemini

Gemini is a hosted API, so it needs a key (create one in Google AI Studio)
and sends your prompts and images to Google. Install the optional peer
package alongside this one:

```bash
bun add @richardmcquiston01/ai-providers @richardmcquiston01/gemini-icon-gen
```

```ts
import {
  GeminiImageGenerator,
  GeminiTextGenerator,
} from '@richardmcquiston01/ai-providers/gemini';

const apiKey: string = env.GEMINI_API_KEY; // your app reads the key; the package never does

const text = new GeminiTextGenerator({ apiKey }); // gemini-3.8-flash unless you pass model
const caption = await text.generateText({
  instructions: 'Rewrite the caption. No emojis. Keep the link.',
  prompt: 'Handmade ink pad holder - $20 https://www.etsy.com/listing/1',
});

const image = new GeminiImageGenerator({ apiKey }); // gemini-2.5-flash-image
const edited = await image.generateImage({
  instructions: 'Keep the product exactly as it is. Do not add text.',
  prompt: 'Place it on a light oak table in soft daylight.',
  images: [{ mimeType: 'image/jpeg', data: photoBytes }], // then any references
  mode: null, // the one mode, listModes() → [model]
});
```

- Text needs non-empty `instructions`, and doesn't take images yet.
- Images must be PNG, JPEG or WebP. Any text Gemini sends with an image
  comes back as `notes`.
- Without the peer package installed, both return an error naming it. The
  `./gemini` subpath is kept out of the main entry, so apps that don't use
  Gemini never resolve it.
- `timeoutMs` (default 120 s) and `signal` stop waiting for a call. The
  underlying request can't be aborted, so it's abandoned, not cancelled.

### Text with Claude

Claude is a hosted API with its own key (create one in the Claude Console;
a Claude plan doesn't include API use). Install the SDK alongside:

```bash
bun add @richardmcquiston01/ai-providers @anthropic-ai/sdk
```

```ts
import { ClaudeTextGenerator } from '@richardmcquiston01/ai-providers/claude';

const apiKey: string = env.ANTHROPIC_API_KEY; // your app reads the key; the package never does

const text = new ClaudeTextGenerator({ apiKey }); // claude-opus-5-5 unless you pass model
const reply = await text.generateText({
  instructions: 'Rewrite captions to be short and friendly.',
  prompt: 'Handmade oak coasters, set of 4',
});
```

- `instructions` become the system prompt (optional); images (PNG, JPEG,
  WebP, GIF) go before the prompt.
- `effort` (`low` … `max`) sets `output_config.effort`; left out, the
  model's default applies. For short rewrites, `low` is usually enough.
- On models that support it (Claude Fable 5.1, Opus 5.5, Opus 5, Sonnet
  5.5) the request opts into the server-side refusal fallback
  (`fallbacks: "default"`), so a declined request is re-run on a fallback
  model in the same call. Pass `refusalFallback: false` to turn it off. A
  request still declined comes back as an error naming the category.
- API errors come back with their status and Anthropic's message (401 says
  the key is wrong, 404 to check the model). Credentials come only from
  `apiKey`; the SDK isn't allowed to fall back to `ANTHROPIC_AUTH_TOKEN`.
- `timeoutMs` (default 120 s) and `signal` cancel the request itself.
- Without the SDK installed, it returns an error naming the package. The
  `./claude` subpath is kept out of the main entry.

### Choosing providers from configuration

Use `checkProviderHost` and `parseAllowedHosts` with your own settings:

```ts
const allowedHosts = parseAllowedHosts(env.AI_ALLOWED_HOSTS); // "gpu-box, 192.168.1.20"
const host = checkProviderHost('COMFYUI_HOST', env.COMFYUI_HOST, {
  allowedHosts,
  allowedHostsLabel: 'AI_ALLOWED_HOSTS',
});
```

### Writing a provider

Implement either interface:

```ts
interface TextGenerator {
  readonly provider: string;
  readonly model: string;
  generateText(request: TextRequest): Promise<Result<{ text: string }>>;
}

interface ImageGenerator {
  readonly provider: string;
  readonly model: string;
  listModes(): Promise<Result<readonly string[]>>;
  generateImage(
    request: ImageRequest
  ): Promise<Result<{ image: AiImage; notes: string | null }>>;
}
```

`callProvider`, `readJson` and `providerMessage` give a new provider the
same timeouts, cancellation (`signal`) and error wording as the built-in
ones. Every provider takes an injectable `fetch`, so it can be tested
without a network.

## Exports

| Subpath     | What                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------- |
| `.`         | everything below except `./gemini`, `./claude` and `./node`                                     |
| `./ollama`  | `OllamaTextGenerator`, `stripThinking`                                                          |
| `./comfyui` | `ComfyUiImageGenerator`, `parseWorkflow`, `fillWorkflow`, `readHistory`, `memoryWorkflowSource` |
| `./gemini`  | `GeminiTextGenerator`, `GeminiImageGenerator` (needs `@richardmcquiston01/gemini-icon-gen`)     |
| `./claude`  | `ClaudeTextGenerator` (needs `@anthropic-ai/sdk`)                                               |
| `./node`    | `directoryWorkflowSource` (Node/Bun only)                                                       |

## Development

```bash
bun install
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run build      # dist/: ESM (.js), CommonJS (.cjs) and .d.ts/.d.cts
```

Releases are published to npm by GitHub Actions when a `vX.Y.Z` tag is
pushed on a commit that's on `main`. The repository needs the `NPM_TOKEN`
secret. See [CLAUDE.md](./CLAUDE.md) for the branch flow.

## Buy Me a Coffee

If this app, code, or repository has helped you or someone you know, please consider donating. I appreciate any help to offset the costs of development and/or AI Credits.

[**Donate via Stripe**](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800), or scan:

[![Donate via Stripe](./donate.svg)](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800)

## License

Apache 2

## Copyright

<!-- prettier-ignore -->
(c)2026 Richard McQuiston.  All rights reserved.
