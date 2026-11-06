import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const createRuntime = async () => {
  const stored = {};
  const writes = [];
  const sandbox = {
    setTimeout, clearTimeout, Event: class { constructor(type) { this.type = type; } },
    MoodliaCorrectorI18n: { t: text => text },
    chrome: { storage: {
      local: {
        get: async keys => Object.fromEntries([keys].flat().filter(key => key in stored).map(key => [key, stored[key]])),
        set: async values => { writes.push(values); Object.assign(stored, values); },
      },
      onChanged: { addListener() {} },
    } },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(await fs.readFile('extension/src/savedInstructions.js', 'utf8'), sandbox);
  const field = () => {
    const listeners = [];
    return { value: '', disabled: false, title: '', addEventListener: (_type, listener) => listeners.push(listener),
      dispatchEvent: () => listeners.forEach(listener => listener()), type(text) { this.value = text; this.dispatchEvent(); } };
  };
  const fields = { course: field(), assignment: field(), case: field() };
  const controller = sandbox.MoodliaCorrectorPreferences.createController(fields, () => {});
  return { controller, fields, stored, writes };
};

test('teacher criteria are saved once typing pauses, and at once on a context change', async () => {
  const { controller, fields, stored, writes } = await createRuntime();
  await controller.setContext({ site: 'https://moodle.example', courseId: '7', assignmentId: '42', userId: '1' });
  writes.length = 0;
  for (const text of ['O', 'On', 'Onl', 'Only student one']) fields.case.type(text);
  assert.equal(writes.length, 0);
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(writes.length, 1);
  assert.equal(Object.values(writes[0])[0], 'Only student one');

  fields.case.type('Typed just before moving on');
  await controller.setContext({ site: 'https://moodle.example', courseId: '7', assignmentId: '42', userId: '2' });
  const firstStudentKey = Object.keys(stored).find(key => key.includes(':user:1:'));
  assert.equal(stored[firstStudentKey], 'Typed just before moving on');
  assert.equal(fields.case.value, '');
});

test('reading the criteria saves pending typing first', async () => {
  const { controller, fields, writes } = await createRuntime();
  await controller.setContext({ site: 'https://moodle.example', courseId: '7', assignmentId: '42', userId: '1' });
  writes.length = 0;
  fields.assignment.type('Use the rubric strictly');
  assert.equal((await controller.getValues()).assignment, 'Use the rubric strictly');
  assert.equal(writes.length, 1);
});
