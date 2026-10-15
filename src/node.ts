import { constants } from 'node:fs';
import { open, readdir, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';

import type { WorkflowSource } from './comfyui.js';
import { describeUnknownError, err, ok, type Result } from './result.js';

/**
 * Node-only helpers (the `./node` subpath). Everything else in the package
 * runs in Node, Bun and browsers.
 */

/** A mode is a file name stem, never a path: no separators, `..`, `:` (a Windows stream) or NUL. */
const UNSAFE_MODE_NAME = /[\\/:\0]|\.\./;
const JSON_EXTENSION = '.json';

interface WorkflowFile {
  readonly mode: string;
  readonly fileName: string;
}

/**
 * The workflow files in `dir`: regular `.json` files whose stem is a safe
 * name. A symbolic link is skipped (a link can point outside the folder),
 * so `list` shows exactly the modes `read` will accept.
 */
async function workflowFiles(dir: string): Promise<WorkflowFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  return entries
    .filter(
      (entry) =>
        entry.isFile() && entry.name.toLowerCase().endsWith(JSON_EXTENSION)
    )
    .map((entry) => ({
      mode: entry.name.slice(0, -JSON_EXTENSION.length),
      fileName: entry.name,
    }))
    .filter((file) => file.mode !== '' && !UNSAFE_MODE_NAME.test(file.mode))
    .sort((a, b) => a.mode.localeCompare(b.mode));
}

/**
 * Reads `fileName` in `dir` and nothing else: the real path must stay inside
 * the real folder (compared on a separator boundary), the file is opened
 * without following a symbolic link where the platform has O_NOFOLLOW, and
 * it must be a regular file.
 */
async function readInside(dir: string, fileName: string): Promise<string> {
  const realDir: string = await realpath(dir);
  const realFile: string = await realpath(join(dir, fileName));
  const prefix: string = realDir.endsWith(sep) ? realDir : realDir + sep;
  if (!realFile.startsWith(prefix)) {
    throw new Error('the file is outside the workflows folder');
  }
  const handle = await open(
    realFile,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)
  );
  try {
    if (!(await handle.stat()).isFile()) {
      throw new Error('the path is not a regular file');
    }
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

/**
 * ComfyUI workflows from a folder: each `<mode>.json` file is one mode,
 * exported with ComfyUI's Export (API). Files are read on every call, so
 * workflows can be added or edited without a restart. Symbolic links are
 * not followed, so a link can't pull in a file from outside the folder.
 */
export function directoryWorkflowSource(dir: string): WorkflowSource {
  return {
    async list(): Promise<Result<readonly string[]>> {
      try {
        return ok((await workflowFiles(dir)).map((file) => file.mode));
      } catch (cause: unknown) {
        return err(
          `Could not read the ComfyUI workflows folder ${dir}: ${describeUnknownError(cause)}. Create it and put workflows exported with Export (API) in it.`,
          cause
        );
      }
    },
    async read(mode: string): Promise<Result<string>> {
      if (mode === '' || UNSAFE_MODE_NAME.test(mode)) {
        return err(`"${mode}" is not a ComfyUI workflow name`);
      }
      try {
        const file = (await workflowFiles(dir)).find(
          (candidate) => candidate.mode === mode
        );
        if (file === undefined) {
          return err(
            `There is no ComfyUI workflow "${mode}" in ${dir} (symbolic links are not followed)`
          );
        }
        return ok(await readInside(dir, file.fileName));
      } catch (cause: unknown) {
        return err(
          `Could not read ComfyUI workflow "${mode}" in ${dir}: ${describeUnknownError(cause)}`,
          cause
        );
      }
    },
  };
}
