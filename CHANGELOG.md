# CHANGELOG

## 0.1.0

### Minor Changes

- ed8d2b8: First release, extracted from etsy-dashboard's `src/ai/`: the
  `TextGenerator`/`ImageGenerator` interfaces, `OllamaTextGenerator`,
  `ComfyUiImageGenerator` with workflow parsing and filling,
  `memoryWorkflowSource`, `directoryWorkflowSource` (`./node`),
  `checkProviderHost`/`parseAllowedHosts`, and the shared HTTP helpers.
  Constructors take an options object.
