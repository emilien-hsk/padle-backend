import mongoose from 'mongoose';
import Availability, { IAvailability } from '../models/Availability';
import Notification from '../models/Notification';
import Player from '../models/Player';
import { sendPushToPlayer } from './push';

/** Chevauchement minimum pour considérer qu'un match est possible. */
export const MIN_OVERLAP_MIN = 60;

const TZ = 'Europe/Brussels';
const dayFmt = new Intl.DateTimeFormat('fr-BE', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' });
const timeFmt = new Intl.DateTimeFormat('fr-BE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

export function formatRange(start: Date, end: Date): string {
  return `${dayFmt.format(start)} de ${timeFmt.format(start)} à ${timeFmt.format(end)}`;
}

/** Retourne la plage commune de deux créneaux si elle dure au moins MIN_OVERLAP_MIN. */
export function overlap(a: { start: Date; end: Date }, b: { start: Date; end: Date }) {
  const start = new Date(Math.max(a.start.getTime(), b.start.getTime()));
  const end = new Date(Math.min(a.end.getTime(), b.end.getTime()));
  const minutes = (end.getTime() - start.getTime()) / 60000;
  return minutes >= MIN_OVERLAP_MIN ? { start, end, minutes } : null;
}

/** Créneaux d'autres joueurs qui chevauchent suffisamment le créneau donné. */
export async function findOverlapping(av: Pick<IAvailability, 'player' | 'start' | 'end'>) {
  const minMs = MIN_OVERLAP_MIN * 60000;
  const candidates = await Availability.find({
    player: { $ne: av.player },
    start: { $lte: new Date(av.end.getTime() - minMs) },
    end: { $gte: new Date(av.start.getTime() + minMs) },
  }).populate('player', 'username elo isAdmin');

  return candidates
    .map((c) => ({ other: c, common: overlap(av, c) }))
    .filter((x): x is { other: typeof x.other; common: NonNullable<typeof x.common> } =>
      !!x.common && !(x.other.player as unknown as { isAdmin?: boolean })?.isAdmin
    );
}

/**
 * Après l'ajout d'un créneau : prévient chaque joueur déjà disponible en même temps
 * (notification dans l'app + push), et prévient l'auteur des joueurs trouvés.
 */
export async function notifyMatches(av: IAvailability, url = '/partners'): Promise<number> {
  const author = await Player.findById(av.player).select('username');
  if (!author) return 0;

  const matches = await findOverlapping(av);
  if (matches.length === 0) return 0;

  // Un seul message par joueur, même s'il a plusieurs créneaux qui chevauchent
  const byPlayer = new Map<string, (typeof matches)[number]>();
  for (const m of matches) {
    const id = (m.other.player as unknown as { _id: mongoose.Types.ObjectId })._id.toString();
    const prev = byPlayer.get(id);
    if (!prev || m.common.minutes > prev.common.minutes) byPlayer.set(id, m);
  }

  for (const [otherId, m] of byPlayer) {
    const range = formatRange(m.common.start, m.common.end);
    const title = 'Partenaire disponible 🎾';
    const body = `${author.username} est dispo ${range}, comme toi !`;
    await Notification.create({
      player: otherId,
      type: 'availability_match',
      title,
      body,
      url,
      fromPlayer: av.player,
      start: m.common.start,
      end: m.common.end,
    });
    sendPushToPlayer(otherId, { title, body, url, tag: `match-${av._id}` }).catch(() => {});
  }

  // Récapitulatif pour l'auteur
  const names = [...byPlayer.values()].map(
    (m) => (m.other.player as unknown as { username: string }).username
  );
  const first = [...byPlayer.values()][0];
  const title = names.length > 1 ? `${names.length} joueurs dispos en même temps que toi` : 'Partenaire disponible 🎾';
  const body =
    names.length > 1
      ? `${names.slice(0, 3).join(', ')}${names.length > 3 ? '…' : ''} sont dispos sur ton créneau.`
      : `${names[0]} est dispo ${formatRange(first.common.start, first.common.end)}.`;
  await Notification.create({
    player: av.player,
    type: 'availability_match',
    title,
    body,
    url,
    start: av.start,
    end: av.end,
  });
  sendPushToPlayer(av.player, { title, body, url, tag: `match-${av._id}` }).catch(() => {});

  return byPlayer.size;
}
