// Container memory from cgroup v2. memory.current/peak include page cache
// (e.g. the Chromium binary read from disk), which the kernel can reclaim;
// "anon" is the memory processes really hold, and what gets the container
// OOM-killed. Returns nulls outside Linux containers.
import fs from 'node:fs';

const CG = '/sys/fs/cgroup';
const mb = (bytes) => (bytes == null ? null : Math.round(bytes / 1048576));
const readNum = (file) => { try { return Number(fs.readFileSync(`${CG}/${file}`, 'utf8').trim()); } catch { return null; } };

function readStat() {
  try {
    const stat = Object.fromEntries(
      fs.readFileSync(`${CG}/memory.stat`, 'utf8').trim().split('\n').map((l) => { const [k, v] = l.split(' '); return [k, Number(v)]; })
    );
    return { anon: stat.anon, file: stat.file, kernel: stat.kernel ?? (stat.kernel_stack ?? 0) + (stat.slab ?? 0) };
  } catch {
    return null;
  }
}

let peakAnon = 0;   // highest sampled anon since boot
let lastRun = null; // { label, peakAnonMb, peakTotalMb, ms }

function sample() {
  const s = readStat();
  if (s && s.anon > peakAnon) peakAnon = s.anon;
  return s;
}

/** Runs `fn` while sampling memory every 200 ms; records the run's peaks. */
export async function trackMemory(label, fn) {
  let runAnon = 0;
  let runTotal = 0;
  const tick = () => {
    const s = sample();
    if (s) runAnon = Math.max(runAnon, s.anon);
    runTotal = Math.max(runTotal, readNum('memory.current') ?? 0);
  };
  tick();
  const timer = setInterval(tick, 200);
  const started = Date.now();
  try {
    return await fn();
  } finally {
    clearInterval(timer);
    tick();
    lastRun = { label, peakAnonMb: mb(runAnon) || null, peakTotalMb: mb(runTotal) || null, ms: Date.now() - started };
  }
}

export function memoryReport() {
  const s = sample();
  return {
    currentMb: mb(readNum('memory.current')),
    peakMb: mb(readNum('memory.peak')),
    limitMb: mb(readNum('memory.max')),
    anonMb: mb(s?.anon),
    fileCacheMb: mb(s?.file),
    kernelMb: mb(s?.kernel),
    peakAnonSampledMb: mb(peakAnon) || null,
    lastRun,
    nodeRssMb: mb(process.memoryUsage().rss),
  };
}
