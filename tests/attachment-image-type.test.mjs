import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectSupportedImageType, resolveSupportedImageType, imageUploadFilename, AttachmentImageTypeConflictError } from '../dist/attachment-image-type.js';
import { messageAttachmentContent } from '../dist/input-attachments.js';
import { Hindsight } from '../dist/hindsight.js';

const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3]);
const jpeg = Buffer.from([0xff,0xd8,0xff,1]);
const gif = Buffer.from('GIF89a');
const webp = Buffer.from('RIFFxxxxWEBP');
const message = (attachment) => ({ id:'m', sessionId:'s', role:'user', content:'', createdAt:'2026-01-01T00:00:00.000Z', source:{}, attachments:[attachment], discordSegments:[] });

for (const [name, bytes, mime, ext] of [['PNG',png,'image/png','.png'],['JPEG',jpeg,'image/jpeg','.jpg'],['GIF',gif,'image/gif','.gif'],['WebP',webp,'image/webp','.webp']]) {
  test(`signature detection recognizes ${name}`, () => assert.deepEqual(detectSupportedImageType(bytes), { mimeType:mime, extension:ext }));
}

test('historical ready extensionless octet-stream PNG formats as input_image without rewriting metadata', async () => {
  const root = await mkdtemp(join(tmpdir(),'butler-image-')); const dir=join(root,'attachments'); const images=join(dir,'images'); await mkdir(images,{recursive:true});
  const path=join(images,'123e4567-e89b-12d3-a456-426614174000-ani-references'); await writeFile(path,png);
  try {
    const attachment={ attachmentId:'a', filename:'ani-references', mimeType:'application/octet-stream', size:png.length, status:'ready', localPath:path };
    const [,formatted]=await messageAttachmentContent(message(attachment),dir);
    assert.equal(formatted.type,'input_image'); assert.match(formatted.image_url,/^data:image\/png;base64,/);
    assert.equal(attachment.filename,'ani-references'); assert.equal(attachment.mimeType,'application/octet-stream');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('Hindsight multipart carries inferred MIME/extension while preserving exact bytes and document metadata', async () => {
  const root=await mkdtemp(join(tmpdir(),'butler-upload-')); const path=join(root,'ani-references'); await writeFile(path,png); const seen=[];
  const fetcher=async (_url,init)=>{ seen.push(init.body); return new Response(JSON.stringify({operation_ids:['op-1']}),{status:200,headers:{'content-type':'application/json'}}); };
  try {
    const h=new Hindsight({baseUrl:'http://hindsight.test',bankId:'bank'},fetcher);
    await h.submitAttachmentFile({path,filename:'ani-references',mimeType:'application/octet-stream',documentId:'doc-id',context:'ctx',metadata:{filename:'ani-references'},timestamp:'unset',size:png.length});
    const form=seen[0]; const file=form.get('files');
    assert.equal(file.name,'ani-references.png'); assert.equal(file.type,'image/png'); assert.deepEqual(Buffer.from(await file.arrayBuffer()),png);
    assert.equal(JSON.parse(form.get('request')).files_metadata[0].document_id,'doc-id');
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('Hindsight rejects conflicting source MIME before any upload request', async () => {
  const root=await mkdtemp(join(tmpdir(),'butler-conflict-')); const path=join(root,'photo.png'); await writeFile(path,png); let requests=0;
  try {
    const h=new Hindsight({baseUrl:'http://hindsight.test',bankId:'bank'},async()=>{requests++; return new Response('{}');});
    await assert.rejects(h.submitAttachmentFile({path,filename:'photo.png',mimeType:'image/jpeg',documentId:'doc',context:'ctx',metadata:{},timestamp:'unset',size:png.length}),/MIME metadata/);
    assert.equal(requests,0);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('consistent named image remains named, unknown bytes are not guessed, and conflicts reject', () => {
  assert.equal(imageUploadFilename('photo.png',{mimeType:'image/png',extension:'.png'}),'photo.png');
  assert.equal(resolveSupportedImageType(Buffer.from('unknown'),'mystery','application/octet-stream'),undefined);
  assert.throws(()=>resolveSupportedImageType(png,'photo.jpg','application/octet-stream'),AttachmentImageTypeConflictError);
  assert.throws(()=>resolveSupportedImageType(png,'photo.png','image/jpeg'),AttachmentImageTypeConflictError);
  assert.throws(()=>resolveSupportedImageType(png,'photo.pdf','application/octet-stream'),AttachmentImageTypeConflictError);
});

test('normal image metadata remains input_image and signature conflicts are explicitly surfaced', async () => {
  const root=await mkdtemp(join(tmpdir(),'butler-image-')); const dir=join(root,'attachments'); const images=join(dir,'images'); await mkdir(images,{recursive:true});
  const path=join(images,'123e4567-e89b-12d3-a456-426614174000-photo.png'); await writeFile(path,png);
  try {
    const good={attachmentId:'a',filename:'photo.png',mimeType:'image/png',size:png.length,status:'ready',localPath:path};
    assert.equal((await messageAttachmentContent(message(good),dir))[1].type,'input_image');
    const conflict={...good,mimeType:'image/jpeg'};
    const result=(await messageAttachmentContent(message(conflict),dir))[1];
    assert.equal(result.type,'input_text'); assert.match(result.text,/簽章與來源名稱\/MIME 不一致/);
  } finally { await rm(root,{recursive:true,force:true}); }
});
