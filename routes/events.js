const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { requireAdmin, ADMIN_EMAIL } = require('../middleware/auth');

const eventsFile = path.join(__dirname, '..', 'data', 'events.json');
const usersFile = path.join(__dirname, '..', 'data', 'users.json');

async function loadEvents() {
  try {
    const data = await fs.readJson(eventsFile);
    return data.events || [];
  } catch {
    return [];
  }
}

async function saveEvents(events) {
  await fs.writeJson(eventsFile, { events }, { spaces: 2 });
}

function formatEventDate(iso) {
  try {
    return new Date(iso).toLocaleString('en-LK', {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return iso;
  }
}

// ========== ADMIN member routes FIRST (before /:id) ==========

// GET /api/events/admin/members
router.get('/admin/members', requireAdmin, async (req, res) => {
  try {
    const users = await fs.readJson(usersFile).catch(() => ({}));
    const list = Object.values(users).map(u => ({
      uid: u.uid,
      email: u.email,
      displayName: u.displayName,
      photoURL: u.photoURL,
      banned: !!u.banned,
      isAdmin: !!u.isAdmin,
      phone: u.phone || null,
      phoneVerified: !!u.phoneVerified,
      storageUsed: u.storageUsed || 0,
      lastLogin: u.lastLogin,
      createdAt: u.createdAt
    })).sort((a, b) => (b.lastLogin || '').localeCompare(a.lastLogin || ''));

    res.json({ success: true, members: list });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/events/admin/ban
router.post('/admin/ban', requireAdmin, async (req, res) => {
  try {
    const { uid, ban = true } = req.body;
    if (!uid) {
      return res.status(400).json({ success: false, error: 'uid is required' });
    }
    if (uid === req.uid) {
      return res.status(400).json({ success: false, error: 'You cannot ban yourself.' });
    }

    const users = await fs.readJson(usersFile);
    if (!users[uid]) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    if (users[uid].isAdmin || (users[uid].email || '').toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
      return res.status(400).json({ success: false, error: 'Cannot ban the administrator.' });
    }

    users[uid].banned = !!ban;
    users[uid].bannedAt = ban ? new Date().toISOString() : null;
    users[uid].bannedBy = ban ? req.uid : null;
    await fs.writeJson(usersFile, users, { spaces: 2 });

    res.json({
      success: true,
      message: ban
        ? `${users[uid].displayName} has been banned.`
        : `${users[uid].displayName} has been unbanned.`,
      user: {
        uid: users[uid].uid,
        displayName: users[uid].displayName,
        banned: users[uid].banned
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========== Events ==========

// GET /api/events — list events
router.get('/', async (req, res) => {
  try {
    let events = await loadEvents();
    events = events.sort((a, b) => new Date(a.eventDate) - new Date(b.eventDate));

    if (!req.isAdmin) {
      events = events.map(e => ({
        id: e.id,
        title: e.title,
        description: e.description,
        eventDate: e.eventDate,
        location: e.location || '',
        createdBy: e.createdBy,
        createdAt: e.createdAt,
        viewCount: (e.viewers || []).length
      }));
    }

    res.json({ success: true, events });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/events — create event (ADMIN ONLY)
router.post('/', requireAdmin, async (req, res) => {
  try {
    const { title, description, eventDate, location } = req.body;

    if (!title || typeof title !== 'string' || title.trim().length < 3) {
      return res.status(400).json({ success: false, error: 'Title is required (min 3 characters).' });
    }
    if (!eventDate) {
      return res.status(400).json({ success: false, error: 'Event date & time is required.' });
    }
    const parsedDate = new Date(eventDate);
    if (isNaN(parsedDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid event date.' });
    }

    const events = await loadEvents();
    const newEvent = {
      id: uuidv4(),
      title: title.trim().slice(0, 120),
      description: (description || '').trim().slice(0, 2000),
      eventDate: parsedDate.toISOString(),
      location: (location || '').trim().slice(0, 200),
      createdBy: req.user.displayName,
      createdByUid: req.uid,
      createdAt: new Date().toISOString(),
      viewers: []
    };

    events.push(newEvent);
    await saveEvents(events);

    const broadcast = req.app.get('broadcastNotification');
    if (broadcast) {
      await broadcast({
        type: 'event',
        message: `📅 New Event: ${newEvent.title} — ${formatEventDate(newEvent.eventDate)}${newEvent.location ? ' @ ' + newEvent.location : ''}`,
        user: req.user.displayName,
        userId: req.uid,
        eventId: newEvent.id,
        eventTitle: newEvent.title,
        eventDate: newEvent.eventDate
      });
    }

    res.status(201).json({
      success: true,
      event: newEvent,
      message: 'Event created and notification sent to all members.'
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/events/:id — view event (records view)
router.get('/:id', async (req, res) => {
  try {
    const events = await loadEvents();
    const event = events.find(e => e.id === req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }

    event.viewers = event.viewers || [];
    const alreadyViewed = event.viewers.some(v => v.uid === req.uid);
    if (!alreadyViewed) {
      event.viewers.push({
        uid: req.uid,
        displayName: req.user.displayName,
        email: req.user.email,
        viewedAt: new Date().toISOString()
      });
      await saveEvents(events);
    }

    const response = { ...event };
    if (!req.isAdmin) {
      response.viewCount = (event.viewers || []).length;
      delete response.viewers;
    }

    res.json({ success: true, event: response });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PUT /api/events/:id
router.put('/:id', requireAdmin, async (req, res) => {
  try {
    const events = await loadEvents();
    const idx = events.findIndex(e => e.id === req.params.id);
    if (idx === -1) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }

    const { title, description, eventDate, location } = req.body;
    if (title) events[idx].title = title.trim().slice(0, 120);
    if (typeof description === 'string') events[idx].description = description.trim().slice(0, 2000);
    if (eventDate) {
      const parsed = new Date(eventDate);
      if (isNaN(parsed.getTime())) {
        return res.status(400).json({ success: false, error: 'Invalid event date.' });
      }
      events[idx].eventDate = parsed.toISOString();
    }
    if (typeof location === 'string') events[idx].location = location.trim().slice(0, 200);
    events[idx].updatedAt = new Date().toISOString();

    await saveEvents(events);

    const broadcast = req.app.get('broadcastNotification');
    if (broadcast) {
      await broadcast({
        type: 'event_update',
        message: `📅 Event updated: ${events[idx].title}`,
        user: req.user.displayName,
        userId: req.uid,
        eventId: events[idx].id
      });
    }

    res.json({ success: true, event: events[idx], message: 'Event updated.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/events/:id
router.delete('/:id', requireAdmin, async (req, res) => {
  try {
    let events = await loadEvents();
    const before = events.length;
    events = events.filter(e => e.id !== req.params.id);
    if (events.length === before) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }
    await saveEvents(events);
    res.json({ success: true, message: 'Event deleted.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/events/:id/viewers
router.get('/:id/viewers', requireAdmin, async (req, res) => {
  try {
    const events = await loadEvents();
    const event = events.find(e => e.id === req.params.id);
    if (!event) {
      return res.status(404).json({ success: false, error: 'Event not found' });
    }
    res.json({
      success: true,
      eventId: event.id,
      title: event.title,
      viewCount: (event.viewers || []).length,
      viewers: event.viewers || []
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
