---
'@richardmcquiston01/ai-providers': minor
---

Add `SdWebUiImageGenerator` (image edits with a local AUTOMATIC1111 or Forge web UI, over plain `fetch`) on the `./sdwebui` subpath and the main entry. It calls `POST /sdapi/v1/img2img` with modes `img2img` and `inpaint` (the second image is the mask). The host goes through `checkProviderHost`, like Ollama and ComfyUI: this machine unless you list the host. A PNG input keeps its size. The web UI's interrupt is global, so a timeout or abort stops waiting but leaves the job running.
