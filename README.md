# @richardmcquiston01/ai-providers

<!-- prettier-ignore-start -->
- Author:  Richard McQuiston
- Website:  https://richardmcquiston.com/
<!-- prettier-ignore-end -->

Swappable AI providers for TypeScript. Your app codes against two small
interfaces: `TextGenerator` for text and `ImageGenerator` for image edits.
You choose the provider for each task in configuration: a local model today,
a hosted API tomorrow, without changing the calling code.

- **Results, not exceptions.** Every call returns
  `{ ok: true, value } | { ok: false, error }`. Errors are specific: they
  name the provider, the model or workflow, the HTTP status and the
  provider's own message.
- **Providers only generate.** Prompt rules, output checks and the decision
  to use a result stay in your app, so swapping providers can't weaken them.
- **Returned images are checked.** Image providers return PNG, JPEG or WebP
  only, and `mimeType` comes from the image's own bytes, never from a type
  the provider declared. Anything else (SVG, GIF, HTML, a truncated file) is
  an error.
- **Local by default.** Providers that talk to a local server only accept
  this machine unless you list the host. A URL with a username or password
  is refused, and messages never repeat the URL you gave.
- **No surprise redirects.** A redirect would carry your prompt and image to
  another address, so it comes back as an error naming where it pointed.
  Reply bodies are read with a size cap, and a bad `timeoutMs` is an error,
  not an exception.
- **Keys are yours.** Keys are passed in as options. The package never reads
  the environment, and never lets an SDK fall back to environment settings.
- **Runtime-neutral.** The main entry runs in Node 20.3+, Bun and browsers,
  and ships as ESM and CommonJS with types.

## Install

```bash
bun add @richardmcquiston01/ai-providers
```

A few providers use an official SDK as an **optional peer dependency**. Add
it only if you use that provider; without it you get an error naming the
package, never a crash at import time.

| Provider                                                  | Install alongside                     |
| --------------------------------------------------------- | ------------------------------------- |
| OpenAI, Grok text, OpenRouter, LM Studio, vLLM, llama.cpp | `openai`                              |
| Claude                                                    | `@anthropic-ai/sdk`                   |
| Gemini                                                    | `@richardmcquiston01/gemini-icon-gen` |
| Everything else                                           | nothing (plain `fetch`)               |

## Quick start

Every text provider has `generateText`; every image provider has
`generateImage` and `listModes`:

```ts
import {
  OllamaTextGenerator,
  StabilityImageGenerator,
  type ImageGenerator,
  type TextGenerator,
} from '@richardmcquiston01/ai-providers';

const text: TextGenerator = new OllamaTextGenerator({ model: 'llama3.2' });
const caption = await text.generateText({
  instructions: 'Rewrite the caption. No emojis. Keep the link.',
  prompt: 'Handmade ink pad holder - $20 https://www.etsy.com/listing/1',
});
if (caption.ok) console.log(caption.value.text);
else console.error(caption.error); // e.g. Ollama (model "llama3.2") failed (HTTP 404): model not found

const image: ImageGenerator = new StabilityImageGenerator({ apiKey });
const edited = await image.generateImage({
  instructions: 'Keep the product unchanged.',
  prompt: 'Place it on a bright kitchen counter.',
  images: [{ mimeType: 'image/png', data: photoBytes }], // the image to edit, then any references
  mode: null, // null = the provider's default; listModes() lists the others
});
if (edited.ok) save(edited.value.image.data, edited.value.image.mimeType);
else console.error(edited.error);
```

Every provider takes `timeoutMs` (default 120 s), a `signal` on each request,
and an injectable `fetch` for tests.

### Choose providers from settings

`createProviders` turns plain settings (a settings file, a form) into
generators, so an app doesn't write the same switch. `provider` names the
provider and the rest are that provider's own options.

