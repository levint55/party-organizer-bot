import { existsSync } from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts, loadImage, type Image } from '@napi-rs/canvas';
import type { GuildParties, PartyRole } from './store.js';

export interface MemberProfile {
  name: string;
  avatarUrl: string | null;
  role?: PartyRole | null;
}

const FONT = registerFont();

export async function renderPartyGrid(
  guild: GuildParties,
  profiles: ReadonlyMap<string, MemberProfile>,
): Promise<Buffer> {
  const avatars = new Map<string, Image>();
  await Promise.all(
    [...profiles.entries()].map(async ([userId, profile]) => {
      if (!profile.avatarUrl) {
        return;
      }
      const avatar = await loadAvatar(profile.avatarUrl);
      if (avatar) {
        avatars.set(userId, avatar);
      }
    }),
  );

  return drawGrid(guild, profiles, avatars);
}

function drawGrid(
  guild: GuildParties,
  profiles: ReadonlyMap<string, MemberProfile>,
  avatars: ReadonlyMap<string, Image>,
): Buffer {
  const columns = Math.max(guild.parties.length, 1);
  const rows = Math.max(guild.maxMembers, 1);
  const pad = 22;
  const gap = 10;
  const titleH = 48;
  const headerH = 40;
  const slotW = columns <= 8 ? 168 : Math.max(104, Math.floor(1480 / columns));
  const slotH = rows <= 6 ? 86 : rows <= 12 ? 68 : 52;
  const width = pad * 2 + columns * slotW + (columns - 1) * gap;
  const height = pad * 2 + titleH + headerH + rows * slotH + rows * gap;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0, '#6f93ab');
  sky.addColorStop(0.45, '#3f6b78');
  sky.addColorStop(1, '#243e52');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  ctx.fillStyle = '#f7f9fb';
  ctx.font = `700 28px ${FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(fitText(ctx, guild.name, width - pad * 2), width / 2, pad + titleH / 2);

  guild.parties.forEach((party, column) => {
    const x = pad + column * (slotW + gap);
    ctx.fillStyle = '#f7f9fb';
    ctx.font = `600 20px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(party.name, x + slotW / 2, pad + titleH + headerH / 2);

    const members = memberIds(guild, party.id);
    for (let row = 0; row < rows; row += 1) {
      const y = pad + titleH + headerH + gap + row * (slotH + gap);
      drawSlot(ctx, x, y, slotW, slotH, slotContent(members, row, guild.maxMembers), profiles, avatars);
    }
  });

  return canvas.toBuffer('image/png');
}

function slotContent(members: string[], row: number, maxMembers: number): string | 'plus' | 'empty' {
  if (row < members.length) {
    return members[row] ?? 'empty';
  }
  if (row === members.length && members.length < maxMembers) {
    return 'plus';
  }
  return 'empty';
}

function drawSlot(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  x: number,
  y: number,
  width: number,
  height: number,
  content: string | 'plus' | 'empty',
  profiles: ReadonlyMap<string, MemberProfile>,
  avatars: ReadonlyMap<string, Image>,
): void {
  ctx.fillStyle = 'rgba(16, 28, 48, 0.34)';
  roundRect(ctx, x, y, width, height, 10);
  ctx.fill();

  if (content === 'empty') {
    return;
  }

  if (content === 'plus') {
    const size = Math.min(42, height - 28);
    const plusX = x + (width - size) / 2;
    const plusY = y + (height - size) / 2;
    ctx.fillStyle = 'rgba(255, 255, 255, 0.14)';
    roundRect(ctx, plusX, plusY, size, size, 10);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = `500 ${Math.round(size * 0.86)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('+', plusX + size / 2, plusY + size / 2 + 1);
    return;
  }

  const profile = profiles.get(content);
  const inset = 7;
  ctx.fillStyle = roleColor(profile?.role ?? null);
  roundRect(ctx, x + inset, y + inset, width - inset * 2, height - inset * 2, 8);
  ctx.fill();

  const avatarSize = Math.min(36, height - inset * 2 - 12);
  const avatarX = x + inset + 8;
  const avatarY = y + (height - avatarSize) / 2;
  const avatar = avatars.get(content);
  ctx.save();
  ctx.beginPath();
  ctx.arc(avatarX + avatarSize / 2, avatarY + avatarSize / 2, avatarSize / 2, 0, Math.PI * 2);
  ctx.clip();
  if (avatar) {
    ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
  } else {
    ctx.fillStyle = '#8ea36a';
    ctx.fillRect(avatarX, avatarY, avatarSize, avatarSize);
    ctx.fillStyle = '#243018';
    ctx.font = `600 ${Math.round(avatarSize * 0.46)}px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(initial(profile?.name ?? 'Member'), avatarX + avatarSize / 2, avatarY + avatarSize / 2);
  }
  ctx.restore();

  const nameX = avatarX + avatarSize + 8;
  const nameWidth = x + width - inset - 8 - nameX;
  const role = roleLabel(profile?.role ?? null);
  ctx.fillStyle = '#243018';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  if (role && height >= 74) {
    ctx.font = `600 15px ${FONT}`;
    ctx.fillText(fitText(ctx, profile?.name ?? 'Member', nameWidth), nameX, y + height / 2 - 9);
    ctx.font = `600 12px ${FONT}`;
    ctx.fillText(role, nameX, y + height / 2 + 10);
    return;
  }

  ctx.font = `600 15px ${FONT}`;
  const label = role ? `${profile?.name ?? 'Member'} · ${role}` : (profile?.name ?? 'Member');
  ctx.fillText(fitText(ctx, label, nameWidth), nameX, y + height / 2);
}

function memberIds(guild: GuildParties, partyId: string): string[] {
  return Object.entries(guild.members)
    .filter(([, member]) => member.partyId === partyId)
    .map(([userId]) => userId);
}

function roleColor(role: PartyRole | null): string {
  if (role === 'dps') {
    return '#f3c1b4';
  }
  if (role === 'tank') {
    return '#b9d6f2';
  }
  if (role === 'healer') {
    return '#d5e3a6';
  }
  if (role === 'support') {
    return '#d7c4f2';
  }
  return '#e4e4dc';
}

function roleLabel(role: PartyRole | null): string {
  if (role === 'dps') {
    return 'DPS';
  }
  if (role === 'tank') {
    return 'Tank';
  }
  if (role === 'healer') {
    return 'Healer';
  }
  if (role === 'support') {
    return 'Support';
  }
  return '';
}

function initial(name: string): string {
  return [...name][0]?.toUpperCase() ?? '?';
}

function fitText(ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) {
    return text;
  }
  let trimmed = text;
  while (trimmed.length > 1 && ctx.measureText(`${trimmed}…`).width > maxWidth) {
    trimmed = trimmed.slice(0, -1);
  }
  return `${trimmed}…`;
}

function roundRect(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

async function loadAvatar(url: string): Promise<Image | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }
    return await loadImage(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  }
}

function registerFont(): string {
  const fonts = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'Fonts');
  const bold = path.join(fonts, 'segoeuib.ttf');
  const regular = path.join(fonts, 'segoeui.ttf');
  if (existsSync(bold) && GlobalFonts.registerFromPath(bold, 'Party')) {
    return 'Party';
  }
  if (existsSync(regular) && GlobalFonts.registerFromPath(regular, 'Party')) {
    return 'Party';
  }
  return 'sans-serif';
}
