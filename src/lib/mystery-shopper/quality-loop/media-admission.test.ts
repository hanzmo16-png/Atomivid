import test from 'node:test';
import assert from 'node:assert/strict';
import { allowMediaProbe, targetOrigin } from './policy';

for (const trigger of ['workflow_dispatch', 'schedule', 'deployment_status', 'repository_dispatch', 'unknown']) {
  test(`${trigger} is not evidence of free media transfer`, () => {
    assert.equal(allowMediaProbe(trigger, false), false);
    assert.equal(allowMediaProbe(trigger, true), false, 'a local-fixture flag cannot turn a remote trigger into transfer authority');
  });
}

test('only an explicitly identified local fixture can probe synthetic media', () => {
  assert.equal(allowMediaProbe('fixture', true), true);
  assert.equal(allowMediaProbe('fixture', false), false);
  assert.equal(targetOrigin('http://127.0.0.1:3100', true), 'http://127.0.0.1:3100');
  for (const origin of ['https://atomivid.vercel.app', 'https://atomicvid.app']) {
    assert.throws(() => targetOrigin(origin, true), /FIXTURE_MUST_BE_LOCAL/);
  }
});
