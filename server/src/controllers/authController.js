const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * Sign a JWT for a given user document.
 */
const signToken = (user) => {
  return jwt.sign(
    {
      userId: user._id.toString(),
      email: user.email,
      name: user.name,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
};

/**
 * Google OAuth callback handler.
 * Passport has attached the authenticated user to req.user.
 * We sign a JWT and redirect the browser back to the frontend with ?token=...
 */
const googleCallback = (req, res) => {
  try {
    const user = req.user;
    if (!user) {
      return res.redirect(`${process.env.CLIENT_URL}/login?error=auth_failed`);
    }

    const token = signToken(user);
    return res.redirect(
      `${process.env.CLIENT_URL}/auth/callback?token=${encodeURIComponent(token)}`
    );
  } catch (err) {
    console.error('Google callback error:', err);
    return res.redirect(`${process.env.CLIENT_URL}/login?error=auth_failed`);
  }
};

/**
 * GET /auth/me — return the current authenticated user (populated workspaces).
 */
const getCurrentUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId)
      .populate('organisations')
      .select('-__v');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({ user });
  } catch (err) {
    console.error('getCurrentUser error:', err);
    return res.status(500).json({ error: 'Server error' });
  }
};

/**
 * POST /auth/logout — JWT is stateless, so we just instruct the client to drop it.
 */
const logout = (req, res) => {
  return res.json({ message: 'Logged out' });
};

module.exports = {
  googleCallback,
  getCurrentUser,
  logout,
};