```ts
import { createProviders } from '@richardmcquiston01/ai-providers/providers';

const built = createProviders({
  text: { provider: 'ollama', model: 'llama3.2' },
  image: { provider: 'stability', apiKey: settings.stabilityKey },
});
if (!built.ok) throw new Error(built.error); // e.g. an unknown provider name
const { text, image } = built.value; // each null when not configured
```

- `createTextGenerator` and `createImageGenerator` build one of each;
  `TEXT_PROVIDERS` and `IMAGE_PROVIDERS` list the accepted names for a
  dropdown. An unknown name is an error that lists the valid ones.
- `provider: 'comfyui'` needs a `workflows` source; the `openai-compatible`
  text provider needs a `host`.
- The `./providers` subpath imports every provider, so it is kept out of the
  main entry. The optional peers still load only when a provider that needs
  one is used.

## Providers

| Provider                | Text | Image | Where  | Subpath               | Checked live |
| ----------------------- | :--: | :---: | ------ | --------------------- | :----------: |
| Ollama                  |  ✓   |       | local  | `./ollama`            |      ✓       |
| ComfyUI                 |      |   ✓   | local  | `./comfyui`           |      ✓       |
| Stable Diffusion web UI |      |   ✓   | local  | `./sdwebui`           |              |
| llama.cpp               |  ✓   |       | local  | `./openai-compatible` |      ✓       |
| LM Studio, vLLM         |  ✓   |       | local  | `./openai-compatible` |              |
| OpenAI                  |  ✓   |   ✓   | hosted | `./openai`            |      ✓       |
| Gemini                  |  ✓   |   ✓   | hosted | `./gemini`            |      ✓       |
| Grok (xAI)              |  ✓   |   ✓   | hosted | `./grok`              |              |
| Claude                  |  ✓   |       | hosted | `./claude`            |              |
| OpenRouter              |  ✓   |       | hosted | `./openai-compatible` |              |
| Replicate               |      |   ✓   | hosted | `./replicate`         |      ✓       |
| fal                     |      |   ✓   | hosted | `./fal`               |              |
| Black Forest Labs       |      |   ✓   | hosted | `./bfl`               |              |
| Stability AI            |      |   ✓   | hosted | `./stability`         |              |

