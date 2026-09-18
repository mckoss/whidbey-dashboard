// Tiny leveled logger. One line per event, prefixed with an ISO timestamp and a
// stable event code so failures are greppable in Railway logs.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;

function emit(level, code, message, fields) {
  if (LEVELS[level] < threshold) return;
  const parts = [new Date().toISOString(), level.toUpperCase(), code, message];
  if (fields && Object.keys(fields).length) {
    parts.push(JSON.stringify(fields));
  }
  const line = parts.join(' ');
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
}

export const log = {
  debug: (code, message, fields) => emit('debug', code, message, fields),
  info: (code, message, fields) => emit('info', code, message, fields),
  warn: (code, message, fields) => emit('warn', code, message, fields),
  error: (code, message, fields) => emit('error', code, message, fields),
  // Multi-line, impossible-to-miss banner. Used for the one failure Mike has to
  // act on himself: an expired session cookie.
  banner: (code, lines) => {
    const bar = '='.repeat(72);
    console.error(`\n${bar}\n${code}\n${bar}`);
    for (const line of lines) console.error(line);
    console.error(`${bar}\n`);
  },
};

export default log;
