import 'dotenv/config';
import { createServer } from 'node:http';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { requireEnv } from './config.js';
import { loadCommands } from './handlers/commands.js';
import { registerEvents } from './handlers/events.js';
import { loadParties } from './party/store.js';

listenForHealthChecks();

const token = requireEnv('DISCORD_TOKEN');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

await loadParties();
client.commands = await loadCommands();
await registerEvents(client);
await client.login(token);

function listenForHealthChecks(): void {
  const port = Number(process.env.PORT);
  if (!Number.isInteger(port) || port <= 0) {
    return;
  }

  const server = createServer((request, response) => {
    if (request.url?.split('?')[0] === '/health') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('ok');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.listen(port, '0.0.0.0');
}
