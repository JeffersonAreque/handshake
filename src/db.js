import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS milestones (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  client_token     TEXT NOT NULL UNIQUE,
  freelancer_token TEXT NOT NULL UNIQUE,
  title            TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  amount           TEXT NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'USD',
  payee_email      TEXT NOT NULL,
  criteria         TEXT NOT NULL,            -- JSON array of strings
  status           TEXT NOT NULL DEFAULT 'DRAFT',
  order_id         TEXT,
  authorization_id TEXT,
  capture_id       TEXT,
  refund_id        TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id),
  url          TEXT NOT NULL,
  attempt      INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  milestone_id  INTEGER NOT NULL REFERENCES milestones(id),
  passed        INTEGER NOT NULL,
  verdicts      TEXT NOT NULL,              -- JSON [{criterion, pass, reason, evidence}]
  checks        TEXT NOT NULL,              -- JSON (status, console errors, ...)
  screenshots   TEXT NOT NULL,              -- JSON [{label, file}]
  model         TEXT NOT NULL,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id),
  status       TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  return db;
}

const parseMilestone = (row) => row && { ...row, criteria: JSON.parse(row.criteria) };
const parseReport = (row) =>
  row && {
    ...row,
    passed: Boolean(row.passed),
    verdicts: JSON.parse(row.verdicts),
    checks: JSON.parse(row.checks),
    screenshots: JSON.parse(row.screenshots),
  };

export function createMilestone(db, m) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO milestones (client_token, freelancer_token, title, description, amount, currency, payee_email, criteria)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(m.clientToken, m.freelancerToken, m.title, m.description ?? '', m.amount, m.currency ?? 'USD', m.payeeEmail, JSON.stringify(m.criteria));
  const id = Number(lastInsertRowid);
  db.prepare('INSERT INTO events (milestone_id, status, note) VALUES (?, ?, ?)').run(id, 'DRAFT', 'Milestone created');
  return getMilestone(db, id);
}

export const getMilestone = (db, id) => parseMilestone(db.prepare('SELECT * FROM milestones WHERE id = ?').get(id));

export function getMilestoneByToken(db, token) {
  const row = db.prepare('SELECT * FROM milestones WHERE client_token = ? OR freelancer_token = ?').get(token, token);
  if (!row) return null;
  return { milestone: parseMilestone(row), role: row.client_token === token ? 'client' : 'freelancer' };
}

export const listMilestonesByStatus = (db, status) =>
  db.prepare('SELECT * FROM milestones WHERE status = ?').all(status).map(parseMilestone);

export function updateMilestone(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE milestones SET ${sets}, updated_at = datetime('now') WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
}

export function addSubmission(db, milestoneId, url) {
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE milestone_id = ?').get(milestoneId);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO submissions (milestone_id, url, attempt) VALUES (?, ?, ?)')
    .run(milestoneId, url, n + 1);
  return db.prepare('SELECT * FROM submissions WHERE id = ?').get(Number(lastInsertRowid));
}

export const latestSubmission = (db, milestoneId) =>
  db.prepare('SELECT * FROM submissions WHERE milestone_id = ? ORDER BY id DESC LIMIT 1').get(milestoneId);

export function addReport(db, r) {
  db.prepare(
    `INSERT INTO reports (submission_id, milestone_id, passed, verdicts, checks, screenshots, model, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(r.submissionId, r.milestoneId, r.passed ? 1 : 0, JSON.stringify(r.verdicts), JSON.stringify(r.checks), JSON.stringify(r.screenshots), r.model, r.error ?? null);
}

export const listReports = (db, milestoneId) =>
  db
    .prepare(
      `SELECT r.*, s.url, s.attempt FROM reports r JOIN submissions s ON s.id = r.submission_id
       WHERE r.milestone_id = ? ORDER BY r.id DESC`
    )
    .all(milestoneId)
    .map(parseReport);

export const listEvents = (db, milestoneId) =>
  db.prepare('SELECT * FROM events WHERE milestone_id = ? ORDER BY id').all(milestoneId);
