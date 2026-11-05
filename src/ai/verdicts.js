// Validation of AI output. The model's JSON is never trusted as-is: every
// criterion gets exactly one verdict, missing ones fail, and objective
// failures (page didn't load) override whatever the model said.

export const EVIDENCE_SOURCES = [
  'desktop.jpg', 'mobile.jpg',
  'checks.httpStatus', 'checks.consoleErrors', 'checks.pageErrors', 'checks.failedRequests',
  'checks.brokenImages', 'checks.mobileHorizontalOverflow', 'checks.title', 'checks.text',
];

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Objective reasons the delivery can't pass, regardless of the model. */
export function hardFailures(checks) {
  const problems = [];
  if (!checks?.httpStatus || checks.httpStatus >= 400) problems.push(`the page returned HTTP ${checks?.httpStatus ?? 'no response'}`);
  return problems;
}

/**
 * @param {string[]} criteria
 * @param {unknown} raw  parsed model output: { verdicts: [{index, pass, reason, evidence}] }
 * @param {object} checks
 * @returns {{criterion, pass, reason, evidence}[]}
 */
export function normalizeVerdicts(criteria, raw, checks) {
  const list = Array.isArray(raw?.verdicts) ? raw.verdicts : [];
  const byIndex = new Map();
  for (const v of list) {
    const i = Number(v?.index);
    if (Number.isInteger(i) && i >= 0 && i < criteria.length && !byIndex.has(i)) byIndex.set(i, v);
  }
  const hard = hardFailures(checks);
  return criteria.map((criterion, i) => {
    const v = byIndex.get(i);
    if (hard.length) {
      return { criterion, pass: false, reason: `Automatic fail: ${hard.join('; ')}.`, evidence: ['checks.httpStatus'] };
    }
    if (!v) return { criterion, pass: false, reason: 'The verifier returned no verdict for this criterion.', evidence: [] };
    const evidence = (Array.isArray(v.evidence) ? v.evidence : []).map(String).filter((e) => EVIDENCE_SOURCES.includes(e));
    const pass = v.pass === true && evidence.length > 0; // a pass needs cited evidence
    const reason = clip(v.reason, 500) || (pass ? 'Passed.' : 'Failed.');
    return { criterion, pass, reason: v.pass === true && !pass ? `${reason} (No evidence cited, so it counts as a fail.)` : reason, evidence };
  });
}

export function normalizeCriteria(raw) {
  const list = Array.isArray(raw?.criteria) ? raw.criteria : [];
  return [...new Set(list.map((c) => clip(c, 300)).filter((c) => c.length >= 8))].slice(0, 10);
}

export function normalizeFixes(raw, criteria) {
  const list = Array.isArray(raw?.fixes) ? raw.fixes : [];
  return list
    .map((f) => {
      const i = Number(f?.index);
      return { criterion: Number.isInteger(i) && criteria[i] ? criteria[i] : null, fix: clip(f?.fix, 300) };
    })
    .filter((f) => f.fix)
    .slice(0, 8);
}
