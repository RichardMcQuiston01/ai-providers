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
- **Grok** (`GrokTextGenerator`, `GrokImageGenerator`): text and photo
  edits with xAI's API; text uses the optional `openai` peer pointed at
  api.x.ai, images use plain `fetch`.
- **fal** (`FalImageGenerator`): image edits with any fal model (FLUX and
  more) through fal's queue, over plain `fetch` (no SDK needed).
- **OpenAI-compatible text** (`OpenRouterTextGenerator`,
  `LmStudioTextGenerator`, `VllmTextGenerator`, `LlamaCppTextGenerator`,
  `OpenAiCompatibleTextGenerator`): text from OpenRouter or a local server
  that speaks OpenAI's protocol, through the optional `openai` peer.
- **Replicate** (`ReplicateImageGenerator`): image edits with any Replicate
  image model, over plain `fetch` (no SDK needed).
- **OpenAI** (`OpenAiTextGenerator`, `OpenAiImageGenerator`): captions and
  photo edits with OpenAI's API, using the official `openai` package as an
  optional peer dependency.

Design:

- **Results, not exceptions.** Every call returns
  `{ ok: true, value } | { ok: false, error }`. Errors are specific: they
  name the provider, the model or workflow, the HTTP status and the
  provider's own message.
- **No surprise redirects.** Provider calls ask `fetch` not to follow
  redirects (a redirect would carry your prompt and image to another
  address), so a redirect comes back as an error naming where it pointed.
  The one exception is Replicate's output download, which follows a
  redirect only to another `replicate.delivery` address. Reply bodies are
  read with a size cap, and a bad `timeoutMs` is an error, not an exception.
- **Returned images are checked.** Every image provider returns PNG, JPEG
  or WebP only, and `mimeType` comes from the image's own bytes, never from
  a type the provider or server declared. Anything else (SVG, GIF, HTML, a
  truncated file) is an error. `sniffImageType` and `checkImageOutput` are
  exported for your own use.
- **Providers only generate.** Prompt rules, output checks and the decision
  to use a result stay in your app, so swapping providers can't weaken
  them.
- **Local by default.** The Ollama and ComfyUI generators run
  `checkProviderHost` on their `host`: only this machine is accepted, unless
  the host is in `allowedHosts`. A URL with a username or password is
  refused, and error messages never repeat the URL you gave.
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
  OllamaTextGenerator,
  parseAllowedHosts,
  type TextGenerator,
} from '@richardmcquiston01/ai-providers';

