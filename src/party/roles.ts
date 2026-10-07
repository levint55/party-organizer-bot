import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { replyIfChannelBlocked } from './access.js';
import { queueBoardPaint } from './board.js';
import {
  clearMember,
  commitGuildChange,
  getBoardByMessage,
  isPartyRole,
  PartySaveError,
  setMemberRole,
  type PartyRole,
} from './store.js';

type RoleUpdate =
  | { ok: false; reason: 'stale-board' | 'not-in-party' }
  | { ok: true; unchanged: true }
  | { ok: true; unchanged: false; boardId: string };

type LeaveUpdate =
  | { ok: false; reason: 'stale-board' | 'not-in-party' }
  | { ok: true; boardId: string };

const ROLE_LABELS: Record<PartyRole, string> = {
  dps: 'DPS',
  tank: 'Tank',
  healer: 'Healer',
  support: 'Support',
};

export async function handlePartyRoleButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const role = interaction.customId.slice('party-role:'.length);
  if (!isPartyRole(role)) {
    await interaction.reply({ content: 'That role is not available.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (await replyIfChannelBlocked(interaction, 'board')) {
    return;
  }

  await interaction.deferUpdate();
  const guildId = interaction.guildId;

  try {
    const result = await commitGuildChange(guildId, (): { result: RoleUpdate; dirty: boolean } => {
      const guild = getBoardByMessage(guildId, interaction.message.id);
      if (!guild) {
        return { result: { ok: false as const, reason: 'stale-board' as const }, dirty: false };
      }

      const update = setMemberRole(guildId, guild.id, interaction.user.id, role);
      if (!update.ok) {
        return { result: { ok: false as const, reason: 'not-in-party' as const }, dirty: false };
      }
      if (update.unchanged) {
        return { result: { ok: true as const, unchanged: true }, dirty: false };
      }

      return { result: { ok: true as const, unchanged: false, boardId: guild.id }, dirty: true };
    });

    if (!result.ok && result.reason === 'not-in-party') {
      await interaction.followUp({
        content: 'Choose a party from the menu first, then pick a role.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!result.ok && result.reason === 'stale-board') {
      await interaction.followUp({
        content: 'This team is no longer active.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (result.ok && result.unchanged) {
      await interaction.followUp({
        content: `You are already ${ROLE_LABELS[role]}.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (result.ok && !result.unchanged) {
      try {
        await queueBoardPaint(guildId, result.boardId, interaction.message);
      } catch (error) {
        console.error('Failed to update the team board.', error);
        await interaction.followUp({
          content: `You are now ${ROLE_LABELS[role]}. I could not update the board.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
    }

    await interaction.followUp({
      content: `You are now ${ROLE_LABELS[role]}.`,
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (!(error instanceof PartySaveError)) {
      throw error;
    }
    console.error('Failed to save a party role.', error);
    await repaintBoard(guildId, interaction);
    await interaction.followUp({
      content: 'I could not save that role. It was not changed.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

export async function handlePartyLeaveButton(interaction: ButtonInteraction): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Use this in a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (await replyIfChannelBlocked(interaction, 'board')) {
    return;
  }

  await interaction.deferUpdate();
  const guildId = interaction.guildId;

  try {
    const result = await commitGuildChange(guildId, (): { result: LeaveUpdate; dirty: boolean } => {
      const guild = getBoardByMessage(guildId, interaction.message.id);
      if (!guild) {
        return { result: { ok: false as const, reason: 'stale-board' as const }, dirty: false };
      }

      const partyId = clearMember(guildId, guild.id, interaction.user.id);
      if (!partyId) {
        return { result: { ok: false as const, reason: 'not-in-party' as const }, dirty: false };
      }

      return { result: { ok: true as const, boardId: guild.id }, dirty: true };
    });

    if (!result.ok && result.reason === 'stale-board') {
      await interaction.followUp({
        content: 'This team is no longer active.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!result.ok) {
      await interaction.followUp({
        content: 'You are not in a party on this team.',
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

    await interaction.followUp({
      content: painted ? 'You left the party.' : 'You left the party. I could not update the board.',
      flags: MessageFlags.Ephemeral,
    });
  } catch (error) {
    if (!(error instanceof PartySaveError)) {
      throw error;
    }
    console.error('Failed to save a party leave.', error);
    await repaintBoard(guildId, interaction);
    await interaction.followUp({
      content: 'I could not save that leave. You are still in the party.',
      flags: MessageFlags.Ephemeral,
    });
  }
}

async function repaintBoard(guildId: string, interaction: ButtonInteraction): Promise<void> {
  const guild = getBoardByMessage(guildId, interaction.message.id);
  if (!guild) {
    return;
  }
  await queueBoardPaint(guildId, guild.id, interaction.message).catch((error: unknown) => {
    console.error('Failed to update the team board.', error);
  });
}
