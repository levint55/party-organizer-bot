import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  type Client,
  type Message,
  type PartialMessage,
} from 'discord.js';
import { getBoard, type GuildParties, type Party, type PartyRole } from './store.js';

export const PARTY_SELECT_ID = 'party-select';

export const BOARD_CAPTION =
  'Choose a party from the menu, then pick DPS, Tank, Healer, or Support. Each party holds up to 5 members. Press Leave to leave.';

export function boardComponents(
  guild: GuildParties,
): [ActionRowBuilder<StringSelectMenuBuilder>, ActionRowBuilder<ButtonBuilder>] | [ActionRowBuilder<ButtonBuilder>] {
  if (guild.parties.length === 0) {
    return [roleSelectRow()];
  }
  return [partySelectRow(guild), roleSelectRow()];
}

export function partySelectRow(guild: GuildParties): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(PARTY_SELECT_ID)
      .setPlaceholder('Choose a party')
      .addOptions(guild.parties.map((party) => partyOption(guild, party.id, party.name, party.emoji))),
  );
}

function partyOption(
  guild: GuildParties,
  partyId: string,
  name: string,
  emoji: string,
): StringSelectMenuOptionBuilder {
  const count = Object.values(guild.members).filter((member) => member.partyId === partyId).length;
  const description = count >= guild.maxMembers ? 'Full' : `${count}/${guild.maxMembers} members`;
  return new StringSelectMenuOptionBuilder()
    .setLabel(name.slice(0, 100))
    .setValue(partyId)
    .setEmoji(emoji)
    .setDescription(description);
}

export function roleSelectRow(): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('party-role:dps').setLabel('DPS').setEmoji('⚔️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('party-role:tank').setLabel('Tank').setEmoji('🛡️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('party-role:healer').setLabel('Healer').setEmoji('💚').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('party-role:support').setLabel('Support').setEmoji('✨').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('party-leave').setLabel('Leave').setEmoji('🚪').setStyle(ButtonStyle.Secondary),
  );
}

const ROLE_TEXT: Record<PartyRole, string> = {
  dps: '⚔️ DPS',
  tank: '🛡️ Tank',
  healer: '💚 Healer',
  support: '✨ Support',
};

export function boardMessageOptions(guild: GuildParties) {
  return {
    content: '',
    embeds: [boardEmbed(guild)],
    components: boardComponents(guild),
    attachments: [],
    allowedMentions: { parse: [] },
  };
}

export function boardEmbed(guild: GuildParties): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x3f6b78)
    .setTitle(guild.name.replace(/\s+/g, ' ').slice(0, 256))
    .setDescription(BOARD_CAPTION)
    .addFields(guild.parties.map((party) => partyField(guild, party)));
}

function partyField(guild: GuildParties, party: Party) {
  const members = Object.entries(guild.members).filter(([, member]) => member.partyId === party.id);
  const lines =
    members.length === 0
      ? ['*Empty*']
      : members.map(([userId, member]) => {
          const role = member.role ? ROLE_TEXT[member.role] : null;
          return role ? `<@${userId}> · ${role}` : `<@${userId}>`;
        });
  return {
    name: `${party.emoji} ${party.name} · ${members.length}/${guild.maxMembers}`.slice(0, 256),
    value: lines.join('\n').slice(0, 1024),
  };
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
  await target.edit(boardMessageOptions(guild));
}
