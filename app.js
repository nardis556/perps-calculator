// --- Application State ---
var state = {
  env: "dev",
  config: { marketConfigs: [] },
  defaultConfig: { marketConfigs: [] },
  positions: [],
  totalDeposits: 0,
  totalHeldFunds: 0,
  includeFees: false,
};

// Stores last calculation results for copy-all
var lastResults = null;

// ============================================================
// BigInt Fixed-Point Arithmetic (scale = 10^8)
// ============================================================

var SCALE = 100000000n; // 10^8

// Parse any value to a scaled BigInt (8 decimal fixed-point)
function BN(v) {
  if (typeof v === "bigint") return v;
  if (v === null || v === undefined || v === "") return 0n;
  var s;
  if (typeof v === "number") {
    if (!isFinite(v)) return 0n;
    s = v.toFixed(8);
  } else {
    s = String(v).trim();
  }
  if (s === "" || s === "NaN") return 0n;
  // Handle scientific notation
  if (s.indexOf("e") !== -1 || s.indexOf("E") !== -1) {
    s = Number(s).toFixed(8);
  }
  var neg = false;
  if (s.charAt(0) === "-") {
    neg = true;
    s = s.slice(1);
  }
  var dot = s.indexOf(".");
  var whole, frac;
  if (dot === -1) {
    whole = s;
    frac = "00000000";
  } else {
    whole = s.slice(0, dot) || "0";
    frac = (s.slice(dot + 1) + "00000000").slice(0, 8);
  }
  var result = BigInt(whole) * SCALE + BigInt(frac);
  return neg ? -result : result;
}

// Format a scaled BigInt back to "X.XXXXXXXX" string
function bnFmt(v) {
  if (typeof v !== "bigint") return String(v);
  var neg = v < 0n;
  if (neg) v = -v;
  var s = v.toString();
  while (s.length <= 8) s = "0" + s;
  var whole = s.slice(0, s.length - 8);
  var frac = s.slice(s.length - 8);
  return (neg ? "-" : "") + whole + "." + frac;
}

// Multiply two scaled values: (a * b) / SCALE
function bnMul(a, b) {
  return (a * b) / SCALE;
}

// Divide two scaled values: (a * SCALE) / b
function bnDiv(a, b) {
  if (b === 0n) return 0n;
  return (a * SCALE) / b;
}

// Absolute value
function bnAbs(a) {
  return a < 0n ? -a : a;
}

// Max / Min
function bnMax(a, b) {
  return a > b ? a : b;
}
function bnMin(a, b) {
  return a < b ? a : b;
}

// Ceiling to nearest integer (result stays in scaled form)
// e.g. 1.5 (150000000n) -> 2.0 (200000000n)
function bnCeilToInt(v) {
  if (v <= 0n) return v - (v % SCALE); // floor toward zero for non-positive
  var rem = v % SCALE;
  if (rem === 0n) return v;
  return v - rem + SCALE;
}

// Make BigInt JSON-serializable
BigInt.prototype.toJSON = function () {
  return bnFmt(this);
};

// ============================================================
// Helpers
// ============================================================

function toNum(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    var n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

function fmt(v) {
  if (typeof v === "bigint") return bnFmt(v);
  if (typeof v === "number") {
    if (!isFinite(v)) return String(v);
    return v.toFixed(8);
  }
  return String(v);
}

function logPadder(msg, len) {
  len = len || 100;
  var half = Math.max(0, Math.floor((len - msg.length) / 2));
  var pad = "-".repeat(half);
  var result = pad + msg + pad;
  if (result.length < len) result += "-";
  return result;
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ============================================================
// Clipboard helpers
// ============================================================

function copyToClipboard(text) {
  function fallback() {
    var ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    document.body.removeChild(ta);
  }
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {}, fallback);
    } else {
      fallback();
    }
  } catch (e) {
    fallback();
  }
}

function flashButton(btn, original) {
  btn.textContent = "Copied!";
  setTimeout(function () {
    btn.textContent = original;
  }, 1200);
}

function sectionToObject(data) {
  var obj = {};
  Object.entries(data).forEach(function (e) {
    obj[e[0]] = typeof e[1] === "bigint" ? bnFmt(e[1]) : e[1];
  });
  return obj;
}

function sectionToCSV(title, data) {
  var lines = [title];
  lines.push("Property,Value");
  Object.entries(data).forEach(function (e) {
    lines.push('"' + e[0] + '",' + fmt(e[1]));
  });
  return lines.join("\n");
}

