import mongoose, { Document, Schema } from 'mongoose';

export interface IPlayer extends Document {
  username: string;
  email?: string;
  passwordHash?: string;
  isRegistered: boolean;
  elo: number;
  badges: string[];
  currentStreak: number;
  bestStreak: number;
  claimedBy?: mongoose.Types.ObjectId;
  claimStatus?: 'pending' | 'approved' | 'rejected';
  claimRequestedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
}

const PlayerSchema = new Schema<IPlayer>(
  {
    username: { type: String, required: true, trim: true },
    email: { type: String, unique: true, sparse: true, lowercase: true },
    passwordHash: { type: String },
    isRegistered: { type: Boolean, default: false },
    elo: { type: Number, default: 1200 },
    badges: [{ type: String }],
    currentStreak: { type: Number, default: 0 },
    bestStreak: { type: Number, default: 0 },
    claimedBy: { type: Schema.Types.ObjectId, ref: 'Player' },
    claimStatus: { type: String, enum: ['pending', 'approved', 'rejected'] },
    claimRequestedBy: { type: Schema.Types.ObjectId, ref: 'Player' },
  },
  { timestamps: true }
);

export default mongoose.model<IPlayer>('Player', PlayerSchema);
