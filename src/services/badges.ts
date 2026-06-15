import Player from '../models/Player';
import Match, { IMatch } from '../models/Match';
import mongoose from 'mongoose';

const BADGES = {
  MERCENAIRE: 'mercenaire',
  FIDELE: 'fidele',
  REMONTADA: 'remontada',
} as const;

async function getPlayerMatches(playerId: mongoose.Types.ObjectId): Promise<IMatch[]> {
  return Match.find({
    $or: [{ teamA: playerId }, { teamB: playerId }],
    winner: { $ne: 'draw' },
  }).sort({ date: 1 });
}

async function checkMercenaire(playerId: mongoose.Types.ObjectId): Promise<boolean> {
  const wins = await Match.find({
    $or: [
      { teamA: playerId, winner: 'teamA' },
      { teamB: playerId, winner: 'teamB' },
    ],
  });

  const partners = new Set<string>();
  for (const match of wins) {
    const team = match.teamA.map((id) => id.toString()).includes(playerId.toString())
      ? match.teamA
      : match.teamB;
    team.forEach((id) => {
      if (id.toString() !== playerId.toString()) partners.add(id.toString());
    });
  }
  return partners.size >= 5;
}

async function checkFidele(playerId: mongoose.Types.ObjectId): Promise<boolean> {
  const matches = await getPlayerMatches(playerId);
  if (matches.length < 5) return false;

  let streak = 1;
  let lastPartner: string | null = null;

  for (const match of matches) {
    const team = match.teamA.map((id) => id.toString()).includes(playerId.toString())
      ? match.teamA
      : match.teamB;
    const partner = team.find((id) => id.toString() !== playerId.toString())?.toString() ?? null;

    if (partner === lastPartner) {
      streak++;
      if (streak >= 5) return true;
    } else {
      streak = 1;
      lastPartner = partner;
    }
  }
  return false;
}

async function checkRemontada(playerId: mongoose.Types.ObjectId): Promise<boolean> {
  // Gagner un match après avoir subi un 6-0 au premier set (min 2 sets)
  const wins = await Match.find({
    $or: [
      { teamA: playerId, winner: 'teamA' },
      { teamB: playerId, winner: 'teamB' },
    ],
    'scores.1': { $exists: true }, // au moins 2 sets
  });

  for (const match of wins) {
    const isTeamA = match.teamA.map((id) => id.toString()).includes(playerId.toString());
    const firstSet = match.scores[0];
    if (!firstSet) continue;

    const playerScore = isTeamA ? firstSet.teamA_Score : firstSet.teamB_Score;
    const opponentScore = isTeamA ? firstSet.teamB_Score : firstSet.teamA_Score;

    if (playerScore === 0 && opponentScore === 6) return true;
  }
  return false;
}

export async function evaluateBadges(playerId: mongoose.Types.ObjectId): Promise<void> {
  const player = await Player.findById(playerId);
  if (!player) return;

  const checks: [string, () => Promise<boolean>][] = [
    [BADGES.MERCENAIRE, () => checkMercenaire(playerId)],
    [BADGES.FIDELE, () => checkFidele(playerId)],
    [BADGES.REMONTADA, () => checkRemontada(playerId)],
  ];

  const newBadges: string[] = [];
  for (const [badge, check] of checks) {
    if (!player.badges.includes(badge) && (await check())) {
      newBadges.push(badge);
    }
  }

  if (newBadges.length > 0) {
    player.badges.push(...newBadges);
    await player.save();
  }
}
