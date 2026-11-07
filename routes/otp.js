const express = require('express');
const router = express.Router();
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const usersFile = path.join(__dirname, '..', 'data', 'users.json');
const otpsFile = path.join(__dirname, '..', 'data', 'otps.json');

// ---------- helpers ----------

async function loadOtps() {
  try {
    return await fs.readJson(otpsFile);
  } catch {
    return { requests: {}, byPhone: {} };
  }
}

async function saveOtps(data) {
  await fs.writeJson(otpsFile, data, { spaces: 2 });
}

function hashOtp(code, salt) {
  return crypto.createHash('sha256').update(`${code}:${salt}`).digest('hex');
}

function generateOtp() {
  // 6-digit, never leading zero issues for display
  return String(crypto.randomInt(100000, 999999));
}

/**
 * Normalize phone to E.164-ish for LK / international.
 * Accepts: 0771234567, 771234567, +94771234567, 94771234567
 */
function normalizePhone(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let p = raw.replace(/[\s\-()]/g, '').trim();
  if (!p) return null;

  // Local Sri Lanka mobile without country code
  if (/^0?7\d{8}$/.test(p)) {
    p = p.replace(/^0/, '');
    p = '+94' + p;
  } else if (/^94\d{9}$/.test(p)) {
    p = '+' + p;
  } else if (/^\+94\d{9}$/.test(p)) {
    // ok
  } else if (/^\+\d{10,15}$/.test(p)) {
    // other international
  } else if (/^\d{10,15}$/.test(p)) {
    p = '+' + p;
  } else {
    return null;
  }

  // Basic length check
  if (p.length < 11 || p.length > 16) return null;
  return p;
}

function isRateLimited(record, maxCount, windowMs) {
  if (!record || !record.timestamps) return false;
  const now = Date.now();
  const recent = record.timestamps.filter(t => now - t < windowMs);
  return recent.length >= maxCount;
}

function pushTimestamp(record) {
  const now = Date.now();
  record.timestamps = (record.timestamps || []).filter(t => now - t < 60 * 60 * 1000);
  record.timestamps.push(now);
  return record;
}

/**
 * Send SMS via TextBee (preferred), Twilio, Textbelt, else mock.
 * Returns { ok, provider, mockCode? }
 */
async function sendSms(phone, message, otpCode) {
  const textbeeKey = process.env.TEXTBEE_API_KEY;
  const textbeeDeviceId = process.env.TEXTBEE_DEVICE_ID || '';
  const textbeeBase = (process.env.TEXTBEE_BASE_URL || 'https://api.textbee.dev/api/v1').replace(/\/$/, '');
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;
  const textbeltKey = process.env.TEXTBELT_KEY;

  // --- TextBee (https://textbee.dev) — preferred ---
  if (textbeeKey) {
    try {
      const payload = {
        recipients: [phone],
        message
      };
      if (textbeeDeviceId) payload.deviceId = textbeeDeviceId;

      const body = JSON.stringify(payload);
      // textbeeBase is like https://api.textbee.dev/api/v1
      const url = new URL(textbeeBase + '/gateway/send-sms');
      const result = await httpRequest({
        method: 'POST',
        hostname: url.hostname,
        path: url.pathname + (url.search || ''),
        headers: {
          'x-api-key': textbeeKey,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        body
      });

      if (result.status >= 200 && result.status < 300) {
        console.log(`TextBee SMS accepted for ${phone}`);
        return { ok: true, provider: 'textbee' };
      }
      console.error('TextBee error:', result.status, result.body);
      let errMsg = 'TextBee rejected the SMS request';
      try {
        const parsed = JSON.parse(result.body || '{}');
        errMsg = parsed.message || parsed.error || parsed.error?.message || errMsg;
        if (typeof errMsg === 'object') errMsg = JSON.stringify(errMsg);
      } catch (_) {}
      // Fall through to mock only if explicitly allowed
      if (process.env.OTP_FALLBACK_MOCK === 'true') {
        console.warn('TextBee failed — falling back to mock OTP');
      } else {
        return { ok: false, provider: 'textbee', error: errMsg };
      }
    } catch (err) {
      console.error('TextBee send failed:', err.message);
      if (process.env.OTP_FALLBACK_MOCK !== 'true') {
        return { ok: false, provider: 'textbee', error: err.message };
      }
    }
  }

  // --- Twilio ---
  if (accountSid && authToken && fromNumber) {
    try {
      const body = new URLSearchParams({
        To: phone,
        From: fromNumber,
        Body: message
      }).toString();

      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      const result = await httpRequest({
        method: 'POST',
        hostname: 'api.twilio.com',
        path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        },
        body
      });

      if (result.status >= 200 && result.status < 300) {
        return { ok: true, provider: 'twilio' };
      }
      console.error('Twilio error:', result.status, result.body);
      return { ok: false, provider: 'twilio', error: 'SMS provider rejected the request' };
    } catch (err) {
      console.error('Twilio send failed:', err.message);
      return { ok: false, provider: 'twilio', error: err.message };
    }
  }

  // --- Textbelt ---
  if (textbeltKey) {
    try {
      const body = new URLSearchParams({
        phone,
        message,
        key: textbeltKey
      }).toString();
      const result = await httpRequest({
        method: 'POST',
        hostname: 'textbelt.com',
        path: '/text',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body)
        },
        body
      });
      const parsed = JSON.parse(result.body || '{}');
      if (parsed.success) {
        return { ok: true, provider: 'textbelt' };
      }
      console.error('Textbelt error:', parsed);
      return { ok: false, provider: 'textbelt', error: parsed.error || 'SMS failed' };
    } catch (err) {
      console.error('Textbelt failed:', err.message);
      return { ok: false, provider: 'textbelt', error: err.message };
    }
  }

  // --- Mock mode ---
  console.log('\n========================================');
  console.log('📱 OTP SMS (MOCK MODE — no SMS gateway configured)');
  console.log(`   To:  ${phone}`);
  console.log(`   OTP: ${otpCode}`);
  console.log('   Set TEXTBEE_API_KEY for TextBee SMS.');
  console.log('========================================\n');
  return { ok: true, provider: 'mock', mockCode: otpCode };
}

