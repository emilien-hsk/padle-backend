import { Router, Response } from 'express';
import mongoose from 'mongoose';
import Player from '../models/Player';
import Match from '../models/Match';
import { authMiddleware, AuthRequest } from '../middleware/auth';

const router = Router();

// GET /api/players — classement général
router.get('/', async (_req, res: Response): Promise<void> => {
  const players = await Player.find({ isAdmin: { $ne: true } }).sort({ elo: -1 }).select('-passwordHash');
  res.json(players);
});

// GET /api/players/pending-claims — demandes de fusion que le joueur connecté peut valider
router.get('/pending-claims', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  const approverId = new mongoose.Types.ObjectId(req.playerId);

  // Trouver tous les profils invités avec une demande en attente
  const pendingGuests = await Player.find({ claimStatus: 'pending' }).select('-passwordHash');

  // Garder seulement ceux avec qui le joueur a partagé un match
  const eligible: typeof pendingGuests = [];
  for (const guest of pendingGuests) {
    const shared = await Match.findOne({
      $or: [
        { teamA: { $all: [guest._id, approverId] } },
        { teamB: { $all: [guest._id, approverId] } },
        { teamA: guest._id, teamB: approverId },
        { teamA: approverId, teamB: guest._id },
      ],
    });
    if (shared) eligible.push(guest);
  }

  // Enrichir avec le nom du réclamant
  const result = await Promise.all(
    eligible.map(async (g) => {
      const claimant = g.claimRequestedBy
        ? await Player.findById(g.claimRequestedBy).select('username')
        : null;
      return { guest: g, claimant };
    })
  );

  res.json(result);
});

// POST /api/players/guest — créer un profil invité
router.post('/guest', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  const { username } = req.body;
  if (!username) {
    res.status(400).json({ message: 'Username requis' });
    return;
  }
  const guest = await Player.create({ username, isRegistered: false });
  res.status(201).json(guest);
});

// GET /api/players/me — profil du joueur connecté
router.get('/me', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  const player = await Player.findById(req.playerId).select('-passwordHash');
  if (!player) {
    res.status(404).json({ message: 'Joueur introuvable' });
    return;
  }
  res.json(player);
});

// GET /api/players/:id — profil + statistiques
router.get('/:id', async (req, res: Response): Promise<void> => {
  const player = await Player.findById(req.params.id).select('-passwordHash');
  if (!player) {
    res.status(404).json({ message: 'Joueur introuvable' });
    return;
  }

  const pid = new mongoose.Types.ObjectId(req.params.id);

  const matches = await Match.find({
    $or: [{ teamA: pid }, { teamB: pid }],
    validated: true,
  })
    .populate('teamA teamB', 'username elo')
    .sort({ date: -1 });

  const stats = computeStats(pid, matches);

  // Historique enrichi avec le résultat du point de vue du joueur
  const history = matches.map((m: any) => {
    const isTeamA = m.teamA.some((p: any) => p._id.toString() === pid.toString());
    const result =
      m.winner === 'draw' ? 'draw'
      : (isTeamA && m.winner === 'teamA') || (!isTeamA && m.winner === 'teamB') ? 'win'
      : 'loss';
    return {
      _id: m._id,
      date: m.date,
      teamA: m.teamA,
      teamB: m.teamB,
      scores: m.scores,
      winner: m.winner,
      coefficient: m.coefficient,
      result,
    };
  });

  res.json({ player, stats, history });
});

// POST /api/players/:id/claim — demande de ralliement d'un profil invité
router.post('/:id/claim', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  const guest = await Player.findById(req.params.id);
  if (!guest || guest.isRegistered) {
    res.status(400).json({ message: 'Profil invité introuvable ou déjà inscrit' });
    return;
  }
  if (guest.claimStatus === 'pending') {
    res.status(409).json({ message: 'Demande déjà en cours' });
    return;
  }

  guest.claimRequestedBy = new mongoose.Types.ObjectId(req.playerId);
  guest.claimStatus = 'pending';
  await guest.save();

  res.json({ message: 'Demande de ralliement soumise, en attente de validation' });
});

