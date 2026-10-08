"""Typed transient-error classification for the pinned Hindsight worker patch."""
from collections.abc import Iterator

from hindsight_api.engine.llm_interface import ProviderContentPolicyError
from hindsight_api.engine.remote_retry import is_transient_remote_error, status_code_of


def _exception_chain(error: BaseException) -> Iterator[BaseException]:
    pending = [error]
    seen: set[int] = set()
    while pending and len(seen) < 32:
        current = pending.pop()
        identity = id(current)
        if identity in seen:
            continue
        seen.add(identity)
        yield current
        cause = current.__cause__
        context = current.__context__ if cause is None and not current.__suppress_context__ else None
        if context is not None:
            pending.append(context)
        if cause is not None:
            pending.append(cause)


def _classify(error: BaseException, depth: int) -> tuple[bool, bool]:
    """Return (permanent_evidence, transient_evidence), bounded across wrappers."""
    if depth > 8:
        return True, False

    chain = tuple(_exception_chain(error))
    permanent = any(isinstance(item, ProviderContentPolicyError) for item in chain)
    transient = any(is_transient_remote_error(item) for item in chain)
    for item in chain:
        status = status_code_of(item)
        if status is not None and not is_transient_remote_error(item):
            permanent = True

    for item in chain:
        failures = getattr(item, "_task_chunk_errors", None)
        if failures is None:
            continue
        if not isinstance(failures, tuple) or not failures:
            permanent = True
            continue
        for failure in failures:
            if not isinstance(failure, BaseException):
                permanent = True
                continue
            child_permanent, child_transient = _classify(failure, depth + 1)
            permanent = permanent or child_permanent
            transient = transient or child_transient
            if not child_transient:
                permanent = True

    return permanent, transient


def is_transient_task_error(error: BaseException) -> bool:
    """Only trust native remote classification and fully transient chunk aggregates."""
    permanent, transient = _classify(error, 0)
    return transient and not permanent


def recovery_delay_seconds(retry_count: int, worker_max_retries: int) -> int:
    offset = max(0, retry_count - worker_max_retries)
    return (300, 900, 1800)[min(offset, 2)]
