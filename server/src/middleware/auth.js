const jwt = require('jsonwebtoken');

const authMiddleware = (req, res, next) => {
  const authHeader = req.headers.authorization || '';

  if (!authHeader.startsWith('Bearer ')) {
    return res
      .status(401)
      .json({ error: 'Missing or invalid authorization header' });
  }

  const token = authHeader.slice('Bearer '.length).trim();

  if (!token) {
    return res.status(401).json({ error: 'Missing token' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Client Portal tokens are signed with the same secret but carry
    // `scope: 'portal'` and no real `userId`. They must NEVER be accepted on the
    // app API — otherwise a portal token would sail through here with
    // `userId: undefined`. Portal requests go through middleware/portalAuth.js.
    if (decoded.scope === 'portal') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    req.user = {
      userId: decoded.userId,
      email: decoded.email,
      name: decoded.name,
    };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};

module.exports = authMiddleware;