// The host defaults to http://127.0.0.1:11434. Anything else must be listed
// in allowedHosts, or generateText returns an error before sending anything.
const text: TextGenerator = new OllamaTextGenerator({
  model: 'llama3.2',
  host: 'http://gpu-box:11434',
  allowedHosts: parseAllowedHosts('gpu-box'),
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

   | Placeholder         | Where                                      | Filled with                                                                                               |
   | ------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
   | `"{{INPUT_IMAGE}}"` | the LoadImage node's `image` (required)    | the uploaded image                                                                                        |
   | `{{PROMPT}}`        | anywhere inside a text value               | `request.instructions`, a blank line, then `request.prompt` (just the prompt when instructions are blank) |
   | `"{{SEED}}"`        | a sampler's `seed` (optional, whole value) | a random number on each run                                                                               |

```ts
import { ComfyUiImageGenerator } from '@richardmcquiston01/ai-providers';
import { directoryWorkflowSource } from '@richardmcquiston01/ai-providers/node';

const image = new ComfyUiImageGenerator({
  workflows: directoryWorkflowSource('comfyui-workflows'), // touch-up.json → mode "touch-up" (symbolic links are not followed)
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

### Image edits with Replicate

Replicate is a hosted API with its own token (create one at
replicate.com/account/api-tokens). It needs no extra package; it runs on
`fetch`, so the main entry and the `./replicate` subpath both export it.

```ts
import { ReplicateImageGenerator } from '@richardmcquiston01/ai-providers/replicate';

const apiKey: string = env.REPLICATE_API_TOKEN; // your app reads the token; the package never does

// black-forest-labs/flux-kontext-pro unless you pass model
const images = new ReplicateImageGenerator({ apiKey });
const edited = await images.generateImage({
  instructions: 'Keep the product unchanged.',
  prompt: 'Place it on a bright kitchen counter.',
  images: [{ mimeType: 'image/png', data: photoBytes }],
  mode: null,
});
```

- `model` is `owner/name` (its latest version) or `owner/name:version`.
- Models name their inputs differently. The defaults are `prompt` and
  `input_image`; set `promptInput` and `imageInput` for other models,
  `referenceImagesInput` to accept extra reference images (a list), and
  `input` for fixed extras such as `{ output_format: 'png' }`.
- It creates a prediction, waits (the first request is held open for up to
  30 s), polls every 2 s, then downloads the output. Replicate has no
  system prompt, so `instructions` lead the prompt.
- A prediction that runs past `runTimeoutMs` (default 5 minutes), or whose
  `signal` is aborted, is cancelled on Replicate too, so it stops costing
  money. `timeoutMs` (default 120 s) limits each HTTP call.
- The output is only downloaded from HTTPS `replicate.delivery`, without
  your token. Output must be PNG, JPEG or WebP.
- Errors give the status and Replicate's message (a failed prediction
  includes the model's own error).

### Image edits with fal

fal is a hosted API with its own key (create one at fal.ai/dashboard/keys).
It needs no extra package; it runs on `fetch`, so the main entry and the
`./fal` subpath both export it.

```ts
import { FalImageGenerator } from '@richardmcquiston01/ai-providers/fal';

const apiKey: string = env.FAL_KEY; // your app reads the key; the package never does

// fal-ai/flux-pro/kontext unless you pass model
const images = new FalImageGenerator({ apiKey });
const edited = await images.generateImage({
  instructions: 'Keep the product unchanged.',
  prompt: 'Place it on a bright kitchen counter.',
  images: [{ mimeType: 'image/png', data: photoBytes }],
  mode: null,
});
```

- `model` is fal's endpoint id, e.g. `fal-ai/flux-pro/kontext`.
- Models name their inputs differently. The defaults are `prompt` and
  `image_url`; set `promptInput` and `imageInput` for other models,
  `referenceImagesInput` to accept extra reference images (a list), and
  `input` for fixed extras such as `{ output_format: 'png' }`.
- It submits the request to fal's queue, polls its status every second, reads
  the result, then downloads the first image. fal has no system prompt, so
  `instructions` lead the prompt.
- A request that runs past `runTimeoutMs` (default 5 minutes), or whose
  `signal` is aborted, is cancelled on fal too. `timeoutMs` (default 120 s)
  limits each HTTP call.
- The key is only sent to `queue.fal.run`: the status, result and cancel URLs
  fal returns must be on that host. Output is only downloaded from HTTPS
  `fal.media` or `fal.run` (and their subdomains), without your key; add
  others with `outputHosts`. Output must be PNG, JPEG or WebP.
- Errors give the status and fal's message.

### Text from OpenRouter and local OpenAI-compatible servers

These use OpenAI's Chat Completions protocol through the optional `openai`
package:

```bash
bun add @richardmcquiston01/ai-providers openai
```

```ts
import {
  LlamaCppTextGenerator,
  LmStudioTextGenerator,
  OpenRouterTextGenerator,
  VllmTextGenerator,
} from '@richardmcquiston01/ai-providers/openai-compatible';

// Hosted: one OpenRouter key for many models (openrouter/auto unless you pass model).
const hosted = new OpenRouterTextGenerator({
  apiKey, // from openrouter.ai/keys; your app reads it, the package never does
  model: 'anthropic/claude-sonnet-5-5',
  appUrl: 'https://shop.example', // optional attribution headers
  appName: 'My Shop',
});

// Local: a model name is required; the host defaults to the server's usual port.
const lmStudio = new LmStudioTextGenerator({ model: 'qwen2.5-7b-instruct' }); // :1234
const vllm = new VllmTextGenerator({ model: 'my-served-model' }); // :8000
const llamaCpp = new LlamaCppTextGenerator({ model: 'any' }); // :8080
```

- Local servers are checked like Ollama: only this machine is accepted
  unless the host is in `allowedHosts`, a URL with a password is refused,
  and a bad host makes `generateText` return an error before anything is
  sent. `apiPath` (default `/v1`) is where the API lives on the host.
- Local servers need no key. Pass `apiKey` if you started yours with one.
  The `openai` SDK is never allowed to read `OPENAI_API_KEY`,
  `OPENAI_BASE_URL` or other OpenAI environment settings.
- `OpenAiCompatibleTextGenerator` covers any other such server (Jan,
  LocalAI, …); give it `host` and `model`, and optionally a `name`.
- Behavior is the same as the OpenAI provider: `instructions` are the system
  message, images (PNG, JPEG, WebP) go before the prompt, and a refusal is
  an error. Whether a model accepts images depends on the model and server.
- Without the `openai` package installed, it returns an error naming it. The
  `./openai-compatible` subpath is kept out of the main entry.

### Text and images with Grok

Grok is xAI's hosted API with its own key (create one at console.x.ai).
Text uses xAI's OpenAI-compatible endpoint, so it needs the `openai`
package; images run on plain `fetch`.

```bash
bun add @richardmcquiston01/ai-providers openai
```

```ts
import {
  GrokImageGenerator,
  GrokTextGenerator,
} from '@richardmcquiston01/ai-providers/grok';

const apiKey: string = env.XAI_API_KEY; // your app reads the key; the package never does

const text = new GrokTextGenerator({ apiKey }); // grok-4 unless you pass model
const reply = await text.generateText({
  instructions: 'Rewrite captions to be short and friendly.',
  prompt: 'Handmade oak coasters, set of 4',
});

const images = new GrokImageGenerator({ apiKey }); // grok-imagine-image unless you pass model
const edited = await images.generateImage({
  instructions: 'Keep the product unchanged.',
  prompt: 'Place it on a bright kitchen counter.',
  images: [{ mimeType: 'image/png', data: photoBytes }],
  mode: null,
});
```

- Text works like the OpenAI provider: `instructions` are the system
  message, images (PNG, JPEG, WebP) go before the prompt, and a refusal is
  an error. The endpoint is fixed to api.x.ai; the SDK can't fall back to
  `OPENAI_BASE_URL` or other OpenAI environment settings.
- Images call `POST /v1/images/edits` with a JSON body (the `openai`
  SDK's `images.edit` sends multipart form data, which xAI doesn't accept).
  It edits one image, so a request with reference images is refused.
  `instructions` lead the prompt.
- Model names change often; pass `model` to use another. The defaults
  haven't been checked against a live account.
- Errors give the status and xAI's message. `timeoutMs` (default 120 s) and
  `signal` apply to both.

### Text and images with OpenAI

OpenAI is a hosted API with its own key (create one at
platform.openai.com; a ChatGPT plan doesn't include API use). Install the
SDK alongside:

```bash
bun add @richardmcquiston01/ai-providers openai
```

```ts
import {
  OpenAiImageGenerator,
  OpenAiTextGenerator,
} from '@richardmcquiston01/ai-providers/openai';

const apiKey: string = env.OPENAI_API_KEY; // your app reads the key; the package never does

const text = new OpenAiTextGenerator({ apiKey }); // gpt-5.5 unless you pass model
const reply = await text.generateText({
  instructions: 'Rewrite captions to be short and friendly.',
  prompt: 'Handmade oak coasters, set of 4',
});

const images = new OpenAiImageGenerator({ apiKey }); // gpt-image-2 unless you pass model
const edited = await images.generateImage({
  instructions: 'Keep the product unchanged.',
  prompt: 'Place it on a bright kitchen counter.',
  images: [{ mimeType: 'image/png', data: photoBytes }],
  mode: null,
});
```

- Text uses Chat Completions: `instructions` become the system message;
  images (PNG, JPEG, WebP) go before the prompt. A refusal comes back as an
  error carrying the model's explanation.
- Images use `images.edit`: the first image is edited, any others are
  references. It has no system prompt, so `instructions` lead the prompt.
  There is one mode, named after the model. `quality` (`low` … `high`) is
  optional.
- API errors come back with their status and OpenAI's message (401 says
  the key is wrong, 404 to check the model). Credentials and the endpoint
  come only from the options; the SDK isn't allowed to fall back to
  `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` or `OPENAI_BASE_URL`.
- `timeoutMs` (default 120 s) and `signal` cancel the request itself.
- Without the SDK installed, it returns an error naming the package. The
  `./openai` subpath is kept out of the main entry.

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

| Subpath       | What                                                                                                     |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| `.`           | everything below except `./gemini`, `./claude`, `./openai`, `./grok`, `./openai-compatible` and `./node` |
| `./ollama`    | `OllamaTextGenerator`, `stripThinking`                                                                   |
| `./comfyui`   | `ComfyUiImageGenerator`, `parseWorkflow`, `fillWorkflow`, `readHistory`, `memoryWorkflowSource`          |
| `./gemini`    | `GeminiTextGenerator`, `GeminiImageGenerator` (needs `@richardmcquiston01/gemini-icon-gen`)              |
| `./claude`    | `ClaudeTextGenerator` (needs `@anthropic-ai/sdk`)                                                        |
| `./fal`       | `FalImageGenerator`                                                                                      |
| `./replicate` | `ReplicateImageGenerator`                                                                                |
| `./openai`    | `OpenAiTextGenerator`, `OpenAiImageGenerator` (needs `openai`)                                           |
| `./node`      | `directoryWorkflowSource` (Node/Bun only)                                                                |

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
