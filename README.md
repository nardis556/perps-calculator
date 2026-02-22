# Perps Calc

Perpetual futures position calculator. Computes margin requirements, liquidation prices, and account health metrics.

**[Live Demo](https://nardis556.github.io/perps-calc/)** (GitHub Pages)

## Features

- Multi-position support across all markets (BTC, ETH, SOL, DIL, CENT, PAR)
- Tiered initial margin calculation with incremental position sizing
- Liquidation price computation with multi-position cross-margin
- Editable market configs per environment (dev, staging, sandbox, prod)
- BigInt fixed-point arithmetic (10^8 scale) matching the exchange backend

## Usage

Open `index.html` in a browser or visit the GitHub Pages deployment.

1. Select an environment
2. Enter total deposits and held funds
3. Add positions with market, side, quantity, entry price, and index price
4. Click **Calculate** to see margin requirements, equity, liquidation prices, and account leverage

## Files

| File | Description |
|------|-------------|
| `index.html` | Main page |
| `app.js` | UI logic and state management |
| `calculation.js` | Margin, liquidation, and equity calculations |
| `config.js` | Market configurations per environment |
| `style.css` | Styles |
| `config/*.json` | Per-environment market config overrides |