function httpRequest({ method, hostname, path: reqPath, headers, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ method, hostname, path: reqPath, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------- routes ----------

/**
 * POST /api/otp/request
 * Body: { phone: "+9477..." }
 */
router.post('/request', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    if (!phone) {
      return res.status(400).json({
        success: false,
        error: 'Invalid phone number. Use format like 0771234567 or +94771234567'
      });
    }

    // Only Sri Lanka mobiles by default (can relax via env)
    const allowIntl = process.env.OTP_ALLOW_INTERNATIONAL === 'true';
    if (!allowIntl && !phone.startsWith('+94')) {
      return res.status(400).json({
        success: false,
        error: 'Only Sri Lankan (+94) mobile numbers are accepted.'
      });
    }

    const otps = await loadOtps();
    const uid = req.uid;

    // Rate limits: 3 per user / 10 min, 5 per phone / 10 min
    const userKey = `user:${uid}`;
    const phoneKey = `phone:${phone}`;
    otps.requests = otps.requests || {};
    otps.byPhone = otps.byPhone || {};

    if (isRateLimited(otps.requests[userKey], 3, 10 * 60 * 1000)) {
      return res.status(429).json({
        success: false,
        error: 'Too many OTP requests. Please wait a few minutes and try again.'
      });
    }
    if (isRateLimited(otps.byPhone[phoneKey], 5, 10 * 60 * 1000)) {
      return res.status(429).json({
        success: false,
        error: 'This phone number has received too many codes. Try again later.'
      });
    }

    // Prevent using a phone already verified by another account
    const users = await fs.readJson(usersFile).catch(() => ({}));
    const taken = Object.values(users).find(
      (u) => u.phone === phone && u.phoneVerified && u.uid !== uid
    );
    if (taken) {
      return res.status(409).json({
        success: false,
        error: 'This phone number is already verified on another account.'
      });
    }

    const code = generateOtp();
    const salt = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

    otps.pending = otps.pending || {};
    otps.pending[uid] = {
      phone,
      hash: hashOtp(code, salt),
      salt,
      expiresAt,
      attempts: 0,
      createdAt: Date.now()
    };

    otps.requests[userKey] = pushTimestamp(otps.requests[userKey] || {});
    otps.byPhone[phoneKey] = pushTimestamp(otps.byPhone[phoneKey] || {});
    await saveOtps(otps);

    const message = `Thakshila PAS verification code: ${code}\nValid for 5 minutes. Do not share this code.`;
    const sendResult = await sendSms(phone, message, code);

    if (!sendResult.ok) {
      return res.status(502).json({
        success: false,
        error: sendResult.error || 'Failed to send SMS. Try again later.'
      });
    }

    // Save pending phone on user (not verified yet)
    if (users[uid]) {
      users[uid].phonePending = phone;
      await fs.writeJson(usersFile, users, { spaces: 2 });
    }

    const response = {
      success: true,
      message: sendResult.provider === 'mock'
        ? 'OTP generated (mock mode). Check server console or the code below.'
        : 'OTP sent to your phone via SMS.',
      phone,
      expiresInSeconds: 300,
      provider: sendResult.provider
    };

    // In mock mode expose code so the system is fully usable without SMS credentials
    if (sendResult.provider === 'mock' || process.env.OTP_EXPOSE_CODE === 'true') {
      response.devCode = code;
    }

    res.json(response);
  } catch (err) {
    console.error('OTP request error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/otp/verify
 * Body: { phone, code }
 */
router.post('/verify', async (req, res) => {
  try {
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.code || '').trim();

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Invalid phone number.' });
    }
    if (!/^\d{6}$/.test(code)) {
      return res.status(400).json({ success: false, error: 'Enter the 6-digit code.' });
    }

    const otps = await loadOtps();
    const pending = otps.pending && otps.pending[req.uid];

    if (!pending) {
      return res.status(400).json({
        success: false,
        error: 'No active OTP. Please request a new code.'
      });
    }
    if (pending.phone !== phone) {
      return res.status(400).json({
        success: false,
        error: 'Phone number does not match the one the code was sent to.'
      });
    }
    if (Date.now() > pending.expiresAt) {
      delete otps.pending[req.uid];
      await saveOtps(otps);
      return res.status(400).json({
        success: false,
        error: 'Code expired. Please request a new one.'
      });
    }
    if (pending.attempts >= 5) {
      delete otps.pending[req.uid];
      await saveOtps(otps);
      return res.status(429).json({
        success: false,
        error: 'Too many wrong attempts. Request a new code.'
      });
    }

    const expected = hashOtp(code, pending.salt);
    if (expected !== pending.hash) {
      pending.attempts += 1;
      otps.pending[req.uid] = pending;
      await saveOtps(otps);
      return res.status(400).json({
        success: false,
        error: `Incorrect code. ${5 - pending.attempts} attempt(s) left.`
      });
    }

    // Success — mark user verified
    const users = await fs.readJson(usersFile);
    if (!users[req.uid]) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    users[req.uid].phone = phone;
    users[req.uid].phoneVerified = true;
    users[req.uid].phoneVerifiedAt = new Date().toISOString();
    delete users[req.uid].phonePending;
    await fs.writeJson(usersFile, users, { spaces: 2 });

    delete otps.pending[req.uid];
    await saveOtps(otps);

    res.json({
      success: true,
      message: 'Phone number verified successfully.',
      phone,
      phoneVerified: true
    });
  } catch (err) {
    console.error('OTP verify error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/otp/remove
 * Remove verified phone from account (requires re-verify later)
 */
router.post('/remove', async (req, res) => {
  try {
    const users = await fs.readJson(usersFile);
    if (!users[req.uid]) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    users[req.uid].phone = null;
    users[req.uid].phoneVerified = false;
    users[req.uid].phoneVerifiedAt = null;
    users[req.uid].phonePending = null;
    await fs.writeJson(usersFile, users, { spaces: 2 });

    const otps = await loadOtps();
    if (otps.pending) delete otps.pending[req.uid];
    await saveOtps(otps);

    res.json({ success: true, message: 'Phone number removed from your account.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/otp/status
 */
router.get('/status', async (req, res) => {
  try {
    res.json({
      success: true,
      phone: req.user.phone || null,
      phoneVerified: !!req.user.phoneVerified,
      phoneVerifiedAt: req.user.phoneVerifiedAt || null,
      phonePending: req.user.phonePending || null,
      smsConfigured: !!(
        process.env.TEXTBEE_API_KEY ||
        (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER) ||
        process.env.TEXTBELT_KEY
      ),
      smsProvider: process.env.TEXTBEE_API_KEY
        ? 'textbee'
        : (process.env.TWILIO_ACCOUNT_SID ? 'twilio' : (process.env.TEXTBELT_KEY ? 'textbelt' : 'mock'))
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.normalizePhone = normalizePhone;
