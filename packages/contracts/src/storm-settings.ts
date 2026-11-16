import { z } from "zod";

const weight = z.number().int().min(0).max(10000);
const symbolWeights = z
  .object({
    ruby: weight,
    emerald: weight,
    sapphire: weight,
    amber: weight,
    lotus: weight,
    scarab: weight,
    sun: weight,
    moon: weight,
    gold: weight,
    scatter: weight,
    orb: weight,
  })
  .strict()
  .refine((v) => Object.values(v).reduce((a, b) => a + b, 0) === 10000, "符號機率總和須為 100%");
const pay = z.number().int().min(1).max(100000);
export const stormSettingsSchema = z
  .object({
    symbolWeights,
    // Multiples in hundredths, before the calibrated global payout scale.
    paytable: z
      .object({
        ruby: pay,
        emerald: pay,
        sapphire: pay,
        amber: pay,
        lotus: pay,
        scarab: pay,
        sun: pay,
        moon: pay,
      })
      .strict(),
    orbWeights: z
      .object({ "2": weight, "3": weight, "5": weight, "10": weight })
      .strict()
      .refine(
        (v) => Object.values(v).reduce((a, b) => a + b, 0) === 10000,
        "倍數球機率總和須為 100%",
      ),
    freeInitial: z.number().int().min(1).max(15),
    freeRetrigger: z.number().int().min(0).max(15),
    freeMax: z.number().int().min(1).max(100),
    scatterTrigger: z.number().int().min(3).max(30),
    scatterRetrigger: z.number().int().min(3).max(30),
    freePayDivisor: z.number().int().min(1).max(100),
    normalUpgradeChance: weight,
    superUpgradeChance: weight,
    upgradeMode: z.enum(["once", "repeat"]),
    orbMax: z.number().int().min(10).max(1000),
    factorCap: z.number().int().min(1).max(3030000),
    accumulatorCap: z.number().int().min(0).max(3000000),
    maxCascades: z.number().int().min(1).max(12),
    count10Factor: z.number().int().min(1).max(20),
    count12Factor: z.number().int().min(1).max(20),
    superBonus: z.tuple([
      z.number().int().min(0).max(2500000),
      z.number().int().min(0).max(2500000),
      z.number().int().min(0).max(2500000),
      z.number().int().min(0).max(2500000),
    ]),
    capScope: z.enum(["spin", "cycle"]),
  })
  .strict()
  .refine((v) => v.freeInitial <= v.freeMax, "初始免費回合不可超過系列上限");
export type StormSettings = z.infer<typeof stormSettingsSchema>;
export const STORM_LEGACY_SETTINGS: StormSettings = {
  symbolWeights: {
    ruby: 1200,
    emerald: 1300,
    sapphire: 1600,
    amber: 1700,
    lotus: 1400,
    scarab: 1500,
    gold: 100,
    sun: 300,
    moon: 300,
    scatter: 300,
    orb: 300,
  },
  paytable: {
    ruby: 120,
    emerald: 100,
    sapphire: 50,
    amber: 60,
    lotus: 80,
    scarab: 40,
    sun: 200,
    moon: 150,
  },
  orbWeights: { "2": 2500, "3": 2500, "5": 2500, "10": 2500 },
  freeInitial: 15,
  freeRetrigger: 5,
  freeMax: 100,
  scatterTrigger: 4,
  scatterRetrigger: 3,
  freePayDivisor: 1,
  normalUpgradeChance: 2000,
  superUpgradeChance: 6000,
  upgradeMode: "repeat",
  orbMax: 1000,
  factorCap: 3030000,
  accumulatorCap: 3000000,
  maxCascades: 12,
  count10Factor: 2,
  count12Factor: 3,
  superBonus: [10000, 50000, 500000, 2500000],
  capScope: "spin",
};
export const STORM_BALANCED_SETTINGS: StormSettings = {
  ...STORM_LEGACY_SETTINGS,
  symbolWeights: {
    ruby: 1150,
    emerald: 1250,
    sapphire: 1700,
    amber: 1950,
    lotus: 1200,
    scarab: 1650,
    sun: 200,
    moon: 200,
    gold: 10,
    scatter: 250,
    orb: 440,
  },
  orbWeights: { "2": 7500, "3": 2000, "5": 450, "10": 50 },
  freeInitial: 10,
  freeRetrigger: 3,
  freeMax: 30,
  freePayDivisor: 3,
  normalUpgradeChance: 1000,
  superUpgradeChance: 2000,
  upgradeMode: "once",
  orbMax: 20,
  factorCap: 20,
  accumulatorCap: 10,
  superBonus: [200, 500, 1000, 2500],
  capScope: "cycle",
};
