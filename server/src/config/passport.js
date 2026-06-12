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

module.exports = passport;
