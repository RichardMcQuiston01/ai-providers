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

| Variable            | Required for | What it is                                                                                                                                                                                                               |
| ------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OLLAMA_MODEL`      | Ollama       | The model to chat with, as `ollama list` shows it, for example `llama3.2`. Also the switch that turns the Ollama checks on. The list check confirms it is pulled.                                                        |
| `OLLAMA_HOST`       | optional     | Where Ollama runs. Default `http://127.0.0.1:11434`.                                                                                                                                                                     |
| `LMSTUDIO_HOST`     | LM Studio    | Address of LM Studio's local server, usually `http://127.0.0.1:1234`.                                                                                                                                                    |
| `LMSTUDIO_MODEL`    | LM Studio    | The model name the server reports (shown in LM Studio's server tab).                                                                                                                                                     |
| `VLLM_HOST`         | vLLM         | Address of the vLLM server, usually `http://127.0.0.1:8000`.                                                                                                                                                             |
| `VLLM_MODEL`        | vLLM         | The model name vLLM serves (its `--served-model-name`, or the model id).                                                                                                                                                 |
| `LLAMACPP_HOST`     | llama.cpp    | Address of `llama-server`, usually `http://127.0.0.1:8080`.                                                                                                                                                              |
| `LLAMACPP_MODEL`    | llama.cpp    | The model name sent with the request. `llama-server` serves the one model it loaded, so use that model's name.                                                                                                           |
| `SDWEBUI_HOST`      | Web UI       | Address of an AUTOMATIC1111 or Forge web UI started with `--api`, usually `http://127.0.0.1:7860`. Also the switch that turns the check on.                                                                              |
| `SDWEBUI_MODEL`     | optional     | A checkpoint to switch to for the call, as the web UI lists it (for example `sd_xl_base_1.0.safetensors`). Left blank, the loaded checkpoint is used.                                                                    |
| `COMFYUI_WORKFLOWS` | ComfyUI      | A folder of workflow files saved from ComfyUI in **API format** (`.json`). Each needs `{{INPUT_IMAGE}}` and `{{PROMPT}}` where the image and prompt go; `{{SEED}}` is optional. Also the switch that turns the check on. |
| `COMFYUI_MODE`      | optional     | Which workflow to run: the file name without `.json` (`edit-sky` for `edit-sky.json`). Left blank, the first workflow in the folder, sorted by name, is used.                                                            |
| `COMFYUI_HOST`      | optional     | Where ComfyUI runs. Default `http://127.0.0.1:8188`.                                                                                                                                                                     |

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

| Option              | What it does                                                                              |
| ------------------- | ----------------------------------------------------------------------------------------- |
| `--list`            | Show which checks are ready or skipped, and what each is missing. Calls nothing.          |
| `--run`             | Run the checks. Required to make any call.                                                |
| `--only=a,b`        | Run only these check ids or id prefixes (`--only=stability` runs both Stability checks).  |
| `--image=path.png`  | Use your own PNG, JPEG or WebP as the image to edit, instead of the generated test image. |
| `--out=dir`         | Where edited images are saved. Default `live-check-output/` (git-ignored).                |
| `--timeout=seconds` | The most one check may take before it is cancelled. Default 300.                          |
