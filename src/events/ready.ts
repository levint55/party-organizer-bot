import { Events } from 'discord.js';
import type { Event } from '../types/event.js';

const event: Event<typeof Events.ClientReady> = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    console.log(`Logged in as ${client.user.tag}`);
  },
};

export default event;
