import Message from '../models/Message';
import Channel from '../models/Channel';
import { pushToChannel } from './channels';

/** Délai après la fin du créneau avant d'envoyer le message « Ajoute le score ». */
const DELAY_AFTER_END_MS = 60 * 1000;
const KEEP_AFTER_MATCH_MS = 24 * 3600 * 1000;
const CHECK_EVERY_MS = 30 * 1000;

const TZ = 'Europe/Brussels';
const timeFmt = new Intl.DateTimeFormat('fr-BE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });

let running = false;

/**
 * Envoie le message « Ajoute le score » pour chaque match validé terminé depuis ≥ 1 min.
 * Idempotent : chaque proposition est marquée avant l'envoi.
 */
export async function sendDueScorePrompts(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const threshold = new Date(Date.now() - DELAY_AFTER_END_MS);
    for (;;) {
      // Réserve atomiquement une proposition validée dont le créneau est fini
      const proposal = await Message.findOneAndUpdate(
        {
          kind: 'proposal',
          'proposal.status': 'confirmed',
          'proposal.scorePromptSent': { $ne: true },
          $expr: {
            $lte: [{ $add: ['$proposal.start', { $multiply: ['$proposal.duration', 60000] }] }, threshold],
          },
        },
        { $set: { 'proposal.scorePromptSent': true } },
        { new: true }
      );
      if (!proposal?.proposal) break;

      const channel = await Channel.findById(proposal.channel);
      if (!channel) continue;

      const p = proposal.proposal;
      const matchEnd = new Date(p.start.getTime() + p.duration * 60000);
      // Laisse 24 h pour saisir le score
      const keepUntil = new Date(matchEnd.getTime() + KEEP_AFTER_MATCH_MS);
      if (channel.expiresAt < keepUntil) {
        channel.expiresAt = keepUntil;
        await Message.updateMany({ channel: channel._id }, { $max: { expiresAt: keepUntil } });
      }

      await Message.create({
        channel: channel._id,
        kind: 'score_prompt',
        text: 'Match terminé ! Ajoute le score pour mettre à jour le classement.',
        scorePrompt: {
          proposal: proposal._id,
          start: p.start,
          duration: p.duration,
          courtNumber: p.courtNumber,
          status: 'pending',
        },
        expiresAt: channel.expiresAt,
      });
      channel.lastMessageAt = new Date();
      await channel.save();

      const when = `${timeFmt.format(p.start)}–${timeFmt.format(matchEnd)}`;
      pushToChannel(
        channel,
        '000000000000000000000000', // message automatique : tout le monde est notifié
        { title: '🎾 Match terminé', body: `Comment s'est passé le match de ${when} ? Ajoute le score.` },
        true
      ).catch(() => {});
    }
  } catch (err) {
    console.error('Erreur messages de score:', err);
  } finally {
    running = false;
  }
}

export function startScorePromptScheduler(): void {
  sendDueScorePrompts();
  setInterval(sendDueScorePrompts, CHECK_EVERY_MS);
}
