"""Fail-closed v1.0.0 installer for the Butler parser and operation linkage."""
from pathlib import Path

root = Path('/app/api/hindsight_api')

# Export/register a distinct parser in the v1.0.0 engine registry.
path = root / 'engine' / 'parsers' / '__init__.py'
s = path.read_text()
anchor = 'from .markitdown import MarkitdownParser\n'
assert s.count(anchor) == 1, f'parser import anchor mismatch: {s.count(anchor)}'
s = s.replace(anchor, anchor + 'from .butler import ButlerParser\n', 1)
anchor = '    "MarkitdownParser",\n'
assert s.count(anchor) == 1, f'parser export anchor mismatch: {s.count(anchor)}'
s = s.replace(anchor, anchor + '    "ButlerParser",\n', 1)
path.write_text(s)

path = root / 'engine' / 'parsers' / 'butler.py'
assert not path.exists(), 'refusing to overwrite an existing ButlerParser'
source = Path('/tmp/butler.py').read_text()
compile(source, str(path), 'exec')
path.write_text(source)

path = root / 'engine' / 'memory_engine.py'
s = path.read_text()
old = '        from .parsers import FileParserRegistry, IrisParser, LlamaParseParser, MarkitdownParser\n'
new = '        from .parsers import ButlerParser, FileParserRegistry, IrisParser, LlamaParseParser, MarkitdownParser\n'
assert s.count(old) == 1, f'memory engine parser import anchor mismatch: {s.count(old)}'
s = s.replace(old, new, 1)
old = '        self._parser_registry = FileParserRegistry()\n'
new = old + '        self._parser_registry.register(ButlerParser())\n'
assert s.count(old) == 1, f'memory engine parser registry anchor mismatch: {s.count(old)}'
s = s.replace(old, new, 1)
# Preserve the existing operation id link when file conversion completes.
old = '''                        SET status = 'completed', error_message = NULL, updated_at = NOW(), completed_at = NOW()
                        WHERE operation_id = $1
                        """,
                        uuid.UUID(operation_id),
'''
new = '''                        SET status = 'completed', error_message = NULL, updated_at = NOW(), completed_at = NOW(),
                            result_metadata = COALESCE(result_metadata, '{{}}'::jsonb) || $2::jsonb
                        WHERE operation_id = $1
                        """,
                        uuid.UUID(operation_id),
                        json.dumps({"butler_retain_operation_id": str(retain_operation_id)}),
'''
assert s.count(old) == 1, f'file operation link anchor mismatch: {s.count(old)}'
s = s.replace(old, new, 1)
compile(s, str(path), 'exec')
path.write_text(s)
for p in (root/'engine/parsers/__init__.py', root/'engine/parsers/butler.py', root/'engine/memory_engine.py'):
    compile(p.read_text(), str(p), 'exec')
print('PATCH_OK: butler parser registered; operation link metadata retained')
