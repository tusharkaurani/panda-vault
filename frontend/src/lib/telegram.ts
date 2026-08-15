export function telegramUrl(channel: string): string {
  const trimmed = channel.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  const handle = trimmed.replace(/^@/, "").replace(/^t\.me\//i, "");
  return `https://t.me/${handle}`;
}
