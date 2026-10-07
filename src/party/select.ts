import { MessageFlags, type StringSelectMenuInteraction } from 'discord.js';
import { replyIfChannelBlocked } from './access.js';
import { boardComponents, queueBoardPaint } from './board.js';
import { commitGuildChange, getBoardByMessage, PartySaveError, setMember, type GuildParties } from './store.js';

type SelectUpdate =
  | { ok: false; reason: 'stale-board' | 'unknown-party' | 'full' }
  | { ok: true; unchanged: true; partyName: string }
  | { ok: true; unchanged: false; boardId: string; partyName: string; moved: boolean };

export async function handlePartySelect(interaction: StringSelectMenuInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const partyId = interaction.values[0];
  if (!partyId) {
    await interaction.reply({ content: 'Choose a party from the menu.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (await replyIfChannelBlocked(interaction, 'board')) {
    return;
  }

  await interaction.deferUpdate();
  const guildId = interaction.guildId;

  try {
    const result = await commitGuildChange(guildId, (): { result: SelectUpdate; dirty: boolean } => {
      const guild = getBoardByMessage(guildId, interaction.message.id);
      if (!guild) {
        return { result: { ok: false as const, reason: 'stale-board' as const }, dirty: false };
      }

      const party = guild.parties.find((entry) => entry.id === partyId);
      const partyName = party ? `${party.emoji} ${party.name}` : 'that party';
      const update = setMember(guildId, guild.id, interaction.user.id, partyId);
      if (!update.ok) {
        return {
          result: { ok: false as const, reason: update.reason === 'full' ? ('full' as const) : ('unknown-party' as const) },
          dirty: false,
        };
      }
      if (update.unchanged) {
        return { result: { ok: true as const, unchanged: true as const, partyName }, dirty: false };
      }

      return {
        result: {
          ok: true as const,
          unchanged: false as const,
          boardId: guild.id,
          partyName,
          moved: update.previousPartyId !== null,
        },
        dirty: true,
      };
    });

    if (!result.ok) {
      await resetMenu(guildId, interaction);
      await interaction.followUp({
        content: selectFailureMessage(result.reason),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (result.unchanged) {
      await resetMenu(guildId, interaction);
      await interaction.followUp({
        content: `You are already in ${result.partyName}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    let painted = true;
    try {
      await queueBoardPaint(guildId, result.boardId, interaction.message);
    } catch (error) {
      painted = false;
      console.error('Failed to update the team board.', error);
    }

    const action = result.moved ? `You moved to ${result.partyName}.` : `You joined ${result.partyName}.`;
    await interaction.followUp({
      content: painted ? action : `${action} I could not update the board.`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (!(error instanceof PartySaveError)) {
      throw error;
    }
    console.error('Failed to save a party choice.', error);
    await repaintBoard(guildId, interaction);
    await interaction.followUp({
      content: 'I could not save that change. Nothing was kept.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

function selectFailureMessage(reason: 'stale-board' | 'unknown-party' | 'full'): string {
  if (reason === 'full') {
    return 'That party is full.';
  }
  if (reason === 'stale-board') {
    return 'This team is no longer active.';
  }
  return 'That party is not on this team.';
}

async function resetMenu(guildId: string, interaction: StringSelectMenuInteraction): Promise<void> {
  const guild = getBoardByMessage(guildId, interaction.message.id);
  if (!guild) {
    return;
  }
  await editMenu(interaction, guild);
}

async function repaintBoard(guildId: string, interaction: StringSelectMenuInteraction): Promise<void> {
  const guild = getBoardByMessage(guildId, interaction.message.id);
  if (!guild) {
    return;
  }
  await queueBoardPaint(guildId, guild.id, interaction.message).catch((error: unknown) => {
    console.error('Failed to update the team board.', error);
  });
}

async function editMenu(interaction: StringSelectMenuInteraction, guild: GuildParties): Promise<void> {
  try {
    const message = interaction.message.partial ? await interaction.message.fetch() : interaction.message;
    await message.edit({ components: boardComponents(guild) });
  } catch (error) {
    console.error('Failed to reset the party menu.', error);
  }
}
