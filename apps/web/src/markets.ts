import {INDEXES,expiryTime,levelThresholds,marketKey,question,SETTLEMENT_POLICY_ID,type MarketDefinition} from "@hyperstrike/market-types";
import type {IndexMarket} from "./types";
export {INDEXES};
// Illustrative sandbox. Never published to the oracle or presented as live prices.
const now=Math.floor(Date.now()/1000);
export const demoMarkets:IndexMarket[]=INDEXES.map((index,i)=>{
  const resolutionTime=expiryTime("WEEKLY",now);
  const definition:MarketDefinition={indexId:index.indexId,template:"LEVEL",direction:"UP",thresholdE8:levelThresholds(1000_00000000n,"WEEKLY")[3],creationReferenceTime:0,creationReferenceValueE8:0n,tradeCloseTime:resolutionTime-300,resolutionTime,settlementPolicyId:SETTLEMENT_POLICY_ID};
  return {id:marketKey(definition),definition,provenance:"DEMO",name:index.ticker,condition:index.name.toUpperCase(),question:question(definition),resolves:new Date(resolutionTime*1000).toLocaleString("en-GB",{timeZone:"UTC",day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"})+" UTC",currentPrice:"1,000.00",change:0,yes:50,volume:"DEMO",accent:i%2?0xe89a42:0x8ef5e3,position:([[-5.5,0,-6],[0,0,-8],[5.5,0,-6],[-4,0,-18],[4,0,-18]] as [number,number,number][])[i]};
});
