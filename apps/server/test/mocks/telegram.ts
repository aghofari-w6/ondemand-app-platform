import { startMock, type MockReply } from './server.ts';

/**
 * Mock Telegram Bot API (plan decision 6: no live calls). Implements the documented
 * shapes of getMe, setWebhook, deleteWebhook and sendMessage for bots registered with
 * `addBot`, and can push an update to the webhook a bot registered, with its secret token.
 */
export interface SentMessage {
  token: string;
  chat_id: string;
  text: string;
  reply_to: number | null;
  message_id: number;
}

export async function startTelegramMock(port = 0) {
  const bots = new Map<string, { id: number; username: string; webhook: { url: string; secret: string } | null }>();
  const sent: SentMessage[] = [];
  /** the next sendMessage calls answer with these statuses first (e.g. [500, 429]) */
  const failures: number[] = [];
  let nextId = 5000;
  let updateId = 9000;
  const ok = (result: unknown): MockReply => ({ json: { ok: true, result } });
  const err = (status: number, description: string, parameters?: Record<string, unknown>): MockReply => ({ status, json: { ok: false, error_code: status, description, ...(parameters ? { parameters } : {}) } });

  const mock = await startMock((req) => {
    const m = /^\/bot([^/]+)\/([A-Za-z]+)$/.exec(req.path);
    if (!m) return err(404, 'Not Found');
    const [, token, method] = m as unknown as [string, string, string];
    const bot = bots.get(token);
    if (!bot) return err(401, 'Unauthorized');
    switch (method) {
      case 'getMe':
        return ok({ id: bot.id, is_bot: true, first_name: bot.username, username: bot.username });
      case 'setWebhook':
        if (typeof req.body?.url !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(String(req.body?.secret_token ?? ''))) return err(400, 'Bad Request: bad webhook');
        bot.webhook = { url: req.body.url, secret: req.body.secret_token };
        return ok(true);
      case 'deleteWebhook':
        bot.webhook = null;
        return ok(true);
      case 'sendMessage': {
        const fail = failures.shift();
        if (fail === 429) return err(429, 'Too Many Requests: retry after 1', { retry_after: 1 });
        if (fail) return err(fail, fail === 403 ? 'Forbidden: bot was blocked by the user' : 'Internal Server Error');
        if (!req.body?.chat_id || typeof req.body?.text !== 'string' || !req.body.text) return err(400, 'Bad Request: message text is empty');
        const message_id = nextId++;
        sent.push({ token, chat_id: String(req.body.chat_id), text: req.body.text, reply_to: req.body.reply_parameters?.message_id ?? null, message_id });
        return ok({ message_id, chat: { id: req.body.chat_id }, text: req.body.text });
      }
      default:
        return err(404, 'Not Found: method not found');
    }
  }, port);

  return {
    ...mock,
    sent,
    failures,
    addBot(token: string, username: string) {
      bots.set(token, { id: 700000 + bots.size, username, webhook: null });
    },
    webhook: (token: string) => bots.get(token)?.webhook ?? null,
    /** The update Telegram would POST for a text message from a user. */
    update(chatId: number, text: string, from: { id: number; first_name?: string; username?: string } = { id: chatId, first_name: 'Tele', username: 'tele_user' }) {
      return { update_id: updateId++, message: { message_id: nextId++, date: Math.floor(Date.now() / 1000), chat: { id: chatId, type: 'private' }, from: { is_bot: false, ...from }, text } };
    },
    /** Delivers an update to the bot's registered webhook, like Telegram does. */
    async push(token: string, chatId: number, text: string, opts: { secret?: string } = {}) {
      const hook = bots.get(token)?.webhook;
      if (!hook) throw new Error('the bot has no webhook');
      const update = this.update(chatId, text);
      const res = await fetch(hook.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': opts.secret ?? hook.secret }, body: JSON.stringify(update) });
      return { status: res.status, update };
    },
  };
}
