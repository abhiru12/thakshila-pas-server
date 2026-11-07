// ============================================
// Thakshila College Photographic Art Society - Server
// Frontend Application
// ============================================

// ---------- Firebase Config ----------
const firebaseConfig = {
  apiKey: "AIzaSyDCUmcdjAwDJ31aomyPD2nEJ7Ge4nzHDII",
  authDomain: "abhiru-apps.firebaseapp.com",
  projectId: "abhiru-apps",
  storageBucket: "abhiru-apps.firebasestorage.app",
  messagingSenderId: "193586722366",
  appId: "1:193586722366:web:3c2313198d7ddd4a15c36f"
};

// Real Firebase Google login enabled
const USE_MOCK_AUTH = false;

let app, auth, currentUser = null, idToken = null;
let socket = null;
let currentPath = '';
let renameTarget = null; // { type, path, name }
let deleteTarget = null;
let unreadNotifs = 0;
let browserNotifsEnabled = false;
let isAdmin = false;
let editingEventId = null;

// ---------- Init ----------
document.addEventListener('DOMContentLoaded', () => {
  initFirebase();
  initSocket();
  initBrowserNotifications();
  initEventsUI();
  loadPublicTree();
  loadNotifications();
  loadEvents();
});

function initFirebase() {
  if (USE_MOCK_AUTH) {
    console.log('Running in MOCK auth mode. Login will create a mock user.');
    // Check localStorage for existing mock session
    const saved = localStorage.getItem('pas_mock_user');
    if (saved) {
      try {
        currentUser = JSON.parse(saved);
        idToken = btoa(JSON.stringify({ uid: currentUser.uid, email: currentUser.email, name: currentUser.displayName }));
        onAuthSuccess();
      } catch (e) {}
    }
    return;
  }

  try {
    app = firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    auth.onAuthStateChanged(async (user) => {
      if (user) {
        // Prefer photo from providerData (Google) when user.photoURL is missing
        const googleProvider = (user.providerData || []).find(p => p.providerId === 'google.com');
        const photo =
          user.photoURL ||
          googleProvider?.photoURL ||
          null;
        currentUser = {
          uid: user.uid,
          email: user.email || '',
          displayName: user.displayName || googleProvider?.displayName || (user.email ? user.email.split('@')[0] : 'Member'),
          photoURL: photo
        };
        idToken = await user.getIdToken();
        onAuthSuccess();
      } else {
        onAuthLogout();
      }
    });
  } catch (err) {
    console.error('Firebase init failed, falling back to mock:', err);
  }
}

function initSocket() {
  socket = io();
  socket.on('connect', () => {
    console.log('Socket connected');
    if (currentUser) socket.emit('join', currentUser.uid);
  });
  socket.on('notification', (notif) => {
    showToast(notif.message, 'info');
    unreadNotifs++;
    updateNotifBadge();
    prependNotification(notif);
    // Browser notification for activity from others (and own actions if tab is in background)
    showBrowserNotification(notif);
  });
}

// ---------- Browser Notifications (Web Notification API) ----------
function initBrowserNotifications() {
  const btn = document.getElementById('browserNotifBtn');
  const dot = document.getElementById('browserNotifDot');

  if (!('Notification' in window)) {
    btn.title = 'Browser notifications not supported';
    btn.disabled = true;
    btn.classList.add('opacity-40');
    return;
  }

  // Restore preference
  browserNotifsEnabled = localStorage.getItem('pas_browser_notifs') === 'true'
    && Notification.permission === 'granted';

  updateBrowserNotifUI();

  btn.addEventListener('click', async () => {
    if (Notification.permission === 'granted') {
      // Toggle off/on
      browserNotifsEnabled = !browserNotifsEnabled;
      localStorage.setItem('pas_browser_notifs', browserNotifsEnabled ? 'true' : 'false');
      updateBrowserNotifUI();
      showToast(
        browserNotifsEnabled
          ? 'Browser notifications enabled'
          : 'Browser notifications disabled',
        'success'
      );
      if (browserNotifsEnabled) {
        showBrowserNotification({
          type: 'system',
          message: 'You will be notified when photos, videos or folders are uploaded or changed.'
        }, true);
      }
      return;
    }

    if (Notification.permission === 'denied') {
      showToast('Notifications are blocked. Please allow them in your browser settings for this site.', 'error');
      return;
    }

    // Request permission
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        browserNotifsEnabled = true;
        localStorage.setItem('pas_browser_notifs', 'true');
        updateBrowserNotifUI();
        showToast('Browser notifications enabled!', 'success');
        showBrowserNotification({
          type: 'system',
          message: 'You will be notified when photos, videos or folders are uploaded or changed.'
        }, true);
      } else {
        browserNotifsEnabled = false;
        localStorage.setItem('pas_browser_notifs', 'false');
        updateBrowserNotifUI();
        showToast('Notification permission denied', 'error');
      }
    } catch (err) {
      showToast('Could not enable notifications: ' + err.message, 'error');
    }
  });
}

function updateBrowserNotifUI() {
  const btn = document.getElementById('browserNotifBtn');
  const dot = document.getElementById('browserNotifDot');
  if (!btn || !dot) return;

  if (browserNotifsEnabled && Notification.permission === 'granted') {
    dot.classList.remove('hidden');
    btn.title = 'Browser notifications ON – click to disable';
    btn.classList.add('text-emerald-400');
  } else {
    dot.classList.add('hidden');
    btn.title = 'Enable browser notifications';
    btn.classList.remove('text-emerald-400');
  }
}

/**
 * Show a native browser notification.
 * @param {object} notif - { type, message, user, ... }
 * @param {boolean} force - show even if tab is focused (for test / enable confirm)
 */
function showBrowserNotification(notif, force = false) {
  if (!browserNotifsEnabled || !('Notification' in window) || Notification.permission !== 'granted') {
    return;
  }

  // Avoid spamming when user is actively looking at the tab (unless forced)
  if (!force && document.visibilityState === 'visible' && document.hasFocus()) {
    // Still allow upload-completed notifications for the uploader
    if (!notif._isOwnUpload) return;
  }

  const title = getNotificationTitle(notif);
  const body = notif.message || 'New activity on the server';
  const icon = '/favicon.ico';

  try {
    const n = new Notification(title, {
      body,
      icon: currentUser?.photoURL || icon,
      badge: icon,
      tag: notif.type || 'pas-activity', // groups similar notifications
      renotify: true,
      silent: false
    });

    n.onclick = () => {
      window.focus();
      n.close();
    };

    // Auto-close after 8 seconds
    setTimeout(() => n.close(), 8000);
  } catch (err) {
    console.warn('Browser notification failed:', err);
  }
}

function getNotificationTitle(notif) {
  const type = notif.type || '';
  switch (type) {
    case 'file_upload':
      return '📷 Upload complete';
    case 'directory_upload':
      return '📁 Folder upload complete';
    case 'folder_create':
      return '📂 New folder created';
    case 'folder_rename':
    case 'file_rename':
      return '✏️ Item renamed';
    case 'folder_delete':
    case 'file_delete':
      return '🗑️ Item deleted';
    case 'profile_update':
      return '👤 Profile updated';
    case 'event':
      return '📅 New Event';
    case 'event_update':
      return '📅 Event Updated';
    case 'system':
      return '🔔 Thakshila PAS Server';
    default:
      return '🔔 Photographic Art Society';
  }
}

