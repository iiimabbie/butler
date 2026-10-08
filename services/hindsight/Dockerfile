FROM ghcr.io/vectorize-io/hindsight:0.10.2

RUN python - <<'PY'
from pathlib import Path

path = Path("/app/api/hindsight_api/engine/cross_encoder.py")
source = path.read_text()
old = "    MAX_QUESTION_TOKENS = 26_000\n"
new = "    MAX_QUESTION_TOKENS = 20_000\n"
old_comment = "    # Single question context limit is 32k. A defensive safety margin (26k vs 32k)\n"
new_comment = "    # Single question context limit is 32k. A defensive safety margin (20k vs 32k)\n"
assert source.count(old) == 1, f"expected exactly one constant match, found {source.count(old)}"
assert source.count(old_comment) == 1, f"expected exactly one comment match, found {source.count(old_comment)}"
path.write_text(source.replace(old, new, 1).replace(old_comment, new_comment, 1))
PY

COPY --chown=hindsight:hindsight patch-request-defaults.py /tmp/patch-request-defaults.py
RUN python /tmp/patch-request-defaults.py && rm /tmp/patch-request-defaults.py
