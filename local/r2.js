/**
 * The images bucket, backed by a directory on the box.
 *
 * Only two operations are used: `upload.js` puts a file, and `serveImage()` in
 * index.js gets one back and copies its metadata onto the response. That is
 * the whole contract, and it is worth keeping it to exactly that — an R2
 * re-implementation is not the project.
 *
 * Keys contain slashes (`menu/1234-abc-photo.jpg`), so they map onto nested
 * directories. They are checked against escaping that root before anything
 * touches the filesystem: the key reaches this code from a URL.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

function resolveKey(root, key) {
  const target = path.resolve(root, key);
  const bounded = path.resolve(root) + path.sep;
  if (!target.startsWith(bounded)) {
    throw new Error(`R2 key escapes the bucket root: ${key}`);
  }
  return target;
}

class LocalR2Bucket {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, { recursive: true });
  }

  async put(key, body, options = {}) {
    const file = resolveKey(this.root, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });

    // Handlers pass `file.stream()` — a web ReadableStream. Buffers and strings
    // are accepted too, since that is what a test or a future caller will hand over.
    if (body && typeof body.getReader === 'function') {
      await fs.promises.writeFile(file, Readable.fromWeb(body));
    } else if (body instanceof ArrayBuffer) {
      await fs.promises.writeFile(file, Buffer.from(body));
    } else {
      await fs.promises.writeFile(file, body);
    }

    const contentType = options.httpMetadata?.contentType || null;
    await fs.promises.writeFile(file + '.meta.json', JSON.stringify({ contentType }));
    const stat = await fs.promises.stat(file);
    return { key, size: stat.size, etag: etagFor(stat) };
  }

  async get(key) {
    let file;
    try { file = resolveKey(this.root, key); } catch { return null; }
    let stat;
    try { stat = await fs.promises.stat(file); } catch { return null; }
    if (!stat.isFile()) return null;

    let contentType = null;
    try {
      contentType = JSON.parse(fs.readFileSync(file + '.meta.json', 'utf8')).contentType;
    } catch { /* an object stored without metadata still serves */ }

    const etag = etagFor(stat);
    return {
      key,
      size: stat.size,
      etag,
      httpEtag: `"${etag}"`,
      httpMetadata: { contentType },
      body: Readable.toWeb(fs.createReadStream(file)),
      writeHttpMetadata(headers) {
        if (contentType) headers.set('Content-Type', contentType);
      },
      async arrayBuffer() {
        const buf = await fs.promises.readFile(file);
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
      },
    };
  }

  async head(key) {
    const object = await this.get(key);
    if (!object) return null;
    delete object.body;
    return object;
  }

  async delete(key) {
    const file = resolveKey(this.root, key);
    await fs.promises.rm(file, { force: true });
    await fs.promises.rm(file + '.meta.json', { force: true });
  }
}

/** Size and mtime are enough to change when the object changes. */
function etagFor(stat) {
  return `${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}`;
}

export function createR2Bucket(root) {
  return new LocalR2Bucket(root);
}
