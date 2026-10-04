import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cert, getApps, initializeApp, type ServiceAccount } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';
import { requireEnv } from '../config.js';
import { MAX_MEMBERS_PER_PARTY, MAX_PARTY_COUNT, PARTY_EMOJIS } from './emojis.js';

export interface Party {
  id: string;
  name: string;
  emoji: string;
}

export interface PartyBoard {
  channelId: string;
  messageId: string;
}

export type PartyRole = 'dps' | 'tank' | 'healer' | 'support';

export interface PartyMember {
  partyId: string;
  role: PartyRole | null;
}

export interface GuildParties {
  id: string;
  name: string;
  maxMembers: number;
  parties: Party[];
  members: Record<string, PartyMember>;
  board: PartyBoard | null;
}

interface GuildRecord {
  boards: GuildParties[];
}

interface StoreFile {
  guilds: Record<string, GuildRecord>;
}

export type SetMemberResult =
  | { ok: true; unchanged: true }
  | { ok: true; unchanged: false; previousPartyId: string | null }
  | { ok: false; reason: 'full' | 'unknown-party' };

const dataDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data');
const dataFile = path.join(dataDir, 'parties.json');

const store: StoreFile = { guilds: {} };
const tails = new Map<string, Promise<void>>();
let writeQueue: Promise<void> = Promise.resolve();
let loaded: Promise<void> | null = null;
let database: Firestore | null = null;

export function loadParties(): Promise<void> {
  loaded ??= readStore();
  return loaded;
}

export function getBoardByMessage(guildId: string, messageId: string): GuildParties | undefined {
  return store.guilds[guildId]?.boards.find((board) => board.board?.messageId === messageId);
}

export function getMemberPartyId(guildId: string, boardId: string, userId: string): string | null {
  return findBoard(guildId, boardId)?.members[userId]?.partyId ?? null;
}

export function buildGuild(partyCount: number, name: string): GuildParties {
  const teamName = name.trim().replace(/\s+/g, ' ');
  if (!teamName) {
    throw new RangeError('Team name is required.');
  }
  if (partyCount < 1 || partyCount > MAX_PARTY_COUNT) {
    throw new RangeError(`Party count must be from 1 to ${MAX_PARTY_COUNT}.`);
  }

  return {
    id: randomUUID(),
    name: teamName,
    maxMembers: MAX_MEMBERS_PER_PARTY,
    parties: Array.from({ length: partyCount }, (_, index) => {
      const emoji = PARTY_EMOJIS[index];
      if (!emoji) {
        throw new RangeError(`Party count must be from 1 to ${MAX_PARTY_COUNT}.`);
      }
      return {
        id: `party-${index + 1}`,
        name: `Party ${index + 1}`,
        emoji,
      };
    }),
    members: {},
    board: null,
  };
}

export function addBoard(guildId: string, board: GuildParties): void {
  const guild = store.guilds[guildId] ?? { boards: [] };
  guild.boards.push(board);
  store.guilds[guildId] = guild;
  persistGuild(guildId);
}

export function setMember(guildId: string, boardId: string, userId: string, partyId: string): SetMemberResult {
  const guild = findBoard(guildId, boardId);
  const party = guild?.parties.find((entry) => entry.id === partyId);
  if (!guild || !party) {
    return { ok: false, reason: 'unknown-party' };
  }

  const current = guild.members[userId] ?? null;
  if (current?.partyId === partyId) {
    return { ok: true, unchanged: true };
  }

  const count = Object.values(guild.members).filter((member) => member.partyId === partyId).length;
  if (count >= guild.maxMembers) {
    return { ok: false, reason: 'full' };
  }

  guild.members[userId] = { partyId, role: current?.role ?? null };
  persistGuild(guildId);
  return { ok: true, unchanged: false, previousPartyId: current?.partyId ?? null };
}

export function setMemberRole(
  guildId: string,
  boardId: string,
  userId: string,
  role: PartyRole,
): { ok: true; unchanged: boolean } | { ok: false; reason: 'not-in-party' } {
  const guild = findBoard(guildId, boardId);
  const current = guild?.members[userId];
  if (!guild || !current) {
    return { ok: false, reason: 'not-in-party' };
  }
  if (current.role === role) {
    return { ok: true, unchanged: true };
  }

  current.role = role;
  persistGuild(guildId);
  return { ok: true, unchanged: false };
}

export function clearMember(guildId: string, boardId: string, userId: string): string | null {
  const guild = findBoard(guildId, boardId);
  if (!guild) {
    return null;
  }

  const current = guild.members[userId] ?? null;
  if (!current) {
    return null;
  }

  delete guild.members[userId];
  persistGuild(guildId);
  return current.partyId;
}

