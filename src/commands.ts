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
  | { type: 'dare' | 'kill' }
  | { type: 'pick'; option: number }
  | { type: 'predict'; yes: boolean }
  | { type: 'overrule'; reason: string };

export function parseCommand(text: string): Command | undefined {
  const value = text.trim();
  switch (value) {
    case '!ping': return { type: 'reply', text: 'pong' };
    case '!race': return { type: 'reply', text: 'Race Control is online.' };
    case '!dare': return { type: 'dare' };
    case '!kill': return { type: 'kill' };
    case '!yes': return { type: 'predict', yes: true };
    case '!no': return { type: 'predict', yes: false };
  }
  const pick = /^!pick\s+([1-4])$/.exec(value);
  if (pick) return { type: 'pick', option: Number(pick[1]) };
  const overrule = /^!overrule\s+([\s\S]+)$/.exec(value);
  if (overrule) return { type: 'overrule', reason: overrule[1]!.trim() };
}
