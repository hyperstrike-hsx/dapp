import {describe,it,expect} from "vitest";
import {demoMarkets,INDEXES} from "./markets";
import {validateDefinition} from "@hyperstrike/market-types";
describe("index-only prediction boundary",()=>{
  it("only constructs canonical index definitions",()=>{
    for(const m of demoMarkets){expect(INDEXES.some(i=>i.indexId===m.definition.indexId)).toBe(true);expect(m).not.toHaveProperty("marketUrl");expect(m.definition).not.toHaveProperty("constituentId");expect(m.provenance).toBe("DEMO");}
  });
  it("rejects an item masquerading as an index",()=>{
    expect(()=>validateDefinition({...demoMarkets[0].definition,indexId:"0x1234"},Math.floor(Date.now()/1000),{valueE8:1000_00000000n,observedAt:Math.floor(Date.now()/1000),confidenceBps:10000})).toThrow("canonical");
  });
});
