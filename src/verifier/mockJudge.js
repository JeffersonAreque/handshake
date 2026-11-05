// Deterministic offline judge used when AI_PROVIDER=mock (tests, local dev,
// slice 1 deploy). A criterion passes only if the page loaded cleanly.
export const mockJudge = {
  model: 'mock',
  async judge({ criteria, checks }) {
    const problems = [];
    if (!checks.httpStatus || checks.httpStatus >= 400) problems.push(`HTTP status ${checks.httpStatus ?? 'none'}`);
    if (checks.pageErrors.length) problems.push(`${checks.pageErrors.length} JavaScript error(s): ${checks.pageErrors[0]}`);
    if (checks.consoleErrors.length) problems.push(`${checks.consoleErrors.length} console error(s): ${checks.consoleErrors[0]}`);
    if (checks.brokenImages.length) problems.push(`${checks.brokenImages.length} broken image(s)`);
    const pass = problems.length === 0;
    return criteria.map((criterion) => ({
      criterion,
      pass,
      reason: pass
        ? 'Mock verifier: the page loaded with HTTP 2xx/3xx and no errors.'
        : `Mock verifier: ${problems.join('; ')}.`,
      evidence: ['desktop.png', 'mobile.png'],
    }));
  },
};
