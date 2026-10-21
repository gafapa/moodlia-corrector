import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const bundle = await readFile(new URL('../extension/src/content/moodleContent.js', import.meta.url), 'utf8');

test('the content entry ignores overview and unrelated pages without localization, storage or DOM initialization', async () => {
  for (const url of [
    'https://moodle.example/school/aulavirtual/mod/assign/view.php?id=71065',
    'https://moodle.example/school/course/view.php?id=7',
    'http://moodle.example/mod/assign/view.php?id=42&action=grader',
  ]) {
    const sandbox = { URL, location: { href: url }, document: { getElementById: () => { throw new Error('Unexpected DOM initialization'); } } };
    await vm.runInNewContext(bundle, sandbox);
    assert.equal(sandbox.MoodliaCorrectorI18n, undefined);
    assert.equal(sandbox.MoodliaCorrectorMessages, undefined);
    assert.equal(sandbox.MoodliaCorrectorPreferences, undefined);
  }
});
