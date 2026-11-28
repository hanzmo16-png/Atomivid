import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const { load } = createRequire(import.meta.url)('js-yaml');
const workflow = load(readFileSync('.github/workflows/mystery-shopper.yml', 'utf8'));
const defaultBranch = 'claude/atomivid-mvp-setup-0079jv';
const sha = 'aea35c69e06062df25228ebf1576e8e703091f8c';

// Evaluate the actual YAML selectors, not a second implementation of the routing.
// The context has no process, credentials, provider clients or network interfaces.
function selected(job, event, operation, ref, result = 'skipped', environment = 'Production') {
  const expression = workflow.jobs[job].if.replaceAll('needs.quality-loop', 'needs["quality-loop"]');
  return Boolean(runInNewContext(`(${expression})`, {
    github: { event_name: event, ref, ref_name: ref.replace(/^refs\/heads\//, ''), event: {
      repository: { private: false, default_branch: defaultBranch },
      deployment: { environment }, deployment_status: { state: 'success' },
    } },
    inputs: { operation }, needs: { 'quality-loop': { result } },
    always: () => true, format: (template, value) => template.replace('{0}', value),
  }, { timeout: 100 }));
}

test('the existing workflow exposes explicit mirror-only dispatch', () => {
  assert.ok(workflow.on.workflow_dispatch.inputs.operation.options.includes('quality-loop-mirror'));
  assert.equal(workflow.jobs['quality-loop-drive'].environment, 'orchestrator');
  assert.deepEqual(workflow.jobs['quality-loop-drive'].permissions, { contents: 'write', 'id-token': 'write' });
});

test('mirror-only default-branch dispatch selects only Drive, never browser, evaluator, QA or tests', () => {
  const jobs = Object.keys(workflow.jobs).filter(job => selected(job, 'workflow_dispatch', 'quality-loop-mirror', `refs/heads/${defaultBranch}`));
  assert.deepEqual(jobs, ['quality-loop-drive']);
});

for (const ref of ['refs/heads/feature/untrusted', `refs/heads/${sha}`, 'refs/tags/release', defaultBranch, '']) {
  test(`mirror-only refuses non-default trusted context: ${ref || '(missing)'}`, () => {
    assert.equal(selected('quality-loop-drive', 'workflow_dispatch', 'quality-loop-mirror', ref), false);
    assert.equal(selected('evaluar', 'workflow_dispatch', 'quality-loop-mirror', ref), false);
  });
}

for (const result of ['success', 'failure']) {
  test(`a genuine default-branch schedule still mirrors after ${result}`, () => {
    assert.equal(selected('quality-loop', 'schedule', '', `refs/heads/${defaultBranch}`), true);
    assert.equal(selected('quality-loop-drive', 'schedule', '', `refs/heads/${defaultBranch}`, result), true);
  });
}

test('detached Production deployment retains its branch fence and cannot gain Drive credentials', () => {
  assert.equal(selected('quality-loop', 'deployment_status', '', `refs/heads/${sha}`), true);
  assert.equal(selected('quality-loop-drive', 'deployment_status', '', `refs/heads/${sha}`, 'failure'), false);
  assert.equal(selected('quality-loop', 'deployment_status', '', `refs/heads/${sha}`, 'skipped', 'Preview'), false);
});

test('normal manual inspection and paid campaign selectors retain their distinct contracts', () => {
  const ref = `refs/heads/${defaultBranch}`;
  assert.equal(selected('quality-loop', 'workflow_dispatch', 'quality-loop', ref), true);
  assert.equal(selected('evaluar', 'workflow_dispatch', 'quality-loop', ref), false);
  assert.equal(selected('evaluar', 'workflow_dispatch', 'campaign-real', ref), true);
  assert.equal(selected('quality-loop-drive', 'workflow_dispatch', 'campaign-real', ref), false);
  assert.equal(selected('quality-loop-drive', 'schedule', '', ref), false);
});
