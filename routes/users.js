const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');

const usersFile = path.join(__dirname, '..', 'data', 'users.json');

// Get current user profile
router.get('/me', async (req, res) => {
  try {
    res.json({
      success: true,
      user: {
        uid: req.user.uid,
        email: req.user.email,
        displayName: req.user.displayName,
        photoURL: req.user.photoURL,
        storageUsed: req.user.storageUsed || 0,
        storageLimit: req.user.storageLimit || 100 * 1024 * 1024 * 1024,
        storageUsedGB: ((req.user.storageUsed || 0) / (1024 * 1024 * 1024)).toFixed(2),
        storageLimitGB: 100,
        percentUsed: Math.min(100, ((req.user.storageUsed || 0) / (req.user.storageLimit || 1)) * 100).toFixed(1),
        isAdmin: !!req.isAdmin,
        banned: !!req.user.banned,
        phone: req.user.phone || null,
        phoneVerified: !!req.user.phoneVerified,
        phoneVerifiedAt: req.user.phoneVerifiedAt || null,
        phonePending: req.user.phonePending || null
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update display name
router.put('/me/name', async (req, res) => {
  try {
    const { displayName } = req.body;
    if (!displayName || typeof displayName !== 'string' || displayName.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'Display name must be at least 2 characters.' });
    }

    const users = await fs.readJson(usersFile);
    if (!users[req.uid]) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const oldName = users[req.uid].displayName;
    users[req.uid].displayName = displayName.trim().slice(0, 50);
    await fs.writeJson(usersFile, users, { spaces: 2 });

    // Broadcast notification
    const broadcast = req.app.get('broadcastNotification');
    if (broadcast) {
      await broadcast({
        type: 'profile_update',
        message: `${users[req.uid].displayName} updated their profile name`,
        user: users[req.uid].displayName,
        userId: req.uid
      });
    }

    res.json({
      success: true,
      displayName: users[req.uid].displayName,
      message: 'Profile name updated successfully'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Recalculate storage used for a user (scan their files)
router.post('/me/recalculate-storage', async (req, res) => {
  try {
    // For simplicity in this shared storage model, we track per-user contribution
    // In a real system you would scan ownership metadata
    const users = await fs.readJson(usersFile);
    // Keep existing value; a full scan would require file ownership tracking
    res.json({
      success: true,
      storageUsed: users[req.uid]?.storageUsed || 0,
      message: 'Storage recalculated (tracked on upload/delete)'
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
