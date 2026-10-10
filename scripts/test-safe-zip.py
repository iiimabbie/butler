import json, subprocess, tempfile, zipfile
from pathlib import Path
SCRIPT=Path(__file__).with_name('read-safe-zip.py')
def run(z):
 p=subprocess.run(['/usr/bin/python3',str(SCRIPT),str(z)],capture_output=True,text=True,timeout=15)
 return p.returncode,json.loads(p.stdout)
with tempfile.TemporaryDirectory() as d:
 d=Path(d); good=d/'good.zip'
 with zipfile.ZipFile(good,'w') as z: z.writestr('notes.txt','hello safe')
 code,out=run(good); assert code==0 and 'hello safe' in out['text'] and out['truncated'] is False
 # Chinese/escaped filename and content stay within the hard byte ceiling; truncation is explicit.
 wide=d/'wide.zip'
 with zipfile.ZipFile(wide,'w',zipfile.ZIP_DEFLATED) as z: z.writestr(('中文"'*300)+'.txt',('中文"'*12000))
 code,out=run(wide); assert code==0 and out['truncated'] and len(json.dumps(out,ensure_ascii=False).encode())<48*1024
 multi=d/'multi.zip'
 with zipfile.ZipFile(multi,'w') as z:
  for n in range(100): z.writestr(f'{n}.txt','a'*300)
 code,out=run(multi); assert code==0 and len(out['text'].encode('utf-8'))<=24*1024 and out['truncated']
 bad=d/'bad.zip'
 with zipfile.ZipFile(bad,'w') as z: z.writestr('../escape.txt','x')
 code,out=run(bad); assert code!=0 and out.get('error')=='unsafe path'
 link=d/'link.zip'
 with zipfile.ZipFile(link,'w') as z:
  i=zipfile.ZipInfo('link'); i.create_system=3; i.external_attr=(0o120777<<16); z.writestr(i,'target')
 code,out=run(link); assert code!=0 and out.get('error')=='symlink'
 many=d/'many.zip'
 with zipfile.ZipFile(many,'w') as z:
  for n in range(201): z.writestr(f'{n}.bin',b'x')
 code,out=run(many); assert code!=0 and out.get('error')=='too many entries'
 single=d/'single.zip'
 with zipfile.ZipFile(single,'w',zipfile.ZIP_STORED) as z: z.writestr('huge.txt',b'x'*(2*1024*1024+1))
 code,out=run(single); assert code!=0 and out.get('error')=='expanded size limit'
 total=d/'total.zip'
 with zipfile.ZipFile(total,'w',zipfile.ZIP_STORED) as z:
  for n in range(11): z.writestr(f'{n}.bin',b'x'*(2*1024*1024))
 code,out=run(total); assert code!=0 and out.get('error')=='expanded size limit'
 bomb=d/'bomb.zip'
 with zipfile.ZipFile(bomb,'w',zipfile.ZIP_DEFLATED) as z: z.writestr('payload.txt',b'A'*(2*1024*1024+1))
 code,out=run(bomb); assert code!=0 and out.get('error')=='expanded size limit'
 print('safe zip regression checks passed')