"Checked live" means run once against the real service with the
[live-API check](#live-api-check). The others are tested against a fake
`fetch` only, so their endpoint paths and field names come from the
providers' documentation. Reports of anything that doesn't match are welcome.

## Local providers

### Ollama

Text from a local model (`POST /api/chat`, not streamed).

```ts
import {
  OllamaTextGenerator,
  listOllamaModels,
  parseAllowedHosts,
} from '@richardmcquiston01/ai-providers';

// The host defaults to http://127.0.0.1:11434. Anything else must be listed
// in allowedHosts, or generateText returns an error before sending anything.
const text = new OllamaTextGenerator({
  model: 'llama3.2',
  host: 'http://gpu-box:11434',
  allowedHosts: parseAllowedHosts('gpu-box'),
});

// For a settings dropdown: the models the host has pulled, sorted.
const models = await listOllamaModels({
  host: 'http://gpu-box:11434',
  allowedHosts: parseAllowedHosts('gpu-box'),
});
if (models.ok) console.log(models.value); // ['llama3.2:latest', 'qwen3:8b']
```

- A reasoning model's `<think>…</think>` block is removed from the reply.
  Pass `images` to send pictures to a vision model.
- `listOllamaModels` needs no model, so it works before one is chosen. A
  generator also has `listModels()` for its own host.

### ComfyUI

Image edits with your own exported workflows. See
[Setting up ComfyUI](./CONFIGURATION.md#setting-up-comfyui) for the full
walkthrough and a [sample workflow](./examples/comfyui/image-edit.json).

1. Build a workflow with a **LoadImage** node and a **SaveImage** node.
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
```

- The image is uploaded and the workflow queued. Its history is then polled
  (5-minute limit, `runTimeoutMs`) and the first saved output downloaded
  (25 MB cap). A run that is aborted or runs too long is removed from
  ComfyUI's queue, or interrupted if it is the one running.
- Placeholders are filled in the parsed JSON, so a prompt can't break the
  workflow. Symbolic links in the workflows folder are not followed.
- In a browser, or for workflows bundled with your app, use
  `memoryWorkflowSource({ 'touch-up': jsonText })` instead.
- The host defaults to `http://127.0.0.1:8188` and follows the same rules as
  Ollama's.
- A plain image-to-image workflow redraws the picture from your prompt; it
  doesn't follow edit instructions the way hosted editing models do, so
  describe the result you want.

### Stable Diffusion web UI

`SdWebUiImageGenerator` talks to an AUTOMATIC1111 or Forge web UI started
with `--api` (`POST /sdapi/v1/img2img`). It needs no key.

```ts
import { SdWebUiImageGenerator } from '@richardmcquiston01/ai-providers/sdwebui';

// host defaults to http://127.0.0.1:7860; the loaded checkpoint is used unless you pass model
const image = new SdWebUiImageGenerator({
  denoisingStrength: 0.5,
  input: { steps: 25, negative_prompt: 'blurry' },
});
```

- Modes are `img2img` (the default) and `inpaint`, which takes a mask as the
  second image (white = redraw, black = keep).
- A PNG input keeps its own size; pass `width` and `height` for other
  inputs, or the web UI falls back to 512 x 512. `instructions` lead the
  prompt.
- Send `negative_prompt`, `steps`, `cfg_scale`, `sampler_name`, `seed` and
  other fields with `input`; the fields the generator sets itself can't be
  overridden. `model` switches the checkpoint for the call.
- There is no job to cancel: the API's interrupt stops whatever the server
  is running, so a timeout or abort stops waiting and leaves the web UI to
  finish. Raise `timeoutMs` for slow GPUs.

### LM Studio, vLLM, llama.cpp and other OpenAI-compatible servers

Text from local servers that speak OpenAI's Chat Completions protocol, and
from OpenRouter (below), through the optional `openai` package.

```ts
import {
  LlamaCppTextGenerator,
  LmStudioTextGenerator,
  OpenAiCompatibleTextGenerator,
  VllmTextGenerator,
} from '@richardmcquiston01/ai-providers/openai-compatible';

// A model name is required; the host defaults to the server's usual port.
const lmStudio = new LmStudioTextGenerator({ model: 'qwen2.5-7b-instruct' }); // :1234
const vllm = new VllmTextGenerator({ model: 'my-served-model' }); // :8000
const llamaCpp = new LlamaCppTextGenerator({ model: 'any' }); // :8080

// Anything else (Jan, LocalAI, ...): host and model are required.
const other = new OpenAiCompatibleTextGenerator({
  host: 'http://127.0.0.1:5000',
  model: 'my-model',
  name: 'jan',
});
```

- Hosts are checked like Ollama's. `apiPath` (default `/v1`) is where the API
  lives on the host.
- Local servers need no key. Pass `apiKey` if you started yours with one.
- Behavior matches the OpenAI provider: `instructions` are the system
  message, images (PNG, JPEG, WebP) go before the prompt, and a refusal is an
  error. Whether a model accepts images depends on the model and server.

## Hosted providers

Each needs its own key, passed as `apiKey`. A hosted provider sends your
prompts and images to that company, and API use is billed separately from
any chat plan.

### OpenAI

Create a key at platform.openai.com.

```ts
import {
  OpenAiImageGenerator,
  OpenAiTextGenerator,
} from '@richardmcquiston01/ai-providers/openai';

const text = new OpenAiTextGenerator({ apiKey }); // gpt-5.5 unless you pass model
const image = new OpenAiImageGenerator({ apiKey }); // gpt-image-2 unless you pass model
```

- Text uses Chat Completions: `instructions` become the system message;
  images (PNG, JPEG, WebP) go before the prompt. A refusal comes back as an
  error carrying the model's explanation.
- Images use `images.edit`: the first image is edited, any others are
  references. `instructions` lead the prompt. There is one mode, named after
  the model. `quality` (`low` … `high`) is optional.
- Credentials and the endpoint come only from the options; the SDK isn't
  allowed to fall back to `OPENAI_ORG_ID`, `OPENAI_PROJECT_ID` or
  `OPENAI_BASE_URL`.

### Gemini

Create a key in Google AI Studio.

```ts
import {
  GeminiImageGenerator,
  GeminiTextGenerator,
} from '@richardmcquiston01/ai-providers/gemini';

const text = new GeminiTextGenerator({ apiKey }); // gemini-3.8-flash unless you pass model
const image = new GeminiImageGenerator({ apiKey }); // gemini-2.5-flash-image
```

- Text needs non-empty `instructions` (its system instruction) and doesn't
  take images yet.
- Images must be PNG, JPEG or WebP. Any text Gemini sends with an image comes
  back as `notes`. There is one mode, named after the model.
- The underlying request can't be aborted, so `timeoutMs` and `signal` stop
  waiting for it and abandon it rather than cancelling it.

### Grok (xAI)

Create a key at console.x.ai. Text uses xAI's OpenAI-compatible endpoint (so
it needs `openai`); images run on plain `fetch`.

```ts
import {
  GrokImageGenerator,
  GrokTextGenerator,
} from '@richardmcquiston01/ai-providers/grok';

const text = new GrokTextGenerator({ apiKey }); // grok-4 unless you pass model
const image = new GrokImageGenerator({ apiKey }); // grok-imagine-image unless you pass model
```

- Text works like the OpenAI provider. The endpoint is fixed to api.x.ai.
- Images call `POST /v1/images/edits` with a JSON body, edit one image (a
  request with references is refused), and `instructions` lead the prompt.
- Model names change often; pass `model` to use another.

### Claude

Create a key in the Claude Console.

```ts
import { ClaudeTextGenerator } from '@richardmcquiston01/ai-providers/claude';

const text = new ClaudeTextGenerator({ apiKey }); // claude-opus-5-5 unless you pass model
```

- `instructions` become the system prompt (optional); images (PNG, JPEG,
  WebP, GIF) go before the prompt.
- `effort` (`low` … `max`) sets `output_config.effort`; left out, the model's
  default applies. For short rewrites, `low` is usually enough.
- On models that support it, the request opts into the server-side refusal
  fallback, so a declined request is re-run on a fallback model in the same
  call. Pass `refusalFallback: false` to turn it off. A request still
  declined comes back as an error naming the category.
- Credentials come only from `apiKey`; the SDK isn't allowed to fall back to
  `ANTHROPIC_AUTH_TOKEN`.

### OpenRouter

One key (openrouter.ai/keys) for many models. Text only.

```ts
import { OpenRouterTextGenerator } from '@richardmcquiston01/ai-providers/openai-compatible';

const text = new OpenRouterTextGenerator({
  apiKey,
  model: 'anthropic/claude-sonnet-5-5', // openrouter/auto unless you pass model
  appUrl: 'https://shop.example', // optional attribution headers
  appName: 'My Shop',
});
```

It behaves like the other OpenAI-compatible providers above.

### Replicate

Create a token at replicate.com/account/api-tokens.

```ts
import { ReplicateImageGenerator } from '@richardmcquiston01/ai-providers/replicate';

// black-forest-labs/flux-kontext-pro unless you pass model
const image = new ReplicateImageGenerator({ apiKey });
```

- `model` is `owner/name` (its latest version) or `owner/name:version`.
- Models name their inputs differently. The defaults are `prompt` and
  `input_image`; set `promptInput` and `imageInput` for other models,
  `referenceImagesInput` to accept extra reference images (a list), and
  `input` for fixed extras such as `{ output_format: 'png' }`.
- It creates a prediction, waits, polls every 2 s, then downloads the output.
  `instructions` lead the prompt.
- A prediction that runs past `runTimeoutMs` (default 5 minutes), or whose
  `signal` is aborted, is cancelled on Replicate too, so it stops costing
  money.
- The output is only downloaded from HTTPS `replicate.delivery`, without your
  token.

### fal

Create a key at fal.ai/dashboard/keys.

```ts
import { FalImageGenerator } from '@richardmcquiston01/ai-providers/fal';

// fal-ai/flux-pro/kontext unless you pass model (any fal endpoint id)
const image = new FalImageGenerator({ apiKey });
```

- The defaults are `prompt` and `image_url`; set `promptInput`, `imageInput`,
  `referenceImagesInput` and `input` for other models, as with Replicate.
- It submits to fal's queue, polls the status every second, reads the result,
  then downloads the first image. `instructions` lead the prompt.
- A request that runs past `runTimeoutMs` (default 5 minutes), or whose
  `signal` is aborted, is cancelled on fal too.
- The key is only sent to `queue.fal.run`. Output is only downloaded from
  HTTPS `fal.media` or `fal.run` (and their subdomains), without your key;
  add others with `outputHosts`.

### Black Forest Labs

Create a key at dashboard.bfl.ai. FLUX Kontext straight from the maker.

```ts
import { BflImageGenerator } from '@richardmcquiston01/ai-providers/bfl';

// flux-kontext-pro unless you pass model (e.g. flux-kontext-max)
const image = new BflImageGenerator({
  apiKey,
  input: { output_format: 'png' },
});
```

- It submits a task, polls the task's URL every second until it is `Ready`,
  then downloads the image. `instructions` lead the prompt.
- The defaults are `prompt` and `input_image`; change `promptInput` and
  `imageInput` for other models, name one field per extra reference image in
  `referenceImageInputs` (e.g. `['input_image_2']`), and send fixed extras
  with `input`.
- Moderation, errors and expired tasks come back as errors that say which.
  **BFL has no cancel call**, so a task you stop waiting for (`runTimeoutMs`,
  default 5 minutes, or an aborted `signal`) may still run and be billed.
- The key is only sent to `bfl.ai`. Output is only downloaded from HTTPS
  `bfl.ai` subdomains, without your key; add others with `outputHosts`.

### Stability AI

Create a key at platform.stability.ai.

```ts
import { StabilityImageGenerator } from '@richardmcquiston01/ai-providers/stability';

// sd3.5-large unless you pass model; strength 0.6 unless you pass strength
const image = new StabilityImageGenerator({ apiKey, strength: 0.5 });
```

- `listModes()` returns `image-to-image` (the default), `structure`,
  `search-and-replace`, `search-and-recolor` and `remove-background`.
  `search-and-replace` needs `searchPrompt` (what to find; the prompt is what
  replaces it) and `search-and-recolor` needs `selectPrompt`.
- Each call is one request and one reply, so there is nothing to poll or
  cancel; a timeout or aborted `signal` drops the connection. They edit one
  image (a request with references is refused), and `instructions` lead the
  prompt.
- Send fixed extras (`negative_prompt`, `seed`, `style_preset`, ...) with
  `input`. The fields the generator sets itself can't be overridden.
- A result Stability filters (`CONTENT_FILTERED`) comes back as an error. The
  key is only sent to `api.stability.ai`.

## Hosts and allow lists

Providers that talk to a server you run (Ollama, ComfyUI, the web UI, the
OpenAI-compatible servers) run `checkProviderHost` on their `host`: only this
machine is accepted, unless the host is in `allowedHosts`. Use it, and
`parseAllowedHosts`, with your own settings:

```ts
const allowedHosts = parseAllowedHosts(env.AI_ALLOWED_HOSTS); // "gpu-box, 192.168.1.20"
const host = checkProviderHost('COMFYUI_HOST', env.COMFYUI_HOST, {
  allowedHosts,
  allowedHostsLabel: 'AI_ALLOWED_HOSTS',
});
```

## Writing a provider

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

`callProvider`, `readJson`, `downloadImage` and `providerMessage` give a new
provider the same timeouts, cancellation (`signal`) and error wording as the
built-in ones. Every provider takes an injectable `fetch`, so it can be
tested without a network.

## Exports

| Subpath               | What                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`                   | everything below except `./gemini`, `./claude`, `./openai`, `./grok`, `./openai-compatible`, `./providers` and `./node`                            |
| `./ollama`            | `OllamaTextGenerator`, `listOllamaModels`, `stripThinking`                                                                                         |
| `./comfyui`           | `ComfyUiImageGenerator`, `parseWorkflow`, `fillWorkflow`, `readHistory`, `memoryWorkflowSource`                                                    |
| `./sdwebui`           | `SdWebUiImageGenerator`                                                                                                                            |
| `./replicate`         | `ReplicateImageGenerator`                                                                                                                          |
| `./fal`               | `FalImageGenerator`                                                                                                                                |
| `./bfl`               | `BflImageGenerator`                                                                                                                                |
| `./stability`         | `StabilityImageGenerator`                                                                                                                          |
| `./gemini`            | `GeminiTextGenerator`, `GeminiImageGenerator` (needs `@richardmcquiston01/gemini-icon-gen`)                                                        |
| `./claude`            | `ClaudeTextGenerator` (needs `@anthropic-ai/sdk`)                                                                                                  |
| `./openai`            | `OpenAiTextGenerator`, `OpenAiImageGenerator` (needs `openai`)                                                                                     |
| `./grok`              | `GrokTextGenerator`, `GrokImageGenerator` (text needs `openai`)                                                                                    |
| `./openai-compatible` | `OpenRouterTextGenerator`, `LmStudioTextGenerator`, `VllmTextGenerator`, `LlamaCppTextGenerator`, `OpenAiCompatibleTextGenerator` (needs `openai`) |
| `./providers`         | `createProviders`, `createTextGenerator`, `createImageGenerator`, `TEXT_PROVIDERS`, `IMAGE_PROVIDERS`                                              |
| `./node`              | `directoryWorkflowSource` (Node/Bun only)                                                                                                          |

The main entry also exports the shared pieces: `Result`, `ok`, `err`,
`callProvider`, `readJson`, `checkProviderHost`, `parseAllowedHosts`,
`sniffImageType` and `checkImageOutput`.

## Development

```bash
bun install
bun run typecheck
bun run lint
bun run format:check
bun run test
bun run build      # dist/: ESM (.js), CommonJS (.cjs) and .d.ts/.d.cts
```

### Live-API check

To check providers against the real services, put the settings you have in a
git-ignored `.env` (the names are in `scripts/live-check.env.example`) and
run:

```bash
bun run live-check --list             # what would run, and what is missing
bun run live-check --run              # one call per provider that has settings
bun run live-check --run --only=fal,bfl,stability
```

Each provider gets one text call or one image edit (a generated test image,
or `--image=your.png`, with `--prompt="..."` to change what the edit asks for); nothing is retried. Hosted providers cost real
money. A provider without its settings is skipped, keys are never printed,
and images are saved in `live-check-output/` (git-ignored). The exit code is
1 if any check fails. [CONFIGURATION.md](./CONFIGURATION.md) explains every
setting.

### Releases

Releases are published to npm by GitHub Actions when a `vX.Y.Z` tag is pushed
on a commit that's on `main`. The repository needs the `NPM_TOKEN` secret.
See [CLAUDE.md](./CLAUDE.md) for the branch flow.

## Buy Me a Coffee

If this app, code, or repository has helped you or someone you know, please consider donating. I appreciate any help to offset the costs of development and/or AI Credits.

[**Donate via Stripe**](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800), or scan:

[![Donate via Stripe](./donate.svg)](https://donate.stripe.com/00w5kD3Gj1Xo9v7gVOcs800)

## License

Apache 2

## Copyright

<!-- prettier-ignore -->
(c)2026 Richard McQuiston.  All rights reserved.
