---
'@richardmcquiston01/ai-providers': minor
---

First release, extracted from etsy-dashboard's `src/ai/`: the
`TextGenerator`/`ImageGenerator` interfaces, `OllamaTextGenerator`,
`ComfyUiImageGenerator` with workflow parsing and filling,
`memoryWorkflowSource`, `directoryWorkflowSource` (`./node`),
`checkProviderHost`/`parseAllowedHosts`, and the shared HTTP helpers.
Constructors take an options object.
