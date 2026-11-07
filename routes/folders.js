const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const STORAGE_ROOT = path.join(__dirname, '..', 'storage');
const foldersFile = path.join(__dirname, '..', 'data', 'folders.json');
const usersFile = path.join(__dirname, '..', 'data', 'users.json');

// Sanitize path to prevent traversal
function safePath(relPath) {
  const normalized = path.normalize(relPath || '').replace(/^(\.\.(\/|\\|$))+/, '');
  if (normalized.includes('..')) throw new Error('Invalid path');
  return normalized;
}

// Create folder
router.post('/create', async (req, res) => {
  try {
    const { name, parentPath = '' } = req.body;
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({ success: false, error: 'Folder name is required' });
    }

    // Sanitize folder name
    const safeName = name.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 100);
    if (!safeName) {
      return res.status(400).json({ success: false, error: 'Invalid folder name' });
    }

    const parent = safePath(parentPath);
    const fullParent = path.join(STORAGE_ROOT, parent);
    await fs.ensureDir(fullParent);

    const newFolderPath = path.join(parent, safeName);
    const fullNewPath = path.join(STORAGE_ROOT, newFolderPath);

    if (await fs.pathExists(fullNewPath)) {
      return res.status(400).json({ success: false, error: 'A folder or file with this name already exists' });
    }

    await fs.ensureDir(fullNewPath);

    // Save metadata
    const foldersData = await fs.readJson(foldersFile).catch(() => ({ folders: [] }));
    foldersData.folders = foldersData.folders || [];
    foldersData.folders.push({
      id: uuidv4(),
      name: safeName,
      path: newFolderPath.replace(/\\/g, '/'),
      parentPath: parent.replace(/\\/g, '/'),
      createdBy: req.user.displayName,
      createdByUid: req.uid,
      createdAt: new Date().toISOString()
    });
    await fs.writeJson(foldersFile, foldersData, { spaces: 2 });

    // Notify
    const broadcast = req.app.get('broadcastNotification');
    if (broadcast) {
      await broadcast({
        type: 'folder_create',
        message: `${req.user.displayName} created folder "${safeName}"`,
        user: req.user.displayName,
        userId: req.uid,
        path: newFolderPath.replace(/\\/g, '/')
      });
    }

    res.json({
      success: true,
      folder: {
        name: safeName,
        path: newFolderPath.replace(/\\/g, '/')
      },
      message: 'Folder created successfully'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Rename folder
router.put('/rename', async (req, res) => {
  try {
    const { path: folderPath, newName } = req.body;
    if (!folderPath || !newName) {
      return res.status(400).json({ success: false, error: 'Path and new name are required' });
    }

    const safeName = newName.trim().replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').slice(0, 100);
    if (!safeName) {
      return res.status(400).json({ success: false, error: 'Invalid folder name' });
    }

    const rel = safePath(folderPath);
    const fullOld = path.join(STORAGE_ROOT, rel);

    if (!(await fs.pathExists(fullOld)) || !(await fs.stat(fullOld)).isDirectory()) {
      return res.status(404).json({ success: false, error: 'Folder not found' });
    }

    const parentDir = path.dirname(rel);
    const newRel = path.join(parentDir === '.' ? '' : parentDir, safeName);
    const fullNew = path.join(STORAGE_ROOT, newRel);

    if (await fs.pathExists(fullNew)) {
      return res.status(400).json({ success: false, error: 'A folder or file with this name already exists' });
    }

    await fs.move(fullOld, fullNew);

    // Update metadata
    const foldersData = await fs.readJson(foldersFile).catch(() => ({ folders: [] }));
    foldersData.folders = (foldersData.folders || []).map(f => {
      if (f.path === rel.replace(/\\/g, '/')) {
        return { ...f, name: safeName, path: newRel.replace(/\\/g, '/'), updatedAt: new Date().toISOString(), updatedBy: req.user.displayName };
      }
      // Update children paths
      if (f.path.startsWith(rel.replace(/\\/g, '/') + '/')) {
        return { ...f, path: f.path.replace(rel.replace(/\\/g, '/'), newRel.replace(/\\/g, '/')) };
      }
      return f;
    });
    await fs.writeJson(foldersFile, foldersData, { spaces: 2 });

    const broadcast = req.app.get('broadcastNotification');
    if (broadcast) {
      await broadcast({
        type: 'folder_rename',
        message: `${req.user.displayName} renamed folder to "${safeName}"`,
        user: req.user.displayName,
        userId: req.uid,
        path: newRel.replace(/\\/g, '/')
      });
    }

    res.json({
      success: true,
      folder: { name: safeName, path: newRel.replace(/\\/g, '/') },
      message: 'Folder renamed successfully'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete folder (and contents)
router.delete('/delete', async (req, res) => {
  try {
    const { path: folderPath } = req.body;
    if (!folderPath) {
      return res.status(400).json({ success: false, error: 'Path is required' });
    }

    const rel = safePath(folderPath);
    const full = path.join(STORAGE_ROOT, rel);

    if (!(await fs.pathExists(full)) || !(await fs.stat(full)).isDirectory()) {
      return res.status(404).json({ success: false, error: 'Folder not found' });
    }

    // Calculate size before delete for storage accounting (simplified - attribute to deleter)
    // In production track ownership properly
    await fs.remove(full);

    // Clean metadata
    const foldersData = await fs.readJson(foldersFile).catch(() => ({ folders: [] }));
    foldersData.folders = (foldersData.folders || []).filter(f => {
      const p = f.path;
      return p !== rel.replace(/\\/g, '/') && !p.startsWith(rel.replace(/\\/g, '/') + '/');
    });
    await fs.writeJson(foldersFile, foldersData, { spaces: 2 });

    const broadcast = req.app.get('broadcastNotification');
    if (broadcast) {
      await broadcast({
        type: 'folder_delete',
        message: `${req.user.displayName} deleted folder "${path.basename(rel)}"`,
        user: req.user.displayName,
        userId: req.uid,
        path: rel.replace(/\\/g, '/')
      });
    }

    res.json({ success: true, message: 'Folder deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// List folder contents (authenticated view with more meta)
router.get('/list', async (req, res) => {
  try {
    const rel = safePath(req.query.path || '');
    const full = path.join(STORAGE_ROOT, rel);
    await fs.ensureDir(full);

    const entries = await fs.readdir(full, { withFileTypes: true });
    const foldersData = await fs.readJson(foldersFile).catch(() => ({ folders: [] }));
    const items = [];

    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const itemRel = path.join(rel, entry.name).replace(/\\/g, '/');
      const itemFull = path.join(full, entry.name);
      const stats = await fs.stat(itemFull);

      if (entry.isDirectory()) {
        const meta = (foldersData.folders || []).find(f => f.path === itemRel) || {};
        items.push({
          type: 'folder',
          name: entry.name,
          path: itemRel,
          createdBy: meta.createdBy || null,
          createdAt: meta.createdAt || stats.birthtime,
          size: null
        });
      } else {
        items.push({
          type: 'file',
          name: entry.name,
          path: itemRel,
          size: stats.size,
          mime: require('mime-types').lookup(entry.name) || 'application/octet-stream',
          modified: stats.mtime
        });
      }
    }

    // Sort folders first
    items.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ success: true, path: rel.replace(/\\/g, '/'), items });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
