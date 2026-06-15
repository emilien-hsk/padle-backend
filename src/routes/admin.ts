import { Router, Response } from 'express';
import mongoose from 'mongoose';
import Player from '../models/Player';
import Match from '../models/Match';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { adminMiddleware } from '../middleware/admin';
import { calculateElo } from '../services/elo';

const router = Router();
router.use(authMiddleware, adminMiddleware);

// GET /api/admin/players — tous les joueurs
router.get('/players', async (_req, res: Response): Promise<void> => {
  const players = await Player.find().sort({ elo: -1 }).select('-passwordHash');
  res.json(players);
});

// PUT /api/admin/players/:id/elo — modifier l'ELO
router.put('/players/:id/elo', async (req: AuthRequest, res: Response): Promise<void> => {
  const { elo } = req.body;
  if (typeof elo !== 'number' || elo < 0) {
    res.status(400).json({ message: 'ELO invalide' });
    return;
  }
  const player = await Player.findByIdAndUpdate(req.params.id, { elo }, { new: true }).select('-passwordHash');
  if (!player) { res.status(404).json({ message: 'Joueur introuvable' }); return; }
  res.json(player);
});

// POST /api/admin/players/:id/reset — remettre les stats à zéro
router.post('/players/:id/reset', async (req: AuthRequest, res: Response): Promise<void> => {
  const player = await Player.findById(req.params.id);
  if (!player) { res.status(404).json({ message: 'Joueur introuvable' }); return; }

  player.elo = 1200;
  player.badges = [];
  player.currentStreak = 0;
  player.bestStreak = 0;
  await player.save();

  res.json({ message: 'Profil réinitialisé', player });
});

// GET /api/admin/matches — tous les matchs
router.get('/matches', async (_req, res: Response): Promise<void> => {
  const matches = await Match.find()
    .populate('teamA teamB', 'username')
    .sort({ date: -1 })
    .limit(100);
  res.json(matches);
});

// DELETE /api/admin/matches/:id — supprimer un match et annuler son ELO
router.delete('/matches/:id', async (_req, res: Response): Promise<void> => {
  const match = await Match.findById(_req.params.id);
  if (!match) { res.status(404).json({ message: 'Match introuvable' }); return; }

  // Annuler les changements ELO
  for (const change of match.eloChanges) {
    await Player.findByIdAndUpdate(change.playerId, { $inc: { elo: -change.delta } });
  }

  await match.deleteOne();
  res.json({ message: 'Match supprimé et ELO annulé' });
});

// PUT /api/admin/matches/:id — modifier les scores d'un match et recalculer l'ELO
router.put('/matches/:id', async (req: AuthRequest, res: Response): Promise<void> => {
  const { scores, winner } = req.body;
  const match = await Match.findById(req.params.id);
  if (!match) { res.status(404).json({ message: 'Match introuvable' }); return; }

  // 1. Annuler l'ancien ELO
  for (const change of match.eloChanges) {
    await Player.findByIdAndUpdate(change.playerId, { $inc: { elo: -change.delta } });
  }

  // 2. Appliquer nouveaux scores et winner
  const hasIncomplete = scores.some((s: any) => s.isComplete === false);
  const coefficient = scores.length === 1 || hasIncomplete ? 0.5 : 1.0;
  match.scores = scores;
  match.winner = winner;
  match.coefficient = coefficient;

  // 3. Recalculer le nouvel ELO
  const [pA1, pA2, pB1, pB2] = await Promise.all([
    Player.findById(match.teamA[0]),
    Player.findById(match.teamA[1]),
    Player.findById(match.teamB[0]),
    Player.findById(match.teamB[1]),
  ]);

  if (pA1 && pA2 && pB1 && pB2) {
    const { deltaA, deltaB } = calculateElo(pA1.elo, pA2.elo, pB1.elo, pB2.elo, winner, coefficient);
    pA1.elo += deltaA; pA2.elo += deltaA;
    pB1.elo += deltaB; pB2.elo += deltaB;

    match.eloChanges = [
      { playerId: pA1._id as mongoose.Types.ObjectId, delta: deltaA },
      { playerId: pA2._id as mongoose.Types.ObjectId, delta: deltaA },
      { playerId: pB1._id as mongoose.Types.ObjectId, delta: deltaB },
      { playerId: pB2._id as mongoose.Types.ObjectId, delta: deltaB },
    ];

    await Promise.all([pA1.save(), pA2.save(), pB1.save(), pB2.save()]);
  }

  await match.save();
  const populated = await match.populate('teamA teamB', 'username elo');
  res.json(populated);
});

export default router;
