"""Install Butler's file parser and retain-operation linkage into the pinned image."""
from pathlib import Path

root = Path("/app/api/hindsight_api")

path = root / "engine" / "parsers" / "__init__.py"
source = path.read_text()
anchor = "from .base import FileParser, UnsupportedFileTypeError\n"
assert source.count(anchor) == 1, "parser import anchor mismatch"
source = source.replace(anchor, anchor + "from .butler import ButlerParser\n", 1)
anchor = '    "MarkitdownParser",\n'
assert source.count(anchor) == 1, "parser export anchor mismatch"
source = source.replace(anchor, anchor + '    "ButlerParser",\n', 1)
path.write_text(source)

path = root / "engine" / "parsers" / "butler.py"
source = Path("/tmp/butler.py").read_text()
assert not path.exists(), "butler parser already exists; refusing overwrite"
path.write_text(source)

path = root / "engine" / "memory_engine.py"
source = path.read_text()
old = "        from .parsers import FileParserRegistry, IrisParser, LlamaParseParser, MarkitdownParser\n"
new = "        from .parsers import ButlerParser, FileParserRegistry, IrisParser, LlamaParseParser, MarkitdownParser\n"
assert source.count(old) == 1, "parser registration import anchor mismatch"
source = source.replace(old, new, 1)
anchor = "        self._parser_registry = FileParserRegistry()\n"
assert source.count(anchor) == 1, "parser registry initialization anchor mismatch"
source = source.replace(anchor, anchor + "        self._parser_registry.register(ButlerParser())\n", 1)
old = '''                if operation_id:
                    await conn.execute(
                        f"""
                        UPDATE {fq_table("async_operations")}
                        SET status = 'completed', error_message = NULL, updated_at = NOW(), completed_at = NOW()
                        WHERE operation_id = $1
                        """,
                        uuid.UUID(operation_id),
                    )
'''
new = '''                if operation_id:
                    await conn.execute(
                        f"""
                        UPDATE {fq_table("async_operations")}
                        SET status = 'completed', error_message = NULL, updated_at = NOW(), completed_at = NOW(),
                            result_metadata = COALESCE(result_metadata, '{{}}'::jsonb) || $2::jsonb
                        WHERE operation_id = $1
                        """,
                        uuid.UUID(operation_id),
                        json.dumps({"butler_retain_operation_id": str(retain_operation_id)}),
                    )
'''
assert source.count(old) == 1, "child retain link transaction anchor mismatch"
source = source.replace(old, new, 1)
path.write_text(source)

for path in (root / "engine" / "parsers" / "__init__.py", root / "engine" / "parsers" / "butler.py", root / "engine" / "memory_engine.py"):
    compile(path.read_text(), str(path), "exec")
