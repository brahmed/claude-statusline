#!/usr/bin/env node
// Claude Code status line.
//
// How it's called: Claude Code runs this script on each status line refresh and
// pipes a JSON object about the current session into stdin. Whatever we print
// on stdout (one line here) becomes the status line.
//
// Output: 🧠 ▓░░░░░░░░░ 6% 57k/1M │ 💰 $0.49 │ ⚡ 5h 6% (2h 36m) · 7d 54% │ 🤖 Opus 5.5 │ 📁 my-project │ 🌿 main*

const path = require('path');
const { execFileSync } = require('child_process');

// ---------------------------------------------------------------------------
// Settings: tweak these to change the look without touching the logic below.
// ---------------------------------------------------------------------------
const CTX_YELLOW_AT = 50; // context % at which the bar turns yellow
const CTX_RED_AT = 80; // context % at which the bar turns red
const RATE_YELLOW_AT = 50; // plan usage % at which a rate limit turns yellow
const RATE_RED_AT = 80; // plan usage % at which a rate limit turns red
const BAR_WIDTH = 10; // number of blocks in the context bar
const GIT_TIMEOUT_MS = 500; // give up on git if it takes longer than this

// ANSI escape codes. A terminal reads "\x1b[32m" as "switch to green" and
// "\x1b[0m" as "reset everything". Every colored piece ends with RESET so
// a color never leaks into the next section.
const RESET = '\x1b[0m';
const C = {
  dim: '\x1b[2m',
  red: '\x1b[1;31m', // bold so it stands out on a light theme
  green: '\x1b[32m',
  yellow: '\x1b[1;33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
};
const color = (name, text) => `${C[name]}${text}${RESET}`;

const SEPARATOR = color('dim', ' │ ');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// 57211 -> "57k", 1000000 -> "1M", 1250000 -> "1.3M"
function formatTokens(n) {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

// 45000 -> "45s", 742000 -> "12m", 5040000 -> "1h 24m"
function formatDuration(ms) {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return `${Math.floor(ms / 1000)}s`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ---------------------------------------------------------------------------
// Sections. Each function returns a string, or null to hide the section
// (that's how "hide when data is missing" works).
// ---------------------------------------------------------------------------

// 🧠 Context window: bar + percentage + tokens used / window size.
function contextSection(data) {
  const ctx = data.context_window;
  if (!ctx) return null;

  // Tokens currently in the context = everything sent as input on the last
  // request (fresh input + cache writes + cache reads).
  const u = ctx.current_usage;
  const used = u
    ? (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
    : null;
  const size = ctx.context_window_size;

  // Prefer Claude Code's own percentage; fall back to computing it.
  let pct = ctx.used_percentage;
  if (typeof pct !== 'number' && used != null && size) pct = (used / size) * 100;
  if (typeof pct !== 'number') return null;
  pct = Math.max(0, Math.min(100, Math.round(pct)));

  // Bar: e.g. 42% with width 10 -> 4 filled + 6 empty.
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const bar = '▓'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);

  // Threshold coloring.
  const tone = pct >= CTX_RED_AT ? 'red' : pct >= CTX_YELLOW_AT ? 'yellow' : 'green';

  // Token count is optional (current_usage is null before the first API call).
  const tokens = used != null && size ? color('dim', ` ${formatTokens(used)}/${formatTokens(size)}`) : '';
  return `🧠 ${color(tone, `${bar} ${pct}%`)}${tokens}`;
}

// 💰 Session cost in USD.
function costSection(data) {
  const usd = data.cost?.total_cost_usd;
  if (typeof usd !== 'number') return null;
  return `💰 ${color('cyan', `$${usd.toFixed(2)}`)}`;
}

// ⚡ Plan rate limits: 5-hour window (with time until reset) and 7-day window.
// Only sent on subscription plans, so with API-key billing this section hides.
function rateLimitSection(data) {
  const limits = data.rate_limits;
  if (!limits) return null;

  // One window -> "5h 6%" colored by threshold, or null if missing.
  const part = (label, win) => {
    const pct = win?.used_percentage;
    if (typeof pct !== 'number') return null;
    const tone = pct >= RATE_RED_AT ? 'red' : pct >= RATE_YELLOW_AT ? 'yellow' : 'green';
    return color(tone, `${label} ${Math.round(pct)}%`);
  };

  let fiveHour = part('5h', limits.five_hour);
  // resets_at is in Unix *seconds*; Date.now() is in milliseconds.
  const resetsAt = limits.five_hour?.resets_at;
  if (fiveHour && typeof resetsAt === 'number') {
    const msLeft = resetsAt * 1000 - Date.now();
    if (msLeft > 0) fiveHour += color('dim', ` (${formatDuration(msLeft)})`);
  }

  const parts = [fiveHour, part('7d', limits.seven_day)].filter(Boolean);
  return parts.length ? `⚡ ${parts.join(color('dim', ' · '))}` : null;
}

// 🤖 Model name.
function modelSection(data) {
  const name = data.model?.display_name || data.model?.id;
  if (!name) return null;
  return `🤖 ${color('magenta', name)}`;
}

// 📁 Current directory (basename only).
function dirSection(dir) {
  if (!dir) return null;
  return `📁 ${color('blue', path.basename(dir) || dir)}`;
}

// 🌿 Git branch, with * when there are uncommitted changes.
function gitSection(dir) {
  if (!dir) return null;
  let out;
  try {
    // One call gives us both the branch and the dirty state:
    //   --no-optional-locks : don't take index.lock, so we never block a real git command
    //   --porcelain --branch: stable machine-readable output; first line is "## <branch>..."
    //   stdio 'ignore' for stderr: "not a git repository" errors stay silent
    out = execFileSync('git', ['--no-optional-locks', 'status', '--porcelain', '--branch'], {
      cwd: dir,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // not a repo, git missing, or too slow -> hide the section
  }

  const [header, ...changes] = out.split('\n').filter(Boolean);
  if (!header?.startsWith('## ')) return null;

  // Header formats we handle:
  //   "## main...origin/main [ahead 1]"   -> main
  //   "## No commits yet on main"         -> main
  //   "## HEAD (no branch)"               -> detached
  let branch = header.slice(3).replace(/^No commits yet on /, '').split('...')[0].split(' ')[0];
  if (branch === 'HEAD') branch = 'detached';

  const dirty = changes.length > 0;
  return `🌿 ${color(dirty ? 'yellow' : 'green', branch + (dirty ? '*' : ''))}`;
}

// ---------------------------------------------------------------------------
// Main: read stdin, build sections in order, print one line.
// ---------------------------------------------------------------------------
function render(data) {
  const dir = data.workspace?.current_dir || data.cwd;
  const sections = [
    contextSection(data),
    costSection(data),
    rateLimitSection(data),
    modelSection(data),
    dirSection(dir),
    gitSection(dir),
  ];
  // filter(Boolean) drops the null (hidden) sections, so separators stay correct.
  return sections.filter(Boolean).join(SEPARATOR) + RESET;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => (input += chunk));
process.stdin.on('end', () => {
  try {
    process.stdout.write(render(JSON.parse(input || '{}')) + '\n');
  } catch {
    // Never crash: a broken status line is worse than a plain one.
    process.stdout.write('🤖 Claude' + RESET + '\n');
  }
});
