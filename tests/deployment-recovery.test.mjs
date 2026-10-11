import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../dist/store.js';

test('running deployment becomes reconciliation event after restart and is never queued for replay', () => {
  const dir = mkdtempSync(join(tmpdir(), 'butler-deploy-recovery-'));
  const store = new Store(join(dir, 'store.sqlite'));
  try {
    store.createDeploymentRequest({ id: 'deploy-running', parentSession: 'origin', channelId: 'chan' });
    store.setDeploymentStatus('deploy-running', 'running');
    store.recoverRunningDeployments();
    assert.equal(store.queuedDeploymentRequest(), undefined);
    const active = store.activeDeploymentRequest();
    assert.equal(active?.status, 'needs_reconciliation');
    const [event] = store.pendingDeploymentEvents();
    assert.equal(event?.deployment_id, 'deploy-running');
    assert.match(String(event?.result_json), /automatic replay refused/);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
