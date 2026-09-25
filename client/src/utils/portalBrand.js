/**
 * Branding for the client-facing portal.
 *
 * The portal is a product surface, not a personal one — a client signing in
 * should see the product they're using, never the organisation owner's own
 * name (`Organisation.orgName` is frequently just a person's first name). The
 * team behind a request is referred to generically as "the team" for the same
 * reason.
 */
export const PORTAL_BRAND = 'Macan';
export const PORTAL_BRAND_INITIAL = PORTAL_BRAND.charAt(0).toUpperCase();

/**
 * The wordmark beside the brand mark. When the workspace has uploaded a logo,
 * the LOGO is the brand — putting "Macan" beside an agency's own mark would
 * read as two companies — so the text becomes a plain description instead.
 * The org's NAME is still never shown, for the reason above: uploading a logo
 * is a deliberate branding act, a workspace name is not.
 */
export const portalBrandName = (orgLogo) => (orgLogo ? 'Support portal' : PORTAL_BRAND);