/** Call this after a successful upload to notify the uploader */
function notifyUploadComplete(files, isDirectory = false) {
  if (!files || !files.length) return;

  const imageExt = /\.(jpe?g|png|gif|webp|bmp|svg)$/i;
  const videoExt = /\.(mp4|webm|mov|avi|mkv)$/i;

  let images = 0, videos = 0, others = 0;
  files.forEach(f => {
    const name = f.name || f.originalName || '';
    if (imageExt.test(name) || (f.mime || '').startsWith('image/')) images++;
    else if (videoExt.test(name) || (f.mime || '').startsWith('video/')) videos++;
    else others++;
  });

  let message = '';
  if (isDirectory) {
    message = `Directory upload finished – ${files.length} file(s) saved.`;
  } else if (videos > 0 && images === 0 && others === 0) {
    message = videos === 1
      ? 'Video upload completed successfully.'
      : `${videos} videos uploaded successfully.`;
  } else if (images > 0 && videos === 0 && others === 0) {
    message = images === 1
      ? 'Photo upload completed successfully.'
      : `${images} photos uploaded successfully.`;
  } else {
    const parts = [];
    if (images) parts.push(`${images} photo${images > 1 ? 's' : ''}`);
    if (videos) parts.push(`${videos} video${videos > 1 ? 's' : ''}`);
    if (others) parts.push(`${others} file${others > 1 ? 's' : ''}`);
    message = `Upload completed: ${parts.join(', ')}.`;
  }

  showBrowserNotification({
    type: isDirectory ? 'directory_upload' : 'file_upload',
    message,
    _isOwnUpload: true
  }, true);
}

// ---------- Auth ----------
document.getElementById('loginBtn').addEventListener('click', async () => {
  if (USE_MOCK_AUTH) {
    // Simulate Google login
    const name = prompt('Enter your display name (mock login):', 'Society Member') || 'Society Member';
    const email = name.toLowerCase().replace(/\s+/g, '.') + '@thakshila.edu';
    currentUser = {
      uid: 'mock-' + Date.now().toString(36),
      email,
      displayName: name,
      photoURL: `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=800000&color=fff`
    };
    idToken = btoa(JSON.stringify({ uid: currentUser.uid, email, name }));
    localStorage.setItem('pas_mock_user', JSON.stringify(currentUser));
    onAuthSuccess();
    showToast('Logged in (mock mode). Configure Firebase for real Google login.', 'success');
    return;
  }

  const provider = new firebase.auth.GoogleAuthProvider();
  // Request profile + email so Google returns name and profile picture
  provider.addScope('profile');
  provider.addScope('email');
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    const result = await auth.signInWithPopup(provider);
    // Ensure we pick up the latest Google profile (name + photo)
    const user = result.user;
    if (user) {
      const googleProvider = (user.providerData || []).find(p => p.providerId === 'google.com');
      const photo = user.photoURL || googleProvider?.photoURL || null;
      currentUser = {
        uid: user.uid,
        email: user.email || '',
        displayName: user.displayName || googleProvider?.displayName || user.email?.split('@')[0] || 'Member',
        photoURL: photo
      };
      idToken = await user.getIdToken(true);
      onAuthSuccess();
      showToast(`Welcome, ${currentUser.displayName}!`, 'success');
    }
  } catch (err) {
    showToast('Login failed: ' + err.message, 'error');
  }
});

document.getElementById('logoutBtn').addEventListener('click', async () => {
  if (USE_MOCK_AUTH) {
    localStorage.removeItem('pas_mock_user');
    currentUser = null;
    idToken = null;
    onAuthLogout();
    return;
  }
  await auth.signOut();
});

/** Normalize Google / Firebase photo URL so it loads in <img> */
function getAvatarUrl(photoURL, name) {
  const fallback = `https://ui-avatars.com/api/?name=${encodeURIComponent(name || 'Member')}&background=1e2433&color=e8b84a&size=128`;
  if (!photoURL || typeof photoURL !== 'string') return fallback;

  let url = photoURL.trim();
  // Google profile photos need a stable size and no-referrer to load
  if (url.includes('googleusercontent.com')) {
    url = url.replace(/=s\d+(-c)?/g, '=s256-c');
    if (!/[?&]sz=\d+/.test(url) && !/=s\d+/.test(url)) {
      url += (url.includes('?') ? '&' : '?') + 'sz=256';
    } else {
      url = url.replace(/([?&])sz=\d+/g, '$1sz=256');
    }
  }
  return url;
}

