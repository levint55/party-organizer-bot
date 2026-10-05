import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Client,
  type Guild,
  type Message,
  type PartialMessage,
} from 'discord.js';
import { renderPartyGrid, type MemberProfile } from './board-image.js';
import { getBoard, type GuildParties, type PartyRole } from './store.js';

export const BOARD_CAPTION =
  'Click an emoji to join a party in this team, then choose DPS, Tank, Healer, or Support. Each party holds up to 5 members. Press Leave, or remove your emoji, to leave.';

export function roleSelectRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('party-role:dps').setLabel('DPS').setEmoji('⚔️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('party-role:tank').setLabel('Tank').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('party-role:healer').setLabel('Healer').setEmoji('💚').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('party-role:support').setLabel('Support').setEmoji('✨').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('party-leave').setLabel('Leave').setEmoji('🚪').setStyle(ButtonStyle.Secondary),
  );
}

export async function createBoardAttachment(
  guild: GuildParties,
  profiles: ReadonlyMap<string, MemberProfile> = new Map(),
): Promise<AttachmentBuilder> {
  const png = await renderPartyGrid(guild, profiles);
  return new AttachmentBuilder(png, { name: `parties-${Date.now()}.png` });
}

export async function fetchBoardMessage(client: Client, guild: GuildParties): Promise<Message | null> {
  const located = guild.board;
  if (!located) {
    return null;
  }

  const channel = await client.channels.fetch(located.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    return null;
  }

  return channel.messages.fetch(located.messageId).catch(() => null);
}

const paints = new Map<string, Promise<void>>();

export function queueBoardPaint(guildId: string, boardId: string, message: Message | PartialMessage): Promise<void> {
  const key = `${guildId}:${boardId}`;
  const previous = paints.get(key) ?? Promise.resolve();
  const run = previous.then(async () => {
    const latest = getBoard(guildId, boardId);
    if (!latest) {
      return;
    }
    await updateBoardMessage(message, latest);
  });
  paints.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export async function updateBoardMessage(message: Message | PartialMessage, guild: GuildParties): Promise<void> {
  const target = message.partial ? await message.fetch() : message;
  await target.edit(await boardMessageOptions(target, guild));
}

export async function boardMessageOptions(message: Message | PartialMessage, guild: GuildParties) {
  const target = message.partial ? await message.fetch() : message;
  return {
    content: `**${guild.name}**\n${BOARD_CAPTION}`,
    components: [roleSelectRow()],
    embeds: [],
    files: [await createBoardAttachment(guild, await resolveProfiles(target, guild))],
    attachments: [],
  };
}

async function resolveProfiles(message: Message, guild: GuildParties): Promise<Map<string, MemberProfile>> {
  const discordGuild = await resolveDiscordGuild(message);
  const profiles = new Map<string, MemberProfile>();
  await Promise.all(
    Object.keys(guild.members).map(async (userId) => {
      profiles.set(userId, await memberProfile(discordGuild, message, userId, guild.members[userId]?.role ?? null));
    }),
  );
  return profiles;
}

async function resolveDiscordGuild(message: Message): Promise<Guild | null> {
  if (message.guild) {
    return message.guild;
  }
  if (!message.guildId) {
    return null;
  }
  return message.client.guilds.fetch(message.guildId).catch(() => null);
}

async function memberProfile(
  guild: Guild | null,
  message: Message,
  userId: string,
  role: PartyRole | null,
): Promise<MemberProfile> {
  if (guild) {
    try {
      const member = await guild.members.fetch(userId);
      return {
        name: member.displayName,
        avatarUrl: member.displayAvatarURL({ extension: 'png', size: 128 }),
        role,
      };
    } catch {
      // Fall back to the Discord user when the member record is unavailable.
    }
  }

  try {
    const user = await message.client.users.fetch(userId);
    return {
      name: user.globalName ?? user.username,
      avatarUrl: user.displayAvatarURL({ extension: 'png', size: 128 }),
      role,
    };
  } catch {
    return { name: 'Member', avatarUrl: null, role };
  }
}
