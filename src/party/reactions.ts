import type { MessageReaction, PartialMessageReaction, PartialUser, User } from 'discord.js';
import { queueBoardPaint } from './board.js';
import {
  clearMember,
  commitGuildChange,
  getBoardByMessage,
  getMemberPartyId,
  PartySaveError,
  setMember,
  withGuildLock,
  type GuildParties,
} from './store.js';

export interface ReactionCleanup {
  guildId: string;
  boardId: string;
  partyId: string;
}

const pendingRemovals = new Map<string, NodeJS.Timeout>();

type JoinResult =
  | { type: 'ignore' }
  | { type: 'full'; emoji: string; partyId: string; boardId: string }
  | { type: 'joined'; previousEmoji: string | null; previousPartyId: string | null; boardId: string };

type LeaveResult = { type: 'ignore' } | { type: 'left'; boardId: string };

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

  const rollbackJoin: { current: (ReactionCleanup & { emoji: string }) | null } = { current: null };
  try {
    const outcome = await commitGuildChange(guildId, (): { result: JoinResult; dirty: boolean } => {
      const guild = getBoardByMessage(guildId, reaction.message.id);
      const party = guild ? partyForReaction(guild, reaction) : undefined;
      if (!guild || !party) {
        return { result: { type: 'ignore' as const }, dirty: false };
      }

      const result = setMember(guildId, guild.id, user.id, party.id);
      if (!result.ok) {
        return {
          result:
            result.reason === 'full'
              ? { type: 'full' as const, emoji: party.emoji, partyId: party.id, boardId: guild.id }
              : { type: 'ignore' as const },
          dirty: false,
        };
      }
      if (result.unchanged) {
        return { result: { type: 'ignore' as const }, dirty: false };
      }

      rollbackJoin.current = { guildId, boardId: guild.id, partyId: party.id, emoji: party.emoji };
      const previousEmoji = result.previousPartyId
        ? (guild.parties.find((entry) => entry.id === result.previousPartyId)?.emoji ?? null)
        : null;
      return {
        result: {
          type: 'joined' as const,
          previousEmoji,
          previousPartyId: result.previousPartyId,
          boardId: guild.id,
        },
        dirty: true,
      };
    });

    if (outcome.type === 'full') {
      await removeMemberPartyReaction(reaction.message, outcome.emoji, user.id, {
        guildId,
        boardId: outcome.boardId,
        partyId: outcome.partyId,
      });
      return;
    }

    if (outcome.type !== 'joined') {
      return;
    }

    try {
      await queueBoardPaint(guildId, outcome.boardId, reaction.message);
    } catch (error) {
      console.error('Failed to update the team board.', error);
    }

    if (outcome.previousEmoji && outcome.previousPartyId) {
      await removeMemberPartyReaction(reaction.message, outcome.previousEmoji, user.id, {
        guildId,
        boardId: outcome.boardId,
        partyId: outcome.previousPartyId,
      });
    }
  } catch (error) {
    if (!(error instanceof PartySaveError)) {
      throw error;
    }
    console.error('Failed to save a party join.', error);
    if (rollbackJoin.current) {
      await removeMemberPartyReaction(reaction.message, rollbackJoin.current.emoji, user.id, rollbackJoin.current);
    }
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

  try {
    const outcome = await commitGuildChange(guildId, (): { result: LeaveResult; dirty: boolean } => {
      const guild = getBoardByMessage(guildId, reaction.message.id);
      const party = guild ? partyForReaction(guild, reaction) : undefined;
      if (!guild || !party || consumeBotRemoval(reaction.message.id, party.id, user.id)) {
        return { result: { type: 'ignore' as const }, dirty: false };
      }
      if (getMemberPartyId(guildId, guild.id, user.id) !== party.id) {
        return { result: { type: 'ignore' as const }, dirty: false };
      }

      clearMember(guildId, guild.id, user.id);
      return { result: { type: 'left' as const, boardId: guild.id }, dirty: true };
    });

    if (outcome.type !== 'left') {
      return;
    }

    try {
      await queueBoardPaint(guildId, outcome.boardId, reaction.message);
    } catch (error) {
      console.error('Failed to update the team board.', error);
    }
  } catch (error) {
    if (!(error instanceof PartySaveError)) {
      throw error;
    }
    console.error('Failed to save a party leave.', error);
    const guild = getBoardByMessage(guildId, reaction.message.id);
    if (!guild) {
      return;
    }
    await queueBoardPaint(guildId, guild.id, reaction.message).catch((paintError: unknown) => {
      console.error('Failed to update the team board.', paintError);
    });
  }
}

export async function removeMemberPartyReaction(
  message: MessageReaction['message'],
  emoji: string,
  userId: string,
  cleanup: ReactionCleanup,
): Promise<'removed' | 'absent' | 'failed'> {
  try {
    const target = await message.fetch();
    let existing = target.reactions.cache.find((entry) => sameEmoji(entry, emoji));
    if (!existing) {
      const fresh = await target.fetch(true);
      existing = fresh.reactions.cache.find((entry) => sameEmoji(entry, emoji));
    }
    if (!existing) {
      return 'absent';
    }
    if (!existing.users.cache.has(userId)) {
      const reactors = await existing.users.fetch();
      if (!reactors.has(userId)) {
        return 'absent';
      }
    }

    const stillInParty = await memberStillInParty(cleanup, userId);
    if (stillInParty) {
      return 'absent';
    }

    expectBotRemoval(target.id, cleanup.partyId, userId);
    await existing.users.remove(userId);
    return 'removed';
  } catch (error) {
    console.error('Failed to remove a party reaction.', error);
    return 'failed';
  }
}

function memberStillInParty(cleanup: ReactionCleanup, userId: string): Promise<boolean> {
  return withGuildLock(
    cleanup.guildId,
    () => getMemberPartyId(cleanup.guildId, cleanup.boardId, userId) === cleanup.partyId,
  );
}

function expectBotRemoval(messageId: string, partyId: string, userId: string): void {
  const key = removalKey(messageId, partyId, userId);
  const existing = pendingRemovals.get(key);
  if (existing) {
    clearTimeout(existing);
  }
  const timer = setTimeout(() => pendingRemovals.delete(key), 30_000);
  timer.unref?.();
  pendingRemovals.set(key, timer);
}

function consumeBotRemoval(messageId: string, partyId: string, userId: string): boolean {
  const key = removalKey(messageId, partyId, userId);
  const timer = pendingRemovals.get(key);
  if (!timer) {
    return false;
  }
  clearTimeout(timer);
  pendingRemovals.delete(key);
  return true;
}

function removalKey(messageId: string, partyId: string, userId: string): string {
  return `${messageId}:${partyId}:${userId}`;
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
  guild: GuildParties,
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