function setUserAvatar(photoURL, name) {
  const avatar = document.getElementById('userAvatar');
  if (!avatar) return;
  const displayName = name || currentUser?.displayName || 'Member';
  avatar.alt = displayName;
  avatar.referrerPolicy = 'no-referrer';
  avatar.onerror = function () {
    this.onerror = null;
    this.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=1e2433&color=e8b84a&size=128`;
  };
  avatar.src = getAvatarUrl(photoURL, displayName);
}

function onAuthSuccess() {
  document.getElementById('loginBtn').classList.add('hidden');
  document.getElementById('userMenu').classList.remove('hidden');
  document.getElementById('userMenu').classList.add('flex');
  document.getElementById('loginBanner').classList.add('hidden');
  document.getElementById('newFolderBtn').disabled = false;

  // Show Google name + profile picture immediately
  const name = currentUser.displayName || 'Member';
  document.getElementById('userName').textContent = name;
  setUserAvatar(currentUser.photoURL, name);

  document.getElementById('storageIndicator').classList.remove('hidden');
  document.getElementById('storageIndicator').classList.add('flex');

  if (socket) socket.emit('join', currentUser.uid);
  fetchUserProfile();
  loadFolder(currentPath);
  loadEvents();
}

function onAuthLogout() {
  document.getElementById('loginBtn').classList.remove('hidden');
  document.getElementById('userMenu').classList.add('hidden');
  document.getElementById('userMenu').classList.remove('flex');
  document.getElementById('loginBanner').classList.remove('hidden');
  document.getElementById('newFolderBtn').disabled = true;
  document.getElementById('storageIndicator').classList.add('hidden');
  currentUser = null;
  idToken = null;
  isAdmin = false;
  updateAdminUI();
  loadPublicTree();
}

async function fetchUserProfile() {
  try {
    const res = await api('/api/users/me');
    if (res.success) {
      const u = res.user;
      // Prefer server-stored display name (user may have customized it)
      if (u.displayName) {
        currentUser.displayName = u.displayName;
        document.getElementById('userName').textContent = u.displayName;
      }
      // Prefer Google photo from client; fall back to server-stored photo
      const photo = currentUser.photoURL || u.photoURL || null;
      if (u.photoURL && !currentUser.photoURL) currentUser.photoURL = u.photoURL;
      setUserAvatar(photo, currentUser.displayName);
      updateStorageUI(u.storageUsed, u.storageLimit, u.storageUsedGB, u.percentUsed);
      isAdmin = !!u.isAdmin;
      currentUser.phone = u.phone || null;
      currentUser.phoneVerified = !!u.phoneVerified;
      currentUser.phoneVerifiedAt = u.phoneVerifiedAt || null;
      updateAdminUI();
      updatePhoneVerifyUI();
      maybePromptPhoneVerify();
    }
  } catch (e) {
    console.error(e);
  }
}

function updateStorageUI(used, limit, usedGB, percent) {
  document.getElementById('storageBar').style.width = Math.min(100, percent) + '%';
  document.getElementById('storageText').textContent = `${usedGB} / 100 GB`;
  const bar = document.getElementById('storageBar');
  if (percent > 90) {
    bar.className = 'bg-gradient-to-r from-rose-dim to-rose h-1.5 rounded-full transition-all duration-500';
  } else {
    bar.className = 'bg-gradient-to-r from-accent-dim to-accent h-1.5 rounded-full transition-all duration-500';
  }
}

// ---------- API helper ----------
async function api(url, options = {}) {
  const headers = options.headers || {};
  if (idToken) headers['Authorization'] = `Bearer ${idToken}`;
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.code = data.code;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------- Folder / File loading ----------
async function loadPublicTree() {
  showLoading(true);
  try {
    // Use public endpoint when not logged in
    if (!currentUser) {
      const res = await fetch('/api/public/tree').then(r => r.json());
      if (res.success) {
        renderItems(flattenForPath(res.tree, currentPath));
      }
    } else {
      await loadFolder(currentPath);
    }
  } catch (e) {
    showToast('Failed to load content', 'error');
  } finally {
    showLoading(false);
  }
}

async function loadFolder(path) {
  currentPath = path || '';
  updateBreadcrumb();
  showLoading(true);
  try {
    if (currentUser) {
      const res = await api(`/api/folders/list?path=${encodeURIComponent(currentPath)}`);
      renderItems(res.items || []);
    } else {
      const res = await fetch('/api/public/tree').then(r => r.json());
      renderItems(flattenForPath(res.tree || [], currentPath));
    }
  } catch (e) {
    showToast(e.message || 'Failed to load folder', 'error');
  } finally {
    showLoading(false);
  }
}

function flattenForPath(tree, targetPath) {
  if (!targetPath) return tree.map(item => ({ ...item, children: undefined }));
  // Find the folder
  function find(items, pathParts) {
    if (pathParts.length === 0) return items;
    const [head, ...rest] = pathParts;
    const folder = items.find(i => i.type === 'folder' && i.name === head);
    if (!folder) return [];
    return find(folder.children || [], rest);
  }
  const parts = targetPath.split('/').filter(Boolean);
  return find(tree, parts).map(item => ({ ...item, children: undefined }));
}

function renderItems(items) {
  const area = document.getElementById('contentArea');
  const empty = document.getElementById('emptyState');
  area.innerHTML = '';

  if (!items || items.length === 0) {
    area.classList.add('hidden');
    empty.classList.remove('hidden');
    return;
  }
  area.classList.remove('hidden');
  empty.classList.add('hidden');

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'file-card bg-surface-800 rounded-2xl overflow-hidden cursor-pointer group relative';

    if (item.type === 'folder') {
      card.innerHTML = `
        <div class="aspect-square bg-gradient-to-br from-surface-700 to-surface-850 flex items-center justify-center">
          <div class="w-16 h-16 rounded-2xl bg-accent/10 flex items-center justify-center">
            <i class="fas fa-folder text-3xl text-accent"></i>
          </div>
        </div>
        <div class="p-3">
          <p class="font-medium text-sm text-gray-100 truncate" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</p>
          <p class="text-[11px] text-gray-500 mt-0.5">Folder</p>
        </div>
        ${currentUser ? actionButtons(item) : ''}
      `;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.action-btn')) return;
        loadFolder(item.path);
      });
    } else {
      const isImage = (item.mime || '').startsWith('image/');
      const isVideo = (item.mime || '').startsWith('video/');
      const fileUrl = `/storage/${encodeURI(item.path)}`;
      const thumb = isImage
        ? `<img src="${fileUrl}" class="w-full h-full object-cover transition duration-500 group-hover:scale-105" loading="lazy" alt="" />`
        : isVideo
          ? `<div class="w-full h-full bg-surface-900 flex items-center justify-center"><i class="fas fa-play-circle text-4xl text-accent/80"></i></div>`
          : `<div class="w-full h-full bg-surface-850 flex items-center justify-center"><i class="fas fa-file text-3xl text-gray-600"></i></div>`;

      card.innerHTML = `
        <div class="aspect-square overflow-hidden bg-surface-900">${thumb}</div>
        <div class="p-3">
          <p class="font-medium text-sm text-gray-100 truncate" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</p>
          <p class="text-[11px] text-gray-500 mt-0.5">${formatSize(item.size)}</p>
        </div>
        ${fileActionButtons(item, fileUrl)}
      `;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.action-btn')) return;
        openPreview(item);
      });
    }
    area.appendChild(card);
  });
}

function fileActionButtons(item, fileUrl) {
  const downloadBtn = `
    <a href="${fileUrl}" download="${escapeHtml(item.name)}" class="action-btn w-8 h-8 rounded-full bg-black/55 backdrop-blur-md text-white hover:bg-emerald-500/90 flex items-center justify-center shadow-lg border border-white/10 transition" title="Download" onclick="event.stopPropagation();">
      <i class="fas fa-download text-xs"></i>
    </a>
  `;
  const editBtns = currentUser ? `
    <button class="action-btn w-8 h-8 rounded-full bg-black/55 backdrop-blur-md text-white hover:bg-accent hover:text-surface-900 flex items-center justify-center shadow-lg border border-white/10 transition" title="Rename" data-action="rename" data-type="${item.type}" data-path="${escapeHtml(item.path)}" data-name="${escapeHtml(item.name)}">
      <i class="fas fa-pen text-xs"></i>
    </button>
    <button class="action-btn w-8 h-8 rounded-full bg-black/55 backdrop-blur-md text-white hover:bg-rose flex items-center justify-center shadow-lg border border-white/10 transition" title="Delete" data-action="delete" data-type="${item.type}" data-path="${escapeHtml(item.path)}" data-name="${escapeHtml(item.name)}">
      <i class="fas fa-trash text-xs"></i>
    </button>
  ` : '';
  return `
    <div class="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex gap-1.5">
      ${downloadBtn}
      ${editBtns}
    </div>
  `;
}

function actionButtons(item) {
  return `
    <div class="absolute top-2.5 right-2.5 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex gap-1.5">
      <button class="action-btn w-8 h-8 rounded-full bg-black/55 backdrop-blur-md text-white hover:bg-accent hover:text-surface-900 flex items-center justify-center shadow-lg border border-white/10 transition" title="Rename" data-action="rename" data-type="${item.type}" data-path="${escapeHtml(item.path)}" data-name="${escapeHtml(item.name)}">
        <i class="fas fa-pen text-xs"></i>
      </button>
      <button class="action-btn w-8 h-8 rounded-full bg-black/55 backdrop-blur-md text-white hover:bg-rose flex items-center justify-center shadow-lg border border-white/10 transition" title="Delete" data-action="delete" data-type="${item.type}" data-path="${escapeHtml(item.path)}" data-name="${escapeHtml(item.name)}">
        <i class="fas fa-trash text-xs"></i>
      </button>
    </div>
  `;
}

// Event delegation for action buttons
document.getElementById('contentArea').addEventListener('click', (e) => {
  const btn = e.target.closest('.action-btn');
  if (!btn) return;
  e.stopPropagation();
  const action = btn.dataset.action;
  const type = btn.dataset.type;
  const path = btn.dataset.path;
  const name = btn.dataset.name;

  if (action === 'rename') {
    renameTarget = { type, path, name };
    document.getElementById('renameInput').value = name;
    document.getElementById('renameModal').classList.remove('hidden');
  } else if (action === 'delete') {
    deleteTarget = { type, path, name };
    document.getElementById('deleteMessage').textContent = `Are you sure you want to delete "${name}"? This cannot be undone.`;
    document.getElementById('deleteModal').classList.remove('hidden');
  }
});

function updateBreadcrumb() {
  const el = document.getElementById('breadcrumb');
  const parts = currentPath ? currentPath.split('/').filter(Boolean) : [];
  let html = `<button data-path="" class="hover:text-accent font-medium whitespace-nowrap"><i class="fas fa-home"></i> Root</button>`;
  let accum = '';
  parts.forEach((p, i) => {
    accum = accum ? `${accum}/${p}` : p;
    html += `<span class="text-gray-600 mx-1">/</span><button data-path="${escapeHtml(accum)}" class="hover:text-accent whitespace-nowrap ${i === parts.length - 1 ? 'font-semibold text-gray-200' : ''}">${escapeHtml(p)}</button>`;
  });
  el.innerHTML = html;
  el.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => loadFolder(btn.dataset.path));
  });
}

// ---------- Upload ----------
document.getElementById('fileInput').addEventListener('change', async (e) => {
  if (!currentUser) return showToast('Please login to upload', 'error');
  const files = e.target.files;
  if (!files.length) return;
  await uploadFiles(files);
  e.target.value = '';
});

document.getElementById('folderInput').addEventListener('change', async (e) => {
  if (!currentUser) return showToast('Please login to upload', 'error');
  const files = e.target.files;
  if (!files.length) return;
  await uploadFiles(files, true);
  e.target.value = '';
});

async function uploadFiles(fileList, isDirectory = false) {
  const form = new FormData();
  form.append('path', currentPath);
  for (const f of fileList) {
    form.append('files', f);
  }

  showToast(`Uploading ${fileList.length} file(s)...`, 'info');
  try {
    const endpoint = isDirectory ? '/api/files/upload-directory' : '/api/files/upload';
    const res = await api(endpoint, { method: 'POST', body: form });
    showToast(res.message || 'Upload complete', 'success');
    // Native browser notification for photo / video / folder upload complete
    notifyUploadComplete(res.files || Array.from(fileList), isDirectory);
    if (res.storageUsed !== undefined) {
      const usedGB = (res.storageUsed / (1024 ** 3)).toFixed(2);
      const percent = (res.storageUsed / (100 * 1024 ** 3)) * 100;
      updateStorageUI(res.storageUsed, 100 * 1024 ** 3, usedGB, percent);
    }
    loadFolder(currentPath);
  } catch (err) {
    if (err.code === 'STORAGE_LIMIT') {
      showToast(err.message, 'error');
    } else {
      showToast(err.message || 'Upload failed', 'error');
    }
  }
}

// ---------- New Folder ----------
document.getElementById('newFolderBtn').addEventListener('click', () => {
  if (!currentUser) return;
  document.getElementById('folderNameInput').value = '';
  document.getElementById('folderModal').classList.remove('hidden');
  document.getElementById('folderNameInput').focus();
});

document.getElementById('cancelFolder').addEventListener('click', () => {
  document.getElementById('folderModal').classList.add('hidden');
});

document.getElementById('confirmFolder').addEventListener('click', async () => {
  const name = document.getElementById('folderNameInput').value.trim();
  if (!name) return showToast('Enter a folder name', 'error');
  try {
    const res = await api('/api/folders/create', {
      method: 'POST',
      body: JSON.stringify({ name, parentPath: currentPath })
    });
    showToast(res.message, 'success');
    document.getElementById('folderModal').classList.add('hidden');
    loadFolder(currentPath);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ---------- Rename ----------
document.getElementById('cancelRename').addEventListener('click', () => {
  document.getElementById('renameModal').classList.add('hidden');
  renameTarget = null;
});

document.getElementById('confirmRename').addEventListener('click', async () => {
  if (!renameTarget) return;
  const newName = document.getElementById('renameInput').value.trim();
  if (!newName) return showToast('Enter a name', 'error');
  try {
    const endpoint = renameTarget.type === 'folder' ? '/api/folders/rename' : '/api/files/rename';
    const res = await api(endpoint, {
      method: 'PUT',
      body: JSON.stringify({ path: renameTarget.path, newName })
    });
    showToast(res.message, 'success');
    document.getElementById('renameModal').classList.add('hidden');
    renameTarget = null;
    loadFolder(currentPath);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ---------- Delete ----------
document.getElementById('cancelDelete').addEventListener('click', () => {
  document.getElementById('deleteModal').classList.add('hidden');
  deleteTarget = null;
});

document.getElementById('confirmDelete').addEventListener('click', async () => {
  if (!deleteTarget) return;
  try {
    const endpoint = deleteTarget.type === 'folder' ? '/api/folders/delete' : '/api/files/delete';
    const res = await api(endpoint, {
      method: 'DELETE',
      body: JSON.stringify({ path: deleteTarget.path })
    });
    showToast(res.message, 'success');
    if (res.storageUsed !== undefined) {
      const usedGB = (res.storageUsed / (1024 ** 3)).toFixed(2);
      const percent = (res.storageUsed / (100 * 1024 ** 3)) * 100;
      updateStorageUI(res.storageUsed, 100 * 1024 ** 3, usedGB, percent);
    }
    document.getElementById('deleteModal').classList.add('hidden');
    deleteTarget = null;
    loadFolder(currentPath);
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ---------- Profile ----------
document.getElementById('profileBtn').addEventListener('click', () => {
  const pa = document.getElementById('profileAvatar');
  const name = currentUser.displayName || 'Member';
  pa.referrerPolicy = 'no-referrer';
  pa.onerror = function () {
    this.onerror = null;
    this.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(name)}&background=1e2433&color=e8b84a&size=128`;
  };
  pa.src = getAvatarUrl(currentUser.photoURL, name);
  document.getElementById('profileEmail').textContent = currentUser.email;
  document.getElementById('profileNameInput').value = currentUser.displayName;
  document.getElementById('profileStorage').textContent = document.getElementById('storageText').textContent;
  updatePhoneVerifyUI();
  document.getElementById('profileModal').classList.remove('hidden');
});

