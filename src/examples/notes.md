# Jupiter Perpetuals Position Fetching Notes

## Overview

This code demonstrates how to fetch position data from Jupiter Perpetuals without relying on a dedicated API. Since Jupiter doesn't provide a direct API for position data, we need to query the Solana blockchain directly, decode the account data, and format it appropriately.

## Approach

### Using PDAs vs. getProgramAccounts

We initially tried using `getProgramAccounts` with filters, but this approach had drawbacks:

1. Many RPC providers limit or disable `getProgramAccounts` due to its resource intensity
2. The query can time out when scanning large programs like Jupiter Perpetuals

Instead, we leveraged the deterministic nature of Position accounts in Jupiter Perpetuals. Each wallet has exactly 9 possible positions (3 assets × 3 configurations), and their addresses are deterministic Program Derived Addresses (PDAs).

### Position Account Structure

According to Jupiter's documentation:
- Position accounts store all data related to a trader's position (open or closed)
- Each trader can have up to 9 positions:
  - Long SOL/wETH/wBTC (using the asset itself as collateral)
  - Short SOL/wETH/wBTC (using USDC as collateral)
  - Short SOL/wETH/wBTC (using USDT as collateral)
- Position account addresses are derived from:
  - The trader's wallet address
  - The JLP pool account
  - The custody account (for the traded asset)
  - The collateral custody account
  - The position side (long/short)

## How It Works

1. **Generate PDAs**: We generate all 9 possible position PDAs for a wallet
2. **Fetch Account Data**: We fetch these specific accounts using `getMultipleAccountsInfo`
3. **Decode**: We decode the binary data using the IDL structure
4. **Format**: We create human-readable representations of the data

## Jupiter Perpetuals Execution Models

Jupiter Perpetuals uses two distinct execution models for trading operations:

### 1. Request-based flows (non-instant)
- User submits a request transaction that is stored on-chain
- Keepers (off-chain services) execute the request in a separate transaction later
- Events like `DecreasePositionEvent` are emitted when the request is fulfilled
- Benefits:
  - Works with any RPC provider regardless of compute limits
  - Compatible with operations that might exceed compute limits
  - More gas-efficient for users as keepers pay execution gas
- Examples: Standard position increases/decreases that aren't marked as "instant"

### 2. Instant flows
- Everything happens in a single transaction
- User directly executes the operation without waiting for a keeper
- Events like `InstantDecreasePositionEvent` are emitted
- Benefits:
  - Immediate execution without waiting
  - Reduced slippage risk due to no delay
  - Simplified transaction flow
- Examples: Instant market orders, instant limit orders

Both approaches can be used for market or limit orders depending on the parameters. The "instant" prefix indicates single-transaction execution rather than the order type.

When tracking positions via events, you need to monitor both types of events since users might use either execution method.

## Field Notes

### Price

Position prices are stored in "atomic" USDC units (6 decimal places). For example, a value of 158225872 represents $158.23. The `BNToUSDRepresentation` function converts these values to human-readable format.

### realisedPnlUsd

All closed positions show `realisedPnlUsd: 0` because Jupiter's design resets this value when a position is fully closed:

- Only partially closed positions maintain a non-zero `realisedPnlUsd`
- When a position's `sizeUsd` becomes 0, it's considered fully closed and its `realisedPnlUsd` is reset to 0
- The actual PnL is settled to the user at closing time, but not stored in the position account afterward

## Fee Structure in Jupiter Perpetuals

Jupiter Perpetuals charges several types of fees that affect position profitability:

### 1. Base Fees

- **Opening/Increasing Fee**: Currently 6 basis points (0.06%) for all assets (SOL, BTC, ETH)
  - Controlled by `increasePositionBps` in the custody account
  - Applied when opening a new position or adding to an existing one

- **Closing/Decreasing Fee**: Also 6 basis points (0.06%) for all assets
  - Controlled by `decreasePositionBps` in the custody account
  - Applied when reducing or closing a position

Base fees scale linearly with position size (e.g., $1,000 position → $0.60 fee, $10,000 position → $6.00 fee).

### 2. Price Impact Fees

- Additional fees based on the position size relative to market depth
- Larger positions cause more market impact and thus incur higher fees
- Calculated as: `position.sizeUsd * BPS_POWER / custody.pricing.tradeImpactFeeScalar`
- The `tradeImpactFeeScalar` is specific to each asset and represents market depth

### 3. Funding Rates / Interest

- Long positions pay funding to short positions when funding rate is positive
- Short positions pay funding to long positions when funding rate is negative
- Accrues over time based on the funding rate
- Calculated using the difference between the current `cumulativeInterestRate` and the `cumulativeInterestSnapshot` when the position was opened
- Applied to the position size: `(currentRate - openingRateSnapshot) * position.sizeUsd / RATE_POWER`

### Calculating Total Fees

To calculate the total fees for a position's lifecycle:

1. **Opening Fee** = Base Fee + Price Impact Fee = `(increasePositionBps + impactFeeBps) * sizeUsd / BPS_POWER`
2. **Funding Paid/Received** = `(cumulativeInterestRate - cumulativeInterestSnapshot) * sizeUsd / RATE_POWER`
3. **Closing Fee** = Base Fee + Price Impact Fee = `(decreasePositionBps + impactFeeBps) * sizeUsd / BPS_POWER`
4. **Total Fees** = Opening Fee + Funding + Closing Fee

These fees are factored into liquidation price calculations and affect the overall profitability of positions.

## Limitations

This approach has some limitations:

1. **No Historical Data**: We only see the current state of position accounts, not historical positions that were opened and closed under different market conditions
2. **No Transaction History**: We don't see individual trades, just the final position state
3. **No Events Data**: PnL calculations, liquidations, and other events are not captured

## Getting Transaction History

This implementation **does not** fetch transaction history - only current position data. To get complete transaction history, you would need to:

1. Fetch all program transactions using `getSignaturesForAddress` for the Jupiter Perpetuals program
2. Filter for transactions involving the target wallet
3. Parse transaction logs to extract position events
4. Reconstruct the history from these events

This would be significantly more complex and resource-intensive than the current implementation.

## References

- [Jupiter Perpetuals Position Account Documentation](https://dev.jup.ag/docs/perp-api/position-account)
- [Solana Web3.js Documentation](https://solana-labs.github.io/solana-web3.js/) 