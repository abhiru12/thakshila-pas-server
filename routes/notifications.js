const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');

const notificationsFile = path.join(__dirname, '..', 'data', 'notifications.json');

// Get recent notifications
router.get('/', async (req, res) => {
  try {
    const data = await fs.readJson(notificationsFile).catch(() => ({ notifications: [] }));
    const list = (data.notifications || []).slice(-100).reverse();
    res.json({ success: true, notifications: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mark as read (optional client-side tracking mostly)
router.post('/read', async (req, res) => {
  // For simplicity we don't persist per-user read state in this version
  res.json({ success: true });
});

module.exports = router;
