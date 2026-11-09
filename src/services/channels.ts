import mongoose from 'mongoose';
import Channel, { IChannel } from '../models/Channel';
import Message from '../models/Message';
import Player from '../models/Player';
import { IAvailability } from '../models/Availability';
import { findOverlapping, formatRange, MIN_OVERLAP_MIN } from './availabilityMatch';
import { sendPushToPlayer } from './push';

const KEEP_AFTER_END_MS = 24 * 3600 * 1000;
export const MESSAGE_PUSH_COOLDOWN_MS = 3 * 60 * 1000;

type Id = mongoose.Types.ObjectId;

export function channelUrl(id: Id | string): string {
  return `/channels/${id}`;
}

export async function postSystemMessage(channel: IChannel, text: string) {
  await Message.create({ channel: channel._id, kind: 'system', text, expiresAt: channel.expiresAt });
  channel.lastMessageAt = new Date();
}

/**
 * Rattache une nouvelle dispo à un canal :
 * - rejoint le canal existant des joueurs avec qui elle chevauche (≥ 1 h),
 * - sinon crée un canal avec ces joueurs.
 * Retourne le canal (ou null si personne n'est dispo en même temps).
 */
export async function attachToChannel(av: IAvailability): Promise<IChannel | null> {
  const matches = await findOverlapping(av);
  if (matches.length === 0) return null;

  const playerOf = (m: (typeof matches)[number]) =>
    (m.other.player as unknown as { _id: Id })._id;
  const otherIds = matches.map(playerOf);
  const commonStart = new Date(Math.min(...matches.map((m) => m.common.start.getTime())));
  const commonEnd = new Date(Math.max(...matches.map((m) => m.common.end.getTime())));
  const minMs = MIN_OVERLAP_MIN * 60000;

  // Canal existant sur la même plage avec au moins un de ces joueurs
  const candidates = await Channel.find({
    members: { $in: otherIds },
    start: { $lte: new Date(commonEnd.getTime() - minMs) },
    end: { $gte: new Date(commonStart.getTime() + minMs) },
    expiresAt: { $gt: new Date() },
  });
  const score = (c: IChannel) =>
    Math.min(c.end.getTime(), commonEnd.getTime()) - Math.max(c.start.getTime(), commonStart.getTime());
  let channel = candidates.sort((a, b) => score(b) - score(a))[0] ?? null;

  const author = await Player.findById(av.player).select('username');
  const name = author?.username ?? 'Un joueur';

  if (!channel) {
    const members = [av.player, ...otherIds.filter((id, i) => otherIds.findIndex((x) => x.equals(id)) === i)];
    channel = await Channel.create({
      members,
      availabilities: [av._id, ...matches.map((m) => m.other._id)],
      start: commonStart,
      end: commonEnd,
      expiresAt: new Date(commonEnd.getTime() + KEEP_AFTER_END_MS),
    });
    await postSystemMessage(
      channel,
      `Canal ouvert : ${members.length} joueurs dispos ${formatRange(commonStart, commonEnd)}. Proposez un horaire !`
    );
  } else {
    const isNewMember = !channel.members.some((m) => m.equals(av.player));
    for (const id of [av.player, ...otherIds]) {
      if (!channel.members.some((m) => m.equals(id))) channel.members.push(id);
    }
    for (const id of [av._id, ...matches.map((m) => m.other._id)]) {
      if (!channel.availabilities.some((a) => a.equals(id as Id))) channel.availabilities.push(id as Id);
    }
    if (commonStart < channel.start) channel.start = commonStart;
    if (commonEnd > channel.end) {
      channel.end = commonEnd;
      channel.expiresAt = new Date(commonEnd.getTime() + KEEP_AFTER_END_MS);
    }
    await postSystemMessage(
      channel,
      isNewMember
        ? `${name} a rejoint le canal (dispo ${formatRange(av.start, av.end)}).`
        : `${name} a ajouté une dispo ${formatRange(av.start, av.end)}.`
    );
  }
  await channel.save();
  return channel;
}

/** Retire une dispo supprimée de son canal ; ferme le canal s'il reste moins de 2 joueurs. */
export async function detachFromChannels(av: IAvailability): Promise<void> {
  const channels = await Channel.find({ availabilities: av._id });
  const player = await Player.findById(av.player).select('username');

  for (const channel of channels) {
    channel.availabilities = channel.availabilities.filter((a) => !a.equals(av._id as Id));
    // Le joueur reste membre s'il a encore une autre dispo dans ce canal
    const AvailabilityModel = mongoose.model('Availability');
    const stillThere = await AvailabilityModel.exists({
      _id: { $in: channel.availabilities },
      player: av.player,
    });
    if (!stillThere) {
      channel.members = channel.members.filter((m) => !m.equals(av.player));
    }

    if (channel.members.length < 2) {
      await Message.deleteMany({ channel: channel._id });
      await channel.deleteOne();
      continue;
    }
    if (!stillThere) await postSystemMessage(channel, `${player?.username ?? 'Un joueur'} n'est plus dispo et a quitté le canal.`);
    await channel.save();
  }
}

/** Push aux autres membres, avec un délai minimum entre deux push par joueur (sauf `force`). */
export async function pushToChannel(
  channel: IChannel,
  fromPlayer: Id | string,
  payload: { title: string; body: string },
  force = false
): Promise<void> {
  const now = Date.now();
  let changed = false;
  for (const member of channel.members) {
    if (member.equals(fromPlayer)) continue;
    const key = member.toString();
    const last = channel.lastPush.get(key)?.getTime() ?? 0;
    if (!force && now - last < MESSAGE_PUSH_COOLDOWN_MS) continue;
    channel.lastPush.set(key, new Date(now));
    changed = true;
    sendPushToPlayer(member, { ...payload, url: channelUrl(channel._id as Id), tag: `channel-${channel._id}` }).catch(() => {});
  }
  if (changed) await channel.save();
}
