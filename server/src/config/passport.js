const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User');
const { cloudinary } = require('./cloudinary');

/**
 * Pull a Google-hosted avatar URL into our own Cloudinary folder so we control
 * the asset (Google links can expire). Applies the same face-crop 200x200 webp
 * transform used for manual uploads. Falls back to the original Google URL if
 * the upload fails, and to null if there is no source image.
 */
const hostAvatar = async (googleUrl) => {
  if (!googleUrl) return null;
  try {
    const res = await cloudinary.uploader.upload(googleUrl, {
      folder: 'macan/avatars',
      transformation: [
        { width: 200, height: 200, crop: 'fill', gravity: 'face', format: 'webp' },
      ],
    });
    return res.secure_url;
  } catch (err) {
    console.error('hostAvatar error:', err);
    return googleUrl;
  }
};

/**
 * Where Google sends the EXTERNAL CLIENT back after they "Accept invitation" and
 * sign in on a Client Portal link. It is a distinct callback from the app's
 * (`GOOGLE_CALLBACK_URL`) so the two flows never cross. Derived from the app
 * callback's origin when `GOOGLE_PORTAL_CALLBACK_URL` isn't set explicitly.
 */
const portalCallbackURL =
  process.env.GOOGLE_PORTAL_CALLBACK_URL ||
  (process.env.GOOGLE_CALLBACK_URL
    ? new URL('/api/portal/auth/google/callback', process.env.GOOGLE_CALLBACK_URL).toString()
    : undefined);

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: process.env.GOOGLE_CALLBACK_URL,
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        const googleId = profile.id;
        const email =
          profile.emails && profile.emails[0] && profile.emails[0].value;
        const name = profile.displayName;
        const profilePic =
          profile.photos && profile.photos[0] && profile.photos[0].value;

        let user = await User.findOne({ googleId });

        if (!user) {
          // Also check by email in case the user exists without googleId
          user = await User.findOne({ email });
          if (user) {
            user.googleId = googleId;
            if (!user.profilePic && profilePic) {
              user.profilePic = await hostAvatar(profilePic);
            }
            if (!user.name && name) user.name = name;
            await user.save();
          } else {
            user = await User.create({
              googleId,
              email,
              name,
              profilePic: await hostAvatar(profilePic),
            });
          }
        }

        return done(null, user);
      } catch (err) {
        console.error('Google strategy verify error:', err);
        return done(err, null);
      }
    }
  )
);

/**
 * `google-portal` — the Client Portal's Google sign-in. It is deliberately a
 * SEPARATE strategy from the app one above:
 *
 *  - It NEVER touches the `User` collection. An external client must never
 *    become an app user or enter the org/permission graph. The verify callback
 *    just hands the raw Google identity (email + name + avatar) to the portal
 *    callback controller, which upserts a `ClientContact` scoped to one group
 *    and mints a `scope:'portal'` JWT.
 *  - It uses its own callback URL (`portalCallbackURL`) so Google can tell the
 *    two flows apart. Add that URL to the OAuth client's authorized redirect
 *    URIs in the Google Cloud console.
 *
 * Which group the client is joining rides along in the OAuth `state` param (the
 * group's `portalToken`), set when the flow starts in routes/portal.js.
 */
passport.use(
  'google-portal',
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: portalCallbackURL,
    },
    (accessToken, refreshToken, profile, done) => {
      const email =
        profile.emails && profile.emails[0] && profile.emails[0].value;
      if (!email) {
        return done(new Error('Google account did not return an email'), null);
      }
      return done(null, {
        email: String(email).toLowerCase(),
        name: profile.displayName || '',
        picture: (profile.photos && profile.photos[0] && profile.photos[0].value) || '',
      });
    }
  )
);

module.exports = passport;
