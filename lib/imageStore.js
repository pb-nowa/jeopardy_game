const { createLocalImageStore } = require('./localImageStore');
const { createCloudinaryImageStore } = require('./cloudinaryImageStore');

// Selects the image storage backend: Cloudinary if CLOUDINARY_URL is set (e.g. on
// Render, so uploaded photos survive redeploys), otherwise local-disk files under
// uploads/ (zero-setup local dev). Both backends implement the same interface:
// uploadImage(buffer, meta) -> {url, publicId} — see localImageStore.js/cloudinaryImageStore.js.
function createImageStore() {
    if (process.env.CLOUDINARY_URL) {
        console.log('Image storage: Cloudinary');
        return createCloudinaryImageStore();
    }

    if (process.env.NODE_ENV === 'production') {
        console.warn('WARNING: no Cloudinary configured (CLOUDINARY_URL) — uploaded photos will be stored on local disk and will NOT survive a redeploy on platforms with ephemeral storage (e.g. Render without a Persistent Disk).');
    }
    console.log('Image storage: local disk (uploads/)');
    return createLocalImageStore();
}

module.exports = { createImageStore };
