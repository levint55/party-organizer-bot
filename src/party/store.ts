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
let loaded: Promise<void> | null = null;
let database: Firestore | null = null;

export function loadParties(): Promise<void> {
  loaded ??= readStore();
  return loaded;
}

export function getBoardByMessage(guildId: string, messageId: string): GuildParties | undefined {
  return store.guilds[guildId]?.boards.find((board) => board.board?.messageId === messageId);
}

export function listBoards(guildId: string): readonly GuildParties[] {
  return store.guilds[guildId]?.boards ?? [];
}

export function getBoard(guildId: string, boardId: string): GuildParties | undefined {
  return findBoard(guildId, boardId);
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
  return current.partyId;
}

function findBoard(guildId: string, boardId: string): GuildParties | undefined {
  return store.guilds[guildId]?.boards.find((board) => board.id === boardId);
}

export class PartySaveError extends Error {
  constructor() {
    super('Failed to save party data.');
    this.name = 'PartySaveError';
  }
}

interface SaveWaiter {
  rev: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const revisions = new Map<string, number>();
const waiters = new Map<string, SaveWaiter[]>();
const writing = new Set<string>();
const lastSaved = new Map<string, GuildRecord>();
const lastWrittenRev = new Map<string, number>();

export function withGuildLock<T>(guildId: string, action: () => T | Promise<T>): Promise<T> {
  const previous = tails.get(guildId) ?? Promise.resolve();
  const run = previous.then(() => action());
  tails.set(
    guildId,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export async function commitGuildChange<T>(
  guildId: string,
  mutate: () => { result: T; dirty: boolean },
): Promise<T> {
  let saved = Promise.resolve();
  const result = await withGuildLock(guildId, () => {
    const outcome = mutate();
    if (outcome.dirty) {
      saved = saveGuild(guildId);
    }
    return outcome.result;
  });
  await saved;
  return result;
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
  rememberSavedGuilds();
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
    rememberSavedGuilds();
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    if (!missing) {
      throw error;
    }
  }
}

function saveGuild(guildId: string): Promise<void> {
  const rev = (revisions.get(guildId) ?? 0) + 1;
  revisions.set(guildId, rev);
  return new Promise((resolve, reject) => {
    const list = waiters.get(guildId) ?? [];
    list.push({ rev, resolve, reject });
    waiters.set(guildId, list);
    void pumpSaves(guildId);
  });
}

async function pumpSaves(guildId: string): Promise<void> {
  if (writing.has(guildId)) {
    return;
  }
  writing.add(guildId);
  try {
    while ((waiters.get(guildId)?.length ?? 0) > 0) {
      const captured = await withGuildLock(guildId, () => ({
        rev: revisions.get(guildId) ?? 0,
        snapshot: structuredClone(store.guilds[guildId]),
      }));
      if (!captured.snapshot) {
        settleThrough(guildId, captured.rev, new PartySaveError());
        continue;
      }

      try {
        await writeSnapshot(guildId, captured.snapshot);
        if ((lastWrittenRev.get(guildId) ?? 0) <= captured.rev) {
          lastSaved.set(guildId, captured.snapshot);
          lastWrittenRev.set(guildId, captured.rev);
        }
        settleThrough(guildId, captured.rev);
      } catch (error) {
        console.error('Failed to save party data to Firestore.', error);
        await withGuildLock(guildId, () => {
          if ((revisions.get(guildId) ?? 0) !== captured.rev) {
            return;
          }
          const saved = lastSaved.get(guildId);
          if (saved) {
            store.guilds[guildId] = structuredClone(saved);
          } else {
            delete store.guilds[guildId];
          }
          settleThrough(guildId, captured.rev, new PartySaveError());
        });
      }
    }
  } finally {
    writing.delete(guildId);
    if ((waiters.get(guildId)?.length ?? 0) > 0) {
      void pumpSaves(guildId);
    }
  }
}

async function writeSnapshot(guildId: string, snapshot: GuildRecord): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await firestore().collection('guilds').doc(guildId).set(snapshot);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await delay(200 * attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new PartySaveError();
}

function settleThrough(guildId: string, rev: number, error?: unknown): void {
  const list = waiters.get(guildId) ?? [];
  const keep: SaveWaiter[] = [];
  for (const waiter of list) {
    if (waiter.rev <= rev) {
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve();
      }
    } else {
      keep.push(waiter);
    }
  }
  if (keep.length > 0) {
    waiters.set(guildId, keep);
  } else {
    waiters.delete(guildId);
  }
}

function rememberSavedGuilds(): void {
  lastSaved.clear();
  lastWrittenRev.clear();
  for (const [guildId, record] of Object.entries(store.guilds)) {
    lastSaved.set(guildId, structuredClone(record));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function loadServiceAccount(): ServiceAccount {
  const inline = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (inline) {
    try {
      return JSON.parse(inline) as ServiceAccount;
    } catch {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.');
    }
  }

  const keyPath = requireEnv('FIREBASE_SERVICE_ACCOUNT');
  return JSON.parse(readFileSync(keyPath, 'utf8')) as ServiceAccount;
}

function firestore(): Firestore {
  if (database) {
    return database;
  }

  const projectId = requireEnv('FIREBASE_PROJECT_ID');
  const serviceAccount = loadServiceAccount();
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
