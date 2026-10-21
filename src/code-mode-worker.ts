import { parentPort, workerData } from 'node:worker_threads';
import { getQuickJS, type QuickJSDeferredPromise } from 'quickjs-emscripten';

// Only JSON strings cross between this worker and the guest; no Node object enters the QuickJS heap.
const port = parentPort!;
const { code, timeoutMs } = workerData as { code: string; timeoutMs: number };
const deadline = Date.now() + timeoutMs;
const vm = (await getQuickJS()).newContext();
vm.runtime.setMemoryLimit(32 * 1024 * 1024);
vm.runtime.setInterruptHandler(() => Date.now() >= deadline);
const pending = new Map<number, QuickJSDeferredPromise>();
let nextId = 0;

const fail = (error: unknown) => port.postMessage({ type: 'error', error: String((error as { message?: unknown })?.message ?? error) });
function runJobs() {
  const jobs = vm.runtime.executePendingJobs();
  if (jobs.error) { fail(vm.dump(jobs.error)); jobs.error.dispose(); }
}

const callTool = vm.newFunction('callTool', (name, args) => {
  const id = ++nextId;
  const deferred = vm.newPromise();
  pending.set(id, deferred);
  port.postMessage({ type: 'call', id, name: vm.getString(name), args: JSON.parse(vm.getString(args)) });
  return deferred.handle;
});
vm.setProp(vm.global, '__callTool', callTool);
callTool.dispose();

port.on('message', (message: { id: number; json?: string; error?: string }) => {
  const deferred = pending.get(message.id)!;
  pending.delete(message.id);
  const value = message.error === undefined ? vm.newString(message.json!) : vm.newError(message.error);
  if (message.error === undefined) deferred.resolve(value); else deferred.reject(value);
  value.dispose();
  deferred.dispose();
  runJobs();
});

try {
  const promise = vm.unwrapResult(vm.evalCode(`(async () => {
    const call = globalThis.__callTool;
    delete globalThis.__callTool;
    globalThis.callTool = async (name, args = {}) => JSON.parse(await call(String(name), JSON.stringify(args)));
    const value = await (async () => {\n${code}\n})();
    return JSON.stringify(value ?? null) ?? 'null';
  })()`, 'script.js'));
  vm.resolvePromise(promise).then(result => {
    promise.dispose();
    if (result.error) { fail(vm.dump(result.error)); result.error.dispose(); }
    else { port.postMessage({ type: 'result', json: vm.getString(result.value) }); result.value.dispose(); }
  });
  runJobs();
} catch (error) { fail(error); }
