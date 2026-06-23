import { Router, Response } from 'express';
import mongoose from 'mongoose';
import Tournament, { ITournamentMatch } from '../models/Tournament';
import Match from '../models/Match';
import Player from '../models/Player';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { calculateElo } from '../services/elo';
import { recomputePlayer } from '../services/recompute';

const router = Router();

function splitIntoPools(numTeams: number): number[][] {
  if (numTeams <= 4) return [Array.from({ length: numTeams }, (_, i) => i)];
  const numPools = numTeams <= 8 ? 2 : Math.ceil(numTeams / 4);
  const pools: number[][] = Array.from({ length: numPools }, () => []);
  for (let i = 0; i < numTeams; i++) pools[i % numPools].push(i);
  return pools;
}

function roundRobinMatches(teamIndexes: number[], phase: 'pool' | 'final', extra: { poolIndex?: number; groupIndex?: number }): ITournamentMatch[] {
  const matches: ITournamentMatch[] = [];
  for (let i = 0; i < teamIndexes.length; i++) {
    for (let j = i + 1; j < teamIndexes.length; j++) {
      matches.push({
        teamAIndex: teamIndexes[i],
        teamBIndex: teamIndexes[j],
        status: 'pending',
        phase,
        ...extra,
      } as ITournamentMatch);
    }
  }
  return matches;
}

interface StandRow { teamIdx: number; pts: number; setsFor: number; setsAgainst: number; gamesFor: number; gamesAgainst: number; }

function computeGroupStandings(teamIndexes: number[], matches: ITournamentMatch[], playedMap: Map<string, any>): StandRow[] {
  const rows: StandRow[] = teamIndexes.map((idx) => ({ teamIdx: idx, pts: 0, setsFor: 0, setsAgainst: 0, gamesFor: 0, gamesAgainst: 0 }));
  const byIdx = new Map(rows.map((r) => [r.teamIdx, r]));

  for (const m of matches) {
    if (m.status !== 'completed' || !m.matchId) continue;
    const match = playedMap.get(m.matchId.toString());
    if (!match) continue;

    const sA = match.scores.reduce((acc: number, s: any) => acc + (s.teamA_Score > s.teamB_Score ? 1 : 0), 0);
    const sB = match.scores.reduce((acc: number, s: any) => acc + (s.teamB_Score > s.teamA_Score ? 1 : 0), 0);
    const gA = match.scores.reduce((acc: number, s: any) => acc + s.teamA_Score, 0);
    const gB = match.scores.reduce((acc: number, s: any) => acc + s.teamB_Score, 0);

    const ra = byIdx.get(m.teamAIndex);
    const rb = byIdx.get(m.teamBIndex);
    if (!ra || !rb) continue;

    ra.setsFor += sA; ra.setsAgainst += sB;
    rb.setsFor += sB; rb.setsAgainst += sA;
    ra.gamesFor += gA; ra.gamesAgainst += gB;
    rb.gamesFor += gB; rb.gamesAgainst += gA;

    if (match.winner === 'teamA') ra.pts += 3;
    else if (match.winner === 'teamB') rb.pts += 3;
    else { ra.pts++; rb.pts++; }
  }

  // Tri : points décroissants, puis moins de jeux perdus, puis meilleure différence de jeux
  return rows.sort((a, b) =>
    b.pts - a.pts ||
    a.gamesAgainst - b.gamesAgainst ||
    (b.gamesFor - b.gamesAgainst) - (a.gamesFor - a.gamesAgainst)
  );
}

// GET /api/tournaments
router.get('/', async (_req, res: Response): Promise<void> => {
  const tournaments = await Tournament.find()
    .populate('teams.players', 'username elo')
    .sort({ createdAt: -1 });
  res.json(tournaments);
});

// POST /api/tournaments — créer
router.post('/', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  const { name, teams, countForRanking } = req.body;

  if (!name || !teams || teams.length < 2) {
    res.status(400).json({ message: 'Nom et au moins 2 équipes requis' });
    return;
  }
  for (const team of teams) {
    if (!team.players || team.players.length !== 2) {
      res.status(400).json({ message: 'Chaque équipe doit avoir exactement 2 joueurs' });
      return;
    }
  }

  const pools = splitIntoPools(teams.length);
  const matches: ITournamentMatch[] = pools.flatMap((pool, i) => roundRobinMatches(pool, 'pool', { poolIndex: i }));

  const tournament = await Tournament.create({
    name,
    teams,
    countForRanking: !!countForRanking,
    pools,
    matches,
    status: 'pool_stage',
  });

  const populated = await tournament.populate('teams.players', 'username elo');
  res.status(201).json(populated);
});

// GET /api/tournaments/:id
router.get('/:id', async (req, res: Response): Promise<void> => {
  const tournament = await Tournament.findById(req.params.id).populate('teams.players', 'username elo');
  if (!tournament) { res.status(404).json({ message: 'Tournoi introuvable' }); return; }

  const matchIds = tournament.matches.filter((m) => m.matchId).map((m) => m.matchId!);
  const playedMatches = await Match.find({ _id: { $in: matchIds } }).populate('teamA teamB', 'username');
  const matchMap = new Map(playedMatches.map((m) => [m._id.toString(), m]));

  const matchesWithData = tournament.matches.map((m) => ({
    teamAIndex: m.teamAIndex,
    teamBIndex: m.teamBIndex,
    status: m.status,
    phase: m.phase,
    poolIndex: m.poolIndex,
    groupIndex: m.groupIndex,
    matchId: m.matchId,
    match: m.matchId ? matchMap.get(m.matchId.toString()) : null,
  }));

  const poolStandings = tournament.pools.map((pool, i) =>
    computeGroupStandings(pool, tournament.matches.filter((m) => m.phase === 'pool' && m.poolIndex === i), matchMap)
  );

  const rankGroupStandings = tournament.rankGroups.map((group, i) =>
    computeGroupStandings(group, tournament.matches.filter((m) => m.phase === 'final' && m.groupIndex === i), matchMap)
  );

  res.json({ tournament, matchesWithData, poolStandings, rankGroupStandings });
});

