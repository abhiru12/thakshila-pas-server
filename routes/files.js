const express = require('express');
const router = express.Router();
const multer = require('multer');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const mime = require('mime-types');

const STORAGE_ROOT = path.join(__dirname, '..', 'storage');
const usersFile = path.join(__dirname, '..', 'data', 'users.json');

function safePath(relPath) {
  const normalized = path.normalize(relPath || '').replace(/^(\.\.(\/|\\|$))+/, '');
  if (normalized.includes('..')) throw new Error('Invalid path');
  return normalized;
}

// Configure multer for disk storage
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      const destRel = safePath(req.body.path || req.query.path || '');
      const dest = path.join(STORAGE_ROOT, destRel);
      await fs.ensureDir(dest);
      cb(null, dest);
    } catch (err) {
      cb(err);
    }
  },
  filename: (req, file, cb) => {
    // Keep original name but sanitize
    const original = file.originalname || 'file';
    const safe = original.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 200);
    // Avoid overwrite by adding short uuid if exists
    cb(null, safe);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024 // 2 GB per file max (reasonable for videos)
  },
  fileFilter: (req, file, cb) => {
    // Allow common image, video, audio, document types
    const allowed = /jpeg|jpg|png|gif|webp|bmp|svg|mp4|webm|mov|avi|mkv|mp3|wav|ogg|pdf|doc|docx|ppt|pptx|txt|zip|rar/;
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    const mimetype = file.mimetype || '';
    if (allowed.test(ext) || mimetype.startsWith('image/') || mimetype.startsWith('video/') || mimetype.startsWith('audio/')) {
      cb(null, true);
    } else {
      cb(new Error('File type not allowed. Allowed: images, videos, audio, documents, archives.'));
    }
  }
});

// Check storage limit before accepting
async function checkStorageLimit(uid, additionalBytes) {
  const users = await fs.readJson(usersFile).catch(() => ({}));
  const user = users[uid];
  if (!user) return { ok: false, error: 'User not found' };

  const used = user.storageUsed || 0;
  const limit = user.storageLimit || 100 * 1024 * 1024 * 1024; // 100 GB

  if (used + additionalBytes > limit) {
    const usedGB = (used / (1024 ** 3)).toFixed(2);
    const limitGB = (limit / (1024 ** 3)).toFixed(0);
    return {
      ok: false,
      error: `Storage limit exceeded! You have used ${usedGB} GB of your ${limitGB} GB quota. Please delete some files to free up space before uploading more.`
    };
  }
  return { ok: true, user, users };
}

// Upload single or multiple files
router.post('/upload', upload.array('files', 20), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    // Calculate total size
    const totalSize = req.files.reduce((sum, f) => sum + f.size, 0);

    // Check limit
    const check = await checkStorageLimit(req.uid, totalSize);
    if (!check.ok) {
      // Clean up uploaded files
      for (const f of req.files) {
        await fs.remove(f.path).catch(() => {});
      }
      return res.status(403).json({ success: false, error: check.error, code: 'STORAGE_LIMIT' });
    }

    // Update user storage
    const { users, user } = check;
    users[req.uid].storageUsed = (user.storageUsed || 0) + totalSize;
    await fs.writeJson(usersFile, users, { spaces: 2 });

    const uploaded = req.files.map(f => ({
      name: f.filename,
      originalName: f.originalname,
      size: f.size,
      path: path.relative(STORAGE_ROOT, f.path).replace(/\\/g, '/'),
      mime: f.mimetype
    }));

    // Notify
    const broadcast = req.app.get('broadcastNotification');
    if (broadcast) {
      const names = uploaded.map(u => u.name).join(', ');
      await broadcast({
        type: 'file_upload',
        message: `${req.user.displayName} uploaded ${uploaded.length} file(s): ${names.length > 80 ? names.slice(0, 80) + '...' : names}`,
        user: req.user.displayName,
        userId: req.uid,
        count: uploaded.length,
        paths: uploaded.map(u => u.path)
      });
    }

    res.json({
      success: true,
      files: uploaded,
      storageUsed: users[req.uid].storageUsed,
      message: `${uploaded.length} file(s) uploaded successfully`
    });
  } catch (err) {
    console.error(err);
    // Cleanup on error
    if (req.files) {
      for (const f of req.files) {
        await fs.remove(f.path).catch(() => {});
      }
    }
    res.status(500).json({ success: false, error: err.message || 'Upload failed' });
  }
});

