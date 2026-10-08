"""Local 0.10.2 API patch: operator-owned defaults, never client-owned budgets.
Fail closed if upstream source changes. Variables are local extensions, not stock API settings.
"""
from pathlib import Path

path = Path('/app/api/hindsight_api/api/http.py')
source = path.read_text()
for classname, following, budget, tokens in [
    ('RecallRequest', 'class ', 'mid', 1200),
    ('ReflectRequest', 'class ', 'mid', 1600),
]:
    start = source.index(f'class {classname}(')
    end = source.find('\nclass ', start + 1)
    if end == -1:
        end = len(source)
    block = source[start:end]
    old_budget = '    budget: Budget = Budget.MID' if classname == 'RecallRequest' else '    budget: Budget = Budget.LOW'
    old_tokens = '    max_tokens: int = 4096' if classname == 'RecallRequest' else '    max_tokens: int = Field(default=4096, description="Maximum tokens for the response")'
    kind = 'RECALL' if classname == 'RecallRequest' else 'REFLECT'
    assert block.count(old_budget) == 1
    assert block.count(old_tokens) == 1
    block = block.replace(old_budget, f'    budget: Budget = Budget(os.getenv("HINDSIGHT_API_REQUEST_{kind}_BUDGET", "{budget}"))')
    block = block.replace(old_tokens, f'    max_tokens: int = Field(default=int(os.getenv("HINDSIGHT_API_REQUEST_{kind}_MAX_TOKENS", "{tokens}")), ge=1)')
    source = source[:start] + block + source[end:]
compile(source, str(path), 'exec')
path.write_text(source)

path = Path('/app/api/hindsight_api/engine/memory_engine.py')
source = path.read_text()
old = '    return int(override) if override > 0 else config.reranker_max_candidates'
assert source.count(old) == 1
source = source.replace(old, '    # JEV deployment safety ceiling, including per-budget overrides.\n    return min(50, int(override) if override > 0 else config.reranker_max_candidates)')
compile(source, str(path), 'exec')
path.write_text(source)