function allResultsToJSON() {
  if (!lastResults) return "{}";
  var out = {};
  lastResults.sections.forEach(function (s) {
    out[s.title] = sectionToObject(s.data);
  });
  return JSON.stringify(out, null, 2);
}

function allResultsToCSV() {
  if (!lastResults) return "";
  var parts = [];
  lastResults.sections.forEach(function (s) {
    parts.push(sectionToCSV(s.title, s.data));
  });
  return parts.join("\n\n");
}

// ============================================================
// Config helpers
// ============================================================

function getMarketConfig(market, config) {
  return (
    config.marketConfigs.find(function (m) {
      return m.market === market;
    }) || null
  );
}

function getFees(config, market) {
  var mc = config.marketConfigs.find(function (m) {
    return m.market === market;
  });
  return [
    {
      maker: Number(mc && mc.makerFeeRate ? mc.makerFeeRate : -0.00005),
      taker: Number(mc && mc.takerFeeRate ? mc.takerFeeRate : 0.0003),
    },
  ];
}

// ============================================================
// Validation
// ============================================================

function validatePositions(deposit, positions, validMarkets) {
  var errors = [];
  if (deposit <= 0) errors.push("Please enter a valid deposit amount");
  if (positions.length === 0) errors.push("Please add at least one position");

  positions.forEach(function (pos, i) {
    var idx = i + 1;
    if (!validMarkets.has(pos.market))
      errors.push("Invalid market at position " + idx);
    if (pos.market === "-USD" || !pos.market)
      errors.push("Please select a market for position " + idx);
    if (!pos.quantity)
      errors.push("Please enter a valid quantity at position " + idx);
    if (!pos.entryPrice)
      errors.push("Please enter a valid entry price for position " + idx);
    if (!pos.indexPrice)
      errors.push("Please enter a valid index price for position " + idx);
    if (!pos.realizedOnOpen)
      errors.push("Please enter valid open fees for position " + idx);
  });

  return errors;
}

// ============================================================
// Load Markets from MARKET_CONFIGS global (config.js)
// ============================================================

function loadMarkets(env) {
  var markets = MARKET_CONFIGS[env] || [];
  if (markets.length === 0) return;

  state.config = { marketConfigs: deepClone(markets) };
  state.defaultConfig = deepClone(state.config);
  renderPositions();
}

// ============================================================
// Main Calculate (all arithmetic uses BigInt fixed-point)
// ============================================================

