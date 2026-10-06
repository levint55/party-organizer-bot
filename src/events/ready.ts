import { Events, type Client } from 'discord.js';
import { fetchBoardMessage, queueBoardPaint } from '../party/board.js';
import { listBoards } from '../party/store.js';
import type { Event } from '../types/event.js';

const event: Event<typeof Events.ClientReady> = {
  name: Events.ClientReady,
  once: true,
  execute(client) {
    console.log(`Logged in as ${client.user.tag}`);
    void refreshBoards(client);
  },
};

async function refreshBoards(client: Client): Promise<void> {
  for (const guild of client.guilds.cache.values()) {
    for (const board of listBoards(guild.id)) {
      const message = await fetchBoardMessage(client, board);
      if (!message) {
        continue;
      }

      try {
        await queueBoardPaint(guild.id, board.id, message);
      } catch (error) {
        console.error('Failed to update the team board.', error);
        continue;
      }

      await message.reactions.removeAll().catch((error: unknown) => {
        console.error('Failed to clear old party reactions.', error);
      });
    }
  }
}

export default event;
