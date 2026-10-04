import { MessageFlags, type ButtonInteraction } from 'discord.js';
import { boardMessageOptions } from './board.js';
import { getBoardByMessage, isPartyRole, setMemberRole, withGuildLock, type PartyRole } from './store.js';

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
    return;
  }

  const guildId = interaction.guildId;
  const result = await withGuildLock(guildId, async () => {
    const guild = getBoardByMessage(guildId, interaction.message.id);
    if (!guild) {
      return { ok: false as const, reason: 'stale-board' as const };
    }

    const update = setMemberRole(guildId, guild.id, interaction.user.id, role);
    if (!update.ok || update.unchanged) {
      return update;
    }

    await interaction.update(await boardMessageOptions(interaction.message, guild));
    return { ok: true as const, unchanged: false };
  });

  if (!result.ok && result.reason === 'not-in-party') {
    await interaction.reply({
      content: 'Join a party first by clicking its emoji, then choose a role.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!result.ok && result.reason === 'stale-board') {
    await interaction.reply({
      content: 'This team is no longer active.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (result.ok && result.unchanged) {
    await interaction.reply({
      content: `You are already ${ROLE_LABELS[role]}.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (result.ok) {
    await interaction.followUp({
      content: `You are now ${ROLE_LABELS[role]}.`,
      flags: MessageFlags.Ephemeral,
    });
  }
}
