import { Events } from 'discord.js';
import { handlePartyReactionAdd } from '../party/reactions.js';
import type { Event } from '../types/event.js';

const event: Event<typeof Events.MessageReactionAdd> = {
  name: Events.MessageReactionAdd,
  async execute(reaction, user) {
    try {
      await handlePartyReactionAdd(reaction, user);
    } catch (error) {
      console.error('Failed to handle a party join.', error);
    }
  },
};

export default event;
