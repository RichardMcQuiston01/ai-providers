import { defineConfig } from 'tsup';

// One entry per public subpath. Add new modules here and in package.json
// "exports" and "typesVersions" together.
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    ollama: 'src/ollama.ts',
    comfyui: 'src/comfyui.ts',
    gemini: 'src/gemini.ts',
    claude: 'src/claude.ts',
    openai: 'src/openai.ts',
    grok: 'src/grok.ts',
    'openai-compatible': 'src/openai-compatible.ts',
    replicate: 'src/replicate.ts',
    node: 'src/node.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: false,
  treeshake: true,
  target: 'es2022',
  platform: 'neutral',
  tsconfig: 'tsconfig.node.json',
});
