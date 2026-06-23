import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import Player from '../models/Player';

dotenv.config({ path: require('path').resolve(__dirname, '../../../.env') });
// fallback si path résolu échoue
if (!process.env.MONGODB_URI) dotenv.config();

async function createAdmin() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/padle');

  const existing = await Player.findOne({ email: 'admin@gmail.com' });
  if (existing) {
    existing.isAdmin = true;
    existing.passwordHash = await bcrypt.hash('padlecau', 10);
    await existing.save();
    console.log('Compte admin mis à jour.');
  } else {
    await Player.create({
      username: 'admin',
      email: 'admin@gmail.com',
      passwordHash: await bcrypt.hash('padlecau', 10),
      isRegistered: true,
      isAdmin: true,
      elo: 1200,
    });
    console.log('Compte admin créé.');
  }

  await mongoose.disconnect();
  process.exit(0);
}

createAdmin().catch((e) => { console.error(e); process.exit(1); });
