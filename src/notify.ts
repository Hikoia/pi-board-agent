/**
 * Phase E — Telegram notifications.
 *
 * Wrapper around the Bot API (sendMessage, HTML parse mode, 4096-char limit).
 * Token/chat id come from the environment (never from the yml): the container
 * passes TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID. Same bot + channel already
 * used by board-game-organizer's release notifications.
 */
import type { Config } from "./config.js";

export interface NotifyInput {
  botToken: string;
  chatId: string;
  title: string;
  body?: string;
  links?: string[];
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function mdToHtml(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return "";
      const header = trimmed.match(/^#{2,4}\s+(.*)/);
      if (header) return `<b>${escapeHtml(header[1])}</b>`;
      const bullet = trimmed.match(/^[-*]\s+(.*)/);
      if (bullet) return `• ${escapeHtml(bullet[1])}`;
      const bold = trimmed.match(/^\*\*(.*)\*\*$/);
      if (bold) return `<b>${escapeHtml(bold[1])}</b>`;
      return escapeHtml(trimmed);
    })
    .filter(Boolean)
    .join("\n");
}

/** Send a Telegram message. Returns true on success (never throws). */
export async function sendTelegram(input: NotifyInput): Promise<boolean> {
  const title = `<b>${escapeHtml(input.title)}</b>`;
  const body = input.body ? mdToHtml(input.body) : "";
  const links = input.links?.length
    ? input.links.map((l) => `🔗 ${l}`).join("\n")
    : "";
  let text = [title, body, links].filter(Boolean).join("\n\n");
  if (text.length > 4000) text = `${text.slice(0, 3999)}…`;

  try {
    const res = await fetch(`https://api.telegram.org/bot${input.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: input.chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
    });
    const json = (await res.json()) as { ok?: boolean; description?: string };
    if (!json.ok) {
      console.error(`[board-agent] Telegram error: ${json.description ?? "unknown"}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[board-agent] Telegram send failed: ${(err as Error).message}`);
    return false;
  }
}

/** Build a notifier bound to the config + env (used by loop/watchdog). */
export function makeNotifier(cfg: Config) {
  return async (
    event: string,
    title: string,
    body?: string,
    links?: string[],
  ): Promise<boolean> => {
    if (!cfg.telegram.enabled) return false;
    if (!cfg.telegram.on.includes(event)) return false;
    const botToken = process.env[cfg.telegram.bot_token_env];
    const chatId = process.env[cfg.telegram.chat_id_env];
    if (!botToken || !chatId) return false;
    return sendTelegram({ botToken, chatId, title, body, links });
  };
}

export type Notifier = ReturnType<typeof makeNotifier>;
