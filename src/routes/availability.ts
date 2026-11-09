import { Router, Response } from 'express';
import mongoose from 'mongoose';
import Availability from '../models/Availability';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { findOverlapping, notifyMatches, MIN_OVERLAP_MIN } from '../services/availabilityMatch';
import { attachToChannel, channelUrl, detachFromChannels } from '../services/channels';
import Channel from '../models/Channel';

const router = Router();

const MAX_DAYS_AHEAD = 14;
const MIN_DURATION_MIN = 60;
const MAX_DURATION_MIN = 8 * 60;
const MAX_ACTIVE_PER_PLAYER = 30;

// GET /api/availability — créneaux à venir de tous les joueurs (14 prochains jours)
router.get('/', async (_req, res: Response): Promise<void> => {
  const now = new Date();
  const until = new Date(now.getTime() + (MAX_DAYS_AHEAD + 1) * 86_400_000);
  const list = await Availability.find({ end: { $gt: now }, start: { $lt: until } })
    .sort({ start: 1 })
    .populate('player', 'username elo isAdmin')
    .limit(300);
  res.json(list.filter((a) => !(a.player as unknown as { isAdmin?: boolean })?.isAdmin));
});

// GET /api/availability/mine — mes créneaux à venir + les joueurs dispos en même temps
router.get('/mine', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  const mine = await Availability.find({
    player: new mongoose.Types.ObjectId(req.playerId),
    end: { $gt: new Date() },
  }).sort({ start: 1 });

  const result = await Promise.all(
    mine.map(async (a) => {
      const [matches, channel] = await Promise.all([
        findOverlapping(a),
        Channel.findOne({ availabilities: a._id, expiresAt: { $gt: new Date() } }).select('_id'),
      ]);
      return {
        _id: a._id,
        channelId: channel?._id ?? null,
        start: a.start,
        end: a.end,
        matches: matches.map((m) => ({
          availabilityId: m.other._id,
          player: m.other.player,
          start: m.common.start,
          end: m.common.end,
        })),
      };
    })
  );
  res.json(result);
});

// POST /api/availability — ajouter un créneau { start, end } (ISO)
router.post('/', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  const start = new Date(req.body.start);
  const end = new Date(req.body.end);
  const now = new Date();

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    res.status(400).json({ message: 'Dates invalides' });
    return;
  }
  const duration = (end.getTime() - start.getTime()) / 60000;
  if (duration < MIN_DURATION_MIN) {
    res.status(400).json({ message: `Le créneau doit durer au moins ${MIN_DURATION_MIN} min` });
    return;
  }
  if (duration > MAX_DURATION_MIN) {
    res.status(400).json({ message: 'Le créneau ne peut pas dépasser 8 h' });
    return;
  }
  if (end <= now) {
    res.status(400).json({ message: 'Ce créneau est déjà passé' });
    return;
  }
  if (start.getTime() > now.getTime() + MAX_DAYS_AHEAD * 86_400_000) {
    res.status(400).json({ message: `Maximum ${MAX_DAYS_AHEAD} jours à l'avance` });
    return;
  }

  const playerId = new mongoose.Types.ObjectId(req.playerId);
  const overlappingMine = await Availability.findOne({
    player: playerId,
    start: { $lt: end },
    end: { $gt: start },
  });
  if (overlappingMine) {
    res.status(409).json({ message: 'Tu as déjà un créneau qui chevauche celui-ci' });
    return;
  }
  const activeCount = await Availability.countDocuments({ player: playerId, end: { $gt: now } });
  if (activeCount >= MAX_ACTIVE_PER_PLAYER) {
    res.status(400).json({ message: 'Trop de créneaux actifs, supprimes-en quelques-uns' });
    return;
  }

  const av = await Availability.create({ player: playerId, start, end });
  const channel = await attachToChannel(av);
  const matchCount = await notifyMatches(av, channel ? channelUrl(channel._id as mongoose.Types.ObjectId) : '/partners');
  res.status(201).json({ availability: av, matchCount, channelId: channel?._id ?? null, minOverlap: MIN_OVERLAP_MIN });
});

// DELETE /api/availability/:id — supprimer un de mes créneaux
router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  if (!mongoose.isValidObjectId(req.params.id)) {
    res.status(400).json({ message: 'Identifiant invalide' });
    return;
  }
  const deleted = await Availability.findOneAndDelete({ _id: req.params.id, player: req.playerId });
  if (!deleted) {
    res.status(404).json({ message: 'Créneau introuvable' });
    return;
  }
  await detachFromChannels(deleted);
  res.json({ ok: true });
});

export default router;
