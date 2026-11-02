const {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client
} = require('@aws-sdk/client-s3');

function createR2ByteStorage({ root = '', client, bucket = process.env.R2_BUCKET } = {}) {
  if (!bucket) throw new Error('R2_BUCKET is required');
  if (!client && (!process.env.R2_ENDPOINT || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY)) {
    throw new Error('R2_ENDPOINT, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required');
  }
  const s3 = client || new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
  const prefix = String(root || '').replace(/^\/+|\/+$/g, '');

  function resolveKey(key) {
    const value = String(key || '').replace(/\\/g, '/');
    if (!value || value.includes('\0') || value.startsWith('/')) {
      throw new Error('storage key must be a relative path');
    }
    const parts = value.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error('invalid storage key');
    }
    const normalized = parts.join('/');
    if (prefix && (normalized === prefix || normalized.startsWith(`${prefix}/`))) return normalized;
    return prefix ? `${prefix}/${normalized}` : normalized;
  }

  async function put(key, bytes, options = {}) {
    const objectKey = resolveKey(key);
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: objectKey,
      Body: buffer,
      ContentType: options.contentType || undefined
    }));
    return { key: objectKey, size: buffer.length };
  }

  async function get(key) {
    const objectKey = resolveKey(key);
    try {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (error.name === 'NoSuchKey') {
        const notFound = new Error(`object not found: ${objectKey}`);
        notFound.code = 'ENOENT';
        throw notFound;
      }
      throw error;
    }
  }

  // ponytail: R2/S3 delete is idempotent and doesn't report whether the key existed;
  // a HEAD-before-delete would cost a round trip nobody reads the return value for
  // (see callers). Always resolves true. Add a HEAD check if a caller starts relying
  // on the "did it exist" signal.
  async function remove(key) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: resolveKey(key) }));
    return true;
  }

  return { put, get, delete: remove };
}

module.exports = { createR2ByteStorage };
