import { Router, Response } from 'express';
import mongoose from 'mongoose';
import Match from '../models/Match';
import Player from '../models/Player';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { calculateElo } from '../services/elo';
import { evaluateBadges } from '../services/badges';
import { parseYouTubeId } from '../utils/youtube';

import Channel from '../models/Channel';
import Message from '../models/Message';
import { postSystemMessage, pushToChannel } from '../services/channels';

const router = Router();

// GET /api/matches — historique
router.get('/', async (_req, res: Response): Promise<void> => {
  const matches = await Match.find({ validated: true })
    .populate('teamA teamB', 'username elo')
    .sort({ date: -1 })
    .limit(50);
  res.json(matches);
});

// POST /api/matches — soumettre un match
router.post('/', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  const { teamA, teamB, scores, winner, videoUrl, scorePrompt } = req.body;

  if (!teamA || !teamB || !scores || !winner) {
    res.status(400).json({ message: 'Données manquantes' });
    return;
  }
  if (teamA.length !== 2 || teamB.length !== 2) {
    res.status(400).json({ message: 'Chaque équipe doit avoir exactement 2 joueurs' });
    return;
  }

  // La vidéo est facultative, mais un lien fourni et invalide est une erreur :
  // l'enregistrer silencieusement sans vidéo perdrait la saisie de l'utilisateur.
  let video = null;
  if (videoUrl?.trim()) {
    const videoId = parseYouTubeId(videoUrl);
    if (!videoId) {
      res.status(400).json({ message: 'Lien YouTube invalide' });
      return;
    }
    video = { videoId, addedBy: req.playerId, addedAt: new Date() };
  }

  // Score saisi depuis une discussion : on réserve le message pour éviter un doublon
  const matchId = new mongoose.Types.ObjectId();
  let promptMsg: InstanceType<typeof Message> | null = null;
  let promptChannel: InstanceType<typeof Channel> | null = null;
  if (scorePrompt?.channelId && scorePrompt?.messageId) {
    if (!mongoose.isValidObjectId(scorePrompt.channelId) || !mongoose.isValidObjectId(scorePrompt.messageId)) {
      res.status(400).json({ message: 'Discussion invalide' });
      return;
    }
    promptChannel = await Channel.findOne({ _id: scorePrompt.channelId, members: req.playerId });
    if (!promptChannel) {
      res.status(403).json({ message: 'Tu ne fais pas partie de cette discussion' });
      return;
    }
    promptMsg = await Message.findOneAndUpdate(
      { _id: scorePrompt.messageId, channel: promptChannel._id, kind: 'score_prompt', 'scorePrompt.status': 'pending' },
      { $set: { 'scorePrompt.status': 'recorded', 'scorePrompt.matchId': matchId, 'scorePrompt.doneBy': req.playerId } },
      { new: true }
    );
    if (!promptMsg) {
      res.status(409).json({ message: 'Le score de cette partie a déjà été enregistré' });
      return;
    }
  }

  // Coefficient automatique : match incomplet ou 1 seul set = 0.5, sinon 1.0
  const hasIncomplete = scores.some((s: any) => s.isComplete === false);
  const coefficient = hasIncomplete || scores.length === 1 ? 0.5 : 1.0;

  let match;
  try {
    match = await Match.create({
    _id: matchId,
    teamA,
    teamB,
    scores,
    winner,
    coefficient,
    submittedBy: req.playerId,
    validated: true, // auto-validé pour l'instant (simplification)
    video,
  });
  } catch (err) {
    // Libère le message de score si l'enregistrement échoue
    if (promptMsg) {
      await Message.updateOne(
        { _id: promptMsg._id },
        { $set: { 'scorePrompt.status': 'pending' }, $unset: { 'scorePrompt.matchId': 1, 'scorePrompt.doneBy': 1 } }
      );
    }
    throw err;
  }

  // Calcul ELO
  const [pA1, pA2, pB1, pB2] = await Promise.all([
    Player.findById(teamA[0]),
    Player.findById(teamA[1]),
    Player.findById(teamB[0]),
    Player.findById(teamB[1]),
  ]);

  if (pA1 && pA2 && pB1 && pB2) {
    const { deltaA, deltaB } = calculateElo(
      pA1.elo, pA2.elo, pB1.elo, pB2.elo, winner, coefficient
    );

    pA1.elo += deltaA;
    pA2.elo += deltaA;
    pB1.elo += deltaB;
    pB2.elo += deltaB;

    // Mise à jour des séries de victoires
    const winnersTeam = winner === 'teamA' ? [pA1, pA2] : winner === 'teamB' ? [pB1, pB2] : [];
    const losersTeam = winner === 'teamA' ? [pB1, pB2] : winner === 'teamB' ? [pA1, pA2] : [pA1, pA2, pB1, pB2];

    for (const p of winnersTeam) {
      p.currentStreak = (p.currentStreak || 0) + 1;
      if (p.currentStreak > (p.bestStreak || 0)) p.bestStreak = p.currentStreak;
    }
    for (const p of losersTeam) {
      if (!winnersTeam.includes(p)) p.currentStreak = 0;
    }

    match.eloChanges = [
      { playerId: pA1._id as mongoose.Types.ObjectId, delta: deltaA },
      { playerId: pA2._id as mongoose.Types.ObjectId, delta: deltaA },
      { playerId: pB1._id as mongoose.Types.ObjectId, delta: deltaB },
      { playerId: pB2._id as mongoose.Types.ObjectId, delta: deltaB },
    ];

    await Promise.all([pA1.save(), pA2.save(), pB1.save(), pB2.save(), match.save()]);

    // Évaluer les badges pour chaque joueur
    await Promise.all([
      evaluateBadges(pA1._id as mongoose.Types.ObjectId),
      evaluateBadges(pA2._id as mongoose.Types.ObjectId),
      evaluateBadges(pB1._id as mongoose.Types.ObjectId),
      evaluateBadges(pB2._id as mongoose.Types.ObjectId),
    ]);
  }

  const populated = await match.populate('teamA teamB', 'username elo');

  if (promptMsg && promptChannel) {
    const names = (team: unknown) =>
      (team as { username: string }[]).map((p) => p.username).join(' & ');
    const sets = scores.map((sc: { teamA_Score: number; teamB_Score: number }) => `${sc.teamA_Score}-${sc.teamB_Score}`).join(' ');
    const result = winner === 'draw' ? 'Match nul' : `Victoire ${names(winner === 'teamA' ? populated.teamA : populated.teamB)}`;
    const author = (await Player.findById(req.playerId).select('username'))?.username ?? 'Un joueur';
    await postSystemMessage(
      promptChannel,
      `🎾 Score enregistré par ${author} : ${names(populated.teamA)} ${sets} ${names(populated.teamB)} — ${result}.`
    );
    await promptChannel.save();
    pushToChannel(promptChannel, req.playerId!, { title: '🎾 Score enregistré', body: `${result} (${sets})` }, true).catch(() => {});
  }

  res.status(201).json(populated);
});