document.getElementById('cancelProfile').addEventListener('click', () => {
  document.getElementById('profileModal').classList.add('hidden');
});

document.getElementById('saveProfile').addEventListener('click', async () => {
  const name = document.getElementById('profileNameInput').value.trim();
  if (name.length < 2) return showToast('Name must be at least 2 characters', 'error');
  try {
    const res = await api('/api/users/me/name', {
      method: 'PUT',
      body: JSON.stringify({ displayName: name })
    });
    currentUser.displayName = res.displayName;
    document.getElementById('userName').textContent = res.displayName;
    if (USE_MOCK_AUTH) {
      localStorage.setItem('pas_mock_user', JSON.stringify(currentUser));
    }
    showToast('Profile updated', 'success');
    document.getElementById('profileModal').classList.add('hidden');
  } catch (err) {
    showToast(err.message, 'error');
  }
});

// ---------- Preview (Plyr.js for video) ----------
let plyrPlayer = null;

function destroyPlyr() {
  if (plyrPlayer) {
    try { plyrPlayer.destroy(); } catch (e) {}
    plyrPlayer = null;
  }
}

function closePreview() {
  destroyPlyr();
  document.getElementById('previewModal').classList.add('hidden');
  document.getElementById('previewContent').innerHTML = '';
}

function openPreview(item) {
  destroyPlyr();
  const content = document.getElementById('previewContent');
  const modal = document.getElementById('previewModal');
  const url = `/storage/${encodeURI(item.path)}`;
  const isImage = (item.mime || '').startsWith('image/');
  const isVideo = (item.mime || '').startsWith('video/');
  const isAudio = (item.mime || '').startsWith('audio/');

  const downloadBar = `
    <div class="flex items-center justify-center gap-3 mt-4">
      <p class="text-cream text-sm opacity-90 max-w-xs truncate" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</p>
      <a href="${url}" download="${escapeHtml(item.name)}"
         class="inline-flex items-center gap-2 px-4 py-2 btn-primary font-semibold rounded-lg shadow transition text-sm">
        <i class="fas fa-download"></i> Download
      </a>
    </div>
  `;

  if (isImage) {
    content.innerHTML = `
      <div class="flex flex-col items-center">
        <img src="${url}" class="max-w-full max-h-[75vh] rounded-lg shadow-2xl" alt="${escapeHtml(item.name)}" />
        ${downloadBar}
      </div>
    `;
  } else if (isVideo) {
    // Plyr.js player – maroon/gold themed
    content.innerHTML = `
      <div class="w-full max-w-5xl">
        <video id="plyrVideo" playsinline controls crossorigin="anonymous">
          <source src="${url}" type="${item.mime || 'video/mp4'}" />
        </video>
        ${downloadBar}
      </div>
    `;
    // Init Plyr after element is in DOM
    requestAnimationFrame(() => {
      const videoEl = document.getElementById('plyrVideo');
      if (videoEl && typeof Plyr !== 'undefined') {
        plyrPlayer = new Plyr(videoEl, {
          controls: [
            'play-large',
            'play',
            'progress',
            'current-time',
            'duration',
            'mute',
            'volume',
            'settings',
            'pip',
            'fullscreen'
          ],
          settings: ['quality', 'speed'],
          speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
          ratio: '16:9',
          autoplay: true,
          keyboard: { focused: true, global: true },
          tooltips: { controls: true, seek: true },
          fullscreen: { enabled: true, fallback: true, iosNative: true },
          storage: { enabled: true, key: 'pas-plyr' }
        });
        plyrPlayer.on('ready', () => {
          try { plyrPlayer.play(); } catch (e) {}
        });
      }
    });
  } else if (isAudio) {
    content.innerHTML = `
      <div class="bg-white p-8 rounded-xl text-center w-full max-w-lg">
        <p class="mb-4 font-medium text-gray-100">${escapeHtml(item.name)}</p>
        <audio id="plyrAudio" controls class="w-full">
          <source src="${url}" type="${item.mime || 'audio/mpeg'}" />
        </audio>
        <a href="${url}" download="${escapeHtml(item.name)}"
           class="inline-flex items-center gap-2 mt-5 px-4 py-2 btn-ghost text-white font-semibold rounded-lg transition text-sm">
          <i class="fas fa-download"></i> Download
        </a>
      </div>
    `;
    requestAnimationFrame(() => {
      const audioEl = document.getElementById('plyrAudio');
      if (audioEl && typeof Plyr !== 'undefined') {
        plyrPlayer = new Plyr(audioEl, {
          controls: ['play', 'progress', 'current-time', 'duration', 'mute', 'volume'],
          autoplay: false
        });
      }
    });
  } else {
    content.innerHTML = `<div class="bg-white p-8 rounded-xl text-center">
      <i class="fas fa-file text-5xl text-gray-500 mb-4"></i>
      <p class="font-medium mb-2 text-gray-100">${escapeHtml(item.name)}</p>
      <a href="${url}" download="${escapeHtml(item.name)}"
         class="inline-flex items-center gap-2 mt-4 px-5 py-2.5 btn-primary font-semibold rounded-lg transition">
        <i class="fas fa-download"></i> Download
      </a>
    </div>`;
  }
  modal.classList.remove('hidden');
}

