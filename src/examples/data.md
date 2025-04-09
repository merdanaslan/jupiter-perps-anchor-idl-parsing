# Jupiter Perpetuals Data Guide

This document provides a structured guide to retrieving different pieces of information from Jupiter Perpetuals.

## Position Basics

### Position Size

**What it is**: The USD value of the position (notional value).

**How to get it**:
- From position account: `position.sizeUsd`
- Convert to USD: `BNToUSDRepresentation(position.sizeUsd, USDC_DECIMALS)`
- For closed positions: Will be 0

### Collateral Amount

**What it is**: The USD value of collateral backing the position.

**How to get it**:
- From position account: `position.collateralUsd`
- Convert to USD: `BNToUSDRepresentation(position.collateralUsd, USDC_DECIMALS)`
- For closed positions: Will be 0

### Leverage

**What it is**: The ratio of position size to collateral (multiplier).

**How to get it**:
- Calculate: `position.sizeUsd / position.collateralUsd`
- Convert to human-readable: `leverage.toNumber()`
- For a given asset's max leverage: `custody.pricing.maxLeverage / BPS_POWER`

### Entry Price

**What it is**: The price at which the position was opened.

**How to get it**:
- From position account: `position.price`
- Convert to USD: `BNToUSDRepresentation(position.price, USDC_DECIMALS)`

### Position Side (Long/Short)

**What it is**: Whether the position is long (betting on price increase) or short (betting on price decrease).

**How to get it**:
- Check: `position.side.long !== undefined ? "Long" : "Short"`

## PnL Information

### Unrealized PnL (Open Positions)

**What it is**: Current profit/loss that would be realized if position closed now.

**How to get it**:
1. Get current price from oracle: `oraclePrice`
2. Calculate price difference: `priceDiff = position.side.long ? (oraclePrice - position.price) : (position.price - oraclePrice)`
3. Calculate PnL: `pnl = position.sizeUsd.mul(priceDiff).div(position.price)`
4. Add code to handle fees in calculation for accuracy

### Realized PnL (Closed Positions)

**What it is**: Actual profit/loss from closed positions.

**How to get it**:
1. For active account:
   - From position account: `position.realisedPnlUsd`
   - But will be 0 for fully closed positions

2. **From transaction events (most accurate)**:
   - Listen for `DecreasePositionEvent` or `InstantDecreasePositionEvent`
   - Extract: `event.data.pnlDelta` and `event.data.hasProfit`
   - Check: `const pnl = event.data.hasProfit ? pnlDelta : pnlDelta.neg()`

## Fee Information

### Base Fees

**What it is**: Fixed percentage fee for opening/closing positions.

**How to get it**:
- Opening fee rate: `custody.increasePositionBps`
- Closing fee rate: `custody.decreasePositionBps`
- Calculate fee amount: `position.sizeUsd.mul(baseFeeBps).div(BPS_POWER)`
- Current values: 6 bps (0.06%) for both opening and closing

### Price Impact Fees

**What it is**: Variable fee based on position size relative to market depth.

**How to get it**:
- Calculate: `position.sizeUsd.mul(BPS_POWER).div(custody.pricing.tradeImpactFeeScalar)`
- This gives the fee in basis points; then multiply by position size and divide by BPS_POWER

### Funding Fees

**What it is**: Interest paid/received based on market conditions and position duration.

**How to get it**:
1. From position account for active positions:
   - `const fundingDelta = collateralCustody.fundingRateState.cumulativeInterestRate.sub(position.cumulativeInterestSnapshot)`
   - `const fundingFeeUsd = fundingDelta.mul(position.sizeUsd).div(RATE_POWER)`

2. From events for historical positions:
   - Track multiple `DecreasePositionEvent` events
   - Look for `borrowFeeUsd` field

### Total Fees for a Position

**What it is**: All fees paid over a position's lifecycle.

**How to get it**:
```javascript
// Opening fees
const openingBaseFeeBps = custody.increasePositionBps;
const openingImpactFeeBps = positionSize.mul(BPS_POWER).div(custody.pricing.tradeImpactFeeScalar);
const openingFeeUsd = positionSize.mul(openingBaseFeeBps.add(openingImpactFeeBps)).div(BPS_POWER);

// Funding fees accrued
const fundingFeeUsd = fundingRateDelta.mul(position.sizeUsd).div(RATE_POWER);

// Closing fees
const closingBaseFeeBps = custody.decreasePositionBps;
const closingImpactFeeBps = positionSize.mul(BPS_POWER).div(custody.pricing.tradeImpactFeeScalar);
const closingFeeUsd = positionSize.mul(closingBaseFeeBps.add(closingImpactFeeBps)).div(BPS_POWER);

// Total fees
const totalFees = openingFeeUsd.add(fundingFeeUsd).add(closingFeeUsd);
```

## Liquidation Information

### Liquidation Price

**What it is**: The price at which a position would be forcibly closed due to insufficient margin.

**How to get it**:
- Use `getLiquidationPrice` function in `get-liquidation-price.ts`
- Calculation includes:
  1. Fees (closing + funding)
  2. Maximum loss based on leverage
  3. Available margin
  4. Price movement needed to trigger liquidation

## Historical Data and Events

### Position History

**What it is**: Complete record of all positions and their outcomes.

**How to get it**:
1. **Current positions**:
   - Generate PDAs for each possible position type (9 total per wallet)
   - Fetch accounts and filter for `sizeUsd > 0`

2. **Closed positions**:
   - Same as above but filter for `sizeUsd == 0`
   - Note: Only shows latest state, not complete history

3. **Complete history (transactions)**:
   - Fetch events: `DecreasePositionEvent`, `IncreasePositionEvent`, etc.
   - Filter by wallet address: `event.data.owner.equals(walletPubkey)`
   - Organize by position key and timestamp

### Events to Track

- **Position Opening**: `IncreasePositionEvent`, `InstantIncreasePositionEvent`
- **Position Closing**: `DecreasePositionEvent`, `InstantDecreasePositionEvent`
- **Liquidations**: `LiquidateFullPositionEvent`
- **Request Creation**: `CreatePositionRequestEvent`, `ClosePositionRequestEvent`

## Practical Code Examples

### Fetching All Positions for a Wallet

```javascript
// See src/examples/get-positions-by-pda.ts
const positions = await getPositionsByPda(walletAddress);
console.log("Open positions:", positions.openPositions);
console.log("Closed positions:", positions.closedPositions);
```

### Calculating Liquidation Price

```javascript
// See src/examples/get-liquidation-price.ts
await getLiquidationPrice(positionPubkey);
```

### Fetching Transaction Events

```javascript
// See src/examples/get-perpetuals-events.ts
await getPositionRealizedPnl(walletAddress);
``` 