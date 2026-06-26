import { getUploadedFileObject, getUploadedFileRecord, saveUploadedFile } from './file_store.js';
import { uploadFileData } from './chat.js';
import { enqueueRequest, dispatchQueued } from './queue.js';

async function parseMultipartUpload(req) {
  const request = new Request(`http://localhost${req.originalUrl || req.url}`, {
    method: req.method,
    headers: req.headers,
    body: req,
    duplex: 'half',
  });

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    throw new Error('file is required');
  }

  const bytes = Buffer.from(await file.arrayBuffer());
  return {
    filename: file.name || 'upload.bin',
    mimeType: file.type || 'application/octet-stream',
    purpose: String(form.get('purpose') || 'assistants').trim() || 'assistants',
    bytes,
  };
}

export async function handleOpenAIFileUpload(req, res) {
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('multipart/form-data')) {
    return res.status(400).json({ error: { message: 'content-type must be multipart/form-data' } });
  }

  let slot = null;
  try {
    const upload = await parseMultipartUpload(req);
    slot = await enqueueRequest(false);
    const glmFile = await uploadFileData(upload.bytes, upload.filename, upload.mimeType, slot.token);
    const fileObject = saveUploadedFile(glmFile, {
      filename: upload.filename,
      bytes: upload.bytes.length,
      mimeType: upload.mimeType,
      fileData: upload.bytes,
      purpose: upload.purpose,
    });
    res.json(fileObject);
  } catch (err) {
    const message = err.message || 'Failed to upload file';
    const status = message === 'file is required' ? 400 : 500;
    res.status(status).json({ error: { message } });
  } finally {
    if (slot) {
      slot.release();
      dispatchQueued();
    }
  }
}

export function handleOpenAIFileRetrieve(req, res) {
  const fileId = String(req.params.file_id || '').trim();
  if (!fileId) {
    return res.status(400).json({ error: { message: 'file_id is required' } });
  }

  const fileObject = getUploadedFileObject(fileId);
  if (!fileObject || !getUploadedFileRecord(fileId)) {
    return res.status(404).json({ error: { message: 'file not found' } });
  }

  res.json(fileObject);
}
