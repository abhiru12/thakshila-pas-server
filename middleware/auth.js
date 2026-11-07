const admin = require('firebase-admin');
const fs = require('fs-extra');
const path = require('path');

const usersFile = path.join(__dirname, '..', 'data', 'users.json');

// Only this email has admin privileges (can create events, ban users, see view stats)
const ADMIN_EMAIL = 'abhiruanuhas23@gmail.com';

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required. Please login with Google.' });
  }

  const token = authHeader.split('Bearer ')[1];

  try {
    let decoded;

    if (global.firebaseMock) {
      try {
        const mock = JSON.parse(Buffer.from(token, 'base64').toString());
        decoded = {
          uid: mock.uid || 'mock-user-' + Date.now(),
          email: mock.email || 'member@thakshila.edu',
          name: mock.name || 'Member',
          picture: mock.picture || null
        };
      } catch {
        decoded = {
          uid: 'dev-user-001',
          email: 'dev@thakshila.edu',
          name: 'Development User'
        };
      }
    } else {
      decoded = await admin.auth().verifyIdToken(token);
    }

    // Load or create user record
    let users = {};
    try {
      users = await fs.readJson(usersFile);
    } catch {
      users = {};
    }

    const isAdmin = (decoded.email || '').toLowerCase() === ADMIN_EMAIL.toLowerCase();

    if (!users[decoded.uid]) {
      users[decoded.uid] = {
        uid: decoded.uid,
        email: decoded.email || '',
        displayName: decoded.name || decoded.email?.split('@')[0] || 'Member',
        photoURL: decoded.picture || null,
        storageUsed: 0,
        storageLimit: 100 * 1024 * 1024 * 1024, // 100 GB
        banned: false,
        isAdmin: isAdmin,
        phone: null,
        phoneVerified: false,
        phoneVerifiedAt: null,
        createdAt: new Date().toISOString(),
        lastLogin: new Date().toISOString()
      };
      await fs.writeJson(usersFile, users, { spaces: 2 });
    } else {
      // Keep admin flag in sync with email
      users[decoded.uid].isAdmin = isAdmin;
      users[decoded.uid].lastLogin = new Date().toISOString();
      if (decoded.picture) users[decoded.uid].photoURL = decoded.picture;
      // Ensure banned field exists
      if (typeof users[decoded.uid].banned === 'undefined') {
        users[decoded.uid].banned = false;
      }
      await fs.writeJson(usersFile, users, { spaces: 2 });
    }

    const user = users[decoded.uid];

    // Block banned users
    if (user.banned) {
      return res.status(403).json({
        success: false,
        error: 'Your account has been banned by the administrator. Contact the society admin if you believe this is a mistake.',
        code: 'BANNED'
      });
    }

    req.user = user;
    req.uid = decoded.uid;
    req.isAdmin = isAdmin;
    next();
  } catch (err) {
    console.error('Auth error:', err.message);
    return res.status(401).json({ success: false, error: 'Invalid or expired token. Please login again.' });
  }
}

// Optional middleware that only allows admins
function requireAdmin(req, res, next) {
  if (!req.isAdmin) {
    return res.status(403).json({
      success: false,
      error: 'Admin access only. Only the society administrator can perform this action.'
    });
  }
  next();
}

module.exports = authMiddleware;
module.exports.requireAdmin = requireAdmin;
module.exports.ADMIN_EMAIL = ADMIN_EMAIL;
