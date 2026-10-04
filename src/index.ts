import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { requireEnv } from './config.js';
import { loadCommands } from './handlers/commands.js';
import { registerEvents } from './handlers/events.js';
import { loadParties } from './party/store.js';

const token = requireEnv('DISCORD_TOKEN');

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessageReactions],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
});

await loadParties();
client.commands = await loadCommands();
await registerEvents(client);
await client.login(token);
