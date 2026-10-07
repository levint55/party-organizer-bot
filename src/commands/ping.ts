import { SlashCommandBuilder } from 'discord.js';
import { replyIfChannelBlocked } from '../party/access.js';
import type { Command } from '../types/command.js';

const command: Command = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Replies with Pong!'),
  async execute(interaction) {
    if (await replyIfChannelBlocked(interaction, 'message')) {
      return;
    }
    await interaction.reply('Pong!');
  },
};

export default command;
