// SQLite store: scan history, fix log (with before/after + undo state),
// PayPal subscription record, and small settings (PayPal plan id).
// Uses Node's built-in node:sqlite — no extra dependency.
// Database file lives in ./data/ (gitignored).

import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = join(root, 'data', 'accesspatch.db');
mkdirSync(dirname(dbPath), { recursive: true });

const db = new DatabaseSync(dbPath);

db.exec(`
  CREATE TABLE IF NOT EXISTS scans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT NOT NULL,
    normalized_url TEXT NOT NULL,
    scanned_at TEXT NOT NULL,
    title TEXT,
    http_status INTEGER,
    is_shopify INTEGER DEFAULT 0,
    total_images INTEGER DEFAULT 0,
    null_alt INTEGER DEFAULT 0,
    empty_alt INTEGER DEFAULT 0,
    violations_json TEXT NOT NULL DEFAULT '[]',
    images_json TEXT NOT NULL DEFAULT '[]',
    error TEXT
  );
  CREATE TABLE IF NOT EXISTS fixes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id INTEGER NOT NULL REFERENCES scans(id),
    image_src TEXT NOT NULL,
    selector TEXT,
    alt_before TEXT,
    alt_after TEXT,
    status TEXT NOT NULL DEFAULT 'generated',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    paypal_subscription_id TEXT NOT NULL,
    plan_id TEXT,
    status TEXT NOT NULL DEFAULT 'reported',
    verified INTEGER DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export function normalizeUrl(raw) {
  const u = new URL(raw);
  return `${u.protocol}//${u.host}${u.pathname}`.replace(/\/$/, '') || `${u.protocol}//${u.host}`;
}

export function saveScan(s) {
  const stmt = db.prepare(`
    INSERT INTO scans (url, normalized_url, scanned_at, title, http_status, is_shopify,
      total_images, null_alt, empty_alt, violations_json, images_json, error)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const res = stmt.run(
    s.url, s.normalizedUrl, s.scannedAt, s.title ?? null, s.httpStatus ?? null,
    s.isShopify ? 1 : 0, s.totalImages, s.nullAlt, s.emptyAlt,
    JSON.stringify(s.violations ?? []), JSON.stringify(s.images ?? []), s.error ?? null);
  return Number(res.lastInsertRowid);
}

export function getScan(id) {
  const row = db.prepare('SELECT * FROM scans WHERE id = ?').get(id);
  if (!row) return null;
  return toScan(row);
}

export function listScans(limit = 20) {
  return db.prepare('SELECT * FROM scans ORDER BY id DESC LIMIT ?').all(limit).map(toScan);
}

export function previousScan(normalizedUrl, beforeId) {
  const row = db.prepare(
    'SELECT * FROM scans WHERE normalized_url = ? AND id < ? AND error IS NULL ORDER BY id DESC LIMIT 1')
    .get(normalizedUrl, beforeId);
  return row ? toScan(row) : null;
}

function toScan(row) {
  return {
    id: row.id,
    url: row.url,
    normalizedUrl: row.normalized_url,
    scannedAt: row.scanned_at,
    title: row.title,
    httpStatus: row.http_status,
    isShopify: row.is_shopify === 1,
    totalImages: row.total_images,
    nullAlt: row.null_alt,
    emptyAlt: row.empty_alt,
    violations: JSON.parse(row.violations_json),
    images: JSON.parse(row.images_json),
    error: row.error,
  };
}

export function saveFix(fix) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO fixes (scan_id, image_src, selector, alt_before, alt_after, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const res = stmt.run(fix.scanId, fix.imageSrc, fix.selector ?? null,
    fix.altBefore ?? null, fix.altAfter ?? null, fix.status, now, now);
  return Number(res.lastInsertRowid);
}

export function getFixesForScan(scanId) {
  return db.prepare('SELECT * FROM fixes WHERE scan_id = ? ORDER BY id ASC').all(scanId).map(toFix);
}

export function getFix(id) {
  const row = db.prepare('SELECT * FROM fixes WHERE id = ?').get(id);
  return row ? toFix(row) : null;
}

export function setFixStatus(id, status) {
  db.prepare('UPDATE fixes SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
}

export function approveAllGenerated(scanId) {
  const res = db.prepare(
    "UPDATE fixes SET status = 'approved', updated_at = ? WHERE scan_id = ? AND status = 'generated'")
    .run(new Date().toISOString(), scanId);
  return res.changes;
}

function toFix(row) {
  return {
    id: row.id,
    scanId: row.scan_id,
    imageSrc: row.image_src,
    selector: row.selector,
    altBefore: row.alt_before,
    altAfter: row.alt_after,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function saveSubscription(sub) {
  const stmt = db.prepare(`
    INSERT INTO subscriptions (paypal_subscription_id, plan_id, status, verified, created_at)
    VALUES (?, ?, ?, ?, ?)`);
  const res = stmt.run(sub.paypalSubscriptionId, sub.planId ?? null,
    sub.status, sub.verified ? 1 : 0, new Date().toISOString());
  return Number(res.lastInsertRowid);
}

export function getSubscription() {
  const row = db.prepare('SELECT * FROM subscriptions ORDER BY id DESC LIMIT 1').get();
  if (!row) return null;
  return {
    id: row.id,
    paypalSubscriptionId: row.paypal_subscription_id,
    planId: row.plan_id,
    status: row.status,
    verified: row.verified === 1,
    createdAt: row.created_at,
  };
}

export function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

export function setSetting(key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