// GET /api/matches/:id
router.get('/:id', async (req, res: Response): Promise<void> => {
  const match = await Match.findById(req.params.id).populate('teamA teamB', 'username elo');
  if (!match) {
    res.status(404).json({ message: 'Match introuvable' });
    return;
  }
  res.json(match);
});

// PUT /api/matches/:id/video — attacher ou remplacer la vidéo d'un match existant
router.put('/:id/video', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  const videoId = parseYouTubeId(req.body?.videoUrl ?? '');
  if (!videoId) {
    res.status(400).json({ message: 'Lien YouTube invalide' });
    return;
  }

  const match = await Match.findById(req.params.id);
  if (!match) {
    res.status(404).json({ message: 'Match introuvable' });
    return;
  }

  match.video = {
    videoId,
    addedBy: req.playerId as unknown as mongoose.Types.ObjectId,
    addedAt: new Date(),
  };
  await match.save();

  const populated = await match.populate('teamA teamB', 'username elo');
  res.json(populated);
});

// DELETE /api/matches/:id/video
// Asymétrie volontaire : n'importe quel membre connecté peut attacher une
// vidéo, mais seuls les joueurs qui ont disputé le match peuvent la retirer.
// Ce sont eux qui apparaissent à l'image — la décision leur revient.
router.delete('/:id/video', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  const match = await Match.findById(req.params.id);
  if (!match) {
    res.status(404).json({ message: 'Match introuvable' });
    return;
  }
  if (!match.video) {
    res.status(404).json({ message: 'Ce match n\'a pas de vidéo' });
    return;
  }

  const participants = [...match.teamA, ...match.teamB].map((p) => p.toString());
  const requester = await Player.findById(req.playerId);
  const allowed =
    requester?.isAdmin === true ||
    participants.includes(req.playerId as string);

  if (!allowed) {
    res.status(403).json({ message: 'Seuls les joueurs de ce match peuvent retirer la vidéo' });
    return;
  }

  match.video = null;
  await match.save();

  const populated = await match.populate('teamA teamB', 'username elo');
  res.json(populated);
});

export default router;
