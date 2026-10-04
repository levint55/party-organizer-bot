import { MessageFlags, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { BOARD_CAPTION, createBoardAttachment, roleSelectRow } from '../party/board.js';
import { MAX_PARTY_COUNT } from '../party/emojis.js';
import { addBoard, buildGuild, withGuildLock } from '../party/store.js';
import type { Command } from '../types/command.js';

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('team')
    .setDescription('Create a team made of several parties. Each party holds up to 5 members.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addStringOption((option) =>
      option.setName('name').setDescription('Name of this team.').setRequired(true).setMaxLength(80),
    )
    .addIntegerOption((option) =>
      option
        .setName('party-count')
        .setDescription(`How many parties are in this team (1-${MAX_PARTY_COUNT}).`)
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(MAX_PARTY_COUNT),
    ),
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Use this command in a server channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.reply({
        content: 'You need the Manage Server permission to create a team.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const teamName = interaction.options.getString('name', true).trim();
    if (!teamName) {
      await interaction.reply({
        content: 'Give the team a name.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const partyCount = interaction.options.getInteger('party-count', true);
    const draft = buildGuild(partyCount, teamName);

    await withGuildLock(interaction.guildId, async () => {
      await interaction.deferReply();
      const message = await interaction.editReply({
        content: BOARD_CAPTION,
        components: [roleSelectRow()],
        files: [await createBoardAttachment(draft)],
      });
      draft.board = { channelId: message.channelId, messageId: message.id };
      addBoard(interaction.guildId, draft);

      try {
        for (const party of draft.parties) {
          await message.react(party.emoji);
        }
      } catch (error) {
        console.error('Failed to add party emojis.', error);
        await interaction.followUp({
          content: 'The team was posted, but I could not add every emoji. I need Add Reactions in this channel.',
          flags: MessageFlags.Ephemeral,
        });
      }
    });
  },
};

export default command;
