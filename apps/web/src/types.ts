export type SkinMarket = {
  id: string;
  name: string;
  condition: string;
  question: string;
  resolves: string;
  currentPrice: string;
  change: number;
  yes: number;
  volume: string;
  accent: number;
  image: string;
  marketUrl: string;
  position: [number, number, number];
};

export type VoteSide = "YES" | "NO";

export type VoteCount = { YES: number; NO: number };

export type PortfolioDisplayEntry = {
  marketName: string;
  side: VoteSide;
  amount: number;
  contracts: number;
  entryPrice: number;
  resolves: string;
};

export type DemoWorldCupPrediction = {
  id: string;
  orderId: string;
  outcomeId: number;
  marketName: string;
  description: string;
  side: VoteSide;
  contracts: number;
  limitPrice: number;
  orderValue: number;
  burnAmount: number;
  status: string;
  createdAt: number;
};
