import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { transcribeAudio, type AudioTranscriptionConfig } from './audio-transcription.js';

const execFileAsync = promisify(execFile);
export const VIDEO_PROCESSING_VERSION = 'video-chat-v1';
const CACHE_SCHEMA = 1;
const MAX_FRAMES = 6;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 15_000;
const VIDEO_PROCESS_BUDGET_MS = 120_000;
const VIDEO_EXTENSIONS = new Set(['.mp4','.mpeg','.mpg','.mov','.avi','.mkv','.webm','.wmv','.flv']);
const inFlight = new Map<string, Promise<VideoResult>>();
type Frame = { timeSeconds: number; cacheName: string };
type VideoResult = { status: 'ready' | 'failed'; transcript?: string; audioStatus: string; frames: Frame[]; error?: string };
type VideoCache = { schema: number; version: string; sha256: string; status: 'ready' | 'failed'; retryAfter?: number; result: VideoResult };
export function isVideoAttachment(mime: string, filename: string): boolean {
  return mime.toLowerCase().startsWith('video/') || VIDEO_EXTENSIONS.has(ext(filename));
}
function ext(filename: string): string { return filename.slice(filename.lastIndexOf('.')).toLowerCase(); }
function safeMessage(error: unknown): string { return error instanceof Error ? error.message.slice(0, 240) : '未知影片處理錯誤'; }
async function readSource(path: string, expectedSize: number): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { const s = await handle.stat(); if (!s.isFile() || s.size !== expectedSize || s.size > 20 * 1024 * 1024) throw new Error('原始影片無法安全讀取或超過限制'); const data = await handle.readFile(); if (data.length !== s.size) throw new Error('原始影片讀取不完整'); return data; }
  finally { await handle.close(); }
}
async function run(binary: string, args: string[], deadline = Date.now() + VIDEO_PROCESS_BUDGET_MS): Promise<string> {
  const timeout = Math.max(1, Math.min(PROCESS_TIMEOUT_MS, deadline - Date.now()));
  try { const result = await execFileAsync(binary, args, { timeout, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', windowsHide: true }); return result.stdout; }
  catch (e) { const error = e as NodeJS.ErrnoException & { code?: number|string; stderr?: string }; const code = error.code === 'ETIMEDOUT' ? 'timeout' : `exit ${String(error.code ?? 'unknown')}`; throw new Error(`${binary} ${code}${error.stderr ? `: ${error.stderr.replace(/[\r\n\t]+/g,' ').slice(0,160)}` : ''}`); }
}
function cacheRoot(attachmentDir: string): string { return resolve(attachmentDir, '.video-cache'); }
function within(root: string, path: string): boolean { const rel = resolve(path).slice(resolve(root).length); return rel === '' || rel.startsWith(sep); }
async function loadCache(root: string, key: string): Promise<VideoResult | undefined> {
  try {
    const file = join(root, `${key}.json`); const fileStat=await lstat(file); if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > 256 * 1024) return; const raw = await readFile(file, 'utf8');
    const item = JSON.parse(raw) as VideoCache;
    if (item.schema !== CACHE_SCHEMA || item.version !== VIDEO_PROCESSING_VERSION || item.sha256 !== key || !item.result || !['ready','failed'].includes(item.status)) return;
    if ((item.status === 'failed' || item.result.audioStatus.startsWith('音軌轉錄失敗：')) && (item.retryAfter ?? 0) <= Date.now()) return;
    if (item.status === 'ready' && item.result.frames.length === 0) return;
    for (const frame of item.result.frames ?? []) {
      const p = resolve(root, frame.cacheName); if (!frame.cacheName || !within(root,p) || dirname(p) !== resolve(root)) return;
      const s = await lstat(p); if (!s.isFile() || s.isSymbolicLink() || s.size < 16 || s.size > MAX_FRAME_BYTES) return;
      const bytes = await readFile(p); if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
    }
    return item.result;
  } catch { return; }
}
async function saveCache(root: string, key: string, result: VideoResult): Promise<void> {
  const item: VideoCache = { schema: CACHE_SCHEMA, version: VIDEO_PROCESSING_VERSION, sha256: key, status: result.status, ...((result.status === 'failed' || result.audioStatus.startsWith('音軌轉錄失敗：')) ? { retryAfter: Date.now() + 5 * 60_000 } : {}), result };
  const temp = join(root, `.${key}.${randomUUID()}.tmp`); await writeFile(temp, JSON.stringify(item), { flag: 'wx', mode: 0o600 }); await rename(temp, join(root, `${key}.json`));
}
async function processVideo(path: string, filename: string, size: number, root: string, key: string, transcription?: AudioTranscriptionConfig, fetcher?: typeof fetch): Promise<VideoResult> {
  const work = join(root, `.work-${randomUUID()}`); await mkdir(work, { mode: 0o700 });
  const frames: Frame[] = []; let audioStatus = '影片無音軌，未產生轉錄。'; let transcript: string | undefined;
  try {
    const sourceBytes = await readSource(path, size); const source = join(work, `input${ext(filename) || '.bin'}`); await writeFile(source, sourceBytes, { mode: 0o600 });
    const probeText = await run('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-show_entries','format=duration:stream=codec_type,r_frame_rate,avg_frame_rate,duration','-of','json',source]);
    const probe = JSON.parse(probeText) as { format?: { duration?: string }; streams?: Array<{ codec_type?: string; avg_frame_rate?: string; r_frame_rate?: string; duration?: string }> };
    const streams = probe.streams ?? []; const video = streams.find(s=>s.codec_type === 'video'); const audio = streams.some(s=>s.codec_type === 'audio');
    const duration = Number(video?.duration ?? probe.format?.duration); if (!video || !Number.isFinite(duration) || duration <= 0) throw new Error('影片沒有可讀取的視訊串流或時長');
    if (audio) {
      try { const wav = join(work,'audio.wav'); await run('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-i',source,'-vn','-ac','1','-ar','16000','-y',wav]); const s=await stat(wav); if (!s.isFile() || s.size < 44 || s.size > 25*1024*1024) throw new Error('抽取音軌超出限制或無效'); transcript = await transcribeAudio({path:wav,filename:'audio.wav',config:transcription,fetcher}); audioStatus='音軌已轉錄（Groq Whisper）。'; }
      catch(e) { audioStatus=`音軌轉錄失敗：${safeMessage(e)}；原始影片已保留。`; }
    }
    const rate = video.avg_frame_rate ?? video.r_frame_rate ?? ''; const [n,d] = rate.split('/').map(Number); const frameStep = n>0 && d>0 ? d/n : 1/25; const tailSafe = Math.max(0.05, Math.min(0.5, frameStep*2));
    const end = Math.max(0,duration-tailSafe); const targets = [...new Set(Array.from({length:MAX_FRAMES},(_,i)=>end*i/(MAX_FRAMES-1)))];
    let frameError='影格輸出無效';
    for (let i=0;i<targets.length;i++) {
      const target=targets[i]!; let saved: string|undefined; let used=target;
      for (let attempt=0;attempt<3;attempt++) {
        used=Math.max(0,target-attempt*Math.max(frameStep,0.04)); const temp=join(work,`frame-${i}-${attempt}.jpg`);
        try { await run('ffmpeg',['-nostdin','-v','error','-protocol_whitelist','file,pipe','-ss',used.toFixed(3),'-i',source,'-frames:v','1','-vf',`scale='min(1280,iw)':'min(1280,ih)':force_original_aspect_ratio=decrease`,'-y',temp]); const s=await stat(temp); if (s.isFile()&&s.size>16&&s.size<=MAX_FRAME_BYTES) { const b=await readFile(temp); if(b[0]===0xff&&b[1]===0xd8){saved=temp;break;} } }
        catch (error) { frameError=safeMessage(error); /* bounded fallback attempts */ }
      }
      if (saved) { const cacheName=`${key}-${i}.jpg`; await rename(saved,join(root,cacheName)); frames.push({timeSeconds:Number(used.toFixed(3)),cacheName}); }
    }
    if (!frames.length) throw new Error(`無法從影片擷取有效畫面：${frameError}`);
    const result: VideoResult={status:'ready',audioStatus, ...(transcript?{transcript}:{}),frames}; await saveCache(root,key,result); return result;
  } catch(e) {
    const result: VideoResult={status:'failed',audioStatus,frames:[],error:safeMessage(e)}; await saveCache(root,key,result).catch(()=>{}); return result;
  } finally { const { rm }=await import('node:fs/promises'); await rm(work,{recursive:true,force:true}).catch(()=>{}); }
}
export async function getVideoAttachmentResult(input: { path: string; filename: string; size: number; attachmentDir: string; transcription?: AudioTranscriptionConfig; fetcher?: typeof fetch }): Promise<{ result: VideoResult; frames: Array<{timeSeconds:number; bytes:Buffer; cachePath:string}> }> {
  const bytes=await readSource(input.path,input.size); const key=createHash('sha256').update(bytes).digest('hex'); const root=cacheRoot(input.attachmentDir); await mkdir(root,{recursive:true,mode:0o700}); const rootStat=await lstat(root); if(!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('影片快取目錄不安全'); await chmod(root,0o700);
  let result=await loadCache(root,key);
  if (!result) { const flightKey=`${root}:${key}`; let pending=inFlight.get(flightKey); if(!pending){pending=processVideo(input.path,input.filename,input.size,root,key,input.transcription,input.fetcher).finally(()=>inFlight.delete(flightKey));inFlight.set(flightKey,pending);} result=await pending; }
  const frames=[] as Array<{timeSeconds:number;bytes:Buffer;cachePath:string}>;
  if(result.status==='ready') for(const frame of result.frames){const p=resolve(root,frame.cacheName);if(!within(root,p)||dirname(p)!==root)throw new Error('影片快取路徑無效');frames.push({timeSeconds:frame.timeSeconds,bytes:await readFile(p),cachePath:p});}
  return {result,frames};
}
