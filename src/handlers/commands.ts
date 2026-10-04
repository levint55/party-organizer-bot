import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Collection } from 'discord.js';
import type { Command } from '../types/command.js';

export async function loadCommands(): Promise<Collection<string, Command>> {
  const commands = new Collection<string, Command>();
  const commandsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'commands');
  const extension = path.extname(fileURLToPath(import.meta.url));
  const files = (await readdir(commandsDir)).filter((file) => file.endsWith(extension));

  for (const file of files) {
    const modulePath = pathToFileURL(path.join(commandsDir, file)).href;
    const command = (await import(modulePath)).default as Command;
    commands.set(command.data.name, command);
  }

  return commands;
}
