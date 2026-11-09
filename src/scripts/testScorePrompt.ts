/**
 * Dépose une carte « Match terminé » de TEST dans une discussion, pour voir le rendu.
 *
 *   npm run test-score-prompt            → dans la discussion active la plus récente
 *   npm run test-score-prompt -- <id>    → dans une discussion précise
 *   npm run test-score-prompt -- --remove → supprime les cartes de test
 *
 * N'enregistre aucun match. Attention : si tu cliques « Ajouter le score » puis valides,
 * un vrai match est créé (utilise plutôt « Ne pas enregistrer cette partie »).
 */
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import Channel from '../models/Channel';
import Message from '../models/Message';

dotenv.config();
const TEST_MARKER = '[test-score-prompt]';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/padle');
  const arg = process.argv[2];

  if (arg === '--remove') {
    const { deletedCount } = await Message.deleteMany({ kind: 'score_prompt', text: TEST_MARKER });
    console.log(`🧹 ${deletedCount} carte(s) de test supprimée(s).`);
    return;
  }

  const channel = arg
    ? await Channel.findById(arg)
    : await Channel.findOne({ expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });

  if (!channel) {
    console.log('❌ Aucune discussion active. Crée deux dispos qui se chevauchent avec deux comptes, puis relance.');
    return;
  }

  const duration = 90;
  const start = new Date(Date.now() - (duration + 1) * 60000);
  start.setSeconds(0, 0);
  const expiresAt = new Date(Math.max(channel.expiresAt.getTime(), Date.now() + 24 * 3600 * 1000));

  await Message.create({
    channel: channel._id,
    kind: 'score_prompt',
    text: TEST_MARKER,
    scorePrompt: {
      proposal: new mongoose.Types.ObjectId(),
      start,
      duration,
      courtNumber: 4,
      status: 'pending',
    },
    expiresAt,
  });
  channel.lastMessageAt = new Date();
  await channel.save();

  console.log(`✅ Carte de test ajoutée dans la discussion ${channel._id}`);
  console.log(`   Ouvre : http://localhost:5173/channels/${channel._id}`);
  console.log('   Pour la retirer : npm run test-score-prompt -- --remove');
}

main()
  .catch((err) => console.error(err))
  .finally(() => mongoose.disconnect());
