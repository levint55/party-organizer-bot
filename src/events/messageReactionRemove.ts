import { Events } from 'discord.js';
import { handlePartyReactionRemove } from '../party/reactions.js';
import type { Event } from '../types/event.js';

const event: Event<typeof Events.MessageReactionRemove> = {
  name: Events.MessageReactionRemove,
  async execute(reaction, user) {
    try {
      await handlePartyReactionRemove(reaction, user);
    } catch (error) {
      console.error('Failed to handle a party leave.', error);
    }
  },
};

export default event;
