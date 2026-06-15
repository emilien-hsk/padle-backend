import mongoose, { Document, Schema } from 'mongoose';

export interface ISetScore {
  teamA_Score: number;
  teamB_Score: number;
  isComplete: boolean;
}

export interface IMatch extends Document {
  date: Date;
  teamA: mongoose.Types.ObjectId[];
  teamB: mongoose.Types.ObjectId[];
  scores: ISetScore[];
  winner: 'teamA' | 'teamB' | 'draw';
  coefficient: 0.5 | 1.0;
  submittedBy: mongoose.Types.ObjectId;
  validated: boolean;
  eloChanges: {
    playerId: mongoose.Types.ObjectId;
    delta: number;
  }[];
}

const SetScoreSchema = new Schema<ISetScore>(
  {
    teamA_Score: { type: Number, required: true, min: 0 },
    teamB_Score: { type: Number, required: true, min: 0 },
    isComplete: { type: Boolean, default: true },
  },
  { _id: false }
);

const MatchSchema = new Schema<IMatch>(
  {
    date: { type: Date, default: Date.now },
    teamA: [{ type: Schema.Types.ObjectId, ref: 'Player', required: true }],
    teamB: [{ type: Schema.Types.ObjectId, ref: 'Player', required: true }],
    scores: [SetScoreSchema],
    winner: { type: String, enum: ['teamA', 'teamB', 'draw'], required: true },
    coefficient: { type: Number, enum: [0.5, 1.0], required: true },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'Player', required: true },
    validated: { type: Boolean, default: false },
    eloChanges: [
      {
        playerId: { type: Schema.Types.ObjectId, ref: 'Player' },
        delta: { type: Number },
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model<IMatch>('Match', MatchSchema);
