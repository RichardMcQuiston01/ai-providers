# Configuration

These are the settings for the live-API check (`bun run live-check`, see
[README](./README.md#live-api-check)). They are environment variables, read
from a git-ignored `.env` in the repository root (Bun loads it
automatically) or from your shell. Start from the template:

```bash
cp scripts/live-check.env.example .env
```

How they behave:

- **Everything is optional.** A check whose required settings are missing is
  skipped, so fill in only the providers you have.
- **Blank counts as unset.** `FAL_KEY=` is the same as leaving it out.
  Surrounding spaces are trimmed.
- **Keys are never printed**, and any key that appears in an error message
  is replaced with `***`.
- **The library itself never reads the environment.** Only this script
  does. In your own app, pass keys and hosts to the providers as options (or
  to `createProviders`).
- Hosted providers cost real money: one text call or one image edit per
  check. Local providers are free.

## Local providers

A host must be this machine (`127.0.0.1`, `localhost`, `::1`). For a
machine on your network, the script allows exactly the host you name; set it
as a full address with `http://` or `https://`, a port if needed, and no
path, username or password.

| Variable            | Required for | What it is                                                                                                                                                                     |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OLLAMA_MODEL`      | Ollama       | The model to chat with, as `ollama list` shows it, for example `llama3.2`. Also the switch that turns the Ollama checks on. The list check confirms it is pulled.              |
| `OLLAMA_HOST`       | optional     | Where Ollama runs. Default `http://127.0.0.1:11434`.                                                                                                                           |
| `LMSTUDIO_HOST`     | LM Studio    | Address of LM Studio's local server, usually `http://127.0.0.1:1234`.                                                                                                          |
| `LMSTUDIO_MODEL`    | LM Studio    | The model name the server reports (shown in LM Studio's server tab).                                                                                                           |
| `VLLM_HOST`         | vLLM         | Address of the vLLM server, usually `http://127.0.0.1:8000`.                                                                                                                   |
| `VLLM_MODEL`        | vLLM         | The model name vLLM serves (its `--served-model-name`, or the model id).                                                                                                       |
| `LLAMACPP_HOST`     | llama.cpp    | Address of `llama-server`, usually `http://127.0.0.1:8080`.                                                                                                                    |
| `LLAMACPP_MODEL`    | llama.cpp    | The model name sent with the request. `llama-server` serves the one model it loaded, so use that model's name.                                                                 |
| `SDWEBUI_HOST`      | Web UI       | Address of an AUTOMATIC1111 or Forge web UI started with `--api`, usually `http://127.0.0.1:7860`. Also the switch that turns the check on.                                    |
| `SDWEBUI_MODEL`     | optional     | A checkpoint to switch to for the call, as the web UI lists it (for example `sd_xl_base_1.0.safetensors`). Left blank, the loaded checkpoint is used.                          |
| `COMFYUI_WORKFLOWS` | ComfyUI      | The folder holding your ComfyUI workflows, in **API format**, with placeholders added. See [Setting up ComfyUI](#setting-up-comfyui). Also the switch that turns the check on. |
| `COMFYUI_MODE`      | optional     | Which workflow to run: the file name without `.json` (`edit-sky` for `edit-sky.json`). Left blank, the first workflow in the folder, sorted by name, is used.                  |
| `COMFYUI_HOST`      | optional     | Where ComfyUI runs. Default `http://127.0.0.1:8188`.                                                                                                                           |

## Setting up ComfyUI

The ComfyUI check needs a folder of workflows in a form the script can
fill in. The files ComfyUI saves by default won't work.

**1. Use API format, not a normal save.** ComfyUI's **Save** button writes the
editor's own format to `user/default/workflows`. The script rejects those
with `is a UI save, not the API format`. Export the workflow instead with
**Workflow → Export (API)** (older versions: enable Dev mode in the settings,
then **Save (API Format)**).

**2. Use a folder of its own.** Don't point `COMFYUI_WORKFLOWS` at
`user/default/workflows`: it holds your normal saves, and the script runs the
first file alphabetically. Make a new folder, for example
`F:/AI/ComfyUI/live-check-workflows`.

**3. Start from the sample, or add placeholders to your own.**
[`examples/comfyui/image-edit.json`](./examples/comfyui/image-edit.json) is a
plain image-to-image workflow made of core ComfyUI nodes. Copy it into the
folder and change `ckpt_name` in the `CheckpointLoaderSimple` node to the
exact file name of a checkpoint you have (as the Load Checkpoint node's list
shows it). It suits Stable Diffusion 1.5 and SDXL style checkpoints; for
other model families (Flux and so on), export your own and add the
placeholders below. The sample has not been run against a live ComfyUI by the
author; a test only checks that the library accepts and fills it.

| Placeholder       | Where it goes                                                                               | Required |
| ----------------- | ------------------------------------------------------------------------------------------- | -------- |
| `{{INPUT_IMAGE}}` | The whole value of the `LoadImage` node's `image`. The script uploads its test image there. | yes      |
| `{{PROMPT}}`      | The text of the positive `CLIPTextEncode`. It may sit inside a longer string.               | no       |
| `{{SEED}}`        | The whole value of the sampler's `seed`. It becomes a number.                               | no       |

The workflow also needs a `SaveImage` node, or ComfyUI finishes without an
image (`produced no image; add a SaveImage node`).

**4. Write the path with forward slashes, without quotes.** The variable is
`COMFYUI_WORKFLOWS`:

```
COMFYUI_WORKFLOWS=F:/AI/ComfyUI/live-check-workflows
```

Windows accepts forward slashes, and they avoid backslash escapes. Unquoted
backslashes also work, but backslashes inside double quotes can be read as
escape sequences, so avoid `"F:\AI\..."`. A misspelled variable name is
ignored without a warning and the check is skipped.

**5. Run it.** Start ComfyUI first (it listens on `http://127.0.0.1:8188` by
default; set `COMFYUI_HOST` otherwise), then:

```bash
bun run live-check --list                    # ComfyUI should say "ready"
bun run live-check --run --only=comfyui
```

Set `COMFYUI_MODE` to the file name (without `.json`) when the folder holds
more than one workflow.

## Hosted providers: keys

Each key switches on that provider's checks.

| Variable              | Provider          | Checks it runs                    | Where to get it                               |
| --------------------- | ----------------- | --------------------------------- | --------------------------------------------- |
| `GEMINI_API_KEY`      | Google Gemini     | text, image edit                  | Google AI Studio                              |
| `ANTHROPIC_API_KEY`   | Anthropic Claude  | text                              | Claude Console                                |
| `OPENAI_API_KEY`      | OpenAI            | text, image edit                  | platform.openai.com                           |
| `XAI_API_KEY`         | xAI Grok          | text, image edit                  | console.x.ai                                  |
| `OPENROUTER_API_KEY`  | OpenRouter        | text                              | openrouter.ai/keys                            |
| `REPLICATE_API_TOKEN` | Replicate         | image edit                        | the API tokens page of your Replicate account |
| `FAL_KEY`             | fal               | image edit                        | fal.ai/dashboard/keys                         |
| `BFL_API_KEY`         | Black Forest Labs | image edit                        | dashboard.bfl.ai                              |
| `STABILITY_API_KEY`   | Stability AI      | image-to-image, remove-background | platform.stability.ai                         |

## Hosted providers: model overrides

Optional. Left blank, the library's default model is used. Set one when a
default has been retired or renamed (a "model not found" or HTTP 404 error),
or to try a different model.

| Variable             | Applies to                    | Default                                                                      |
| -------------------- | ----------------------------- | ---------------------------------------------------------------------------- |
| `GEMINI_TEXT_MODEL`  | Gemini text                   | `gemini-3.8-flash`                                                           |
| `GEMINI_IMAGE_MODEL` | Gemini image edit             | `gemini-2.5-flash-image`                                                     |
| `CLAUDE_TEXT_MODEL`  | Claude text                   | `claude-opus-5-5`                                                            |
| `OPENAI_TEXT_MODEL`  | OpenAI text                   | `gpt-5.5`                                                                    |
| `OPENAI_IMAGE_MODEL` | OpenAI image edit             | `gpt-image-2`                                                                |
| `GROK_TEXT_MODEL`    | Grok text                     | `grok-4`                                                                     |
| `GROK_IMAGE_MODEL`   | Grok image edit               | `grok-imagine-image`                                                         |
| `OPENROUTER_MODEL`   | OpenRouter text               | `openrouter/auto` (OpenRouter picks)                                         |
| `REPLICATE_MODEL`    | Replicate image edit          | `black-forest-labs/flux-kontext-pro` (`owner/name`, or `owner/name:version`) |
| `FAL_MODEL`          | fal image edit                | `fal-ai/flux-pro/kontext`                                                    |
| `BFL_MODEL`          | Black Forest Labs image edit  | `flux-kontext-pro`                                                           |
| `STABILITY_MODEL`    | Stability image-to-image only | `sd3.5-large` (remove-background has no model choice)                        |

Replicate, fal and BFL models other than the default may expect different
input field names than the library's defaults (`input_image`, `image_url`
and `prompt`); the check only exercises the defaults.

## Not set in `.env`

These are command-line options on `bun run live-check`:

| Option              | What it does                                                                                                                                                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--list`            | Show which checks are ready or skipped, and what each is missing. Calls nothing.                                                                                                                                                                                                                                               |
| `--run`             | Run the checks. Required to make any call.                                                                                                                                                                                                                                                                                     |
| `--only=a,b`        | Run only these check ids or id prefixes (`--only=stability` runs both Stability checks).                                                                                                                                                                                                                                       |
| `--image=path.png`  | Use your own PNG, JPEG or WebP as the image to edit, instead of the generated test image.                                                                                                                                                                                                                                      |
| `--prompt="text"`   | What every image edit asks for, instead of "Make the sky orange, like a sunset." Plain image-to-image models (the ComfyUI sample, the Stable Diffusion web UI) only repaint from the prompt, so describe the whole result you want, for example `--prompt="a sunny day, bright orange sunset sky"`. Text checks are unchanged. |
| `--out=dir`         | Where edited images are saved. Default `live-check-output/` (git-ignored).                                                                                                                                                                                                                                                     |
| `--timeout=seconds` | The most one check may take, and the limit for each request and for jobs that are polled (fal, Replicate, Black Forest Labs, ComfyUI). Default 300. Raise it for a first run with a large model, for example `--timeout=900`.                                                                                                  |
