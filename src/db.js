// Storage on libsql: Turso when TURSO_DATABASE_URL is set, otherwise a local
// SQLite file (or ':memory:' in tests). Same SQL and code path for all three.
import fs from 'node:fs';
import path from 'node:path';
import { createClient } from '@libsql/client';

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
  criteria         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'DRAFT',
  order_id         TEXT,
  authorization_id TEXT,
  capture_id       TEXT,
  refund_id        TEXT,
  last_error       TEXT,
  is_demo          INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS milestones_status ON milestones(status);
CREATE TABLE IF NOT EXISTS submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id),
  url          TEXT NOT NULL,
  attempt      INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS submissions_milestone ON submissions(milestone_id);
CREATE TABLE IF NOT EXISTS reports (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  milestone_id  INTEGER NOT NULL REFERENCES milestones(id),
  passed        INTEGER NOT NULL,
  verdicts      TEXT NOT NULL,
  checks        TEXT NOT NULL,
  screenshots   TEXT NOT NULL,
  model         TEXT NOT NULL,
  error         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS reports_milestone ON reports(milestone_id);
CREATE TABLE IF NOT EXISTS screenshots (
  submission_id INTEGER NOT NULL REFERENCES submissions(id),
  label         TEXT NOT NULL,
  mime          TEXT NOT NULL DEFAULT 'image/jpeg',
  data          BLOB NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (submission_id, label)
);
CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  milestone_id INTEGER NOT NULL REFERENCES milestones(id),
  status       TEXT NOT NULL,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS events_milestone ON events(milestone_id);
`;

/**
 * Opens storage. `url` may be a libsql:// (Turso) URL, 'file:...' or
 * ':memory:'. Returns a libsql client with the schema applied.
 */
export async function openDb({ url, authToken } = {}) {
  if (url?.startsWith('file:')) fs.mkdirSync(path.dirname(url.slice('file:'.length)), { recursive: true });
  const db = createClient({ url, ...(authToken && { authToken }) });
  if (!url?.startsWith('libsql:') && !url?.startsWith('https:')) await db.execute('PRAGMA foreign_keys = ON');
  await db.executeMultiple(SCHEMA);
  for (const sql of MIGRATIONS) {
    try { await db.execute(sql); } catch (err) { if (!/duplicate column/i.test(err.message)) throw err; }
  }
  return db;
}

// Additive column migrations for databases created by earlier versions.
const MIGRATIONS = [
  'ALTER TABLE reports ADD COLUMN fixes TEXT',
  'ALTER TABLE milestones ADD COLUMN brief TEXT',
  // 'paypal' (real sandbox money) or 'simulated' (one-click freelancer demo)
  "ALTER TABLE milestones ADD COLUMN funding TEXT NOT NULL DEFAULT 'paypal'",
  // null for real milestones; 'try' (created by a demo button) or 'showcase' (seeded, read-only)
  'ALTER TABLE milestones ADD COLUMN demo_kind TEXT',
];

/** Converts a libsql result to plain row objects. */
export const toRows = (result) =>
  result.rows.map((row) => Object.fromEntries(result.columns.map((c, i) => [c, row[i]])));
const first = (result) => toRows(result)[0] ?? null;
const q = (sql, args = []) => ({ sql, args });

const parseMilestone = (row) => row && { ...row, id: Number(row.id), is_demo: Boolean(row.is_demo), criteria: JSON.parse(row.criteria) };
const parseReport = (row) =>
  row && {
    ...row,
    passed: Boolean(row.passed),
    id: Number(row.id),
    verdicts: JSON.parse(row.verdicts),
    checks: JSON.parse(row.checks),
    screenshots: JSON.parse(row.screenshots),
    fixes: row.fixes ? JSON.parse(row.fixes) : [],
  };

export async function createMilestone(db, m) {
  const [ins] = await db.batch(
    [
      q(
        `INSERT INTO milestones (client_token, freelancer_token, title, description, amount, currency, payee_email, criteria, is_demo, brief, funding, demo_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [m.clientToken, m.freelancerToken, m.title, m.description ?? '', m.amount, m.currency ?? 'USD', m.payeeEmail, JSON.stringify(m.criteria), m.demoKind ? 1 : 0, m.brief || null, m.funding ?? 'paypal', m.demoKind ?? null]
      ),
      q("INSERT INTO events (milestone_id, status, note) VALUES (last_insert_rowid(), 'DRAFT', 'Milestone created')"),
    ],
    'write'
  );
  return getMilestone(db, Number(ins.lastInsertRowid));
}

export const getMilestone = async (db, id) => parseMilestone(first(await db.execute(q('SELECT * FROM milestones WHERE id = ?', [id]))));

export async function getMilestoneByToken(db, token) {
  if (typeof token !== 'string' || token.length > 64) return null;
  const row = first(await db.execute(q('SELECT * FROM milestones WHERE client_token = ? OR freelancer_token = ?', [token, token])));
  if (!row) return null;
  return { milestone: parseMilestone(row), role: row.client_token === token ? 'client' : 'freelancer' };
}

