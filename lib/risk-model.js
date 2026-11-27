"use strict";

const DEFAULT_RISK_PERCENT = 2;
const MIN_BALANCE_EUR = 160;
const MAX_BALANCE_EUR = 500;

/**
 * EUR-denominated account risk planning.
 * Position sizing is deliberately fail-closed: broker contract data, EUR
 * conversion, and round-trip costs must be supplied from verified sources.
 */
function getRiskBudgetEUR(balanceEUR, riskPercent = DEFAULT_RISK_PERCENT) {
  if (!Number.isFinite(balanceEUR) || balanceEUR <= 0) {
    throw new Error("INVALID_ACCOUNT_BALANCE_EUR");
  }
  if (!Number.isFinite(riskPercent) || riskPercent <= 0 || riskPercent > 2) {
    throw new Error("RISK_PERCENT_OUT_OF_RANGE");
  }
  return Number((balanceEUR * riskPercent / 100).toFixed(2));
}

function calculatePositionSizeEUR({
  balanceEUR,
  riskPercent = DEFAULT_RISK_PERCENT,
  entryPrice,
  stopPrice,
  contractSize,
  usdToEur,
  minVolume,
  volumeStep,
  roundTripCostEURPerLot
}) {
  const riskBudgetEUR = getRiskBudgetEUR(balanceEUR, riskPercent);
  const required = {
    entryPrice, stopPrice, contractSize, usdToEur,
    minVolume, volumeStep, roundTripCostEURPerLot
  };
  if (Object.values(required).some(value => !Number.isFinite(value) || value <= 0)) {
    return { ok: false, status: "BLOCKED", reason: "BROKER_SPEC_OR_COST_DATA_UNVERIFIED", riskBudgetEUR };
  }

  const stopDistance = Math.abs(entryPrice - stopPrice);
  if (stopDistance <= 0) {
    return { ok: false, status: "BLOCKED", reason: "INVALID_STOP_DISTANCE", riskBudgetEUR };
  }

  const stopRiskEURPerLot = stopDistance * contractSize * usdToEur;
  const totalRiskEURPerLot = stopRiskEURPerLot + roundTripCostEURPerLot;
  if (!Number.isFinite(totalRiskEURPerLot) || totalRiskEURPerLot <= 0) {
    return { ok: false, status: "BLOCKED", reason: "INVALID_RISK_PER_LOT", riskBudgetEUR };
  }

  const rawVolume = riskBudgetEUR / totalRiskEURPerLot;
  const steps = Math.floor((rawVolume + 1e-10) / volumeStep);
  const volume = Number((steps * volumeStep).toFixed(8));
  if (volume < minVolume) {
    return {
      ok: false,
      status: "BLOCKED",
      reason: "MINIMUM_VOLUME_EXCEEDS_RISK_BUDGET",
      riskBudgetEUR,
      minimumVolumeRiskEUR: Number((minVolume * totalRiskEURPerLot).toFixed(2))
    };
  }

  const estimatedRiskEUR = Number((volume * totalRiskEURPerLot).toFixed(2));
  if (estimatedRiskEUR > riskBudgetEUR + 0.01) {
    return { ok: false, status: "BLOCKED", reason: "RISK_CAP_EXCEEDED_AFTER_ROUNDING", riskBudgetEUR };
  }

  return {
    ok: true,
    status: "CALCULATED_NOT_BROKER_VERIFIED",
    volume,
    riskBudgetEUR,
    estimatedRiskEUR,
    stopRiskEUR: Number((volume * stopRiskEURPerLot).toFixed(2)),
    estimatedRoundTripCostEUR: Number((volume * roundTripCostEURPerLot).toFixed(2)),
    stopDistancePrice: Number(stopDistance.toFixed(5))
  };
}

module.exports = {
  DEFAULT_RISK_PERCENT,
  MIN_BALANCE_EUR,
  MAX_BALANCE_EUR,
  getRiskBudgetEUR,
  calculatePositionSizeEUR
};
