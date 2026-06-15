const K_FACTOR = 32;

function expectedScore(eloA: number, eloB: number): number {
  return 1 / (1 + Math.pow(10, (eloB - eloA) / 400));
}

export interface EloResult {
  deltaA: number;
  deltaB: number;
}

/**
 * Calcule les deltas ELO pour un match 2v2.
 * La force d'équipe = moyenne ELO des deux joueurs.
 */
export function calculateElo(
  eloA1: number,
  eloA2: number,
  eloB1: number,
  eloB2: number,
  winner: 'teamA' | 'teamB' | 'draw',
  coefficient: number
): EloResult {
  const avgA = (eloA1 + eloA2) / 2;
  const avgB = (eloB1 + eloB2) / 2;

  const expectedA = expectedScore(avgA, avgB);
  const expectedB = expectedScore(avgB, avgA);

  let scoreA: number;
  let scoreB: number;

  if (winner === 'teamA') {
    scoreA = 1;
    scoreB = 0;
  } else if (winner === 'teamB') {
    scoreA = 0;
    scoreB = 1;
  } else {
    scoreA = 0.5;
    scoreB = 0.5;
  }

  const deltaA = Math.round(K_FACTOR * (scoreA - expectedA) * coefficient);
  const deltaB = Math.round(K_FACTOR * (scoreB - expectedB) * coefficient);

  return { deltaA, deltaB };
}
