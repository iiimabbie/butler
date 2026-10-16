"""Fail-closed v1.0.0 defaults, context guard and reranker safety cap."""
from pathlib import Path

# Retain the operator's smaller Jev context budget across the upstream refactor.
encoder = Path('/app/api/hindsight_api/engine/cross_encoder.py')
s = encoder.read_text()
old = '    MAX_QUESTION_TOKENS = 26_000\n'
new = '    MAX_QUESTION_TOKENS = 20_000\n'
assert s.count(old) == 1, f'cross-encoder context anchor mismatch: {s.count(old)}'
s = s.replace(old, new, 1)
old_comment = '    # Single question context limit is 32k. A defensive safety margin (26k vs 32k)\n'
new_comment = '    # Single question context limit is 32k. A defensive safety margin (20k vs 32k)\n'
assert s.count(old_comment) == 1, f'cross-encoder comment anchor mismatch: {s.count(old_comment)}'
s = s.replace(old_comment, new_comment, 1)
compile(s, str(encoder), 'exec')
encoder.write_text(s)

api = Path('/app/api/hindsight_api/api/http.py')
s = api.read_text()
for name, default_budget, default_tokens, env_budget, env_tokens in (
    ('RecallRequest', 'mid', 1200, 'RECALL', 'RECALL'),
    ('ReflectRequest', 'mid', 1600, 'REFLECT', 'REFLECT'),
):
    start = s.index(f'class {name}(')
    end = s.find('\nclass ', start + 1)
    if end < 0:
        end = len(s)
    block = s[start:end]
    old_budget = '    budget: Budget = Budget.MID' if name == 'RecallRequest' else '    budget: Budget = Budget.LOW'
    old_tokens = '    max_tokens: int = 4096' if name == 'RecallRequest' else '    max_tokens: int = Field(default=4096, description="Maximum tokens for the response")'
    new_budget = f'    budget: Budget = Budget(os.getenv("HINDSIGHT_API_REQUEST_{env_budget}_BUDGET", "{default_budget}"))'
    new_tokens = f'    max_tokens: int = Field(default=int(os.getenv("HINDSIGHT_API_REQUEST_{env_tokens}_MAX_TOKENS", "{default_tokens}")), ge=1)'
    assert block.count(old_budget) == 1, f'{name} budget anchor mismatch'
    assert block.count(old_tokens) == 1, f'{name} max_tokens anchor mismatch'
    block = block.replace(old_budget, new_budget, 1).replace(old_tokens, new_tokens, 1)
    s = s[:start] + block + s[end:]
compile(s, str(api), 'exec')
api.write_text(s)

engine = Path('/app/api/hindsight_api/engine/memory_engine.py')
s = engine.read_text()
old = '    return int(override) if override > 0 else config.reranker_max_candidates'
new = '    # Butler/JEV safety ceiling, including any per-budget override.\n    return min(50, int(override) if override > 0 else config.reranker_max_candidates)'
assert s.count(old) == 1, f'reranker resolver anchor mismatch: {s.count(old)}'
s = s.replace(old, new, 1)
compile(s, str(engine), 'exec')
engine.write_text(s)
print('PATCH_OK: Recall/Reflect defaults configurable; reranker hard cap=50')
