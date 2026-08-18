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
    // Scoped tokens are signed with the same secret and must NEVER be accepted
    // as an app session:
    //
    //   'portal' — a Client Portal contact. Carries no real `userId`, so it
    //              would sail through here with `userId: undefined`. Portal
    //              requests go through middleware/portalAuth.js.
    //   'vault'  — proof that somebody entered a board's vault password. It
    //              DOES carry a userId, which is exactly why it has to be named
    //              here: without this line a 15-minute unlock token would work
    //              as a full app session on every endpoint in the API.
    //
    // Each scope's own middleware rejects the others in return.
    if (decoded.scope === 'portal' || decoded.scope === 'vault') {
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
