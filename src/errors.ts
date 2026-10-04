// One error shape for every API response: { error: { code, message } }. The message is always written for the
// shop owner. Internal detail (stack, upstream body, DB error, keys) goes to the server log / Sentry only.

export class AppError extends Error {
  code: string; status: number; detail?: string;
  constructor(code: string, message: string, status = 400, detail?: string) {
    super(message);
    this.name = 'AppError';
    this.code = code; this.status = status; this.detail = detail;
  }
}
export const fail = (code: string, message: string, status = 400, detail?: string) => new AppError(code, message, status, detail);

const BY_STATUS: Record<number, [string, string]> = {
  400: ['bad_request', "That request didn't look right. Check it and try again."],
  401: ['not_allowed', "You don't have access to that."],
  403: ['not_allowed', "You don't have access to that."],
  404: ['not_found', "We couldn't find that."],
  413: ['too_large', 'That was too large to send.'],
  415: ['bad_request', "That kind of file can't be used here."],
  422: ['unreadable', "Nivara couldn't make sense of that. Try rewording it."],
  429: ['busy', 'Nivara is busy. Try again in a moment.'],
  500: ['server_error', 'Something went wrong on our side. Please try again.'],
  501: ['not_available', "That isn't available right now."],
  502: ['unavailable', 'A service Nivara relies on is not responding. Please try again in a moment.'],
  503: ['unavailable', 'A service Nivara relies on is not responding. Please try again in a moment.'],
  504: ['timeout', 'That took too long. Please try again.'],
};

/** HTTP status + safe envelope for any thrown value. Only AppError messages are shown; everything else gets the status default. */
export function errorResponse(e: any): { status: number; body: { error: { code: string; message: string } } } {
  let status = Number(e?.status ?? e?.statusCode) || 500;
  if (status < 400 || status > 599) status = 500;
  if (e?.type === 'entity.parse.failed') return { status: 400, body: { error: { code: 'bad_json', message: "That request wasn't readable. Please try again." } } };
  if (e?.type === 'entity.too.large') return { status: 413, body: { error: { code: 'too_large', message: BY_STATUS[413][1] } } };
  const [code, message] = BY_STATUS[status] ?? (status >= 500 ? BY_STATUS[500] : BY_STATUS[400]);
  return e instanceof AppError
    ? { status, body: { error: { code: e.code, message: e.message } } }
    : { status, body: { error: { code, message } } };
}
