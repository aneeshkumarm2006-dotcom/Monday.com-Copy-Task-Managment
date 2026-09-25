/**
 * Client-side logo checks — the SAME limits the server's `logoUpload` enforces
 * (server/src/config/cloudinary.js), so a wrong file is refused instantly with a
 * sentence instead of after an upload. The server stays the authority.
 */
export const LOGO_ACCEPT = 'image/png,image/jpeg,image/webp,image/svg+xml,image/gif';
export const LOGO_MAX_BYTES = 2 * 1024 * 1024;

/** '' when the file is acceptable, else the sentence to show. */
export const validateLogoFile = (file) => {
  if (!file) return 'No file selected.';
  if (!/^image\/(png|jpe?g|webp|svg\+xml|gif)$/i.test(file.type || '')) {
    return 'Please choose a PNG, JPG, WEBP, SVG or GIF image.';
  }
  if (file.size > LOGO_MAX_BYTES) return 'That image is over 2MB. Please use a smaller file.';
  return '';
};
