export interface ChatMessage {
  chatter_user_id: string;
  message: { text: string };
}

export function routeCommand(event: ChatMessage, botId: string): string | undefined {
  if (event.chatter_user_id === botId) return;
  const command = parseCommand(event.message.text);
  return command?.type === 'reply' ? command.text : undefined;
}

export interface ChatInput { userId: string; login: string; text: string }
export type Command =
  | { type: 'reply'; text: string }
  | { type: 'dare' | 'kill' | 'approve' | 'reroll' }
  | { type: 'pick'; option: number }
  | { type: 'predict'; yes: boolean }
  | { type: 'overrule'; reason: string };

export function parseCommand(text: string, options: readonly string[] = []): Command | undefined {
  const trimmed = text.trim();
  // Chatters often end commands with "." or "!" ("!approve.").
  const value = trimmed.startsWith('!') ? trimmed.replace(/[.!]+$/, '') : trimmed;
  switch (value) {
    case '!ping': return { type: 'reply', text: 'pong' };
    case '!race': return { type: 'reply', text: 'Race Control is online.' };
    case '!dare': return { type: 'dare' };
    case '!approve': return { type: 'approve' };
    case '!reroll': return { type: 'reroll' };
    case '!kill': return { type: 'kill' };
    case '!yes': return { type: 'predict', yes: true };
    case '!no': return { type: 'predict', yes: false };
  }
  const pick = /^!pick\s+([1-4])$/.exec(value);
  if (pick) return { type: 'pick', option: Number(pick[1]) };
  if (options.length) {
    if (/^[1-4]$/.test(value) && options[Number(value) - 1]) return { type: 'pick', option: Number(value) };
    const matches = options.map((option, index) => ({ word: option.split(/\s+/)[0]!.toLowerCase(), index }));
    const match = matches.filter(option => option.word === value.toLowerCase());
    if (match.length === 1) return { type: 'pick', option: match[0]!.index + 1 };
  }
  const overrule = /^!overrule\s+([\s\S]+)$/.exec(value);
  if (overrule) return { type: 'overrule', reason: overrule[1]!.trim() };
}
