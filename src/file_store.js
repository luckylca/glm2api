const uploadedFiles = new Map();

const TEXT_PREVIEW_LIMIT = 128 * 1024;
const TEXT_MIME_RE = /^(text\/|application\/(json|xml|javascript|x-javascript|typescript|x-typescript))/i;

function toOpenAIFileObject(record) {
  if (!record) return null;
  return {
    id: record.id,
    object: 'file',
    bytes: record.bytes,
    created_at: record.created_at,
    filename: record.filename,
    purpose: record.purpose,
    status: 'uploaded',
    status_details: null,
  };
}

function tryDecodeText(buffer, mimeType, filename) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length === 0) return '';
  const normalizedMime = String(mimeType || '').trim().toLowerCase();
  const lowerName = String(filename || '').toLowerCase();
  const looksTextByName = /\.(txt|md|markdown|json|js|ts|tsx|jsx|xml|yaml|yml|csv|log|py|java|go|rs|c|cc|cpp|h|hpp|html|css|sql)$/i.test(lowerName);
  if (!TEXT_MIME_RE.test(normalizedMime) && !looksTextByName) return '';

  const slice = buffer.subarray(0, TEXT_PREVIEW_LIMIT);
  try {
    return slice.toString('utf8');
  } catch {
    return '';
  }
}

function buildDisplayFile(record) {
  if (!record) return null;
  return {
    id: record.id,
    name: record.filename,
    filename: record.filename,
    bytes: record.bytes,
    mimeType: record.mimeType || '',
    content: record.textContent || '',
    source: 'stored-upload',
  };
}

export function saveUploadedFile(glmFile, {
  filename = '',
  bytes = 0,
  purpose = 'assistants',
  mimeType = '',
  fileData = null,
} = {}) {
  if (!glmFile?.file_id) {
    throw new Error('uploaded GLM file is missing file_id');
  }

  const buffer = Buffer.isBuffer(fileData) ? fileData : null;
  const resolvedFilename = filename || glmFile.file_name || 'upload.bin';
  const record = {
    id: glmFile.file_id,
    created_at: Math.floor(Date.now() / 1000),
    filename: resolvedFilename,
    purpose,
    bytes: Buffer.isBuffer(bytes) ? bytes.length : (Number.isFinite(bytes) ? bytes : (buffer?.length || glmFile.file_size || 0)),
    mimeType: mimeType || '',
    textContent: tryDecodeText(buffer, mimeType, resolvedFilename),
    glmFile: {
      ...glmFile,
      file_name: glmFile.file_name || resolvedFilename,
    },
  };

  uploadedFiles.set(record.id, record);
  return toOpenAIFileObject(record);
}

export function getUploadedFileRecord(fileId) {
  return uploadedFiles.get(fileId) || null;
}

export function getUploadedFileObject(fileId) {
  return toOpenAIFileObject(getUploadedFileRecord(fileId));
}

export function getUploadedFileDisplay(fileId) {
  return buildDisplayFile(getUploadedFileRecord(fileId));
}
