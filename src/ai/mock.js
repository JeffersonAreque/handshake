// Deterministic offline provider (tests, local dev without a key). Same raw
// output shape as the Gemini adapter.
export function createMock() {
  return {
    provider: 'mock',
    model: 'mock',
    async judge({ criteria, checks }) {
      const problems = [];
      if (!checks.httpStatus || checks.httpStatus >= 400) problems.push(`HTTP status ${checks.httpStatus ?? 'none'}`);
      if (checks.pageErrors?.length) problems.push(`${checks.pageErrors.length} JavaScript error(s): ${checks.pageErrors[0]}`);
      if (checks.consoleErrors?.length) problems.push(`${checks.consoleErrors.length} console error(s): ${checks.consoleErrors[0]}`);
      if (checks.brokenImages?.length) problems.push(`${checks.brokenImages.length} broken image(s)`);
      const pass = problems.length === 0;
      return {
        verdicts: criteria.map((_, index) => ({
          index,
          pass,
          reason: pass ? 'Mock verifier: the page loaded with no errors.' : `Mock verifier: ${problems.join('; ')}.`,
          evidence: pass ? ['desktop.jpg', 'mobile.jpg'] : ['checks.pageErrors', 'checks.consoleErrors'],
        })),
      };
    },
    async draftCriteria(brief) {
      const sentences = brief.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim().replace(/[.!?]+$/, '')).filter((s) => s.length >= 8);
      return {
        criteria: [
          ...sentences.slice(0, 5).map((s) => `The page clearly shows: ${s}`),
          'The page loads without errors',
          'The page works on mobile without horizontal scrolling',
        ],
      };
    },
    async fixList({ verdicts }) {
      return {
        fixes: verdicts
          .map((v, index) => ({ index, fix: `Fix this so it passes: ${v.reason}` }))
          .filter((_, i) => !verdicts[i].pass),
      };
    },
  };
}
