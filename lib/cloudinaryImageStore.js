const cloudinary = require('cloudinary').v2;
const { Readable } = require('stream');

// Cloudinary-backed image store — used when CLOUDINARY_URL is set, so uploaded photos
// survive redeploys on hosts with ephemeral storage (e.g. Render). The Cloudinary Node
// SDK auto-parses CLOUDINARY_URL (format cloudinary://<api_key>:<api_secret>@<cloud_name>)
// from the environment the moment this module is required — no explicit
// cloudinary.config() call needed.
function createCloudinaryImageStore() {
    return {
        backend: 'cloudinary',

        uploadImage(buffer, meta) {
            return new Promise((resolve, reject) => {
                const options = {
                    folder: 'jeopardy',
                    resource_type: 'image',
                    // Resize on upload (not just at delivery) so a multi-MB phone photo
                    // doesn't ship straight to the shared screen at full size.
                    transformation: [{ width: 1600, crop: 'limit', quality: 'auto:good' }]
                };
                // A caller-supplied publicId (e.g. Final Jeopardy's per-team answer slot)
                // overwrites the same asset on every upload instead of accumulating a new
                // one per submission. Cloudinary bumps the version segment in secure_url
                // on each overwrite, so callers still get a fresh, cache-safe URL back.
                if (meta && meta.publicId) {
                    options.public_id = meta.publicId;
                    options.overwrite = true;
                    options.invalidate = true;
                }
                const uploadStream = cloudinary.uploader.upload_stream(
                    options,
                    (err, result) => {
                        if (err) return reject(err);
                        resolve({ url: result.secure_url, publicId: result.public_id });
                    }
                );
                Readable.from(buffer).pipe(uploadStream);
            });
        }
    };
}

module.exports = { createCloudinaryImageStore };
