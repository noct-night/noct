/** Minimal structured logger. Vercel captures stdout/stderr per invocation. */

export type Logger = {
  info: (msg: string, data?: Record<string, unknown>) => void;
  warn: (msg: string, data?: Record<string, unknown>) => void;
  error: (msg: string, data?: Record<string, unknown>) => void;
  child: (scope: string) => Logger;
};

function line(level: string, scope: string, msg: string, data?: Record<string, unknown>): string {
  const base = `${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${msg}`;
  return data && Object.keys(data).length ? `${base} ${JSON.stringify(data)}` : base;
}

export function createLogger(scope = 'noct'): Logger {
  return {
    info: (m, d) => console.log(line('info', scope, m, d)),
    warn: (m, d) => console.warn(line('warn', scope, m, d)),
    error: (m, d) => console.error(line('error', scope, m, d)),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}

export const log = createLogger();
