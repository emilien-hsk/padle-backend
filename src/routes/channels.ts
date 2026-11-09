import { Router, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import Channel, { IChannel } from '../models/Channel';
import Message from '../models/Message';
import Player from '../models/Player';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { pushToChannel, postSystemMessage } from '../services/channels';
import { COURTS, slotBookingUrl } from '../config/club';
import { sendDueScorePrompts } from '../services/scorePrompts';

const router = Router();
router.use(authMiddleware);

interface ChannelRequest extends AuthRequest {
  channel?: IChannel;
}

const TZ = 'Europe/Brussels';
const timeFmt = new Intl.DateTimeFormat('fr-BE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const dayFmt = new Intl.DateTimeFormat('fr-BE', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });

// Vérifie que le canal existe et que le joueur en fait partie
async function loadChannel(req: ChannelRequest, res: Response, next: NextFunction): Promise<void> {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(404).json({ message: 'Canal introuvable' });
    return;
  }
  const channel = await Channel.findById(req.params.id);
  if (!channel || channel.expiresAt < new Date()) {
    res.status(404).json({ message: 'Ce canal est fermé' });
    return;
  }
  if (!channel.members.some((m) => m.equals(req.playerId))) {
    res.status(403).json({ message: "Tu ne fais pas partie de ce canal" });
    return;
  }
  req.channel = channel;
  next();
}

async function playerName(id: string): Promise<string> {
  return (await Player.findById(id).select('username'))?.username ?? 'Un joueur';
}

// GET /api/channels — mes canaux actifs + messages non lus
router.get('/', async (req: AuthRequest, res: Response): Promise<void> => {
  // Le serveur gratuit peut s'endormir : on rattrape les messages de score en retard
  await sendDueScorePrompts();
  const channels = await Channel.find({ members: req.playerId, expiresAt: { $gt: new Date() } })
    .sort({ start: 1 })
    .populate('members', 'username elo');

  const result = await Promise.all(
    channels.map(async (c) => {
      const lastRead = c.reads.get(req.playerId!) ?? new Date(0);
      const [unread, last, confirmed] = await Promise.all([
        Message.countDocuments({ channel: c._id, createdAt: { $gt: lastRead }, author: { $ne: req.playerId } }),
        Message.findOne({ channel: c._id }).sort({ createdAt: -1 }).populate('author', 'username'),
        Message.findOne({
          channel: c._id,
          kind: 'proposal',
          'proposal.status': 'confirmed',
          'proposal.start': { $gt: new Date(Date.now() - 2 * 3600 * 1000) },
        }).sort({ 'proposal.start': 1 }),
      ]);
      return {
        _id: c._id,
        start: c.start,
        end: c.end,
        members: c.members,
        unread,
        nextMatch: confirmed?.proposal
          ? {
              start: confirmed.proposal.start,
              duration: confirmed.proposal.duration,
              courtNumber: confirmed.proposal.courtNumber,
              courtName: confirmed.proposal.courtName,
              bookingUrl: confirmed.proposal.bookingUrl,
            }
          : null,
        lastMessage: last
          ? {
              text: last.kind === 'proposal' ? 'Nouvelle proposition d’horaire'
                : last.kind === 'score_prompt' ? '🎾 Match terminé : ajoute le score'
                : last.text,
              author: last.author,
              createdAt: last.createdAt,
            }
          : null,
      };
    })
  );
  res.json(result);
});

// GET /api/channels/unread — total de messages non lus (badge)
router.get('/unread', async (req: AuthRequest, res: Response): Promise<void> => {
  const channels = await Channel.find({ members: req.playerId, expiresAt: { $gt: new Date() } }).select('reads');
  let total = 0;
  for (const c of channels) {
    const lastRead = c.reads.get(req.playerId!) ?? new Date(0);
    total += await Message.countDocuments({ channel: c._id, createdAt: { $gt: lastRead }, author: { $ne: req.playerId } });
  }
  res.json({ unread: total });
});

// GET /api/channels/:id — infos + messages (marque comme lu)
router.get('/:id', loadChannel, async (req: ChannelRequest, res: Response): Promise<void> => {
  const channel = req.channel!;
  await sendDueScorePrompts();
  await channel.populate('members', 'username elo');
  const messages = await Message.find({ channel: channel._id })
    .sort({ createdAt: 1 })
    .limit(300)
    .populate('author', 'username');

  channel.reads.set(req.playerId!, new Date());
  await Channel.updateOne({ _id: channel._id }, { $set: { [`reads.${req.playerId}`]: new Date() } });

  res.json({
    _id: channel._id,
    start: channel.start,
    end: channel.end,
    expiresAt: channel.expiresAt,
    members: channel.members,
    messages,
  });
});

// POST /api/channels/:id/messages { text }
router.post('/:id/messages', loadChannel, async (req: ChannelRequest, res: Response): Promise<void> => {
  const text = String(req.body?.text ?? '').trim();
  if (!text) {
    res.status(400).json({ message: 'Message vide' });
    return;
  }
  if (text.length > 500) {
    res.status(400).json({ message: 'Message trop long (500 caractères max)' });
    return;
  }
  const channel = req.channel!;
  const msg = await Message.create({
    channel: channel._id,
    author: req.playerId,
    kind: 'text',
    text,
    expiresAt: channel.expiresAt,
  });
  channel.lastMessageAt = new Date();
  channel.reads.set(req.playerId!, new Date());
  await channel.save();

  const name = await playerName(req.playerId!);
  pushToChannel(channel, req.playerId!, { title: `💬 ${name}`, body: text.slice(0, 120) }).catch(() => {});
  res.status(201).json(await msg.populate('author', 'username'));
});

// POST /api/channels/:id/proposals { start, duration, courtId? }
router.post('/:id/proposals', loadChannel, async (req: ChannelRequest, res: Response): Promise<void> => {
  const channel = req.channel!;
  const start = new Date(req.body?.start);
  const duration = Number(req.body?.duration);
  if (Number.isNaN(start.getTime()) || ![60, 90, 120].includes(duration)) {
    res.status(400).json({ message: 'Proposition invalide' });
    return;
  }
  const end = new Date(start.getTime() + duration * 60000);
  if (start < channel.start || end > channel.end) {
    res.status(400).json({ message: 'Cet horaire sort de la plage commune' });
    return;
  }
  if (start < new Date()) {
    res.status(400).json({ message: 'Cet horaire est déjà passé' });
    return;
  }

  const court = req.body?.courtId ? COURTS.find((c) => c.id === req.body.courtId) : undefined;
  const msg = await Message.create({
    channel: channel._id,
    author: req.playerId,
    kind: 'proposal',
    text: '',
    proposal: {
      start,
      duration,
      courtId: court?.id,
      courtNumber: court?.number,
      courtName: court?.name,
      bookingUrl: court ? slotBookingUrl(court.id, start.toISOString(), duration) : undefined,
      votes: [new mongoose.Types.ObjectId(req.playerId)],
      status: 'open',
    },
    expiresAt: channel.expiresAt,
  });
  channel.lastMessageAt = new Date();
  channel.reads.set(req.playerId!, new Date());
  await channel.save();

  const name = await playerName(req.playerId!);
  const what = `${dayFmt.format(start)} à ${timeFmt.format(start)} (${duration} min)${court ? ` · terrain ${court.number}` : ''}`;
  pushToChannel(channel, req.playerId!, { title: `📅 ${name} propose un horaire`, body: `${what} — tu es OK ?` }, true).catch(() => {});
  res.status(201).json(await msg.populate('author', 'username'));
});

// POST /api/channels/:id/proposals/:msgId/vote — je suis OK / je retire mon OK
router.post('/:id/proposals/:msgId/vote', loadChannel, async (req: ChannelRequest, res: Response): Promise<void> => {
  const channel = req.channel!;
  if (!mongoose.isValidObjectId(req.params.msgId)) {
    res.status(404).json({ message: 'Proposition introuvable' });
    return;
  }
  const msg = await Message.findOne({ _id: req.params.msgId, channel: channel._id, kind: 'proposal' });
  if (!msg?.proposal) {
    res.status(404).json({ message: 'Proposition introuvable' });
    return;
  }

  const me = new mongoose.Types.ObjectId(req.playerId);
  const votes = msg.proposal.votes;
  const already = votes.some((v) => v.equals(me));
  msg.proposal.votes = already ? votes.filter((v) => !v.equals(me)) : [...votes, me];

  // Validée quand tous les membres (max 4) sont OK
  const needed = Math.min(channel.members.length, 4);
  const wasConfirmed = msg.proposal.status === 'confirmed';
  msg.proposal.status = msg.proposal.votes.length >= needed ? 'confirmed' : 'open';
  msg.markModified('proposal');
  await msg.save();

  if (!wasConfirmed && msg.proposal.status === 'confirmed') {
    const p = msg.proposal;
    const what = `${dayFmt.format(p.start)} à ${timeFmt.format(p.start)} (${p.duration} min)${p.courtNumber ? ` sur le terrain ${p.courtNumber}` : ''}`;
    await postSystemMessage(channel, `✅ Tout le monde est OK pour ${what} ! Une seule personne réserve sur Playtomic.`);
    await channel.save();
    pushToChannel(channel, req.playerId!, { title: '✅ Match validé', body: `${what} — il reste à réserver le terrain.` }, true).catch(() => {});
  }
  res.json(await msg.populate('author', 'username'));
});

// POST /api/channels/:id/score-prompts/:msgId/dismiss — ne pas enregistrer cette partie
router.post('/:id/score-prompts/:msgId/dismiss', loadChannel, async (req: ChannelRequest, res: Response): Promise<void> => {
  const channel = req.channel!;
  if (!mongoose.isValidObjectId(req.params.msgId)) {
    res.status(404).json({ message: 'Message introuvable' });
    return;
  }
  const msg = await Message.findOneAndUpdate(
    { _id: req.params.msgId, channel: channel._id, kind: 'score_prompt', 'scorePrompt.status': 'pending' },
    { $set: { 'scorePrompt.status': 'dismissed', 'scorePrompt.doneBy': req.playerId } },
    { new: true }
  );
  if (!msg) {
    res.status(409).json({ message: 'Le score a déjà été traité' });
    return;
  }
  await postSystemMessage(channel, `${await playerName(req.playerId!)} a indiqué que cette partie ne sera pas enregistrée.`);
  await channel.save();
  res.json(msg);
});

export default router;
