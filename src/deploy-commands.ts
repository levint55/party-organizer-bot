import 'dotenv/config';
import { REST, Routes } from 'discord.js';
import { requireEnv } from './config.js';
import { loadCommands } from './handlers/commands.js';

const token = requireEnv('DISCORD_TOKEN');
const clientId = requireEnv('DISCORD_CLIENT_ID');
const guildId = process.env.DISCORD_GUILD_ID;

const commands = await loadCommands();
const body = commands.map((command) => command.data.toJSON());
const rest = new REST().setToken(token);

if (guildId) {
  await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body });
  console.log(`Registered ${body.length} guild command(s) in ${guildId}.`);
} else {
  await rest.put(Routes.applicationCommands(clientId), { body });
  console.log(`Registered ${body.length} global command(s). Global commands can take up to an hour to appear.`);
}
