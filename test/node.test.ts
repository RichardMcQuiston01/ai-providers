import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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

void describe('directoryWorkflowSource containment', async () => {
  const base: string = await mkdtemp(join(tmpdir(), 'ai-providers-link-'));
  after(() => rm(base, { recursive: true, force: true }));
  const dir: string = join(base, 'workflows');
  await mkdir(dir);
  await writeFile(join(base, 'outside.json'), '{"secret":"{{INPUT_IMAGE}}"}');
  await writeFile(join(dir, 'real.json'), '{"ok":"{{INPUT_IMAGE}}"}');
  await writeFile(join(dir, 'Upper.JSON'), '{"upper":1}');
  await writeFile(join(dir, '..secret.json'), '{}');
  await writeFile(join(dir, 'a:b.json'), '{}');
  await mkdir(join(dir, 'folder.json'));
  await symlink(join(base, 'outside.json'), join(dir, 'touch-up.json'));
  await symlink(join(dir, 'real.json'), join(dir, 'alias.json'));
  const source = directoryWorkflowSource(dir);

  void it('does not read a symbolic link that points outside the folder', async () => {
    const result = await source.read('touch-up');
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /secret/);
    assert.match(
      (result as { error: string }).error,
      /symbolic links are not followed/
    );
  });

  void it('does not follow a link inside the folder either', async () => {
    assert.equal((await source.read('alias')).ok, false);
  });

  void it('lists only the modes that read will accept', async () => {
    assert.deepEqual(await source.list(), ok(['real', 'Upper']));
    assert.deepEqual(await source.read('real'), ok('{"ok":"{{INPUT_IMAGE}}"}'));
    // The extension's case doesn't matter, and the listed name is what reads.
    assert.deepEqual(await source.read('Upper'), ok('{"upper":1}'));
  });

  void it('rejects names with separators, dots, colons and NUL', async () => {
    for (const name of ['..secret', 'a:b', 'a/b', 'a\\b', '..', 'x\0y', '']) {
      assert.match(
        ((await source.read(name)) as { error: string }).error,
        /not a ComfyUI workflow name/,
        JSON.stringify(name)
      );
    }
  });

  void it('works when the folder itself is reached through a link', async () => {
    const viaLink: string = join(base, 'link-to-workflows');
    await symlink(dir, viaLink);
    const linked = directoryWorkflowSource(viaLink);
    assert.deepEqual(await linked.list(), ok(['real', 'Upper']));
    assert.deepEqual(await linked.read('real'), ok('{"ok":"{{INPUT_IMAGE}}"}'));
  });
});