document.getElementById('closePreview').addEventListener('click', closePreview);

// ---------- Notifications ----------
document.getElementById('notifBtn').addEventListener('click', () => {
  document.getElementById('notifPanel').classList.toggle('hidden');
  unreadNotifs = 0;
  updateNotifBadge();
});

document.getElementById('closeNotif').addEventListener('click', () => {
  document.getElementById('notifPanel').classList.add('hidden');
});

async function loadNotifications() {
  try {
    const res = await fetch('/api/public/notifications').then(r => r.json());
    if (res.success && res.notifications.length) {
      const list = document.getElementById('notifList');
      list.innerHTML = '';
      res.notifications.forEach(n => prependNotification(n, false));
    }
  } catch (e) {}
}

function prependNotification(n, toTop = true) {
  const list = document.getElementById('notifList');
  if (list.querySelector('.text-center')) list.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'p-3.5 hover:bg-white/[0.03] text-sm transition';
  const time = n.timestamp ? new Date(n.timestamp).toLocaleString() : '';
  const isEvent = (n.type || '').startsWith('event');
  div.innerHTML = `
    <div class="flex gap-3">
      <div class="w-8 h-8 rounded-xl ${isEvent ? 'bg-accent/15 text-accent' : 'bg-white/5 text-gray-400'} flex items-center justify-center shrink-0">
        <i class="fas ${isEvent ? 'fa-calendar-alt' : 'fa-bell'} text-xs"></i>
      </div>
      <div class="min-w-0">
        <p class="text-gray-200 leading-snug">${escapeHtml(n.message || '')}</p>
        <p class="text-[11px] text-gray-500 mt-1">${time}</p>
      </div>
    </div>
  `;
  if (toTop) list.prepend(div);
  else list.appendChild(div);
}

