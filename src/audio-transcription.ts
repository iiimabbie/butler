import { readSafeFile } from './safe-file.js';

export interface AudioTranscriptionConfig {
  apiKey: string;
}

const GROQ_TRANSCRIPTION_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_AUDIO_EXTENSIONS = new Set(['.flac', '.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.ogg', '.wav', '.webm']);

export async function transcribeAudio(input: { path: string; filename: string; config?: AudioTranscriptionConfig; timeoutMs?: number }): Promise<string> {
  if (!input.config) throw new Error('語音轉錄未設定，原始音訊已保留。');
  const ext = input.filename.toLowerCase().slice(input.filename.lastIndexOf('.'));
  if (!GROQ_AUDIO_EXTENSIONS.has(ext) && ext !== '.opus') throw new Error(`Groq 不支援此音訊格式（${ext || '無副檔名'}），原始音訊已保留。`);
  let bytes: Buffer;
  try {
    bytes = await readSafeFile(input.path);
  } catch { throw new Error('無法安全讀取已保存音訊，原始檔案仍保留。'); }
  const form = new FormData();
  const uploadName = ext === '.opus' ? `${input.filename.slice(0, -ext.length)}.ogg` : input.filename;
  form.set('file', new Blob([new Uint8Array(bytes)]), uploadName);
  form.set('model', 'whisper-large-v3');
  form.set('response_format', 'json');
  let response: Response;
  try {
    response = await fetch(GROQ_TRANSCRIPTION_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${input.config.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(input.timeoutMs ?? 120_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('Groq 語音轉錄逾時，原始音訊已保留。');
    throw new Error('Groq 語音轉錄請求失敗，原始音訊已保留。');
  }
  if (!response.ok) throw new Error(`Groq 語音轉錄失敗（HTTP ${response.status}），原始音訊已保留。`);
  let body: unknown;
  try { body = await response.json(); } catch { throw new Error('Groq 語音轉錄回應格式無效，原始音訊已保留。'); }
  if (typeof body !== 'object' || body === null || Array.isArray(body) || typeof (body as Record<string, unknown>).text !== 'string') throw new Error('Groq 語音轉錄回應缺少文字，原始音訊已保留。');
  const transcript = ((body as { text: string }).text).trim();
  if (!transcript) throw new Error('音訊中沒有可轉錄語音，原始音訊已保留。');
  return transcript;
}
