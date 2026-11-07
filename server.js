require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const fs = require('fs-extra');
const admin = require('firebase-admin');

// Routes
const filesRouter = require('./routes/files');
const foldersRouter = require('./routes/folders');
const usersRouter = require('./routes/users');
const notificationsRouter = require('./routes/notifications');
const eventsRouter = require('./routes/events');
const otpRouter = require('./routes/otp');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"]
  }
});

// Make io available to routes
app.set('io', io);

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));

// Serve storage files publicly (view only)
app.use('/storage', express.static(path.join(__dirname, 'storage'), {
  setHeaders: (res, filePath) => {
    // Allow embedding and download
    res.set('Access-Control-Allow-Origin', '*');
  }
}));

// Ensure storage root exists
const STORAGE_ROOT = path.join(__dirname, 'storage');
fs.ensureDirSync(STORAGE_ROOT);

// Data store for users, folders metadata, notifications (simple JSON for demo)
const DATA_DIR = path.join(__dirname, 'data');
fs.ensureDirSync(DATA_DIR);

const usersFile = path.join(DATA_DIR, 'users.json');
const foldersFile = path.join(DATA_DIR, 'folders.json');
const notificationsFile = path.join(DATA_DIR, 'notifications.json');

if (!fs.existsSync(usersFile)) fs.writeJsonSync(usersFile, {});
if (!fs.existsSync(foldersFile)) fs.writeJsonSync(foldersFile, { folders: [] });
if (!fs.existsSync(notificationsFile)) fs.writeJsonSync(notificationsFile, { notifications: [] });
const eventsFile = path.join(DATA_DIR, 'events.json');
if (!fs.existsSync(eventsFile)) fs.writeJsonSync(eventsFile, { events: [] });
const otpsFile = path.join(DATA_DIR, 'otps.json');
if (!fs.existsSync(otpsFile)) fs.writeJsonSync(otpsFile, { requests: {}, byPhone: {}, pending: {} });

// Initialize Firebase Admin (use env or placeholder)
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin initialized');
  } else if (fs.existsSync(path.join(__dirname, 'firebase-service-account.json'))) {
    const serviceAccount = require('./firebase-service-account.json');
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log('Firebase Admin initialized from file');
  } else {
    console.warn('⚠️  Firebase Admin not configured. Auth verification will be mocked for development.');
    // Mock for development
    global.firebaseMock = true;
  }
} catch (err) {
  console.warn('Firebase init error:', err.message);
  global.firebaseMock = true;
}

// Auth middleware (used by routes)
const authMiddleware = require('./middleware/auth');

// API Routes
app.use('/api/files', authMiddleware, filesRouter);
app.use('/api/folders', authMiddleware, foldersRouter);
app.use('/api/users', authMiddleware, usersRouter);
app.use('/api/notifications', authMiddleware, notificationsRouter);
app.use('/api/events', authMiddleware, eventsRouter);
app.use('/api/otp', authMiddleware, otpRouter);

// Public endpoint to list public content (no auth required for viewing)
app.get('/api/public/tree', async (req, res) => {
  try {
    const foldersData = await fs.readJson(foldersFile);
    const tree = await buildPublicTree(STORAGE_ROOT, foldersData.folders || []);
    res.json({ success: true, tree });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Public notifications (latest few)
app.get('/api/public/notifications', async (req, res) => {
  try {
    const data = await fs.readJson(notificationsFile);
    const recent = (data.notifications || []).slice(-50).reverse();
    res.json({ success: true, notifications: recent });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Public upcoming events (no auth required to view list)
app.get('/api/public/events', async (req, res) => {
  try {
    const data = await fs.readJson(path.join(DATA_DIR, 'events.json')).catch(() => ({ events: [] }));
    const now = new Date();
    // Show upcoming + events from last 7 days
    const events = (data.events || [])
      .filter(e => new Date(e.eventDate) >= new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000))
      .sort((a, b) => new Date(a.eventDate) - new Date(b.eventDate))
      .map(e => ({
        id: e.id,
        title: e.title,
        description: e.description,
        eventDate: e.eventDate,
        location: e.location || '',
        createdBy: e.createdBy,
        createdAt: e.createdAt,
        viewCount: (e.viewers || []).length
      }));
    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Helper to build public tree
async function buildPublicTree(dir, folderMeta, relative = '') {
  const items = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    const relPath = relative ? `${relative}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      const meta = (folderMeta || []).find(f => f.path === relPath) || {};
      const children = await buildPublicTree(fullPath, folderMeta, relPath);
      items.push({
        type: 'folder',
        name: entry.name,
        path: relPath,
        createdBy: meta.createdBy || 'system',
        createdAt: meta.createdAt || null,
        children
      });
    } else {
      const stats = await fs.stat(fullPath);
      items.push({
        type: 'file',
        name: entry.name,
        path: relPath,
        size: stats.size,
        mime: require('mime-types').lookup(entry.name) || 'application/octet-stream',
        modified: stats.mtime
      });
    }
  }
  return items;
}

// Socket.IO for real-time notifications
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('join', (userId) => {
    if (userId) {
      socket.join(`user:${userId}`);
      socket.join('global');
      console.log(`User ${userId} joined rooms`);
    }
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Global notification broadcaster
app.set('broadcastNotification', async (notification) => {
  try {
    const data = await fs.readJson(notificationsFile);
    data.notifications = data.notifications || [];
    data.notifications.push({
      id: require('uuid').v4(),
      ...notification,
      timestamp: new Date().toISOString()
    });
    // Keep last 200
    if (data.notifications.length > 200) {
      data.notifications = data.notifications.slice(-200);
    }
    await fs.writeJson(notificationsFile, data, { spaces: 2 });

    // Broadcast to all
    io.to('global').emit('notification', notification);
  } catch (err) {
    console.error('Broadcast error:', err);
  }
});

// Fallback to index.html for SPA-like behavior
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 Thakshila College Photographic Art Society - Server running on http://localhost:${PORT}`);
  console.log(`📁 Storage folder: ${STORAGE_ROOT}`);
  console.log(`🎨 Colors: Maroon / Dark Yellow / Cream\n`);
});