// Upload entire directory (multiple files with relative paths preserved via webkitRelativePath)
router.post('/upload-directory', upload.array('files', 100), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ success: false, error: 'No files uploaded' });
    }

    const basePath = safePath(req.body.path || '');
    const totalSize = req.files.reduce((sum, f) => sum + f.size, 0);

    const check = await checkStorageLimit(req.uid, totalSize);
    if (!check.ok) {
      for (const f of req.files) await fs.remove(f.path).catch(() => {});
      return res.status(403).json({ success: false, error: check.error, code: 'STORAGE_LIMIT' });
    }

    // Move files according to relative paths if provided
    const results = [];
    for (const file of req.files) {
      // Client should send relativePath in form data or we use filename
      // For simplicity, files already landed in destination; if webkitRelativePath used,
      // we need custom handling. Here we keep them in the target folder.
      results.push({
        name: file.filename,
        size: file.size,
        path: path.relative(STORAGE_ROOT, file.path).replace(/\\/g, '/')
      });
    }

    const { users, user } = check;
    users[req.uid].storageUsed = (user.storageUsed || 0) + totalSize;
    await fs.writeJson(usersFile, users, { spaces: 2 });

    const broadcast = req.app.get('broadcastNotification');
    if (broadcast) {
      await broadcast({
        type: 'directory_upload',
        message: `${req.user.displayName} uploaded a directory with ${results.length} file(s)`,
        user: req.user.displayName,
        userId: req.uid,
        count: results.length
      });
    }

    res.json({
      success: true,
      files: results,
      storageUsed: users[req.uid].storageUsed,
      message: `Directory uploaded (${results.length} files)`
    });
  } catch (err) {
    console.error(err);
    if (req.files) for (const f of req.files) await fs.remove(f.path).catch(() => {});
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete file
router.delete('/delete', async (req, res) => {
  try {
    const { path: filePath } = req.body;
    if (!filePath) {
      return res.status(400).json({ success: false, error: 'Path is required' });
    }

    const rel = safePath(filePath);
    const full = path.join(STORAGE_ROOT, rel);

    if (!(await fs.pathExists(full)) || (await fs.stat(full)).isDirectory()) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    const stats = await fs.stat(full);
    const size = stats.size;

    await fs.remove(full);

    // Decrease storage used (simplified - attribute to current user)
    const users = await fs.readJson(usersFile).catch(() => ({}));
    if (users[req.uid]) {
      users[req.uid].storageUsed = Math.max(0, (users[req.uid].storageUsed || 0) - size);
      await fs.writeJson(usersFile, users, { spaces: 2 });
    }

    const broadcast = req.app.get('broadcastNotification');
    if (broadcast) {
      await broadcast({
        type: 'file_delete',
        message: `${req.user.displayName} deleted file "${path.basename(rel)}"`,
        user: req.user.displayName,
        userId: req.uid,
        path: rel.replace(/\\/g, '/')
      });
    }

    res.json({
      success: true,
      message: 'File deleted successfully',
      storageUsed: users[req.uid]?.storageUsed || 0
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rename file
router.put('/rename', async (req, res) => {
  try {
    const { path: filePath, newName } = req.body;
    if (!filePath || !newName) {
      return res.status(400).json({ success: false, error: 'Path and new name required' });
    }

    const safeName = newName.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 200);
    if (!safeName) return res.status(400).json({ success: false, error: 'Invalid name' });

    const rel = safePath(filePath);
    const fullOld = path.join(STORAGE_ROOT, rel);

    if (!(await fs.pathExists(fullOld)) || (await fs.stat(fullOld)).isDirectory()) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    const dir = path.dirname(rel);
    const newRel = path.join(dir === '.' ? '' : dir, safeName);
    const fullNew = path.join(STORAGE_ROOT, newRel);

    if (await fs.pathExists(fullNew)) {
      return res.status(400).json({ success: false, error: 'A file with this name already exists' });
    }

    await fs.move(fullOld, fullNew);

    const broadcast = req.app.get('broadcastNotification');
    if (broadcast) {
      await broadcast({
        type: 'file_rename',
        message: `${req.user.displayName} renamed a file to "${safeName}"`,
        user: req.user.displayName,
        userId: req.uid,
        path: newRel.replace(/\\/g, '/')
      });
    }

    res.json({
      success: true,
      file: { name: safeName, path: newRel.replace(/\\/g, '/') },
      message: 'File renamed successfully'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
