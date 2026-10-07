import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { replyIfChannelBlocked } from '../party/access.js';
import { fetchBoardMessage, queueBoardPaint } from '../party/board.js';
import {
  clearMember,
  commitGuildChange,
  getBoard,
  listBoards,
  PartySaveError,
  setMember,
  type GuildParties,
  type Party,
} from '../party/store.js';
import type { Command } from '../types/command.js';

type MemberAction = 'add' | 'remove' | 'switch';

interface MemberChange {
  content: string;
  boardId: string | null;
}

const command: Command = {
  data: new SlashCommandBuilder()
    .setName('member')
    .setDescription('Add, remove, or move a member on a team. Requires Manage Server.')
    .setDMPermission(false)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((subcommand) =>
      subcommand
        .setName('add')
        .setDescription('Add a member to a party.')
        .addUserOption((option) => option.setName('user').setDescription('Member to add.').setRequired(true))
        .addStringOption((option) =>
          option.setName('team').setDescription('Team to change.').setRequired(true).setAutocomplete(true),
        )
        .addStringOption((option) =>
          option.setName('party').setDescription('Party to put them in.').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('remove')
        .setDescription('Remove a member from a team.')
        .addUserOption((option) => option.setName('user').setDescription('Member to remove.').setRequired(true))
        .addStringOption((option) =>
          option.setName('team').setDescription('Team to change.').setRequired(true).setAutocomplete(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('switch')
        .setDescription('Move a member to a different party.')
        .addUserOption((option) => option.setName('user').setDescription('Member to move.').setRequired(true))
        .addStringOption((option) =>
          option.setName('team').setDescription('Team to change.').setRequired(true).setAutocomplete(true),
        )
        .addStringOption((option) =>
          option.setName('party').setDescription('Party to move them to.').setRequired(true).setAutocomplete(true),
        ),
    ),
  async autocomplete(interaction) {
    if (!interaction.inGuild() || !canManageMembers(interaction)) {
      await interaction.respond([]);
      return;
    }

    const focused = interaction.options.getFocused(true);
    if (focused.name === 'team') {
      await interaction.respond(teamChoices(interaction.guildId, String(focused.value)));
      return;
    }
    if (focused.name === 'party') {
      await interaction.respond(
        partyChoices(interaction.guildId, interaction.options.getString('team'), String(focused.value)),
      );
      return;
    }
    await interaction.respond([]);
  },
  async execute(interaction) {
    if (!interaction.inGuild()) {
      await interaction.reply({
        content: 'Use this command in a server channel.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (!canManageMembers(interaction)) {
      await interaction.reply({
        content: 'You need the Manage Server permission to change party members.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    if (await replyIfChannelBlocked(interaction, 'message')) {
      return;
    }

    const action = interaction.options.getSubcommand(true);
    if (!isMemberAction(action)) {
      await interaction.reply({
        content: 'Choose add, remove, or switch.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const user = interaction.options.getUser('user', true);
    if (user.bot) {
      await interaction.reply({
        content: 'Choose a server member.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const guildId = interaction.guildId;
    const teamValue = interaction.options.getString('team', true);
    const partyValue = action === 'remove' ? null : interaction.options.getString('party', true);
    const mention = `<@${user.id}>`;

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    let touchedBoardId: string | null = null;
    try {
      const change = await commitGuildChange(guildId, () => {
        const planned = applyMemberChange(guildId, action, user.id, mention, teamValue, partyValue);
        if (planned.dirty) {
          touchedBoardId = planned.result.boardId;
        }
        return planned;
      });
      await publishMemberChange(interaction, guildId, change);
    } catch (error) {
      if (!(error instanceof PartySaveError)) {
        throw error;
      }
      console.error('Failed to save a party member change.', error);
      await interaction.editReply({ content: 'I could not save that change. Nothing was kept.' });
      if (touchedBoardId) {
        await repaintSavedBoard(interaction, guildId, touchedBoardId);
      }
    }
  },
};

export default command;

function applyMemberChange(
  guildId: string,
  action: MemberAction,
  userId: string,
  mention: string,
  teamValue: string,
  partyValue: string | null,
): { result: MemberChange; dirty: boolean } {
  const board = resolveBoard(guildId, teamValue);
  if (board === 'ambiguous') {
    return { result: unchangedChange('More than one team has that name. Pick the team from the list.'), dirty: false };
  }
  if (!board) {
    return { result: unchangedChange('That team was not found. Pick it from the list.'), dirty: false };
  }

  if (action === 'remove') {
    return removeFromTeam(guildId, board, userId, mention);
  }

  const party = partyValue ? resolveParty(board, partyValue) : undefined;
  if (party === 'ambiguous') {
    return { result: unchangedChange('More than one party has that name. Pick the party from the list.'), dirty: false };
  }
  if (!party) {
    return { result: unchangedChange(`${board.name} does not have that party.`), dirty: false };
  }

  const update = setMember(guildId, board.id, userId, party.id);
  if (!update.ok) {
    const content =
      update.reason === 'full' ? `${partyLabel(party)} in ${board.name} is full.` : `${board.name} does not have that party.`;
    return { result: unchangedChange(content), dirty: false };
  }
  if (update.unchanged) {
    return { result: unchangedChange(`${mention} is already in ${partyLabel(party)}.`), dirty: false };
  }

  const previous = update.previousPartyId
    ? board.parties.find((entry) => entry.id === update.previousPartyId)
    : undefined;
  const content = previous
    ? `Moved ${mention} from ${partyLabel(previous)} to ${partyLabel(party)} in ${board.name}.`
    : `Added ${mention} to ${partyLabel(party)} in ${board.name}.`;
  return {
    result: {
      content,
      boardId: board.id,
    },
    dirty: true,
  };
}

function removeFromTeam(
  guildId: string,
  board: GuildParties,
  userId: string,
  mention: string,
): { result: MemberChange; dirty: boolean } {
  const partyId = clearMember(guildId, board.id, userId);
  if (!partyId) {
    return { result: unchangedChange(`${mention} is not in ${board.name}.`), dirty: false };
  }

  const party = board.parties.find((entry) => entry.id === partyId);
  const content = party
    ? `Removed ${mention} from ${partyLabel(party)} in ${board.name}.`
    : `Removed ${mention} from ${board.name}.`;
  return {
    result: {
      content,
      boardId: board.id,
    },
    dirty: true,
  };
}

function unchangedChange(content: string): MemberChange {
  return { content, boardId: null };
}

async function publishMemberChange(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  change: MemberChange,
): Promise<void> {
  if (!change.boardId) {
    await interaction.editReply({ content: change.content });
    return;
  }

  const board = getBoard(guildId, change.boardId);
  const message = board ? await fetchBoardMessage(interaction.client, board) : null;
  if (!board || !message) {
    await interaction.editReply({
      content: `${change.content} I could not update the team board message.`,
    });
    return;
  }

  try {
    await queueBoardPaint(guildId, board.id, message);
  } catch (error) {
    console.error('Failed to update the team board.', error);
    change.content += ' I could not update the team board message.';
  }

  await interaction.editReply({ content: change.content });
}

async function repaintSavedBoard(
  interaction: ChatInputCommandInteraction,
  guildId: string,
  boardId: string,
): Promise<void> {
  const board = getBoard(guildId, boardId);
  if (!board) {
    return;
  }
  const message = await fetchBoardMessage(interaction.client, board);
  if (!message) {
    return;
  }
  await queueBoardPaint(guildId, board.id, message).catch((error: unknown) => {
    console.error('Failed to update the team board.', error);
  });
}

function teamChoices(guildId: string, query: string): { name: string; value: string }[] {
  const boards = sortedBoards(guildId);
  const needle = query.trim().toLowerCase();
  return boards
    .filter((board) => board.name.toLowerCase().includes(needle))
    .slice(0, 25)
    .map((board) => ({ name: teamChoiceName(board, boards), value: board.id }));
}

function partyChoices(guildId: string, teamValue: string | null, query: string): { name: string; value: string }[] {
  if (!teamValue) {
    return [];
  }
  const board = resolveBoard(guildId, teamValue);
  if (!board || board === 'ambiguous') {
    return [];
  }

  const needle = query.trim().toLowerCase();
  return board.parties
    .filter((party) => party.name.toLowerCase().includes(needle) || party.emoji.includes(query.trim()))
    .slice(0, 25)
    .map((party) => ({ name: partyLabel(party).slice(0, 100), value: party.id }));
}

function sortedBoards(guildId: string): GuildParties[] {
  return [...listBoards(guildId)].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function teamChoiceName(board: GuildParties, boards: readonly GuildParties[]): string {
  const same = boards.filter((entry) => entry.name === board.name);
  const name = same.length > 1 ? `${board.name} (${same.indexOf(board) + 1})` : board.name;
  const parties = board.parties.length === 1 ? '1 party' : `${board.parties.length} parties`;
  return `${name} · ${parties}`.slice(0, 100);
}

function resolveBoard(guildId: string, raw: string): GuildParties | 'ambiguous' | undefined {
  const boards = listBoards(guildId);
  const byId = boards.find((board) => board.id === raw);
  if (byId) {
    return byId;
  }

  const needle = raw.trim().toLowerCase();
  const byName = boards.filter((board) => board.name.toLowerCase() === needle);
  if (byName.length === 1) {
    return byName[0];
  }
  if (byName.length > 1) {
    return 'ambiguous';
  }
  return undefined;
}

function resolveParty(board: GuildParties, raw: string): Party | 'ambiguous' | undefined {
  const byId = board.parties.find((party) => party.id === raw);
  if (byId) {
    return byId;
  }

  const needle = raw.trim().toLowerCase();
  const byName = board.parties.filter((party) => party.name.toLowerCase() === needle);
  if (byName.length === 1) {
    return byName[0];
  }
  if (byName.length > 1) {
    return 'ambiguous';
  }
  return undefined;
}

function partyLabel(party: Party): string {
  return `${party.emoji} ${party.name}`;
}

function canManageMembers(interaction: ChatInputCommandInteraction | AutocompleteInteraction): boolean {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild) ?? false;
}

function isMemberAction(value: string): value is MemberAction {
  return value === 'add' || value === 'remove' || value === 'switch';
}
