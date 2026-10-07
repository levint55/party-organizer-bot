import {
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type InteractionReplyOptions,
  type StringSelectMenuInteraction,
} from 'discord.js';

type ChannelInteraction = ButtonInteraction | ChatInputCommandInteraction | StringSelectMenuInteraction;
type ChannelAccess = 'message' | 'board';

const MESSAGE_ACCESS = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.SendMessages, 'Send Messages'],
] as const;

const BOARD_ACCESS = [
  ...MESSAGE_ACCESS,
  [PermissionFlagsBits.EmbedLinks, 'Embed Links'],
  [PermissionFlagsBits.ReadMessageHistory, 'Read Message History'],
] as const;

export function isChannelAccessError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return false;
  }
  const code = error.code;
  return code === RESTJSONErrorCodes.MissingAccess || code === RESTJSONErrorCodes.MissingPermissions;
}

export function channelAccessReply(missing: readonly string[] = BOARD_ACCESS.map(([, name]) => name)): string {
  const list = missing.join(', ');
  return `I can't post in this channel yet. Open Edit Channel, then Permissions, add the bot, and allow ${list}. If the channel is synced to a category, add the bot on the category. For a private thread, add the bot to the thread.`;
}

export async function replyIfChannelBlocked(interaction: ChannelInteraction, access: ChannelAccess): Promise<boolean> {
  const missing = missingChannelAccess(interaction, access);
  if (!missing) {
    return false;
  }

  await interaction.reply({
    content: channelAccessReply(missing),
    flags: MessageFlags.Ephemeral,
  } satisfies InteractionReplyOptions);
  return true;
}

function missingChannelAccess(interaction: ChannelInteraction, access: ChannelAccess): string[] | null {
  if (!interaction.inGuild()) {
    return null;
  }

  const required = access === 'board' ? BOARD_ACCESS : MESSAGE_ACCESS;
  const permissions = interaction.appPermissions;
  if (!permissions) {
    return null;
  }

  const missing = required.filter(([bit]) => !permissions.has(bit)).map(([, name]) => name);
  return missing.length === 0 ? null : missing;
}
