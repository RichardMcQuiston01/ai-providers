import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { WorkflowSource } from './comfyui.js';
import { describeUnknownError, err, ok } from './result.js';

/**
 * Node-only helpers (the `./node` subpath). Everything else in the package
 * runs in Node, Bun and browsers.
 */

/**
 * ComfyUI workflows from a folder: each `<mode>.json` file is one mode,
 * exported with ComfyUI's Export (API). Files are read on every call, so
 * workflows can be added or edited without a restart.
 */
export function directoryWorkflowSource(dir: string): WorkflowSource {
  return {
    async list() {
      try {
        const names: string[] = await readdir(dir);
        return ok(
          names
            .filter((name) => name.toLowerCase().endsWith('.json'))
            .map((name) => name.slice(0, -'.json'.length))
            .sort((a, b) => a.localeCompare(b))
        );
      } catch (cause: unknown) {
        return err(
          `Could not read the ComfyUI workflows folder ${dir}: ${describeUnknownError(cause)}. Create it and put workflows exported with Export (API) in it.`,
          cause
        );
      }
    },
    async read(mode: string) {
      // A mode is a file name, never a path.
      if (mode === '' || /[\\/]|\.\./.test(mode)) {
        return err(`"${mode}" is not a ComfyUI workflow name`);
      }
      try {
        return ok(await readFile(join(dir, `${mode}.json`), 'utf8'));
      } catch (cause: unknown) {
        return err(
          `Could not read ComfyUI workflow "${mode}.json" in ${dir}: ${describeUnknownError(cause)}`,
          cause
        );
      }
    },
  };
}
