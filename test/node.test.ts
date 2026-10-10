import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';

import { ok } from '../src/index.js';
import { directoryWorkflowSource } from '../src/node.js';

void describe('directoryWorkflowSource', async () => {
  const dir: string = await mkdtemp(join(tmpdir(), 'ai-providers-'));
  after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'b-scene.json'), '{"b":1}');
  await writeFile(join(dir, 'a-touch-up.JSON'), '{"a":1}');
  await writeFile(join(dir, 'notes.txt'), 'ignored');

  void it('lists .json files as sorted modes and reads one', async () => {
    const source = directoryWorkflowSource(dir);
    assert.deepEqual(await source.list(), ok(['a-touch-up', 'b-scene']));
    assert.deepEqual(await source.read('b-scene'), ok('{"b":1}'));
  });

  void it('refuses paths as mode names and explains a missing folder', async () => {
    const source = directoryWorkflowSource(dir);
    assert.match(
      ((await source.read('../secret')) as { error: string }).error,
      /not a ComfyUI workflow name/
    );
    const missing = directoryWorkflowSource(join(dir, 'nope'));
    assert.match(
      ((await missing.list()) as { error: string }).error,
      /Could not read the ComfyUI workflows folder/
    );
  });
});