// POST /api/players/:id/claim/approve — valider la demande
router.post('/:id/claim/approve', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  const guest = await Player.findById(req.params.id);
  if (!guest || guest.claimStatus !== 'pending') {
    res.status(400).json({ message: 'Aucune demande en attente' });
    return;
  }

  // Vérifier que l'approbateur a joué avec ce profil invité
  const pid = new mongoose.Types.ObjectId(req.params.id);
  const approverId = new mongoose.Types.ObjectId(req.playerId);

  const sharedMatch = await Match.findOne({
    $or: [
      { teamA: { $all: [pid, approverId] } },
      { teamB: { $all: [pid, approverId] } },
      { teamA: pid, teamB: approverId },
      { teamA: approverId, teamB: pid },
    ],
  });

  if (!sharedMatch) {
    res.status(403).json({ message: 'Vous devez avoir joué avec ce joueur pour valider' });
    return;
  }

  // Fusionner : réassigner les matchs de l'invité vers le compte réclamant
  const claimantId = guest.claimRequestedBy!;
  await Match.updateMany({ teamA: pid }, { $set: { 'teamA.$[el]': claimantId } }, { arrayFilters: [{ 'el': pid }] });
  await Match.updateMany({ teamB: pid }, { $set: { 'teamB.$[el]': claimantId } }, { arrayFilters: [{ 'el': pid }] });

  // Transférer ELO et badges
  const claimant = await Player.findById(claimantId);
  if (claimant) {
    claimant.elo = guest.elo;
    const newBadges = guest.badges.filter((b) => !claimant.badges.includes(b));
    claimant.badges.push(...newBadges);
    await claimant.save();
  }

  // Supprimer le profil invité maintenant que tout est transféré
  await Player.findByIdAndDelete(pid);

  res.json({ message: 'Profil fusionné avec succès' });
});

function computeStats(pid: mongoose.Types.ObjectId, matches: any[]) {
  let wins = 0, losses = 0, draws = 0;
  const partnerWins: Record<string, { wins: number; total: number; name: string }> = {};
  const nemesisLosses: Record<string, { losses: number; total: number; name: string }> = {};

  for (const match of matches) {
    const isTeamA = match.teamA.some((p: any) => p._id.toString() === pid.toString());
    const myTeam = isTeamA ? match.teamA : match.teamB;
    const oppTeam = isTeamA ? match.teamB : match.teamA;
    const won = (isTeamA && match.winner === 'teamA') || (!isTeamA && match.winner === 'teamB');
    const lost = (isTeamA && match.winner === 'teamB') || (!isTeamA && match.winner === 'teamA');

    if (won) wins++;
    else if (lost) losses++;
    else draws++;

    const partner = myTeam.find((p: any) => p._id.toString() !== pid.toString());
    if (partner) {
      const key = partner._id.toString();
      if (!partnerWins[key]) partnerWins[key] = { wins: 0, total: 0, name: partner.username };
      partnerWins[key].total++;
      if (won) partnerWins[key].wins++;
    }

    for (const opp of oppTeam) {
      const key = opp._id.toString();
      if (!nemesisLosses[key]) nemesisLosses[key] = { losses: 0, total: 0, name: opp.username };
      nemesisLosses[key].total++;
      if (lost) nemesisLosses[key].losses++;
    }
  }

  const bestPartner = Object.entries(partnerWins)
    .filter(([, v]) => v.total >= 2)
    .sort(([, a], [, b]) => b.wins / b.total - a.wins / a.total)[0];

  const nemesis = Object.entries(nemesisLosses)
    .filter(([, v]) => v.total >= 2)
    .sort(([, a], [, b]) => b.losses / b.total - a.losses / a.total)[0];

  return {
    wins,
    losses,
    draws,
    total: matches.length,
    winRate: matches.length > 0 ? Math.round((wins / matches.length) * 100) : 0,
    bestPartner: bestPartner
      ? { id: bestPartner[0], name: bestPartner[1].name, winRate: Math.round((bestPartner[1].wins / bestPartner[1].total) * 100) }
      : null,
    nemesis: nemesis
      ? { id: nemesis[0], name: nemesis[1].name, lossRate: Math.round((nemesis[1].losses / nemesis[1].total) * 100) }
      : null,
  };
}

export default router;
