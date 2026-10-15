# CLAUDE.md

Project memory for Claude Code. Read this before changing anything.

## What this is

`@richardmcquiston01/ai-providers`: swappable AI providers behind two small
interfaces, `TextGenerator` and `ImageGenerator` (`src/port.ts`).
Extracted from etsy-dashboard's `src/ai/`. Consumers: etsy-dashboard
(captions with Ollama, Gemini or Claude, photo edits with ComfyUI or
Gemini), and later Maker Toolkit. `ROADMAP.md` has what comes next
(`createProviders`, model listing).

## Layout

```
src/
  index.ts      barrel: everything except ./node, ./gemini, ./claude, ./openai and ./grok (runtime-neutral)
  result.ts     Result<T>, ok, err, describeUnknownError
  port.ts       AiImage, TextGenerator, ImageGenerator, requests, FetchLike
  http.ts       callProvider (timeout + signal + specific errors), readJson,
                providerMessage, toBase64/fromBase64 (no Buffer)
  hosts.ts      checkProviderHost (loopback unless allowed), parseAllowedHosts
  ollama.ts     subpath ./ollama: OllamaTextGenerator, stripThinking
  comfyui.ts    subpath ./comfyui: ComfyUiImageGenerator, WorkflowSource,
                parseWorkflow, fillWorkflow, readHistory, memoryWorkflowSource
  gemini.ts     subpath ./gemini: GeminiTextGenerator, GeminiImageGenerator over
                the optional peer @richardmcquiston01/gemini-icon-gen (dynamic
                import(), injectable loadModule for tests)
  claude.ts     subpath ./claude: ClaudeTextGenerator over the optional peer
                @anthropic-ai/sdk (dynamic import(), injectable loadModule; tests run
                the real SDK against a fake fetch)
  grok.ts       subpath ./grok: GrokTextGenerator (ChatCompletionsTextGenerator from openai.ts
                pointed at api.x.ai), GrokImageGenerator (JSON POST /images/edits over fetch)
  replicate.ts  subpath ./replicate: ReplicateImageGenerator over plain fetch (create, poll,
                cancel on timeout/abort, download from replicate.delivery only)
  openai.ts     subpath ./openai: OpenAiTextGenerator (Chat Completions), OpenAiImageGenerator
                (images.edit) over the optional peer openai (dynamic import(), injectable
                loadModule; tests run the real SDK against a fake fetch)
  node.ts       subpath ./node: directoryWorkflowSource (the only node:* code)
test/           node:test + node:assert, run by bun test; fake fetch, no network
```

Adding a provider: `src/<provider>.ts`, export it from `src/index.ts` (unless
it loads an optional peer, like `gemini.ts`, `claude.ts`, `openai.ts` and `grok.ts`), add
the entry to `tsup.config.ts`, `package.json` `exports` and `typesVersions`,
test it against a fake `fetch`, and add a changeset. A provider whose SDK
is heavy (Gemini, Claude, OpenAI) takes it as an **optional peer dependency**
loaded with `import()`, and returns a Result error naming the package when
it's missing.

## Rules

- **Providers only generate.** No prompt policy, no output checks, no
  saving or posting. Those belong to the consumer, so swapping a provider
  can't weaken them. Don't add consumer-specific wording (Etsy, captions,
  listings) to this package.
- **Results, not throws.** Every public function returns `Result<T>`.
  Errors name the provider, model/workflow, what was being done, the HTTP
  status and the provider's message.
- **Local by default.** Keep `checkProviderHost` strict: http(s), origin
  only, loopback unless on the allow list.
- **No credentials in code, logs or errors.** Keys are passed in by the
  consumer; never read `process.env` here (ESLint blocks `process`).
- **Runtime-neutral core.** `src/` (except `node.ts`) has no `node:*`
  imports, `Buffer`, `process` or `Bun` (ESLint enforces it). Lib is
  ES2023 + DOM for `fetch`/`FormData`/`Blob` types. `tsconfig.json`
  checks the neutral files without Node types; `tsconfig.node.json` adds
  `node.ts`.
- **Dual ESM and CommonJS** with `.d.ts`/`.d.cts` for every entry. Check
  `require()` and `import()` of `dist/` before releasing.
- Node ≥ 20.3 (`AbortSignal.any`, global `crypto.randomUUID`).

## Commands (Bun only)

Never `npm`/`npx`/`tsx` locally; the release workflow's `npm publish` is
the one exception (provenance).

```bash
bun install
bun run typecheck
bun run lint
bun run format        # format:check in CI
bun run test
bun run build
bun run changeset
```

## Conventions

TypeScript strict, plus `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes`, `noImplicitReturns`, `noImplicitOverride`,
`verbatimModuleSyntax`, `useUnknownInCatchVariables`. Google TypeScript
Style Guide; descriptive camelCase; typed locals where they help.
Prettier (`.prettierrc.json`).

## Git and releases

- `dev` is the integration branch. Branch features off `dev` and open PRs
  into `dev`, never `main`.
- Each user-facing change gets a changeset.
- Release: on `dev`, `bun run version-packages` (bumps `package.json`,
  writes `CHANGELOG.md`); merge `dev` → `main`; tag `main` with `vX.Y.Z`
  and push the tag. `.github/workflows/release.yml` checks the tag matches
  `package.json` and that the tagged commit is on `main`, then typechecks,
  lints, tests, builds and runs `npm publish --provenance --access public`
  with the `NPM_TOKEN` secret.
- `package.json` starts at 0.0.0; the initial `minor` changeset makes the
  first release 0.1.0.
- CI (`.github/workflows/ci.yml`): PRs and pushes to dev/main.

Never commit secrets or tokens.