function updateNotifBadge() {
  const badge = document.getElementById('notifBadge');
  if (unreadNotifs > 0) {
    badge.textContent = unreadNotifs > 9 ? '9+' : unreadNotifs;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ---------- UI helpers ----------
document.getElementById('refreshBtn').addEventListener('click', () => loadFolder(currentPath));

function showLoading(show) {
  document.getElementById('loadingState').classList.toggle('hidden', !show);
  if (show) {
    document.getElementById('contentArea').classList.add('hidden');
    document.getElementById('emptyState').classList.add('hidden');
  }
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  const styles = {
    success: 'border-emerald-500/30 bg-emerald-950/90 text-emerald-100',
    error: 'border-rose/40 bg-[#2a1215]/95 text-rose-100',
    info: 'border-accent/25 bg-surface-800/95 text-gray-100'
  };
  const icons = { success: 'fa-check-circle text-emerald-400', error: 'fa-exclamation-circle text-rose-soft', info: 'fa-info-circle text-accent' };
  toast.className = `notification-toast ${styles[type] || styles.info} border px-4 py-3 rounded-2xl shadow-panel text-sm flex items-start gap-3`;
  toast.innerHTML = `<i class="fas ${icons[type] || icons.info} mt-0.5"></i><span class="flex-1 leading-snug">${escapeHtml(message)}</span><button class="opacity-50 hover:opacity-100 transition"><i class="fas fa-times text-xs"></i></button>`;
  toast.querySelector('button').onclick = () => toast.remove();
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(12px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 5500);
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 ** 3) return (bytes / (1024 ** 2)).toFixed(1) + ' MB';
  return (bytes / (1024 ** 3)).toFixed(2) + ' GB';
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Close modals on outside click
['folderModal', 'renameModal', 'profileModal', 'deleteModal', 'previewModal', 'eventModal', 'eventDetailModal', 'membersModal'].forEach(id => {
  document.getElementById(id).addEventListener('click', (e) => {
    if (e.target.id === id) {
      if (id === 'previewModal') {
        closePreview();
      } else {
        document.getElementById(id).classList.add('hidden');
      }
    }
  });
});


// ============================================
// Upcoming Events Notifier System
// ============================================

function updateAdminUI() {
  const createBtn = document.getElementById('createEventBtn');
  const membersBtn = document.getElementById('adminMembersBtn');
  if (createBtn) {
    if (isAdmin) createBtn.classList.remove('hidden');
    else createBtn.classList.add('hidden');
  }
  if (membersBtn) {
    if (isAdmin) membersBtn.classList.remove('hidden');
    else membersBtn.classList.add('hidden');
  }
}

function initEventsUI() {
  const eventsBtn = document.getElementById('eventsBtn');
  const closeEvents = document.getElementById('closeEvents');
  const eventsPanel = document.getElementById('eventsPanel');
  const createEventBtn = document.getElementById('createEventBtn');
  const cancelEvent = document.getElementById('cancelEvent');
  const saveEvent = document.getElementById('saveEvent');
  const closeEventDetail = document.getElementById('closeEventDetail');
  const adminMembersBtn = document.getElementById('adminMembersBtn');
  const closeMembers = document.getElementById('closeMembers');

  if (eventsBtn) {
    eventsBtn.addEventListener('click', () => {
      eventsPanel.classList.toggle('hidden');
      document.getElementById('notifPanel')?.classList.add('hidden');
      loadEvents();
    });
  }
  if (closeEvents) closeEvents.addEventListener('click', () => eventsPanel.classList.add('hidden'));
  if (createEventBtn) createEventBtn.addEventListener('click', () => openEventModal());
  if (cancelEvent) cancelEvent.addEventListener('click', () => document.getElementById('eventModal').classList.add('hidden'));
  if (saveEvent) saveEvent.addEventListener('click', submitEvent);
  if (closeEventDetail) closeEventDetail.addEventListener('click', () => document.getElementById('eventDetailModal').classList.add('hidden'));
  if (adminMembersBtn) adminMembersBtn.addEventListener('click', openMembersModal);
  if (closeMembers) closeMembers.addEventListener('click', () => document.getElementById('membersModal').classList.add('hidden'));
}

async function loadEvents() {
  const list = document.getElementById('eventsList');
  if (!list) return;
  try {
    let res;
    if (currentUser && idToken) {
      res = await api('/api/events');
    } else {
      const r = await fetch('/api/public/events');
      res = await r.json();
    }
    if (!res.success) {
      list.innerHTML = `<p class="p-4 text-sm text-red-500 text-center">${escapeHtml(res.error || 'Failed to load')}</p>`;
      return;
    }
    const events = res.events || [];
    const badge = document.getElementById('eventsBadge');
    const upcoming = events.filter(e => new Date(e.eventDate) >= new Date());
    if (badge) {
      if (upcoming.length > 0) {
        badge.textContent = upcoming.length > 9 ? '9+' : upcoming.length;
        badge.classList.remove('hidden');
      } else {
        badge.classList.add('hidden');
      }
    }
    if (!events.length) {
      list.innerHTML = `<p class="p-6 text-sm text-gray-500 text-center"><i class="fas fa-calendar-times text-2xl text-gray-600 block mb-3"></i>No upcoming events yet.</p>`;
      return;
    }
    list.innerHTML = events.map(e => {
      const d = new Date(e.eventDate);
      const isPast = d < new Date();
      const dateStr = d.toLocaleString('en-LK', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      return `
        <button class="w-full text-left px-4 py-3.5 hover:bg-white/[0.03] transition ${isPast ? 'opacity-55' : ''}" onclick="openEventDetail('${e.id}')">
          <div class="flex items-start gap-3">
            <div class="w-9 h-9 rounded-xl bg-accent/12 text-accent flex items-center justify-center shrink-0">
              <i class="fas fa-calendar-day"></i>
            </div>
            <div class="min-w-0 flex-1">
              <p class="font-semibold text-gray-200 truncate">${escapeHtml(e.title)}</p>
              <p class="text-[11px] text-gray-400 mt-0.5"><i class="far fa-clock mr-1"></i>${dateStr}</p>
              ${e.location ? `<p class="text-xs text-gray-500 mt-0.5"><i class="fas fa-map-marker-alt mr-1"></i>${escapeHtml(e.location)}</p>` : ''}
              <p class="text-xs text-gray-400 mt-1">${e.viewCount != null ? e.viewCount + ' views' : (e.viewers ? e.viewers.length + ' views' : '')}</p>
            </div>
            ${isPast
              ? '<span class="text-[10px] bg-white/5 text-gray-500 px-2 py-0.5 rounded-full">Past</span>'
              : '<span class="text-[10px] bg-accent/15 text-accent px-2 py-0.5 rounded-full font-medium">Upcoming</span>'}
          </div>
        </button>`;
    }).join('');
  } catch (err) {
    console.error(err);
    list.innerHTML = `<p class="p-4 text-sm text-red-500 text-center">Failed to load events</p>`;
  }
}

function openEventModal(event = null) {
  if (!isAdmin) return showToast('Only the administrator can schedule events.', 'error');
  editingEventId = event ? event.id : null;
  document.getElementById('eventModalTitle').textContent = event ? 'Edit Event' : 'Schedule New Event';
  document.getElementById('eventTitle').value = event ? event.title : '';
  document.getElementById('eventLocation').value = event ? (event.location || '') : '';
  document.getElementById('eventDescription').value = event ? (event.description || '') : '';
  if (event && event.eventDate) {
    const d = new Date(event.eventDate);
    // datetime-local needs local YYYY-MM-DDTHH:mm
    const pad = n => String(n).padStart(2, '0');
    const local = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    document.getElementById('eventDate').value = local;
  } else {
    document.getElementById('eventDate').value = '';
  }
  document.getElementById('eventModal').classList.remove('hidden');
}

async function submitEvent() {
  if (!isAdmin) return;
  const title = document.getElementById('eventTitle').value.trim();
  const eventDate = document.getElementById('eventDate').value;
  const location = document.getElementById('eventLocation').value.trim();
  const description = document.getElementById('eventDescription').value.trim();

  if (!title || title.length < 3) return showToast('Title must be at least 3 characters.', 'error');
  if (!eventDate) return showToast('Please set the event date & time.', 'error');

  try {
    const body = { title, eventDate: new Date(eventDate).toISOString(), location, description };
    let res;
    if (editingEventId) {
      res = await api(`/api/events/${editingEventId}`, { method: 'PUT', body: JSON.stringify(body) });
    } else {
      res = await api('/api/events', { method: 'POST', body: JSON.stringify(body) });
    }
    if (res.success) {
      showToast(res.message || 'Event saved!', 'success');
      document.getElementById('eventModal').classList.add('hidden');
      loadEvents();
    } else {
      showToast(res.error || 'Failed to save event', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Failed to save event', 'error');
  }
}

async function openEventDetail(id) {
  try {
    let res;
    if (currentUser && idToken) {
      res = await api(`/api/events/${id}`);
    } else {
      // Public: find from public list (no view tracking without login)
      const r = await fetch('/api/public/events');
      const data = await r.json();
      const ev = (data.events || []).find(e => e.id === id);
      if (!ev) return showToast('Event not found', 'error');
      res = { success: true, event: ev };
    }
    if (!res.success) return showToast(res.error || 'Not found', 'error');

    const e = res.event;
    const d = new Date(e.eventDate);
    const dateStr = d.toLocaleString('en-LK', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });

    document.getElementById('eventDetailTitle').textContent = e.title;
    let viewersHtml = '';
    if (isAdmin && e.viewers) {
      viewersHtml = `
        <div class="mt-4 border-t border-white/5 pt-4">
          <p class="text-sm font-semibold text-gray-200 mb-2.5"><i class="fas fa-eye mr-1"></i> Viewers (${e.viewers.length})</p>
          <div class="max-h-40 overflow-y-auto space-y-1">
            ${e.viewers.length ? e.viewers.map(v => `
              <div class="flex items-center justify-between text-xs bg-white/[0.03] rounded-xl px-3 py-2">
                <span class="font-medium text-gray-200">${escapeHtml(v.displayName)}</span>
                <span class="text-gray-500">${new Date(v.viewedAt).toLocaleString('en-LK')}</span>
              </div>`).join('') : '<p class="text-xs text-gray-500">No views yet</p>'}
          </div>
        </div>`;
    } else if (e.viewCount != null) {
      viewersHtml = `<p class="text-xs text-gray-500 mt-2"><i class="fas fa-eye mr-1"></i>${e.viewCount} view(s)</p>`;
    }

    document.getElementById('eventDetailBody').innerHTML = `
      <p class="text-gray-300"><i class="far fa-clock mr-2 text-accent"></i>${dateStr}</p>
      ${e.location ? `<p class="text-gray-300"><i class="fas fa-map-marker-alt mr-2 text-accent"></i>${escapeHtml(e.location)}</p>` : ''}
      ${e.description ? `<p class="text-gray-400 whitespace-pre-wrap mt-3 leading-relaxed">${escapeHtml(e.description)}</p>` : ''}
      <p class="text-xs text-gray-400 mt-3">Posted by ${escapeHtml(e.createdBy || 'Admin')} · ${e.createdAt ? new Date(e.createdAt).toLocaleDateString('en-LK') : ''}</p>
      ${viewersHtml}
    `;

    const actions = document.getElementById('eventDetailActions');
    if (isAdmin) {
      window.__editingEvent = e;
      actions.classList.remove('hidden');
      actions.innerHTML = `
        <button onclick="document.getElementById('eventDetailModal').classList.add('hidden'); openEventModal(window.__editingEvent)" class="btn-ghost px-4 py-2 text-sm">
          <i class="fas fa-pen mr-1"></i>Edit
        </button>
        <button onclick="deleteEvent('${e.id}')" class="btn-danger px-4 py-2 text-sm font-semibold">
          <i class="fas fa-trash mr-1"></i>Delete
        </button>
      `;
    } else {
      actions.classList.add('hidden');
      actions.innerHTML = '';
    }

    document.getElementById('eventDetailModal').classList.remove('hidden');
    // Refresh list so view counts update for admin
    if (currentUser) loadEvents();
  } catch (err) {
    console.error(err);
    showToast('Failed to open event', 'error');
  }
}

async function deleteEvent(id) {
  if (!isAdmin) return;
  if (!confirm('Delete this event permanently?')) return;
  try {
    const res = await api(`/api/events/${id}`, { method: 'DELETE' });
    if (res.success) {
      showToast('Event deleted', 'success');
      document.getElementById('eventDetailModal').classList.add('hidden');
      loadEvents();
    } else {
      showToast(res.error || 'Delete failed', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Delete failed', 'error');
  }
}

async function openMembersModal() {
  if (!isAdmin) return;
  const list = document.getElementById('membersList');
  list.innerHTML = '<p class="text-sm text-gray-500 text-center py-6"><i class="fas fa-spinner fa-spin mr-2"></i>Loading members...</p>';
  document.getElementById('membersModal').classList.remove('hidden');
  try {
    const res = await api('/api/events/admin/members');
    if (!res.success) {
      list.innerHTML = `<p class="text-red-500 text-center">${escapeHtml(res.error)}</p>`;
      return;
    }
    const members = res.members || [];
    if (!members.length) {
      list.innerHTML = '<p class="text-gray-500 text-center">No members yet</p>';
      return;
    }
    list.innerHTML = `
      <div class="space-y-2">
        ${members.map(m => `
          <div class="flex items-center gap-3 bg-white/[0.03] border border-white/5 rounded-2xl p-3 ${m.banned ? 'opacity-60 border-rose/30' : ''} transition hover:bg-white/[0.05]">
            <img src="${m.photoURL || ''}" onerror="this.src='https://ui-avatars.com/api/?name=${encodeURIComponent(m.displayName || 'M')}&background=1e2433&color=e8b84a'" class="w-10 h-10 rounded-xl object-cover bg-surface-700" referrerpolicy="no-referrer" />
            <div class="flex-1 min-w-0">
              <p class="font-semibold text-gray-200 truncate">${escapeHtml(m.displayName)} ${m.isAdmin ? '<span class="text-[10px] bg-accent/20 text-accent px-1.5 py-0.5 rounded ml-1">ADMIN</span>' : ''}</p>
              <p class="text-xs text-gray-500 truncate">${escapeHtml(m.email)}</p>
              <p class="text-[10px] text-gray-400">
                ${m.phoneVerified ? '<span class="text-emerald-400"><i class="fas fa-mobile-alt mr-1"></i>Verified</span> · ' : '<span class="text-gray-500"><i class="fas fa-mobile-alt mr-1"></i>No phone</span> · '}
                Last: ${m.lastLogin ? new Date(m.lastLogin).toLocaleString('en-LK') : '—'}
              </p>
            </div>
            <div class="shrink-0">
              ${m.isAdmin ? '<span class="text-xs text-accent font-medium">Admin</span>' :
                m.banned
                  ? `<button onclick="toggleBan('${m.uid}', false)" class="text-xs bg-emerald-600/80 hover:bg-emerald-500 text-white px-3 py-1.5 rounded-full font-medium transition">Unban</button>`
                  : `<button onclick="toggleBan('${m.uid}', true)" class="text-xs btn-danger px-3 py-1.5 font-medium">Ban</button>`
              }
            </div>
          </div>
        `).join('')}
      </div>`;
  } catch (err) {
    list.innerHTML = `<p class="text-red-500 text-center">${escapeHtml(err.message)}</p>`;
  }
}

async function toggleBan(uid, ban) {
  if (!isAdmin) return;
  const action = ban ? 'ban' : 'unban';
  if (!confirm(`Are you sure you want to ${action} this member?`)) return;
  try {
    const res = await api('/api/events/admin/ban', {
      method: 'POST',
      body: JSON.stringify({ uid, ban })
    });
    if (res.success) {
      showToast(res.message, 'success');
      openMembersModal();
    } else {
      showToast(res.error || 'Action failed', 'error');
    }
  } catch (err) {
    showToast(err.message || 'Action failed', 'error');
  }
}


// ============================================
// Phone OTP Verification
// ============================================

let otpCooldownTimer = null;

function updatePhoneVerifyUI() {
  const badge = document.getElementById('phoneStatusBadge');
  const info = document.getElementById('phoneVerifiedInfo');
  const form = document.getElementById('phoneForm');
  const removeBtn = document.getElementById('removePhoneBtn');
  const otpRow = document.getElementById('otpRow');
  const phoneInput = document.getElementById('phoneInput');
  if (!badge) return;

  if (currentUser && currentUser.phoneVerified && currentUser.phone) {
    badge.textContent = 'Verified';
    badge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 font-semibold';
    info.classList.remove('hidden');
    info.innerHTML = `<i class="fas fa-check-circle text-emerald-400 mr-1.5"></i>${escapeHtml(currentUser.phone)}`;
    form.classList.add('hidden');
    removeBtn.classList.remove('hidden');
  } else {
    badge.textContent = 'Not verified';
    badge.className = 'text-[10px] px-2 py-0.5 rounded-full bg-white/5 text-gray-500';
    info.classList.add('hidden');
    form.classList.remove('hidden');
    removeBtn.classList.add('hidden');
    if (otpRow) otpRow.classList.add('hidden');
    if (phoneInput && currentUser?.phonePending) {
      phoneInput.value = currentUser.phonePending;
    }
  }
}

function maybePromptPhoneVerify() {
  if (!currentUser || currentUser.phoneVerified) return;
  if (sessionStorage.getItem('pas_phone_prompted') === '1') return;
  sessionStorage.setItem('pas_phone_prompted', '1');
  // Soft nudge after login
  setTimeout(() => {
    showToast('For extra security, verify your phone number in Profile.', 'info');
  }, 1200);
}

async function requestOtp() {
  if (!currentUser) return showToast('Please login first', 'error');
  const phone = document.getElementById('phoneInput').value.trim();
  if (!phone) return showToast('Enter your mobile number', 'error');

  const btn = document.getElementById('requestOtpBtn');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1.5"></i>Sending…';

  try {
    const res = await api('/api/otp/request', {
      method: 'POST',
      body: JSON.stringify({ phone })
    });
    if (!res.success) {
      showToast(res.error || 'Failed to send OTP', 'error');
      return;
    }
    showToast(res.message || 'OTP sent', 'success');
    document.getElementById('otpRow').classList.remove('hidden');
    document.getElementById('otpInput').value = '';
    document.getElementById('otpInput').focus();

    const hint = document.getElementById('otpDevHint');
    if (res.devCode) {
      hint.classList.remove('hidden');
      hint.innerHTML = `<i class="fas fa-flask mr-1"></i>Dev mode code: <strong class="tracking-widest">${res.devCode}</strong>`;
      document.getElementById('otpInput').value = res.devCode;
    } else {
      hint.classList.add('hidden');
    }

    startOtpCooldown(60);
  } catch (err) {
    showToast(err.message || 'Failed to send OTP', 'error');
  } finally {
    if (!otpCooldownTimer) {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }
}

function startOtpCooldown(seconds) {
  const btn = document.getElementById('requestOtpBtn');
  const resend = document.getElementById('resendOtpBtn');
  let left = seconds;
  if (otpCooldownTimer) clearInterval(otpCooldownTimer);
  const tick = () => {
    if (left <= 0) {
      clearInterval(otpCooldownTimer);
      otpCooldownTimer = null;
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-sms mr-1.5"></i>Send OTP';
      if (resend) resend.disabled = false;
      return;
    }
    btn.disabled = true;
    btn.innerHTML = `Resend in ${left}s`;
    if (resend) resend.disabled = true;
    left -= 1;
  };
  tick();
  otpCooldownTimer = setInterval(tick, 1000);
}

async function verifyOtp() {
  const phone = document.getElementById('phoneInput').value.trim();
  const code = document.getElementById('otpInput').value.trim();
  if (!/^\d{6}$/.test(code)) return showToast('Enter the 6-digit code', 'error');

  const btn = document.getElementById('verifyOtpBtn');
  btn.disabled = true;
  try {
    const res = await api('/api/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ phone, code })
    });
    if (!res.success) {
      showToast(res.error || 'Verification failed', 'error');
      return;
    }
    currentUser.phone = res.phone;
    currentUser.phoneVerified = true;
    showToast('Phone verified successfully!', 'success');
    updatePhoneVerifyUI();
  } catch (err) {
    showToast(err.message || 'Verification failed', 'error');
  } finally {
    btn.disabled = false;
  }
}

async function removePhone() {
  if (!confirm('Remove your verified phone number? You can verify again later.')) return;
  try {
    const res = await api('/api/otp/remove', { method: 'POST', body: '{}' });
    if (res.success) {
      currentUser.phone = null;
      currentUser.phoneVerified = false;
      showToast(res.message, 'success');
      updatePhoneVerifyUI();
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Wire buttons once DOM ready (script is at end of body)
(function initOtpUI() {
  const req = document.getElementById('requestOtpBtn');
  const ver = document.getElementById('verifyOtpBtn');
  const resend = document.getElementById('resendOtpBtn');
  const rem = document.getElementById('removePhoneBtn');
  if (req) req.addEventListener('click', requestOtp);
  if (ver) ver.addEventListener('click', verifyOtp);
  if (resend) resend.addEventListener('click', requestOtp);
  if (rem) rem.addEventListener('click', removePhone);
  const otpInput = document.getElementById('otpInput');
  if (otpInput) {
    otpInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') verifyOtp();
    });
  }
})();