// POST /api/tournaments/:id/matches/:idx — soumettre un score
router.post('/:id/matches/:idx', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  const { scores, winner } = req.body;
  const idx = parseInt(req.params.idx);

  const tournament = await Tournament.findById(req.params.id);
  if (!tournament) { res.status(404).json({ message: 'Tournoi introuvable' }); return; }

  const tm = tournament.matches[idx];
  if (!tm) { res.status(404).json({ message: 'Match introuvable' }); return; }
  if (tm.status === 'completed') { res.status(400).json({ message: 'Match déjà joué' }); return; }

  const teamA = tournament.teams[tm.teamAIndex].players;
  const teamB = tournament.teams[tm.teamBIndex].players;

  const hasIncomplete = scores.some((s: any) => s.isComplete === false);
  const coefficient = hasIncomplete || scores.length === 1 ? 0.5 : 1.0;

  let eloChanges: { playerId: mongoose.Types.ObjectId; delta: number }[] = [];

  if (tournament.countForRanking) {
    const [pA1, pA2, pB1, pB2] = await Promise.all([
      Player.findById(teamA[0]), Player.findById(teamA[1]),
      Player.findById(teamB[0]), Player.findById(teamB[1]),
    ]);

    if (pA1 && pA2 && pB1 && pB2) {
      const { deltaA, deltaB } = calculateElo(pA1.elo, pA2.elo, pB1.elo, pB2.elo, winner, coefficient);
      pA1.elo += deltaA; pA2.elo += deltaA;
      pB1.elo += deltaB; pB2.elo += deltaB;

      eloChanges = [
        { playerId: pA1._id as mongoose.Types.ObjectId, delta: deltaA },
        { playerId: pA2._id as mongoose.Types.ObjectId, delta: deltaA },
        { playerId: pB1._id as mongoose.Types.ObjectId, delta: deltaB },
        { playerId: pB2._id as mongoose.Types.ObjectId, delta: deltaB },
      ];

      await Promise.all([pA1.save(), pA2.save(), pB1.save(), pB2.save()]);
      await Promise.all([pA1._id, pA2._id, pB1._id, pB2._id].map((id) => recomputePlayer(id as mongoose.Types.ObjectId)));
    }
  }

  const match = await Match.create({
    teamA, teamB, scores, winner, coefficient,
    submittedBy: req.playerId, validated: true, eloChanges,
  });

  tm.matchId = match._id as mongoose.Types.ObjectId;
  tm.status = 'completed';

  // Si phase de poules terminée → générer la phase finale par rang
  if (tournament.status === 'pool_stage') {
    const poolMatches = tournament.matches.filter((m) => m.phase === 'pool');
    const allPoolsDone = poolMatches.every((m) => m.status === 'completed');

    if (allPoolsDone) {
      const matchIds = tournament.matches.filter((m) => m.matchId).map((m) => m.matchId!);
      const playedMatches = await Match.find({ _id: { $in: matchIds } });
      const matchMap = new Map(playedMatches.map((m) => [m._id.toString(), m]));

      const maxPoolSize = Math.max(...tournament.pools.map((p) => p.length));
      const rankGroups: number[][] = Array.from({ length: maxPoolSize }, () => []);

      tournament.pools.forEach((pool, i) => {
        const standings = computeGroupStandings(pool, tournament.matches.filter((m) => m.phase === 'pool' && m.poolIndex === i), matchMap);
        standings.forEach((s, rank) => rankGroups[rank].push(s.teamIdx));
      });

      tournament.rankGroups = rankGroups;

      const newMatches: ITournamentMatch[] = rankGroups.flatMap((group, i) =>
        group.length >= 2 ? roundRobinMatches(group, 'final', { groupIndex: i }) : []
      );

      tournament.matches.push(...newMatches);
      tournament.status = newMatches.length > 0 ? 'playoffs' : 'completed';
    }
  } else if (tournament.status === 'playoffs') {
    const allDone = tournament.matches.every((m) => m.status === 'completed');
    if (allDone) tournament.status = 'completed';
  }

  await tournament.save();
  res.json({ match, tournament });
});

// DELETE /api/tournaments/:id
router.delete('/:id', authMiddleware, async (req: AuthRequest, res: Response): Promise<void> => {
  const tournament = await Tournament.findById(req.params.id);
  if (!tournament) { res.status(404).json({ message: 'Tournoi introuvable' }); return; }

  for (const tm of tournament.matches) {
    if (tm.matchId) {
      const match = await Match.findById(tm.matchId);
      if (match && tournament.countForRanking) {
        for (const change of match.eloChanges) {
          await Player.findByIdAndUpdate(change.playerId, { $inc: { elo: -change.delta } });
        }
      }
      await Match.findByIdAndDelete(tm.matchId);
    }
  }

  const playerIds = tournament.teams.flatMap((t) => t.players) as mongoose.Types.ObjectId[];
  if (tournament.countForRanking) {
    await Promise.all(playerIds.map((id) => recomputePlayer(id)));
  }

  await tournament.deleteOne();
  res.json({ message: 'Tournoi supprimé' });
});

export default router;
