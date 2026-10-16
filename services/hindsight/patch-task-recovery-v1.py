"""Fail-closed v1.0.0 task retry extension; preserve native defer/cancel handling."""
from pathlib import Path
root = Path('/app/api/hindsight_api')

path = root / 'engine' / 'memory_engine.py'
s = path.read_text()
old = '''                    if retry_count < config.worker_max_retries:
                        raise RetryTaskAt(
                            retry_at=datetime.now(UTC) + timedelta(seconds=config.worker_task_retry_backoff_seconds),
                            message=error_message,
                        )
                    raise
'''
new = '''                    if retry_count < config.worker_max_retries:
                        raise RetryTaskAt(
                            retry_at=datetime.now(UTC) + timedelta(seconds=config.worker_task_retry_backoff_seconds),
                            message=error_message,
                        )
                    from hindsight_api.engine.task_recovery import is_transient_task_error, recovery_delay_seconds

                    if task_type in {"batch_retain", "refresh_mental_model"} and is_transient_task_error(e):
                        delay = recovery_delay_seconds(retry_count, config.worker_max_retries)
                        raise RetryTaskAt(retry_at=datetime.now(UTC) + timedelta(seconds=delay), message=error_message)
                    raise
'''
assert s.count(old) == 1, f'worker retry anchor mismatch: {s.count(old)}'
s = s.replace(old, new, 1)
compile(s, str(path), 'exec')
path.write_text(s)

path = root / 'engine' / 'retain' / 'fact_extraction.py'
s = path.read_text()
old = '''        raise RuntimeError(
            f"Fact extraction failed: {len(failed_chunks)}/{len(chunks)} chunks failed. "
            f"First failures: {failed_summary}"
        )
'''
new = '''        error = RuntimeError(
            f"Fact extraction failed: {len(failed_chunks)}/{len(chunks)} chunks failed. "
            f"First failures: {failed_summary}"
        )
        error._task_chunk_errors = tuple(err for _, err in failed_chunks)
        raise error
'''
assert s.count(old) == 1, f'chunk error aggregate anchor mismatch: {s.count(old)}'
s = s.replace(old, new, 1)
compile(s, str(path), 'exec')
path.write_text(s)
for p in (root/'engine/memory_engine.py', root/'engine/retain/fact_extraction.py', root/'engine/task_recovery.py'):
    compile(p.read_text(), str(p), 'exec')
print('PATCH_OK: transient retain/refresh recovery installed; native cancellation/defer branches untouched')