function calculateValues() {
  var marketResults = new Map();
  var marketResultsOnClose = new Map();

  var deposit = BN(state.totalDeposits);
  var depositNum = toNum(state.totalDeposits);
  var validMarkets = new Set(
    state.config.marketConfigs.map(function (mc) {
      return mc.market;
    }),
  );

  var errors = validatePositions(depositNum, state.positions, validMarkets);
  if (errors.length > 0) {
    alert(errors.join("\n"));
    return;
  }

  // Auto-compute fees when "Include Fees" is checked
  if (state.includeFees) {
    state.positions.forEach(function (pos, idx) {
      var feeConfig = getFees(state.config, pos.market);
      var takerRate = feeConfig[0].taker;
      var openNotional = Math.abs(toNum(pos.quantity)) * toNum(pos.entryPrice);
      var openFee = -(openNotional * takerRate);
      pos.realizedOnOpen = openFee;

      if (pos.exitPrice && pos.exitQuantity) {
        var closeNotional = Math.abs(toNum(pos.exitQuantity)) * toNum(pos.exitPrice);
        var closeFee = -(closeNotional * takerRate);
        pos.exitCloseFees = closeFee;
      }
    });
    renderPositions();
  }

  // ---- OPEN POSITIONS ----
  state.positions.forEach(function (pos) {
    var feeConfig = getFees(state.config, pos.market);
    var mc = getMarketConfig(pos.market, state.config);
    if (!mc) return;

    var absSize = bnAbs(BN(pos.quantity));
    var size = BN(pos.quantity);

    var finalIM = Calculation.calculateInitialMargin(absSize, mc);
    var ipNot = Calculation.calculateValueFromIndexPrice(size, pos.indexPrice);
    var etNot = Calculation.calculateValueFromEntryPrice(size, pos.entryPrice);

    var side = size > 0n ? "LONG" : "SHORT";
    var key = pos.market + ":" + side;

    var makerPct = feeConfig[0].maker * 100 + "%";
    var takerPct = feeConfig[0].taker * 100 + "%";

    if (!marketResults.has(key)) {
      var init = {
        totalIMF: 0n,
        MMF: 0n,
        InitialMargin: 0n,
        quoteRequiredIfMaker: 0n,
        quoteRequiredIfTaker: 0n,
        maintenanceRequirement: 0n,
        absPositionSize: 0n,
        positionSize: 0n,
        indexPrice: 0n,
        entryPrice: 0n,
        totalIPNotional: 0n,
        totalETNotionalCB: 0n,
        realizedOnOpen: 0n,
        realizedOnClose: 0n,
        positionSide: "",
      };
      init["feeIfMaker:" + makerPct] = 0n;
      init["feeIfTaker:" + takerPct] = 0n;
      marketResults.set(key, init);
    }

    Calculation.InitializeEntry(
      marketResults.get(key),
      finalIM,
      mc,
      feeConfig,
      absSize,
      pos,
      size,
      ipNot,
      etNot,
      side,
      marketResults,
      key,
    );
  });

  // ---- AGGREGATE OPEN WALLET ----
  var totalUSDChange = 0n;
  var totalIndexNotional = 0n;
  var totalRealizedFees = 0n;
  var totalIMR = 0n;
  var totalAbsIndexNotional = 0n;
  var totalMMR = 0n;

  marketResults.forEach(function (mr) {
    totalUSDChange = totalUSDChange - mr.totalETNotionalCB;
    totalIndexNotional = totalIndexNotional + mr.totalIPNotional;
    totalAbsIndexNotional = totalAbsIndexNotional + bnAbs(mr.totalIPNotional);
    totalRealizedFees = totalRealizedFees + mr.realizedOnOpen;
    totalIMR = totalIMR + mr.InitialMargin;
    totalMMR = totalMMR + mr.maintenanceRequirement;
  });

  var usdAfter = deposit + totalUSDChange + totalRealizedFees;
  var totalAV = usdAfter + totalIndexNotional;
  var cpMultiplier = bnDiv(totalAV, totalMMR);

  var imfValues = state.config.marketConfigs.map(function (mc) {
    return BN(mc.initialMarginFraction);
  });
  var lowestIMF = imfValues.reduce(function (min, v) {
    return v < min ? v : min;
  });

  var buyingPower = bnDiv(totalAV - totalIMR, lowestIMF);
  var freeCollateral = totalAV - totalIMR;
  var heldFunds = BN(state.totalHeldFunds);
  var availCollateral = freeCollateral - heldFunds;

  var walletResults = {
    "Total Deposit": deposit,
    "Total Account Value": totalAV,
    "Quote Balance": usdAfter,
    "Free Collateral": freeCollateral,
    "Available Collateral": availCollateral,
    "Margin Ratio": bnDiv(totalAV, totalAbsIndexNotional),
    "Total initial margin": totalIMR,
    "Total maintenance margin": totalMMR,
    "Close Price MP": cpMultiplier,
    "Buying Power": buyingPower,
    "Account Leverage": bnDiv(totalAbsIndexNotional, totalAV),
  };

  // Console output - open wallet
  console.log("\n");
  console.log(
    "%c" + logPadder("START", 50),
    "color: black; font-weight: bold; background-color: white;",
  );
  console.log(
    "%c" + logPadder("Wallet Results START", 50),
    "color: white; font-weight: bold; background-color: blue;",
  );
  console.table(
    Object.entries(walletResults).map(function (e) {
      return { Key: e[0], Value: fmt(e[1]) };
    }),
  );
  console.log(
    "%c" + logPadder("Wallet Results END", 50),
    "color: white; font-weight: bold; background-color: blue;",
  );

  // Calculate entry metrics
  Calculation.CalculateEntry(
    marketResults,
    totalAV,
    state.positions,
    usdAfter,
    cpMultiplier,
    availCollateral,
  );

  // Console output - open positions
  console.log("\n");
  console.log(
    "%c" + logPadder("Positions ON OPEN Results START", 50),
    "color: white; font-weight: bold; background-color: purple;",
  );
  marketResults.forEach(function (mr, key) {
    console.log(key);
    console.table(
      Object.entries(mr).map(function (e) {
        return { Property: e[0], Value: fmt(e[1]) };
      }),
    );
  });
  console.log(
    "%c" + logPadder("Positions ON OPEN Results END", 50),
    "color: white; font-weight: bold; background-color: purple;",
  );

  // ---- CLOSE POSITIONS ----
  var hasClose = false;

  state.positions.forEach(function (pos) {
    if (!pos.exitPrice || !pos.exitQuantity) return;
    hasClose = true;

    var mc = getMarketConfig(pos.market, state.config);
    if (!mc) return;

    var feeConfig = getFees(state.config, pos.market);
    var prevAbsSize = bnAbs(BN(pos.quantity));
    var prevSize = BN(pos.quantity);
    var exitQty = BN(pos.exitQuantity);
    var exitPrice = BN(pos.exitPrice);
    var newSize = prevSize + exitQty;

    // Check for closeAndOpen (side flip)
    if (newSize !== 0n && (prevSize > 0n) !== (newSize > 0n)) {
      alert(
        "A close could trigger a closeAndOpen fill.\n" +
          "The app does not support closeAndOpen directly.\n" +
          "Split into a closing trade and a new opening trade.",
      );
      return;
    }

    var absSize = bnAbs(newSize);
    var finalIM = Calculation.calculateInitialMargin(absSize, mc);
    var closeFees = BN(pos.exitCloseFees);
    var side = prevSize > 0n ? "LONG" : "SHORT";
    var status = newSize === 0n ? "CLOSED" : "OPEN";
    var key = pos.market + ":" + side;

    var makerPct = feeConfig[0].maker * 100 + "%";
    var takerPct = feeConfig[0].taker * 100 + "%";

    if (!marketResultsOnClose.has(key)) {
      var init = {
        totalIMF: 0n,
        MMF: 0n,
        InitialMargin: 0n,
        maintenanceRequirement: 0n,
        absPositionSize: 0n,
        positionSize: 0n,
        previousabsPositionSize: 0n,
        previousPositionSize: 0n,
        indexPrice: 0n,
        entryPrice: 0n,
        exitPrice: 0n,
        totalIPNotional: 0n,
        totalETNotionalCB: 0n,
        realizedOnOpen: 0n,
        realizedOnClose: 0n,
        unrealizedPNL: 0n,
        positionSide: "",
        status: "",
      };
      init["closeFeeIfMaker:" + makerPct] = 0n;
      init["closeFeeIfTaker:" + takerPct] = 0n;
      marketResultsOnClose.set(key, init);
    }

    Calculation.InitializeExit(
      marketResultsOnClose.get(key),
      finalIM,
      mc,
      feeConfig,
      absSize,
      pos,
      newSize,
      prevAbsSize,
      prevSize,
      exitPrice,
      side,
      status,
      exitQty,
      closeFees,
      marketResultsOnClose,
      key,
    );
  });

  // ---- CLOSE WALLET ----
  var finalWalletResults = {};
  if (hasClose) {
    // Merge open positions without close into close results
    marketResults.forEach(function (v, k) {
      if (!marketResultsOnClose.has(k)) {
        marketResultsOnClose.set(k, v);
      }
    });

    var finalUSDChange = 0n;
    var finalIndexNotional = 0n;
    var finalRealizedFees = 0n;
    var finalIMR = 0n;
    var finalAbsIndexNotional = 0n;
    var finalMMR = 0n;

    marketResultsOnClose.forEach(function (mr) {
      finalUSDChange = finalUSDChange - mr.totalETNotionalCB;
      finalIndexNotional = finalIndexNotional + mr.totalIPNotional;
      finalAbsIndexNotional = finalAbsIndexNotional + bnAbs(mr.totalIPNotional);
      // Open-only positions (merged) don't have previousPositionSize
      if (mr.previousPositionSize === undefined) {
        finalRealizedFees = finalRealizedFees + mr.realizedOnOpen;
      } else {
        finalRealizedFees = finalRealizedFees + mr.realizedOnClose;
      }
      finalIMR = finalIMR + mr.InitialMargin;
      finalMMR = finalMMR + mr.maintenanceRequirement;
    });

    finalUSDChange = finalUSDChange + finalRealizedFees;
    var finalUSDAfter = deposit + finalUSDChange;
    var finalTotalAV = finalUSDAfter + finalIndexNotional;
    var finalCPMultiplier = bnDiv(finalTotalAV, finalMMR);
    var finalBuyingPower = bnDiv(finalTotalAV - finalIMR, lowestIMF);
    var finalFreeCollateral = finalTotalAV - finalIMR;
    var finalAvailCollateral = finalFreeCollateral - heldFunds;

    finalWalletResults = {
      "Total Deposit": deposit,
      "Total Account Value": finalTotalAV,
      "Quote Balance": finalUSDAfter,
      "Free Collateral": finalFreeCollateral,
      "Available Collateral": finalAvailCollateral,
      "Margin Ratio": bnDiv(finalMMR, finalTotalAV),
      "Total Margin Requirement": finalIMR,
      "Total Maintenance Margin": finalMMR,
      "Close Price MP": finalCPMultiplier,
      "Buying Power": finalBuyingPower,
      "Account Leverage": bnDiv(finalAbsIndexNotional, finalTotalAV),
    };

    // Console output - final wallet
    console.log(
      "%c" + logPadder("Wallet Results FINAL START", 50),
      "color: white; font-weight: bold; background-color: blue;",
    );
    console.table(
      Object.entries(finalWalletResults).map(function (e) {
        return { Key: e[0], Value: fmt(e[1]) };
      }),
    );
    console.log(
      "%c" + logPadder("Wallet Results FINAL END", 50),
      "color: white; font-weight: bold; background-color: blue;",
    );

    // Calculate exit metrics
    Calculation.CalculateExit(
      marketResultsOnClose,
      finalTotalAV,
      state.positions,
      finalUSDAfter,
      marketResults,
      finalCPMultiplier,
      totalAV,
      totalIMR,
      finalAvailCollateral,
    );

    // Console output - final positions
    console.log("\n");
    console.log(
      "%c" + logPadder("Positions Results FINAL START", 50),
      "color: white; font-weight: bold; background-color: purple;",
    );
    marketResultsOnClose.forEach(function (mr, key) {
      console.log(key);
      console.table(
        Object.entries(mr).map(function (e) {
          return { Property: e[0], Value: fmt(e[1]) };
        }),
      );
    });
    console.log(
      "%c" + logPadder("Positions Results FINAL END", 50),
      "color: white; font-weight: bold; background-color: purple;",
    );
  }

  console.log(
    "%c" + logPadder("END", 50),
    "color: black; font-weight: bold; background-color: white;",
  );
  console.log("\n");

  // ---- JSON DUMP ----
  var marketResultsDump = [
    { positionCalculationsOnOpen: Object.fromEntries(marketResults) },
  ];
  var marketResultsOnCloseDump = hasClose
    ? [
        {
          positionCalculationsOnClose: Object.fromEntries(marketResultsOnClose),
        },
      ]
    : null;
  var walletResultsDump = [
    {
      walletCalculations: {
        open: walletResults,
        close: hasClose ? finalWalletResults : null,
      },
    },
  ];

  console.log(
    "%c" + logPadder("Start of wallets dump", 50),
    "color: purple; font-weight: bold; background-color: green;",
  );
  console.log(walletResultsDump);
  console.log(
    "%c" + logPadder("End of wallets dump", 50),
    "color: purple; font-weight: bold; background-color: green;",
  );

  console.log(
    "%c" + logPadder("Start of positions dump", 50),
    "color: purple; font-weight: bold; background-color: green;",
  );
  console.log("Positions on open:");
  console.log(marketResultsDump);
  if (hasClose) {
    console.log("Positions on close:");
    console.log(marketResultsOnCloseDump);
  }
  console.log(
    "%c" + logPadder("End of positions dump", 50),
    "color: purple; font-weight: bold; background-color: green;",
  );

  // ---- RENDER TO PAGE ----
  renderResults(
    walletResults,
    marketResults,
    hasClose ? finalWalletResults : null,
    hasClose ? marketResultsOnClose : null,
  );
}

