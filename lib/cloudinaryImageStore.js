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
                const uploadStream = cloudinary.uploader.upload_stream(
                    {
                        folder: 'jeopardy',
                        resource_type: 'image',
                        // Resize on upload (not just at delivery) so a multi-MB phone photo
                        // doesn't ship straight to the shared screen at full size.
                        transformation: [{ width: 1600, crop: 'limit', quality: 'auto:good' }]
                    },
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
