import asyncio
import importlib.util
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

# The production image supplies Pillow/httpx/Hindsight. Stub imports here because
# this test exercises only sampling orchestration and must never call a provider.
pil = types.ModuleType('PIL'); image_mod = types.ModuleType('PIL.Image')
class FakeImage:
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def verify(self): pass
image_mod.open=lambda *args,**kwargs: FakeImage(); pil.Image=image_mod; pil.ImageOps=types.SimpleNamespace()
sys.modules.setdefault('PIL',pil); sys.modules.setdefault('PIL.Image',image_mod)
httpx=types.ModuleType('httpx'); httpx.Timeout=lambda *a,**k:None; httpx.AsyncClient=object; sys.modules.setdefault('httpx',httpx)
base=types.ModuleType('hindsight_api.engine.parsers.base')
class FileParser: pass
class UnsupportedFileTypeError(Exception): pass
base.FileParser=FileParser; base.UnsupportedFileTypeError=UnsupportedFileTypeError
mark=types.ModuleType('hindsight_api.engine.parsers.markitdown'); mark.MarkitdownParser=object
for name in ('hindsight_api','hindsight_api.engine','hindsight_api.engine.parsers'):
    sys.modules.setdefault(name,types.ModuleType(name))
sys.modules['hindsight_api.engine.parsers.base']=base; sys.modules['hindsight_api.engine.parsers.markitdown']=mark
spec=importlib.util.spec_from_file_location('butler_file_parser',Path(__file__).with_name('butler-file-parser.py'))
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class Parser(module.ButlerParser):
    def __init__(self, mode='normal'): self.mode=mode; self.calls=[]
    async def _run(self, argv, *, capture=False):
        self.calls.append(argv)
        if argv[0]=='ffprobe':
            return json.dumps({'format':{'duration':'8.0'},'streams':[{'codec_type':'video','duration':'5.125','avg_frame_rate':'24/1'},{'codec_type':'audio','duration':'8.0'}]})
        if '-vn' in argv:
            Path(argv[-1]).write_bytes(b'fake-wav')
            return ''
        ts=float(argv[argv.index('-ss')+1]); out=Path(argv[-1])
        if ts > 5.0: return '' # emulate tail failure, including exit-0/no-file
        if self.mode=='fail': raise RuntimeError('ffmpeg exit 234: bounded diagnostic')
        out.write_bytes(b'fake-jpeg-data-that-is-not-actually-decoded')
        return ''
    async def _transcribe(self,data,filename): return '# Audio transcript: mock\n\nmock'
    async def _image(self,data,filename): return f'# Image: {filename}\n\nmock-frame-description'

class SamplingTests(unittest.TestCase):
    def test_tail_uses_video_duration_and_retries_missing_output(self):
        parser=Parser()
        text=asyncio.run(parser._video(b'not-read-by-test','video.mp4'))
        self.assertIn('mock-frame-description',text)
        frame_calls=[x for x in parser.calls if x[0]=='ffmpeg' and '-ss' in x]
        times=[float(x[x.index('-ss')+1]) for x in frame_calls]
        self.assertTrue(times)
        self.assertLessEqual(max(times),5.125)
        self.assertGreater(len(frame_calls),6) # bounded retry for exit 0/no file near end
        self.assertTrue(all('-vf' in x and '-frames:v' in x for x in frame_calls))

    def test_no_valid_video_output_fails_with_bounded_error(self):
        parser=Parser('fail')
        with self.assertRaisesRegex(RuntimeError,'No valid video frames'):
            asyncio.run(parser._video(b'not-read-by-test','video.mp4'))
        self.assertLessEqual(len([x for x in parser.calls if x[0]=='ffmpeg' and '-ss' in x]),18)

if __name__=='__main__': unittest.main()