// ============================================================
// UI: Render Results
// ============================================================

function renderResults(walletOpen, positionsOpen, walletClose, positionsClose) {
  var container = document.getElementById("results");
  container.innerHTML = "";

  // Store for copy-all
  lastResults = { sections: [] };

  // Copy-all bar
  var copyBar = document.createElement("div");
  copyBar.className = "copy-all-bar";
  copyBar.innerHTML =
    '<button class="btn btn-sm btn-blue" id="copyAllJSON">Copy All (JSON)</button>' +
    '<button class="btn btn-sm btn-gray" id="copyAllCSV">Copy All (CSV)</button>';
  container.appendChild(copyBar);

  // Wallets row
  var walletsRow = document.createElement("div");
  walletsRow.className = "results-wallets";
  walletsRow.appendChild(
    buildResultSection("Wallet Results (Open)", "wallet", walletOpen),
  );
  lastResults.sections.push({
    title: "Wallet Results (Open)",
    data: walletOpen,
  });
  if (walletClose) {
    walletsRow.appendChild(
      buildResultSection("Wallet Results (Final)", "final-wallet", walletClose),
    );
    lastResults.sections.push({
      title: "Wallet Results (Final)",
      data: walletClose,
    });
  }
  container.appendChild(walletsRow);

  // Positions row
  var posRow = document.createElement("div");
  posRow.className = "results-positions";
  positionsOpen.forEach(function (mr, key) {
    posRow.appendChild(buildResultSection(key, "position", mr));
    lastResults.sections.push({ title: key, data: mr });
  });
  if (positionsClose) {
    positionsClose.forEach(function (mr, key) {
      posRow.appendChild(
        buildResultSection(key + " (Final)", "final-position", mr),
      );
      lastResults.sections.push({ title: key + " (Final)", data: mr });
    });
  }
  container.appendChild(posRow);

  // Bind copy-all buttons
  document
    .getElementById("copyAllJSON")
    .addEventListener("click", function () {
      copyToClipboard(allResultsToJSON());
      flashButton(this, "Copy All (JSON)");
    });
  document
    .getElementById("copyAllCSV")
    .addEventListener("click", function () {
      copyToClipboard(allResultsToCSV());
      flashButton(this, "Copy All (CSV)");
    });
}

