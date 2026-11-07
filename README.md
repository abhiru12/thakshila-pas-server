# Thakshila College Photographic Art Society - Server

A private media storage server for the Photographic Art Society. Members can upload photos, videos and other media, organize them into folders, and receive real-time notifications when content changes. Everyone can view the gallery; only logged-in members can upload or edit.

## Features

- **Google Login** via Firebase Authentication (with mock mode for local development)
- **Shared storage** in a local `storage/` folder on the server
- **Folder management**: create, rename, delete folders
- **File upload**: single/multiple files + whole directory upload
- **100 GB quota per member** — clear error message when limit is reached
- **Real-time notifications** via Socket.IO when someone uploads, creates/renames/deletes
- **Public viewing** — no login required to browse and preview media
- **Profile**: change display name
- **Color theme**: Maroon, Dark Yellow (Gold), Cream background
- **Upcoming Events Notifier** (new)
  - Only admin (`abhiruanuhas23@gmail.com`) can schedule / edit / delete events
  - When admin creates an event, **all members** receive a real-time + browser notification
  - Everyone (even guests) can view the events list
  - Opening an event while logged in records a **view**
  - Admin can see **who viewed** each event and total view count
  - Admin can **ban / unban** members (banned users cannot use the API)
- **Phone OTP verification** for members (extra security)
  - Request 6-digit SMS OTP (Sri Lanka +94 by default)
  - Works in **mock mode** without SMS keys (code shown in UI + server log)
  - Production: set Twilio or Textbelt env vars for real SMS
  - Rate limited, hashed OTP storage, 5-minute expiry

## Tech Stack

- **Backend**: Node.js + Express
- **Auth**: Firebase Admin (Google Sign-In)
- **Realtime**: Socket.IO
- **Uploads**: Multer
- **Frontend**: HTML + Tailwind CSS (CDN) + Vanilla JavaScript
- **Storage**: Local filesystem (`storage/` directory)

## Quick Start

### 1. Install dependencies

```bash
cd thakshila-pas-server
npm install
```

### 2. Configure Firebase (optional for production)

1. Create a Firebase project at https://console.firebase.google.com
2. Enable **Google** sign-in under Authentication → Sign-in method
3. Create a Web App and copy the config into `public/app.js` (`firebaseConfig` object)
4. Download a **Service Account** JSON key (Project Settings → Service accounts → Generate new private key)
5. Save it as `firebase-service-account.json` in the project root  
   **OR** set the environment variable:
   ```bash
   export FIREBASE_SERVICE_ACCOUNT='{"type":"service_account",...}'
   ```
6. In `public/app.js` set `USE_MOCK_AUTH = false`

Without Firebase the app runs in **mock auth mode**: login prompts for a name and works fully for testing.

### 3. Run the server

```bash
npm start
# or for development with auto-restart:
npm run dev
```

Open http://localhost:3000

## Project Structure

```
thakshila-pas-server/
├── server.js              # Main Express + Socket.IO server
├── package.json
├── middleware/
│   └── auth.js            # Firebase token verification + user records
├── routes/
│   ├── files.js           # Upload, delete, rename files + quota check
│   ├── folders.js         # Create / rename / delete / list folders
│   ├── users.js           # Profile + storage info
│   └── notifications.js   # Notification history
├── public/
│   ├── index.html         # SPA frontend
│   └── app.js             # Client logic (auth, uploads, UI)
├── storage/               # All uploaded media lives here (served publicly)
└── data/                  # JSON stores for users, folder meta, notifications
```

## API Overview

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/public/tree` | No | Full public folder tree |
| GET | `/api/public/notifications` | No | Recent activity |
| GET | `/api/folders/list?path=` | Yes | List folder contents |
| POST | `/api/folders/create` | Yes | Create folder |
| PUT | `/api/folders/rename` | Yes | Rename folder |
| DELETE | `/api/folders/delete` | Yes | Delete folder |
| POST | `/api/files/upload` | Yes | Upload files |
| POST | `/api/files/upload-directory` | Yes | Upload directory |
| DELETE | `/api/files/delete` | Yes | Delete file |
| PUT | `/api/files/rename` | Yes | Rename file |
| GET | `/api/users/me` | Yes | Current user + storage + isAdmin |
| PUT | `/api/users/me/name` | Yes | Update display name |
| GET | `/api/events` | Yes | List events (admin sees viewers) |
| POST | `/api/events` | Admin | Create event + broadcast notification |
| GET | `/api/events/:id` | Yes | View event (records view) |
| PUT | `/api/events/:id` | Admin | Update event |
| DELETE | `/api/events/:id` | Admin | Delete event |
| GET | `/api/events/:id/viewers` | Admin | Who viewed the event |
| GET | `/api/events/admin/members` | Admin | List all members |
| POST | `/api/events/admin/ban` | Admin | Ban / unban a member |
| GET | `/api/public/events` | No | Public upcoming events list |
| POST | `/api/otp/request` | Yes | Send phone OTP |
| POST | `/api/otp/verify` | Yes | Verify OTP & bind phone |
| POST | `/api/otp/remove` | Yes | Remove verified phone |
| GET | `/api/otp/status` | Yes | Phone verification status |

## Storage Quota

Each member has a **100 GB** soft quota tracked on upload/delete.  
When the limit would be exceeded the server returns:

```json
{
  "success": false,
  "code": "STORAGE_LIMIT",
  "error": "Storage limit exceeded! You have used X GB of your 100 GB quota. Please delete some files..."
}
```

## Production Notes

- Put the app behind HTTPS (e.g. Nginx + Let's Encrypt or Cloudflare)
- Set a strong `PORT` and run with a process manager (`pm2`)
- Back up the `storage/` and `data/` directories regularly
- For large deployments consider moving media to S3/R2 and keeping only metadata locally
- Adjust Multer `fileSize` limit and allowed MIME types in `routes/files.js` as needed

## License

Internal use — Thakshila College Photographic Art Society
