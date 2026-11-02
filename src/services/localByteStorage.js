const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

function createLocalByteStorage({ root }) {
  if (!root) throw new Error('local byte storage root is required');
  const resolvedRoot = path.resolve(root);

  function resolveKey(key) {
    const value = String(key || '').replace(/\\/g, '/');
    if (!value || value.includes('\0') || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
      throw new Error('storage key must be a relative path');
    }
    const parts = value.split('/');
    if (parts.some((part) => !part || part === '.' || part === '..')) {
      throw new Error('invalid storage key');
    }
    const absolutePath = path.resolve(resolvedRoot, ...parts);
    if (!absolutePath.startsWith(`${resolvedRoot}${path.sep}`)) {
      throw new Error('storage key escapes storage root');
    }
    return { key: parts.join('/'), absolutePath };
  }

  async function put(key, bytes, options = {}) {
    const resolved = resolveKey(key);
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    await fs.mkdir(path.dirname(resolved.absolutePath), { recursive: true });
    const temporaryPath = `${resolved.absolutePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporaryPath, buffer, { mode: options.mode ?? 0o600, flag: 'wx' });
      await fs.rename(temporaryPath, resolved.absolutePath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
    return { ...resolved, size: buffer.length };
  }

  async function get(key) {
    return fs.readFile(resolveKey(key).absolutePath);
  }

  async function remove(key) {
    try {
      await fs.unlink(resolveKey(key).absolutePath);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  return { put, get, delete: remove };
}

module.exports = { createLocalByteStorage };