function findBoard(guildId: string, boardId: string): GuildParties | undefined {
  return store.guilds[guildId]?.boards.find((board) => board.id === boardId);
}

export function withGuildLock<T>(guildId: string, action: () => Promise<T>): Promise<T> {
  const previous = tails.get(guildId) ?? Promise.resolve();
  const run = previous.then(action);
  tails.set(
    guildId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function readStore(): Promise<void> {
  const snapshot = await firestore().collection('guilds').get();
  if (snapshot.empty) {
    await importLocalParties();
    return;
  }

  const guilds: Record<string, GuildRecord> = {};
  snapshot.forEach((doc) => {
    guilds[doc.id] = { boards: normalizeBoards(doc.data()) };
  });
  store.guilds = guilds;
}

async function importLocalParties(): Promise<void> {
  try {
    const raw = await readFile(dataFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isStoreFile(parsed)) {
      return;
    }
    store.guilds = normalizeGuilds(parsed.guilds);
    for (const guildId of Object.keys(store.guilds)) {
      await firestore().collection('guilds').doc(guildId).set(store.guilds[guildId] ?? { boards: [] });
    }
    console.log(`Imported ${Object.keys(store.guilds).length} server(s) from data/parties.json into Firestore.`);
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    if (!missing) {
      throw error;
    }
  }
}

function persistGuild(guildId: string): void {
  const snapshot = structuredClone(store.guilds[guildId]);
  if (!snapshot) {
    return;
  }
  writeQueue = writeQueue
    .then(async () => {
      await firestore().collection('guilds').doc(guildId).set(snapshot);
    })
    .catch((error: unknown) => {
      console.error('Failed to save party data to Firestore.', error);
    });
}

function firestore(): Firestore {
  if (database) {
    return database;
  }

  const projectId = requireEnv('FIREBASE_PROJECT_ID');
  const keyPath = requireEnv('FIREBASE_SERVICE_ACCOUNT');
  const serviceAccount = JSON.parse(readFileSync(keyPath, 'utf8')) as ServiceAccount;
  if (getApps().length === 0) {
    initializeApp({ credential: cert(serviceAccount), projectId });
  }
  database = getFirestore();
  return database;
}

function isStoreFile(value: unknown): value is { guilds: Record<string, unknown> } {
  if (typeof value !== 'object' || value === null || !('guilds' in value)) {
    return false;
  }
  return typeof value.guilds === 'object' && value.guilds !== null;
}

function normalizeGuilds(guilds: Record<string, unknown>): Record<string, GuildRecord> {
  const normalized: Record<string, GuildRecord> = {};
  for (const [guildId, value] of Object.entries(guilds)) {
    normalized[guildId] = { boards: normalizeBoards(value) };
  }
  return normalized;
}

function normalizeBoards(value: unknown): GuildParties[] {
  if (typeof value !== 'object' || value === null) {
    return [];
  }
  if ('boards' in value && Array.isArray(value.boards)) {
    return value.boards.flatMap((board) => {
      const normalized = normalizeBoard(board);
      return normalized ? [normalized] : [];
    });
  }
  const single = normalizeBoard(value);
  return single ? [single] : [];
}

function normalizeBoard(value: unknown): GuildParties | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const guild = value as Partial<GuildParties> & { members?: unknown };
  if (!Array.isArray(guild.parties) || typeof guild.maxMembers !== 'number') {
    return null;
  }

  return {
    id: typeof guild.id === 'string' ? guild.id : randomUUID(),
    name: typeof guild.name === 'string' && guild.name.trim() ? guild.name.trim() : 'Team',
    maxMembers: guild.maxMembers,
    parties: guild.parties,
    members: normalizeMembers(guild.members),
    board: guild.board ?? null,
  };
}

function normalizeMembers(members: unknown): Record<string, PartyMember> {
  if (typeof members !== 'object' || members === null) {
    return {};
  }

  const normalized: Record<string, PartyMember> = {};
  for (const [userId, value] of Object.entries(members)) {
    if (typeof value === 'string') {
      normalized[userId] = { partyId: value, role: null };
      continue;
    }
    if (typeof value !== 'object' || value === null || !('partyId' in value) || typeof value.partyId !== 'string') {
      continue;
    }
    const role = 'role' in value && isPartyRole(value.role) ? value.role : null;
    normalized[userId] = { partyId: value.partyId, role };
  }
  return normalized;
}

export function isPartyRole(value: unknown): value is PartyRole {
  return value === 'dps' || value === 'tank' || value === 'healer' || value === 'support';
}
