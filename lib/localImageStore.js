const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

const EXT_BY_MIMETYPE = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif'
};

// Local-disk image store — used when CLOUDINARY_URL isn't set (e.g. local dev, or a
// production deploy that hasn't set up Cloudinary yet). Served automatically by the
// app's existing blanket express.static root, the same mechanism that already serves
// games/*.json directly.
function createLocalImageStore() {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });

    return {
        backend: 'local',

        async uploadImage(buffer, meta) {
            const ext = EXT_BY_MIMETYPE[meta && meta.mimetype] || 'jpg';
            // A caller-supplied publicId (e.g. Final Jeopardy's per-team answer slot)
            // reuses the same filename on every upload, so a redraw overwrites in place
            // instead of accumulating a new file per submission. The cache-busting query
            // param matters only in this overwrite case — browsers won't otherwise notice
            // the file changed underneath an unchanged URL.
            const filename = (meta && meta.publicId) ? `${meta.publicId}.${ext}` : `${crypto.randomUUID()}.${ext}`;
            await fsp.writeFile(path.join(UPLOADS_DIR, filename), buffer);
            const cacheBust = (meta && meta.publicId) ? `?v=${Date.now()}` : '';
            return { url: `/uploads/${filename}${cacheBust}`, publicId: (meta && meta.publicId) || null };
        }
    };
}

module.exports = { createLocalImageStore, EXT_BY_MIMETYPE };
