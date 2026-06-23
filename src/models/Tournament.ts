import mongoose, { Document, Schema } from 'mongoose';

export interface ITournamentMatch {
  teamAIndex: number;
  teamBIndex: number;
  matchId?: mongoose.Types.ObjectId;
  status: 'pending' | 'completed';
  phase: 'pool' | 'final';
  poolIndex?: number;
  groupIndex?: number;
}

export interface ITournament extends Document {
  name: string;
  status: 'pool_stage' | 'playoffs' | 'completed';
  countForRanking: boolean;
  teams: { players: mongoose.Types.ObjectId[] }[];
  pools: number[][];
  rankGroups: number[][];
  matches: ITournamentMatch[];
  createdAt: Date;
}

const TournamentSchema = new Schema<ITournament>(
  {
    name: { type: String, required: true },
    status: { type: String, enum: ['pool_stage', 'playoffs', 'completed'], default: 'pool_stage' },
    countForRanking: { type: Boolean, default: false },
    teams: [{ players: [{ type: Schema.Types.ObjectId, ref: 'Player' }] }],
    pools: { type: [[Number]], default: [] },
    rankGroups: { type: [[Number]], default: [] },
    matches: [
      {
        teamAIndex: { type: Number, required: true },
        teamBIndex: { type: Number, required: true },
        matchId: { type: Schema.Types.ObjectId, ref: 'Match' },
        status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
        phase: { type: String, enum: ['pool', 'final'], default: 'pool' },
        poolIndex: { type: Number },
        groupIndex: { type: Number },
        _id: false,
      },
    ],
  },
  { timestamps: true }
);

export default mongoose.model<ITournament>('Tournament', TournamentSchema);
