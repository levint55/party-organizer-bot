import type { MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import { updateBoardMessage } from './board.js';
import { clearMember, getBoardByMessage, getMemberPartyId, setMember, withGuildLock } from './store.js';

export async function handlePartyReactionAdd(
  reactionInput: MessageReaction | PartialMessageReaction,
  userInput: User | PartialUser,
): Promise<void> {
  const resolved = await resolveReaction(reactionInput, userInput);
  if (!resolved || resolved.user.bot) {
    return;
  }

  const { reaction, user } = resolved;
  const guildId = reaction.message.guildId;
  if (!guildId) {
    return;
  }

  const outcome = await withGuildLock(guildId, async () => {
    const guild = getBoardByMessage(guildId, reaction.message.id);
    const party = guild ? partyForReaction(guild, reaction) : undefined;
    if (!guild || !party) {
      return { type: 'ignore' as const };
    }

    const result = setMember(guildId, guild.id, user.id, party.id);
    if (!result.ok) {
      return result.reason === 'full' ? { type: 'full' as const } : { type: 'ignore' as const };
    }
    if (result.unchanged) {
      return { type: 'ignore' as const };
    }

    const previousEmoji = result.previousPartyId
      ? (guild.parties.find((entry) => entry.id === result.previousPartyId)?.emoji ?? null)
      : null;
    await updateBoardMessage(reaction.message, guild);
    return { type: 'joined' as const, previousEmoji };
  });

  if (outcome.type === 'full') {
    await reaction.users.remove(user.id).catch((error: unknown) => {
      console.error('Failed to remove a reaction for a full party.', error);
    });
    return;
  }

  if (outcome.type === 'joined' && outcome.previousEmoji) {
    await removeMemberReaction(reaction.message, outcome.previousEmoji, user.id);
  }
}

export async function handlePartyReactionRemove(
  reactionInput: MessageReaction | PartialMessageReaction,
  userInput: User | PartialUser,
): Promise<void> {
  const resolved = await resolveReaction(reactionInput, userInput);
  if (!resolved || resolved.user.bot) {
    return;
  }

  const { reaction, user } = resolved;
  const guildId = reaction.message.guildId;
  if (!guildId) {
    return;
  }

  await withGuildLock(guildId, async () => {
    const guild = getBoardByMessage(guildId, reaction.message.id);
    const party = guild ? partyForReaction(guild, reaction) : undefined;
    if (!guild || !party || getMemberPartyId(guildId, guild.id, user.id) !== party.id) {
      return;
    }

    clearMember(guildId, guild.id, user.id);
    await updateBoardMessage(reaction.message, guild);
  });
}

async function removeMemberReaction(
  message: MessageReaction['message'],
  emoji: string,
  userId: string,
): Promise<void> {
  try {
    const target = message.partial ? await message.fetch() : message;
    const existing = target.reactions.cache.find((entry) => sameEmoji(entry, emoji));
    if (!existing) {
      return;
    }
    await existing.users.remove(userId);
  } catch (error) {
    console.error('Failed to remove a party reaction.', error);
  }
}

async function resolveReaction(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
): Promise<{ reaction: MessageReaction; user: User } | null> {
  try {
    const fullReaction = reaction.partial ? await reaction.fetch() : reaction;
    if (fullReaction.message.partial) {
      await fullReaction.message.fetch();
    }
    const fullUser = user.partial ? await user.fetch() : user;
    return { reaction: fullReaction, user: fullUser };
  } catch (error) {
    console.error('Failed to fetch a party reaction.', error);
    return null;
  }
}

function partyForReaction(
  guild: NonNullable<ReturnType<typeof getBoardByMessage>>,
  reaction: MessageReaction,
): { id: string; emoji: string } | undefined {
  if (guild.board?.messageId !== reaction.message.id) {
    return undefined;
  }
  return guild.parties.find((entry) => sameEmoji(reaction, entry.emoji));
}

function sameEmoji(reaction: MessageReaction, emoji: string): boolean {
  return reaction.emoji.name === emoji || reaction.emoji.toString() === emoji;
}
