import { Events, MessageFlags, type InteractionReplyOptions } from 'discord.js';
import type { Event } from '../types/event.js';

const event: Event<typeof Events.InteractionCreate> = {
  name: Events.InteractionCreate,
  async execute(interaction) {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const command = interaction.client.commands.get(interaction.commandName);
    if (!command) {
      console.error(`No command matching ${interaction.commandName} was found.`);
      return;
    }

    try {
      await command.execute(interaction);
    } catch (error) {
      console.error(error);
      const payload = {
        content: 'There was an error while executing this command.',
        flags: MessageFlags.Ephemeral,
      } satisfies InteractionReplyOptions;

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    }
  },
};

export default event;
