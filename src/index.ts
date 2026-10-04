import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { requireEnv } from './config.js';
import { loadCommands } from './handlers/commands.js';
import { registerEvents } from './handlers/events.js';

const token = requireEnv('DISCORD_TOKEN');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.commands = await loadCommands();
await registerEvents(client);
await client.login(token);
