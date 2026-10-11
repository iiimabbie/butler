"""Real ffmpeg integration tests; only provider calls are mocked.

This host lacks Pillow/httpx/Hindsight packages, so minimal import shims are installed.
Frame verification is NOT stubbed: the shim's verify() executes the system ffmpeg
against the real generated JPEG. The parser's subprocess runner is unchanged.
"""
import asyncio
import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path

pil = types.ModuleType('PIL'); image_mod = types.ModuleType('PIL.Image')
class FfmpegVerifiedImage:
    def __init__(self,path): self.path=str(path)
    def __enter__(self): return self
    def __exit__(self,*args): pass
    def verify(self):
        subprocess.run(['ffmpeg','-nostdin','-v','error','-i',self.path,'-f','null','-'],check=True,capture_output=True,timeout=15)
image_mod.open=lambda path,*a,**kw:FfmpegVerifiedImage(path); pil.Image=image_mod; pil.ImageOps=types.SimpleNamespace()
sys.modules.setdefault('PIL',pil); sys.modules.setdefault('PIL.Image',image_mod)
httpx=types.ModuleType('httpx'); httpx.Timeout=lambda *a,**k:None; httpx.AsyncClient=object; sys.modules.setdefault('httpx',httpx)
base=types.ModuleType('hindsight_api.engine.parsers.base')
class FileParser: pass
class UnsupportedFileTypeError(Exception): pass
base.FileParser=FileParser; base.UnsupportedFileTypeError=UnsupportedFileTypeError
mark=types.ModuleType('hindsight_api.engine.parsers.markitdown'); mark.MarkitdownParser=object
for name in ('hindsight_api','hindsight_api.engine','hindsight_api.engine.parsers'): sys.modules.setdefault(name,types.ModuleType(name))
sys.modules['hindsight_api.engine.parsers.base']=base; sys.modules['hindsight_api.engine.parsers.markitdown']=mark
spec=importlib.util.spec_from_file_location('butler_file_parser_real_ffmpeg',Path(__file__).with_name('butler-file-parser.py'))
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)

class ProviderStubParser(module.ButlerParser):
    def __init__(self): self.frame_descriptions=[]
    async def _transcribe(self,data,filename):
        assert data[:4] == b'RIFF' and data[8:12] == b'WAVE'
        return '# Audio transcript: mock\n\nmock provider transcript'
    async def _image(self,data,filename):
        assert data[:2] == b'\xff\xd8'
        self.frame_descriptions.append(filename)
        return f'# Image: {filename}\n\nmock visual provider description'

class RealFfmpegVideoParserTests(unittest.TestCase):
    def setUp(self): self.tmp=tempfile.TemporaryDirectory(); self.root=Path(self.tmp.name)
    def tearDown(self): self.tmp.cleanup()
    def create_clip(self,path):
        subprocess.run(['ffmpeg','-nostdin','-v','error','-f','lavfi','-i','testsrc=size=320x240:rate=12:duration=1.3','-f','lavfi','-i','sine=frequency=440:sample_rate=16000:duration=2.4','-map','0:v:0','-map','1:a:0','-c:v','mpeg4','-q:v','5','-c:a','aac','-y',str(path)],check=True,capture_output=True,timeout=30)
    def test_real_video_shorter_than_audio_extracts_frames_from_video_duration(self):
        path=self.root/'audio-longer.mp4'; self.create_clip(path)
        probe=json.loads(subprocess.run(['ffprobe','-v','error','-show_entries','stream=codec_type,duration','-of','json',str(path)],check=True,capture_output=True,text=True).stdout)
        durations={s['codec_type']:float(s['duration']) for s in probe['streams']}
        self.assertGreater(durations['audio'],durations['video'])
        parser=ProviderStubParser(); text=asyncio.run(parser._video(path.read_bytes(),path.name))
        self.assertIn('mock provider transcript',text); self.assertIn('mock visual provider description',text)
        self.assertGreaterEqual(len(parser.frame_descriptions),1); self.assertLessEqual(len(parser.frame_descriptions),6)
        times=[float(x) for x in re.findall(r'## Keyframe at ([0-9.]+)s',text)]
        self.assertEqual(len(times),len(parser.frame_descriptions)); self.assertEqual(len(set(times)),len(times))
        self.assertLessEqual(max(times),durations['video']-0.1)
        self.assertLess(max(times),durations['audio'])
    def test_real_corrupt_video_emits_no_frame_and_fails_after_bounded_sampling(self):
        path=self.root/'corrupt-no-frames.mp4'; self.create_clip(path)
        data=bytearray(path.read_bytes()); marker=data.find(b'mdat'); self.assertGreater(marker,0)
        # Corrupt only packet payloads belonging to video stream 0; preserve MP4 box
        # metadata and audio packets, so ffprobe has durations and the real WAV extraction works.
        packets=json.loads(subprocess.run(['ffprobe','-v','error','-show_packets','-show_entries','packet=stream_index,pos,size','-of','json',str(path)],check=True,capture_output=True,text=True,timeout=15).stdout)['packets']
        video_packets=[p for p in packets if p.get('stream_index')==0]; self.assertTrue(video_packets)
        for packet in video_packets:
            start=int(packet['pos']); end=start+int(packet['size']); data[start:end]=b'\0'*(end-start)
        path.write_bytes(data)
        probe=subprocess.run(['ffprobe','-v','error','-show_entries','stream=codec_type,duration','-of','json',str(path)],capture_output=True,text=True,timeout=15)
        self.assertEqual(probe.returncode,0,probe.stderr)
        parser=ProviderStubParser(); original_run=parser._run; frame_commands=[]
        async def observed_run(argv,*,capture=False):
            if argv[0]=='ffmpeg' and '-ss' in argv: frame_commands.append(argv)
            return await original_run(argv,capture=capture)
        parser._run=observed_run
        with self.assertRaisesRegex(RuntimeError,'No valid video frames'):
            asyncio.run(parser._video(path.read_bytes(),path.name))
        self.assertEqual(parser.frame_descriptions,[])
        self.assertGreater(len(frame_commands),6); self.assertLessEqual(len(frame_commands),18)

if __name__=='__main__': unittest.main()
