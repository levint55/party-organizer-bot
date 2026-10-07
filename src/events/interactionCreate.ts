import { Events, MessageFlags, type InteractionReplyOptions } from 'discord.js';
import { channelAccessReply, isChannelAccessError } from '../party/access.js';
import { PARTY_SELECT_ID } from '../party/board.js';
import { handlePartyLeaveButton, handlePartyRoleButton } from '../party/roles.js';
import { handlePartySelect } from '../party/select.js';
import type { Event } from '../types/event.js';

const event: Event<typeof Events.InteractionCreate> = {
  name: Events.InteractionCreate,
  async execute(interaction) {
    if (interaction.isStringSelectMenu() && interaction.customId === PARTY_SELECT_ID) {
      try {
        await handlePartySelect(interaction);
      } catch (error) {
        await fail(interaction, error, 'There was an error while choosing a party.');
      }
      return;
    }

    if (interaction.isButton() && (interaction.customId === 'party-leave' || interaction.customId.startsWith('party-role:'))) {
      try {
        if (interaction.customId === 'party-leave') {
          await handlePartyLeaveButton(interaction);
        } else {
          await handlePartyRoleButton(interaction);
        }
      } catch (error) {
        const fallback =
          interaction.customId === 'party-leave'
            ? 'There was an error while leaving the party.'
            : 'There was an error while choosing a role.';
        await fail(interaction, error, fallback);
      }
      return;
    }

    if (interaction.isAutocomplete()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (!command?.autocomplete) {
        return;
      }

      try {
        await command.autocomplete(interaction);
      } catch (error) {
        console.error(error);
      }
      return;
    }

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
      await fail(interaction, error, 'There was an error while executing this command.');
    }
  },
};

export default event;

interface ErrorReply {
  deferred: boolean;
  replied: boolean;
  followUp(options: InteractionReplyOptions): Promise<unknown>;
  reply(options: InteractionReplyOptions): Promise<unknown>;
}

async function fail(interaction: ErrorReply, error: unknown, fallback: string): Promise<void> {
  console.error(error);
  const payload = {
    content: isChannelAccessError(error) ? channelAccessReply() : fallback,
    flags: MessageFlags.Ephemeral,
  } satisfies InteractionReplyOptions;

  try {
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(payload);
    } else {
      await interaction.reply(payload);
    }
  } catch (replyError) {
    console.error('Failed to send an error reply.', replyError);
  }
}
