"""Apply the task recovery patch to the pinned Hindsight 0.10.2 image."""
from pathlib import Path

root = Path('/app/api/hindsight_api')

path = root / 'engine' / 'memory_engine.py'
source = path.read_text()
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
assert source.count(old) == 1, f'memory_engine.py retry anchor expected once, found {source.count(old)}'
path.write_text(source.replace(old, new, 1))

path = root / 'engine' / 'retain' / 'fact_extraction.py'
source = path.read_text()
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
assert source.count(old) == 1, f'fact_extraction.py aggregation anchor expected once, found {source.count(old)}'
path.write_text(source.replace(old, new, 1))

for path in (root / 'engine' / 'memory_engine.py', root / 'engine' / 'retain' / 'fact_extraction.py', root / 'engine' / 'task_recovery.py'):
    compile(path.read_text(), str(path), 'exec')