export const listMilestonesByStatus = async (db, status) =>
  toRows(await db.execute(q('SELECT * FROM milestones WHERE status = ?', [status]))).map(parseMilestone);

export async function updateMilestone(db, id, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await db.execute(q(`UPDATE milestones SET ${sets}, updated_at = datetime('now') WHERE id = ?`, [...keys.map((k) => fields[k]), id]));
}

export async function addSubmission(db, milestoneId, url) {
  const res = await db.execute(
    q(
      `INSERT INTO submissions (milestone_id, url, attempt)
       VALUES (?, ?, (SELECT COUNT(*) + 1 FROM submissions WHERE milestone_id = ?))`,
      [milestoneId, url, milestoneId]
    )
  );
  return getSubmission(db, Number(res.lastInsertRowid));
}

export const getSubmission = async (db, id) => first(await db.execute(q('SELECT * FROM submissions WHERE id = ?', [id])));

export const latestSubmission = async (db, milestoneId) =>
  first(await db.execute(q('SELECT * FROM submissions WHERE milestone_id = ? ORDER BY id DESC LIMIT 1', [milestoneId])));

/** Stores a report and its screenshots ({label, data: Buffer}) atomically. */
export async function addReport(db, r) {
  await db.batch(
    [
      ...(r.images ?? []).map((img) =>
        q('INSERT OR REPLACE INTO screenshots (submission_id, label, mime, data) VALUES (?, ?, ?, ?)', [r.submissionId, img.label, img.mime ?? 'image/jpeg', img.data])
      ),
      q(
        `INSERT INTO reports (submission_id, milestone_id, passed, verdicts, checks, screenshots, model, error, fixes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [r.submissionId, r.milestoneId, r.passed ? 1 : 0, JSON.stringify(r.verdicts), JSON.stringify(r.checks), JSON.stringify(r.screenshots), r.model, r.error ?? null, JSON.stringify(r.fixes ?? [])]
      ),
    ],
    'write'
  );
}

export async function getScreenshot(db, milestoneId, submissionId, label) {
  const row = first(
    await db.execute(
      q(
        `SELECT sc.mime, sc.data FROM screenshots sc JOIN submissions s ON s.id = sc.submission_id
         WHERE sc.submission_id = ? AND s.milestone_id = ? AND sc.label = ?`,
        [submissionId, milestoneId, label]
      )
    )
  );
  return row && { mime: row.mime, data: Buffer.from(row.data) };
}

/** Everything a milestone page needs, in one round trip. */
export async function getMilestoneView(db, milestoneId) {
  const [reports, events, submission] = await db.batch(
    [
      q(
        `SELECT r.*, s.url, s.attempt FROM reports r JOIN submissions s ON s.id = r.submission_id
         WHERE r.milestone_id = ? ORDER BY r.id DESC`,
        [milestoneId]
      ),
      q('SELECT * FROM events WHERE milestone_id = ? ORDER BY id', [milestoneId]),
      q('SELECT * FROM submissions WHERE milestone_id = ? ORDER BY id DESC LIMIT 1', [milestoneId]),
    ],
    'read'
  );
  return { reports: toRows(reports).map(parseReport), events: toRows(events), submission: first(submission) };
}

export async function getReport(db, milestoneId, reportId) {
  const row = first(
    await db.execute(
      q(
        `SELECT r.*, s.url, s.attempt FROM reports r JOIN submissions s ON s.id = r.submission_id
         WHERE r.id = ? AND r.milestone_id = ?`,
        [reportId, milestoneId]
      )
    )
  );
  return parseReport(row);
}

export const listEvents = async (db, milestoneId) =>
  toRows(await db.execute(q('SELECT * FROM events WHERE milestone_id = ? ORDER BY id', [milestoneId])));

export const listShowcase = async (db) =>
  toRows(await db.execute("SELECT * FROM milestones WHERE demo_kind = 'showcase' ORDER BY id")).map(parseMilestone);

/** Deletes 'try' demo milestones older than `hours` (and everything they own). */
export async function deleteOldDemos(db, hours = 24) {
  const old = "SELECT id FROM milestones WHERE demo_kind = 'try' AND created_at < datetime('now', ?)";
  const args = [`-${hours} hours`];
  const [, , , , gone] = await db.batch(
    [
      q(`DELETE FROM screenshots WHERE submission_id IN (SELECT id FROM submissions WHERE milestone_id IN (${old}))`, args),
      q(`DELETE FROM reports WHERE milestone_id IN (${old})`, args),
      q(`DELETE FROM submissions WHERE milestone_id IN (${old})`, args),
      q(`DELETE FROM events WHERE milestone_id IN (${old})`, args),
      q("DELETE FROM milestones WHERE demo_kind = 'try' AND created_at < datetime('now', ?)", args),
    ],
    'write'
  );
  return gone.rowsAffected;
}

export const countReports = async (db, milestoneId) =>
  Number(first(await db.execute(q('SELECT COUNT(*) AS n FROM reports WHERE milestone_id = ?', [milestoneId]))).n);
