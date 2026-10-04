import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Client } from 'discord.js';
import type { Event } from '../types/event.js';

export async function registerEvents(client: Client): Promise<void> {
  const eventsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'events');
  const extension = path.extname(fileURLToPath(import.meta.url));
  const files = (await readdir(eventsDir)).filter((file) => file.endsWith(extension));

  for (const file of files) {
    const modulePath = pathToFileURL(path.join(eventsDir, file)).href;
    const event = (await import(modulePath)).default as Event;
    const listener = (...args: ClientEventsArgs) => {
      void event.execute(...args);
    };

    if (event.once) {
      client.once(event.name, listener);
    } else {
      client.on(event.name, listener);
    }
  }
}

type ClientEventsArgs = Parameters<Event['execute']>;