function buildResultSection(title, cssClass, data) {
  var section = document.createElement("div");
  var isWallet = cssClass === "wallet" || cssClass === "final-wallet";
  section.className = "result-section" + (isWallet ? " is-wallet" : "");

  var header = document.createElement("div");
  header.className = "result-header";

  var h3 = document.createElement("h3");
  h3.className = cssClass;
  h3.textContent = title;

  var copyBtn = document.createElement("button");
  copyBtn.className = "btn btn-sm btn-gray btn-copy-section";
  copyBtn.textContent = "Copy";
  copyBtn.addEventListener("click", function () {
    copyToClipboard(JSON.stringify(sectionToObject(data), null, 2));
    flashButton(copyBtn, "Copy");
  });

  header.appendChild(h3);
  header.appendChild(copyBtn);
  section.appendChild(header);

  var table = document.createElement("table");
  table.className = "result-table";

  var thead = document.createElement("thead");
  thead.innerHTML = "<tr><th>Property</th><th>Value</th><th></th></tr>";
  table.appendChild(thead);

  var tbody = document.createElement("tbody");
  Object.entries(data).forEach(function (entry) {
    var tr = document.createElement("tr");
    var tdKey = document.createElement("td");
    tdKey.textContent = entry[0];
    var tdVal = document.createElement("td");
    tdVal.textContent = fmt(entry[1]);
    var tdCopy = document.createElement("td");
    tdCopy.className = "td-copy";
    var rowBtn = document.createElement("button");
    rowBtn.className = "btn-copy-row";
    rowBtn.title = "Copy value";
    rowBtn.textContent = "\u2398";
    (function (val) {
      rowBtn.addEventListener("click", function () {
        copyToClipboard(fmt(val));
        rowBtn.textContent = "\u2713";
        setTimeout(function () {
          rowBtn.textContent = "\u2398";
        }, 1200);
      });
    })(entry[1]);
    tdCopy.appendChild(rowBtn);
    tr.appendChild(tdKey);
    tr.appendChild(tdVal);
    tr.appendChild(tdCopy);
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  section.appendChild(table);

  return section;
}

// ============================================================
// UI: Position Forms
// ============================================================

function renderPositions() {
  var container = document.getElementById("positions");
  container.innerHTML = "";

  state.positions.forEach(function (pos, index) {
    container.appendChild(createPositionCard(pos, index));
  });
}

function createPositionCard(pos, index) {
  var card = document.createElement("div");
  card.className = "position-card";

  var marketsHtml =
    '<option value="" disabled ' +
    (!pos.market ? "selected" : "") +
    ">Select Market</option>";
  state.config.marketConfigs.forEach(function (mc) {
    marketsHtml +=
      '<option value="' +
      mc.market +
      '"' +
      (pos.market === mc.market ? " selected" : "") +
      ">" +
      mc.market +
      "</option>";
  });

  card.innerHTML =
    '<div class="form-group">' +
    "<label>Market</label>" +
    '<select data-field="market" data-idx="' +
    index +
    '">' +
    marketsHtml +
    "</select>" +
    "</div>" +
    '<div class="form-group">' +
    "<label>Quantity</label>" +
    '<input type="number" step="any" data-field="quantity" data-idx="' +
    index +
    '" value="' +
    (pos.quantity || "") +
    '">' +
    "</div>" +
    '<div class="form-row">' +
    '<div class="form-group">' +
    "<label>Entry Price</label>" +
    '<input type="number" step="any" data-field="entryPrice" data-idx="' +
    index +
    '" value="' +
    (pos.entryPrice || "") +
    '">' +
    "</div>" +
    '<div class="form-group">' +
    "<label>Index Price</label>" +
    '<input type="number" step="any" data-field="indexPrice" data-idx="' +
    index +
    '" value="' +
    (pos.indexPrice || "") +
    '">' +
    "</div>" +
    "</div>" +
    '<div class="form-group">' +
    "<label>Open Fees</label>" +
    '<input type="number" step="any" data-field="realizedOnOpen" data-idx="' +
    index +
    '" value="' +
    (pos.realizedOnOpen || "") +
    '">' +
    "</div>" +
    '<div class="close-section' +
    (pos._showClose ? "" : " hidden") +
    '">' +
    '<div class="form-row">' +
    '<div class="form-group">' +
    "<label>Exit Price</label>" +
    '<input type="number" step="any" data-field="exitPrice" data-idx="' +
    index +
    '" value="' +
    (pos.exitPrice || "") +
    '">' +
    "</div>" +
    '<div class="form-group">' +
    "<label>Exit Quantity</label>" +
    '<input type="number" step="any" data-field="exitQuantity" data-idx="' +
    index +
    '" value="' +
    (pos.exitQuantity || "") +
    '">' +
    "</div>" +
    "</div>" +
    '<div class="form-group">' +
    "<label>Close Fees</label>" +
    '<input type="number" step="any" data-field="exitCloseFees" data-idx="' +
    index +
    '" value="' +
    (pos.exitCloseFees || "") +
    '">' +
    "</div>" +
    "</div>" +
    '<div class="btn-row">' +
    '<button class="btn btn-sm btn-outline" data-action="delete" data-idx="' +
    index +
    '">Delete</button>' +
    '<button class="btn btn-sm btn-blue" data-action="toggleClose" data-idx="' +
    index +
    '">' +
    (pos._showClose ? "Cancel Close" : "Close Position") +
    "</button>" +
    "</div>";

  return card;
}

// ============================================================
// UI: Config Modal
// ============================================================

var configModalConfigs = null;

function openConfigModal() {
  configModalConfigs = deepClone(state.config.marketConfigs);
  renderConfigModal();
  document.getElementById("configModal").classList.remove("hidden");
}

function closeConfigModal() {
  document.getElementById("configModal").classList.add("hidden");
  configModalConfigs = null;
}

function renderConfigModal() {
  var body = document.getElementById("configModalBody");
  var html = "";

  configModalConfigs.forEach(function (mc, i) {
    var defaultMC = state.defaultConfig.marketConfigs.find(function (d) {
      return d.market === mc.market;
    });
    html +=
      '<details class="config-market">' +
      "<summary>" +
      mc.market +
      "</summary>" +
      '<div class="config-fields">' +
      configField(
        "Initial Margin Fraction",
        "initialMarginFraction",
        mc.initialMarginFraction,
        i,
        "0.001",
      ) +
      configField(
        "Maintenance Margin Fraction",
        "maintenanceMarginFraction",
        mc.maintenanceMarginFraction,
        i,
        "0.001",
      ) +
      configField(
        "Base Position Size",
        "basePositionSize",
        mc.basePositionSize,
        i,
      ) +
      configField(
        "Incremental Position Size",
        "incrementalPositionSize",
        mc.incrementalPositionSize,
        i,
      ) +
      configField(
        "Incremental Initial Margin Fraction",
        "incrementalInitialMarginFraction",
        mc.incrementalInitialMarginFraction,
        i,
        "0.001",
      ) +
      configField(
        "Maker Fee Rate" +
          (defaultMC ? " (Default: " + defaultMC.makerFeeRate + ")" : ""),
        "makerFeeRate",
        mc.makerFeeRate,
        i,
        "0.000001",
      ) +
      configField(
        "Taker Fee Rate" +
          (defaultMC ? " (Default: " + defaultMC.takerFeeRate + ")" : ""),
        "takerFeeRate",
        mc.takerFeeRate,
        i,
        "0.000001",
      ) +
      '<button class="btn btn-sm btn-gray" data-config-reset="' +
      i +
      '">Reset to Default</button>' +
      "</div>" +
      "</details>";
  });

  body.innerHTML = html;
}

function configField(label, field, value, index, step) {
  return (
    '<div class="form-group">' +
    "<label>" +
    label +
    "</label>" +
    '<input type="number" step="' +
    (step || "any") +
    '" data-cfg-field="' +
    field +
    '" data-cfg-idx="' +
    index +
    '" value="' +
    (value || "") +
    '">' +
    "</div>"
  );
}

// ============================================================
// Event Binding
// ============================================================

function bindEvents() {
  // Environment change -> load from MARKET_CONFIGS
  document.getElementById("envSelect").addEventListener("change", function (e) {
    state.env = e.target.value;
    loadMarkets(state.env);
  });

  // Deposits & held funds
  document
    .getElementById("totalDeposits")
    .addEventListener("input", function (e) {
      state.totalDeposits = e.target.value;
    });
  document
    .getElementById("totalHeldFunds")
    .addEventListener("input", function (e) {
      state.totalHeldFunds = e.target.value;
    });

  // Include Fees toggle
  document
    .getElementById("includeFees")
    .addEventListener("change", function (e) {
      state.includeFees = e.target.checked;
    });

  // Calculate
  document
    .getElementById("calculateBtn")
    .addEventListener("click", calculateValues);

  // Clear
  document.getElementById("clearBtn").addEventListener("click", function () {
    console.clear();
    document.getElementById("results").innerHTML = "";
    lastResults = null;
  });

  // Add position
  document
    .getElementById("addPositionBtn")
    .addEventListener("click", function () {
      state.positions.push({ realizedOnOpen: 0, exitCloseFees: 0 });
      renderPositions();
    });

  // Position form events (event delegation)
  document.getElementById("positions").addEventListener("input", function (e) {
    var field = e.target.dataset.field;
    var idx = parseInt(e.target.dataset.idx);
    if (field !== undefined && !isNaN(idx) && state.positions[idx]) {
      state.positions[idx][field] = e.target.value;
    }
  });

  document.getElementById("positions").addEventListener("change", function (e) {
    var field = e.target.dataset.field;
    var idx = parseInt(e.target.dataset.idx);
    if (field !== undefined && !isNaN(idx) && state.positions[idx]) {
      state.positions[idx][field] = e.target.value;
    }
  });

  document.getElementById("positions").addEventListener("click", function (e) {
    var action = e.target.dataset.action;
    var idx = parseInt(e.target.dataset.idx);
    if (!action || isNaN(idx)) return;

    if (action === "delete") {
      state.positions.splice(idx, 1);
      renderPositions();
    } else if (action === "toggleClose") {
      var pos = state.positions[idx];
      pos._showClose = !pos._showClose;
      if (!pos._showClose) {
        pos.exitPrice = "";
        pos.exitQuantity = "";
        pos.exitCloseFees = "";
      }
      renderPositions();
    }
  });

  // Config modal
  document
    .getElementById("configBtn")
    .addEventListener("click", openConfigModal);
  document
    .querySelector("#configModal .modal-backdrop")
    .addEventListener("click", closeConfigModal);
  document
    .querySelector("#configModal .modal-close")
    .addEventListener("click", closeConfigModal);

  document
    .getElementById("saveConfigBtn")
    .addEventListener("click", function () {
      if (configModalConfigs) {
        state.config.marketConfigs = configModalConfigs;
        renderPositions();
      }
      closeConfigModal();
    });

  // Config modal field changes (delegation)
  document
    .getElementById("configModalBody")
    .addEventListener("input", function (e) {
      var field = e.target.dataset.cfgField;
      var idx = parseInt(e.target.dataset.cfgIdx);
      if (
        field !== undefined &&
        !isNaN(idx) &&
        configModalConfigs &&
        configModalConfigs[idx]
      ) {
        configModalConfigs[idx][field] = e.target.value;
      }
    });

  // Config modal reset button
  document
    .getElementById("configModalBody")
    .addEventListener("click", function (e) {
      var resetIdx = e.target.dataset.configReset;
      if (resetIdx === undefined) return;
      var idx = parseInt(resetIdx);
      var defaultMC = state.defaultConfig.marketConfigs.find(function (d) {
        return d.market === configModalConfigs[idx].market;
      });
      if (defaultMC && configModalConfigs) {
        configModalConfigs[idx] = deepClone(defaultMC);
        renderConfigModal();
      }
    });
}

// ============================================================
// Init
// ============================================================

document.addEventListener("DOMContentLoaded", function () {
  bindEvents();
  loadMarkets(state.env);
});
