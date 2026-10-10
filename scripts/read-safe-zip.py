#!/usr/bin/python3
import json, re, stat, sys, zipfile
MAX_FILES=200; MAX_TOTAL=20*1024*1024; MAX_ONE=2*1024*1024; MAX_TEXT_BYTES=24*1024; MAX_STDOUT_BYTES=48*1024

def emit(payload):
  encoded=json.dumps(payload,ensure_ascii=False,separators=(',',':'))
  if len(encoded.encode('utf-8'))>MAX_STDOUT_BYTES:
    payload['text']=''; payload['truncated']=True
    encoded=json.dumps(payload,ensure_ascii=False,separators=(',',':'))
  sys.stdout.write(encoded+'\n')
def utf8_prefix(text, budget):
  raw=text.encode('utf-8')[:budget]
  return raw.decode('utf-8','ignore')
# The caller's execFileSync maxBuffer is deliberately larger than this enforced JSON byte ceiling.

def main(path):
  with zipfile.ZipFile(path) as z:
    infos=z.infolist()
    if len(infos)>MAX_FILES: raise ValueError('too many entries')
    total=0; chosen=[]
    for i in infos:
      n=i.filename
      if not n or n.startswith(('/','\\')) or re.match(r'^[A-Za-z]:',n) or '\\' in n or any(p in ('.','..') for p in n.split('/')): raise ValueError('unsafe path')
      mode=(i.external_attr>>16)&0xffff
      if stat.S_ISLNK(mode): raise ValueError('symlink')
      if i.flag_bits & 1: raise ValueError('encrypted entry')
      if i.is_dir(): continue
      if i.compress_type not in (zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED): raise ValueError('unsupported compression')
      total+=i.file_size
      if total>MAX_TOTAL or i.file_size>MAX_ONE: raise ValueError('expanded size limit')
      chosen.append(i)
    out=[]; used=0; truncated=False
    for i in chosen:
      if not i.filename.lower().endswith(('.txt','.md','.csv','.tsv','.json','.xml','.yaml','.yml','.log','.py','.js','.ts','.html','.css')): continue
      with z.open(i) as f: data=f.read(MAX_ONE+1)
      if len(data)>MAX_ONE: raise ValueError('entry limit')
      text=data.decode('utf-8','replace')
      header=f'--- {i.filename} ({i.file_size} bytes) ---\n'
      separator_bytes=1 if out else 0
      budget=MAX_TEXT_BYTES-used-separator_bytes-len(header.encode('utf-8'))
      if budget<=0: truncated=True; break
      snippet=utf8_prefix(text,budget)
      if len(snippet)<len(text): truncated=True
      out.append(header+snippet); used+=separator_bytes+len(header.encode('utf-8'))+len(snippet.encode('utf-8'))
      if used>=MAX_TEXT_BYTES: truncated=True; break
    emit({'files':len(chosen),'expandedBytes':total,'text':'\n'.join(out),'truncated':truncated})
try:
  if len(sys.argv)!=2: raise ValueError('expected one archive path')
  main(sys.argv[1])
except Exception as e:
  emit({'error':str(e)}); sys.exit(2)
