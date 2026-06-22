import mongoose from 'mongoose';
import Player from '../models/Player';
import Match from '../models/Match';

// Recalcule les streaks et badges d'un joueur depuis son historique complet
export async function recomputePlayer(playerId: mongoose.Types.ObjectId): Promise<void> {
  const player = await Player.findById(playerId);
  if (!player) return;

  const matches = await Match.find({
    $or: [{ teamA: playerId }, { teamB: playerId }],
    validated: true,
  }).sort({ date: 1 });

  // ── Streaks ──
  let currentStreak = 0;
  let bestStreak = 0;

  for (const match of matches) {
    const isTeamA = match.teamA.map((id) => id.toString()).includes(playerId.toString());
    const won = (isTeamA && match.winner === 'teamA') || (!isTeamA && match.winner === 'teamB');
    const lost = (isTeamA && match.winner === 'teamB') || (!isTeamA && match.winner === 'teamA');

    if (won) {
      currentStreak++;
      if (currentStreak > bestStreak) bestStreak = currentStreak;
    } else if (lost) {
      currentStreak = 0;
    }
    // draw → streak inchangée
  }

  // ── Badges ──
  const badges: string[] = [];

  // Mercenaire : gagner avec 5 partenaires différents
  const wins = matches.filter((m) => {
    const isTeamA = m.teamA.map((id) => id.toString()).includes(playerId.toString());
    return (isTeamA && m.winner === 'teamA') || (!isTeamA && m.winner === 'teamB');
  });
  const partners = new Set<string>();
  for (const m of wins) {
    const isTeamA = m.teamA.map((id) => id.toString()).includes(playerId.toString());
    const team = isTeamA ? m.teamA : m.teamB;
    team.forEach((id) => { if (id.toString() !== playerId.toString()) partners.add(id.toString()); });
  }
  if (partners.size >= 5) badges.push('mercenaire');

  // Fidèle : 5 matchs consécutifs avec le même partenaire
  if (matches.length >= 5) {
    let streak = 1;
    let lastPartner: string | null = null;
    let fidele = false;
    for (const m of matches) {
      const isTeamA = m.teamA.map((id) => id.toString()).includes(playerId.toString());
      const team = isTeamA ? m.teamA : m.teamB;
      const partner = team.find((id) => id.toString() !== playerId.toString())?.toString() ?? null;
      if (partner === lastPartner) { streak++; if (streak >= 5) { fidele = true; break; } }
      else { streak = 1; lastPartner = partner; }
    }
    if (fidele) badges.push('fidele');
  }

  // Remontada : gagner après un 6-0 au premier set (min 2 sets)
  for (const m of wins) {
    if (!m.scores[1]) continue;
    const isTeamA = m.teamA.map((id) => id.toString()).includes(playerId.toString());
    const first = m.scores[0];
    const playerScore = isTeamA ? first.teamA_Score : first.teamB_Score;
    const oppScore = isTeamA ? first.teamB_Score : first.teamA_Score;
    if (playerScore === 0 && oppScore === 6) { badges.push('remontada'); break; }
  }

  player.currentStreak = currentStreak;
  player.bestStreak = bestStreak;
  player.badges = badges;
  await player.save();
}
