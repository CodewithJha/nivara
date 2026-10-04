// Preloaded with `node --import ./src/instrument.ts` so Sentry patches http/express before they are imported.
import * as Sentry from '@sentry/node';

if (process.env.SENTRY_DSN && !Sentry.getClient()) Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 1),
  sendDefaultPii: false,
  environment: process.env.NODE_ENV ?? 'development',
});
