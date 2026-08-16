import { json } from '../lib/db.js';

/**
 * File upload to R2.
 *
 * Used for menu and gallery images, and — since payment evidence was wired up —
 * for the transfer screenshots §9 requires against a Telebirr, CBE or bank
 * payment.
 *
 * ── Why evidence goes in its own prefix ─────────────────────────────────────
 *
 * Everything landed under `uploads/` regardless of what it was, so a payment
 * screenshot sat beside a menu photo with nothing distinguishing them. Evidence
 * is financial-record retention and menu images are not, so they are separated
 * at the key: `payments/` can be given a different lifecycle rule, and it is
 * possible to answer "show me every payment screenshot from March" at all.
 */

/** Prefixes a caller may write to. Anything else falls back to `uploads/`. */
const FOLDERS = new Set(['uploads', 'payments', 'menu', 'gallery', 'receipts']);

/**
 * Images and PDFs only. Without this the endpoint accepts any file a browser
 * will post, and R2 becomes a general-purpose file host attached to a till.
 */
const ALLOWED_TYPES = /^(image\/(jpeg|jpg|png|webp|gif|heic|heif)|application\/pdf)$/i;

/** 10 MB. A phone screenshot is well under this; a video is not. */
const MAX_BYTES = 10 * 1024 * 1024;

async function handleUpload(request, env) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) return json({ ok: false, error: 'No file' }, 400);

    if (file.type && !ALLOWED_TYPES.test(file.type)) {
      return json(
        { ok: false, error: `Files of type ${file.type} are not accepted — use an image or a PDF` },
        415
      );
    }
    if (file.size && file.size > MAX_BYTES) {
      return json(
        { ok: false, error: `That file is ${Math.round(file.size / 1048576)} MB; the limit is 10 MB` },
        413
      );
    }

    const requested = String(formData.get('folder') || 'uploads');
    const folder = FOLDERS.has(requested) ? requested : 'uploads';

    // The original name is kept for recognisability but sanitised, and prefixed
    // with a timestamp so two screenshots taken on the same phone in the same
    // minute cannot overwrite one another.
    const safeName = String(file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80);
    const key = `${folder}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${safeName}`;

    await env.IMAGES_R2.put(key, file.stream(), { httpMetadata: { contentType: file.type } });

    return json({
      ok: true,
      key,
      // Served back through the API's own /api/images/ route, which is what the
      // POS can actually reach — the images subdomain is not wired for these.
      url: `/api/images/${encodeURIComponent(key)}`,
      contentType: file.type || null,
      size: file.size || null,
    });
  } catch (e) {
    return json({ ok: false, error: String(e.message || e) }, 500);
  }
}

export { handleUpload, FOLDERS, ALLOWED_TYPES, MAX_BYTES };
