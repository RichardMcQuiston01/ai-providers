---
'@richardmcquiston01/ai-providers': patch
---

`ComfyUiImageGenerator` now puts `request.instructions` ahead of the prompt in `{{PROMPT}}` (as the other image providers do; blank instructions change nothing). When the caller aborts or the run time limit passes, it removes the prompt from ComfyUI's queue or interrupts it if it is the one running, and an abort no longer waits out the poll interval. New exported helper `promptWithInstructions`.
