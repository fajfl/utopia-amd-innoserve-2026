// Shrinks phone photos in the browser before upload: long edge 2048px, JPEG 0.8.
// 2048px still shows hairline cracks and water stains when zoomed; a 12MP original
// is ~4x the pixels and ~5-10x the bytes, which is what made LINE uploads slow.
// Videos, PDFs and anything the browser can't decode are passed through untouched.
(function (root) {
  const MAX_EDGE = 2048;
  const QUALITY = 0.8;

  function scaledSize(width, height, maxEdge = MAX_EDGE) {
    const scale = Math.min(1, maxEdge / Math.max(width, height));
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  }

  async function compressImage(file) {
    if (!file || !/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type || '')) return file;
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      const { width, height } = scaledSize(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff'; // transparent PNG areas would turn black as JPEG
      context.fillRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      if (bitmap.close) bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', QUALITY));
      if (!blob || blob.size >= file.size) return file;
      return new File([blob], String(file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
    } catch (error) {
      return file; // old WebView or out of memory: upload the original rather than fail
    }
  }

  if (typeof module === 'object' && module.exports) module.exports = { scaledSize, MAX_EDGE, QUALITY };
  else root.compressImage = compressImage;
})(this);
