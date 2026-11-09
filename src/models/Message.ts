import mongoose, { Document, Schema } from 'mongoose';

export interface IProposal {
  start: Date;
  duration: number;
  courtId?: string;
  courtNumber?: number;
  courtName?: string;
  bookingUrl?: string;
  votes: mongoose.Types.ObjectId[];
  status: 'open' | 'confirmed';
  scorePromptSent?: boolean;
}

/** Message automatique « Ajoute le score » envoyé après un match validé. */
export interface IScorePrompt {
  proposal: mongoose.Types.ObjectId; // message de la proposition validée
  start: Date;
  duration: number;
  courtNumber?: number;
  status: 'pending' | 'recorded' | 'dismissed';
  matchId?: mongoose.Types.ObjectId;
  doneBy?: mongoose.Types.ObjectId;
}

export interface IMessage extends Document {
  channel: mongoose.Types.ObjectId;
  author?: mongoose.Types.ObjectId; // absent pour les messages système
  kind: 'text' | 'system' | 'proposal' | 'score_prompt';
  text: string;
  proposal?: IProposal;
  scorePrompt?: IScorePrompt;
  expiresAt: Date;
  createdAt: Date;
}

const MessageSchema = new Schema<IMessage>(
  {
    channel: { type: Schema.Types.ObjectId, ref: 'Channel', required: true, index: true },
    author: { type: Schema.Types.ObjectId, ref: 'Player' },
    kind: { type: String, enum: ['text', 'system', 'proposal', 'score_prompt'], required: true },
    text: { type: String, default: '', maxlength: 500 },
    proposal: {
      type: {
        start: { type: Date, required: true },
        duration: { type: Number, required: true },
        courtId: String,
        courtNumber: Number,
        courtName: String,
        bookingUrl: String,
        votes: [{ type: Schema.Types.ObjectId, ref: 'Player' }],
        status: { type: String, enum: ['open', 'confirmed'], default: 'open' },
        scorePromptSent: { type: Boolean, default: false },
      },
      _id: false,
      default: undefined,
    },
    scorePrompt: {
      type: {
        proposal: { type: Schema.Types.ObjectId, ref: 'Message', required: true },
        start: { type: Date, required: true },
        duration: { type: Number, required: true },
        courtNumber: Number,
        status: { type: String, enum: ['pending', 'recorded', 'dismissed'], default: 'pending' },
        matchId: { type: Schema.Types.ObjectId, ref: 'Match' },
        doneBy: { type: Schema.Types.ObjectId, ref: 'Player' },
      },
      _id: false,
      default: undefined,
    },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

MessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
MessageSchema.index({ channel: 1, createdAt: 1 });

export default mongoose.model<IMessage>('Message', MessageSchema);
