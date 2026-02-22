// ============================================================
// Calculation (exact port from index.jsx Calculation class)
// All arithmetic uses BigInt fixed-point (scaled by 10^8)
// ============================================================

var Calculation = {
  // --- Initial Margin ---
  calculateInitialMargin: function (positionSize, marketConfig) {
    var imf = BN(marketConfig.initialMarginFraction);
    var bps = BN(marketConfig.basePositionSize);
    var ips = BN(marketConfig.incrementalPositionSize);
    var iimf = BN(marketConfig.incrementalInitialMarginFraction);

    positionSize = bnAbs(BN(positionSize));
    var finalIM = imf;
    var diff = positionSize - bps;

    if (diff > 0n) {
      // ceil(diff / ips): since both are scaled, ratio is unscaled integer
      var steps = (diff + ips - 1n) / ips;
      // steps is unscaled, iimf is scaled -> product is scaled
      finalIM = finalIM + steps * iimf;
    }
    return finalIM;
  },

  // --- Notional helpers ---
  calculateValueFromIndexPrice: function (size, price) {
    return bnMul(BN(size), BN(price));
  },
  calculateValueFromEntryPrice: function (size, price) {
    return bnMul(BN(size), BN(price));
  },

  // --- Initialize open position result ---
  InitializeEntry: function (
    mr, finalIM, mc, feeConfig, absSize, pos, size,
    ipNot, etNot, side, results, key
  ) {
    var indexPrice = BN(pos.indexPrice);
    var entryPrice = BN(pos.entryPrice);
    var maker = BN(feeConfig[0].maker);
    var taker = BN(feeConfig[0].taker);
    var mmf = BN(mc.maintenanceMarginFraction);

    mr.totalIMF = mr.totalIMF + finalIM;
    mr.MMF = mr.MMF + mmf;
    mr.InitialMargin = mr.InitialMargin + bnMul(bnMul(finalIM, absSize), indexPrice);

    // quoteRequired: maker uses =, taker uses +=
    mr.quoteRequiredIfMaker =
      bnMul(bnMul(finalIM, absSize), indexPrice) +
      bnMul(bnMul(absSize, entryPrice), maker);
    mr.quoteRequiredIfTaker = mr.quoteRequiredIfTaker +
      bnMul(bnMul(finalIM, absSize), indexPrice) +
      bnMul(bnMul(absSize, entryPrice), taker);

    var makerPct = feeConfig[0].maker * 100 + "%";
    var takerPct = feeConfig[0].taker * 100 + "%";
    mr["feeIfMaker:" + makerPct] = bnMul(bnMul(absSize, entryPrice), maker);
    mr["feeIfTaker:" + takerPct] = bnMul(bnMul(absSize, entryPrice), taker);

    mr.maintenanceRequirement = mr.maintenanceRequirement +
      bnMul(bnMul(mmf, absSize), indexPrice);
    mr.absPositionSize = mr.absPositionSize + absSize;
    mr.positionSize = mr.positionSize + size;
    mr.indexPrice = mr.indexPrice + indexPrice;
    mr.entryPrice = mr.entryPrice + entryPrice;
    mr.totalIPNotional = mr.totalIPNotional + ipNot;
    mr.totalETNotionalCB = mr.totalETNotionalCB + etNot;
    mr.realizedOnOpen = mr.realizedOnOpen + BN(pos.realizedOnOpen);
    mr.positionSide = side;

    results.set(key, mr);
  },

  // --- Initialize close position result ---
  InitializeExit: function (
    mr, finalIM, mc, feeConfig, absSize, pos, size,
    prevAbsSize, prevSize, exitPrice, side, status,
    exitQty, closeFees, results, key
  ) {
    var indexPrice = BN(pos.indexPrice);
    var entryPrice = BN(pos.entryPrice);
    var maker = BN(feeConfig[0].maker);
    var taker = BN(feeConfig[0].taker);

    mr.totalIMF = mr.totalIMF + finalIM;
    mr.MMF = BN(mc.maintenanceMarginFraction);
    mr.InitialMargin = bnMul(bnMul(finalIM, absSize), indexPrice);

    var makerPct = feeConfig[0].maker * 100 + "%";
    var takerPct = feeConfig[0].taker * 100 + "%";
    mr["closeFeeIfMaker:" + makerPct] = bnMul(bnMul(bnAbs(exitQty), exitPrice), maker);
    mr["closeFeeIfTaker:" + takerPct] = bnMul(bnMul(bnAbs(exitQty), exitPrice), taker);

    mr.maintenanceRequirement = bnMul(bnMul(mr.MMF, absSize), indexPrice);
    mr.absPositionSize = absSize;
    mr.positionSize = size;
    mr.previousabsPositionSize = prevAbsSize;
    mr.previousPositionSize = prevSize;
    mr.indexPrice = indexPrice;
    mr.entryPrice = entryPrice;
    mr.exitPrice = exitPrice;
    mr.totalIPNotional = bnMul(indexPrice, size);
    mr.totalETNotionalCB = bnMul(entryPrice, size);
    mr.realizedOnOpen = BN(pos.realizedOnOpen);
    mr.unrealizedPNL = size > 0n
      ? bnMul(indexPrice - entryPrice, size)
      : bnMul(entryPrice - indexPrice, size);
    mr.positionSide = side;
    mr.status = status;

    mr.realizedOnClose = side === "LONG"
      ? bnMul(exitPrice - entryPrice, bnAbs(exitQty)) + closeFees + BN(pos.realizedOnOpen)
      : bnMul(entryPrice - exitPrice, bnAbs(exitQty)) + closeFees + BN(pos.realizedOnOpen);

    results.set(key, mr);
  },

  // --- Post-open calculations ---
  CalculateEntry: function (
    results, totalAV, positions, usdAfter, cpMultiplier, availCollateral
  ) {
    // Leverage
    results.forEach(function (mr) {
      mr.leverage = bnDiv(bnAbs(mr.totalIPNotional), totalAV);
    });

    // Maintenance Price
    results.forEach(function (current, currentKey) {
      var denom = bnMul(bnAbs(current.positionSize), current.MMF) - current.positionSize;
      if (positions.length === 1) {
        current.maintenancePrice = bnDiv(usdAfter, denom);
      } else {
        var num = 0n;
        results.forEach(function (other, otherKey) {
          if (currentKey !== otherKey) {
            num = num + other.totalIPNotional -
              bnMul(bnMul(bnAbs(other.positionSize), other.indexPrice), other.MMF);
          }
        });
        current.maintenancePrice = bnDiv(num + usdAfter, denom);
      }
    });

    // Close Price
    results.forEach(function (mr) {
      if (mr.positionSide === "LONG") {
        mr.closePrice = bnMul(mr.indexPrice, SCALE - bnMul(mr.MMF, cpMultiplier));
      } else {
        mr.closePrice = bnMul(mr.indexPrice, SCALE + bnMul(mr.MMF, cpMultiplier));
      }
    });

    // Zero Price
    results.forEach(function (mr) {
      mr.zeroPrice = bnDiv(bnMul(mr.indexPrice, mr.positionSize) - totalAV, mr.positionSize);
    });

    // Unrealized PNL
    results.forEach(function (mr) {
      if (mr.positionSide === "LONG") {
        mr.unrealizedPNL = bnMul(mr.indexPrice - mr.entryPrice, mr.absPositionSize);
      } else {
        mr.unrealizedPNL = bnMul(mr.entryPrice - mr.indexPrice, mr.absPositionSize);
      }
    });

    // Maximum Leverage & IMFO
    results.forEach(function (mr) {
      var notional = bnMul(mr.indexPrice, mr.positionSize);
      var collateral = availCollateral + bnAbs(bnMul(notional, mr.totalIMF));
      var absNotional = bnAbs(notional);
      mr.maximumLeverage = bnCeilToInt(bnMax(SCALE, bnDiv(absNotional, collateral)));
      mr.maximumIMFO = bnMin(SCALE, bnDiv(collateral, absNotional));
    });
  },

  // --- Post-close calculations ---
  CalculateExit: function (
    results, totalAV, positions, usdAfter, _openResults,
    cpMultiplier, _prevTotalAV, _prevIMR, availCollateral
  ) {
    // Leverage
    results.forEach(function (mr) {
      mr.leverage = bnDiv(bnAbs(mr.totalIPNotional), totalAV);
    });

    // Maintenance Price
    results.forEach(function (current, currentKey) {
      var denom = bnMul(bnAbs(current.positionSize), current.MMF) - current.positionSize;
      if (positions.length === 1) {
        current.maintenancePrice = bnDiv(usdAfter, denom);
      } else {
        var num = 0n;
        results.forEach(function (other, otherKey) {
          if (currentKey !== otherKey) {
            num = num + other.totalIPNotional -
              bnMul(bnMul(bnAbs(other.positionSize), other.indexPrice), other.MMF);
          }
        });
        current.maintenancePrice = bnDiv(num + usdAfter, denom);
      }
    });

    // Close Price
    results.forEach(function (mr) {
      if (mr.positionSize !== 0n) {
        if (mr.positionSide === "LONG") {
          mr.closePrice = bnMul(mr.indexPrice, SCALE - bnMul(mr.MMF, cpMultiplier));
        } else {
          mr.closePrice = bnMul(mr.indexPrice, SCALE + bnMul(mr.MMF, cpMultiplier));
        }
      } else {
        mr.closePrice = 0n;
      }
    });

    // Zero Price
    results.forEach(function (mr) {
      if (mr.positionSize !== 0n) {
        mr.zeroPrice = bnDiv(bnMul(mr.indexPrice, mr.positionSize) - totalAV, mr.positionSize);
      } else {
        mr.zeroPrice = 0n;
      }
    });

    // Unrealized PNL
    results.forEach(function (mr) {
      if (mr.positionSide === "LONG") {
        mr.unrealizedPNL = bnMul(mr.indexPrice - mr.entryPrice, mr.absPositionSize);
      } else {
        mr.unrealizedPNL = bnMul(mr.entryPrice - mr.indexPrice, mr.absPositionSize);
      }
    });

    // Maximum Leverage & IMFO
    results.forEach(function (mr) {
      var notional = bnMul(mr.indexPrice, mr.positionSize);
      var collateral = availCollateral + bnAbs(bnMul(notional, mr.totalIMF));
      var absNotional = bnAbs(notional);
      mr.maximumLeverage = bnCeilToInt(bnMax(SCALE, bnDiv(absNotional, collateral)));
      mr.maximumIMFO = bnMin(SCALE, bnDiv(collateral, absNotional));
    });
  },
};
