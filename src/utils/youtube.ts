/**
 * On ne stocke jamais l'URL collée par l'utilisateur, uniquement l'identifiant
 * de la vidéo : les liens YouTube traînent des paramètres de suivi, existent
 * sous cinq formes différentes, et une URL de playlist casserait le lecteur.
 * L'identifiant seul est stable et suffit à reconstruire l'embed.
 */

/** Un identifiant YouTube fait toujours 11 caractères dans cet alphabet. */
const ID = /^[A-Za-z0-9_-]{11}$/;

const PATTERNS: RegExp[] = [
  /[?&]v=([A-Za-z0-9_-]{11})/,          // youtube.com/watch?v=ID
  /youtu\.be\/([A-Za-z0-9_-]{11})/,     // youtu.be/ID
  /\/embed\/([A-Za-z0-9_-]{11})/,       // youtube.com/embed/ID
  /\/shorts\/([A-Za-z0-9_-]{11})/,      // youtube.com/shorts/ID
  /\/live\/([A-Za-z0-9_-]{11})/,        // youtube.com/live/ID
];

/**
 * Extrait l'identifiant d'un lien YouTube, ou null si ce n'en est pas un.
 * Accepte aussi un identifiant collé seul.
 */
export function parseYouTubeId(input: string): string | null {
  const raw = (input ?? '').trim();
  if (!raw) return null;

  if (ID.test(raw)) return raw;

  for (const pattern of PATTERNS) {
    const match = raw.match(pattern);
    if (match) return match[1];
  }

  return null;
}
