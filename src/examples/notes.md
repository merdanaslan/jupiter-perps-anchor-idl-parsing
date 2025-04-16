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

## Tracking Position Events

To properly track historical trades and position events, you need to query and process events emitted by the Jupiter Perpetuals program.

### Key Events to Track

**Position Opening/Increasing:**
- `IncreasePositionEvent` - Standard (keeper-executed) position increase
- `InstantIncreasePositionEvent` - Immediate position increase
- `IncreasePositionPreSwapEvent` - Preliminary swap event when input token differs from collateral

**Position Closing/Decreasing:**
- `DecreasePositionEvent` - Standard (keeper-executed) position decrease
- `InstantDecreasePositionEvent` - Immediate position decrease
- `ClosePositionRequestEvent` - Request to close a position (keeper model)
- `DecreasePositionPostSwapEvent` - Swap event when closing a position with a different desired token

**Liquidations:**
- `LiquidateFullPositionEvent` - Complete liquidation of a position
- `LiquidatePartialPositionEvent` - Partial liquidation of a position

**Position Request:**
- `CreatePositionRequestEvent` - Initial position request creation
- `CancelTPSLEvent` - Cancellation of TP/SL orders

### IncreasePositionPreSwapEvent Fields

The `IncreasePositionPreSwapEvent` event captures details about token swaps that happen before increasing a position:

- `positionRequestKey` - The PDA of the position request
- `transferAmount` - The amount of tokens transferred in the swap
- `collateralCustodyPreSwapAmount` - The amount of collateral tokens received after the swap

This event is emitted when a user deposits Token A but wants to use Token B as collateral, requiring an intermediate swap.

### DecreasePositionPostSwapEvent Fields

The `DecreasePositionPostSwapEvent` event captures details about token swaps that happen after decreasing a position:

- `positionRequestKey` - The PDA of the position request
- `swapAmount` - The amount of tokens being swapped
- `jupiterMinimumOut` - The minimum amount expected to receive from the swap (optional parameter)

This event is emitted when a user closes a position and requests to receive a different token than their collateral token (e.g., closing a SOL-collateralized position but requesting USDC).

### Position Request Types

The `positionRequestType` field in events like `DecreasePositionEvent` indicates what triggered the position change:

- **Type 0**: Instant/Direct execution (executed immediately without going through the request system)
- **Type 1**: Market Order (direct user action through request)
- **Type 2**: Take Profit Order (automated execution when price rises to TP level)
- **Type 3**: Stop Loss Order (automated execution when price drops to SL level)
- **Type 4**: Limit Order (pending execution at a specific price)

### Identifying Individual Trades

Since position PDAs are reused (e.g., the same PDA is used for all Short SOL with USDC collateral positions), you need to identify distinct trade lifecycles by:

1. Looking for position open events (first event for a PDA or after a complete close)
2. Tracking events chronologically
3. Identifying complete closes when position size returns to zero
4. Grouping all events between an open and a close as a single trade

### Take Profit / Stop Loss

In Jupiter Perpetuals:
- You can have one TP and one SL order active simultaneously for a position
- You cannot have multiple TPs or multiple SLs at the same time
- TP/SL executions appear as normal decrease events with appropriate `positionRequestType`

### Collateral & Swaps

**Opening positions:**
- Long positions typically use the asset itself as collateral (SOL for SOL long)
- Short positions use stablecoins (USDC/USDT) as collateral
- If depositing a different token than required, a swap occurs first (emitting `IncreasePositionPreSwapEvent`)

**Closing positions:**
- When closing, users can specify which token to receive via the `desiredMint` parameter
- If requesting a different token than the collateral, a swap happens automatically

## Fetching User Trade History

To get the complete trade history of a user in Jupiter Perpetuals, you need to fetch and process these events:

### Required Events for Trade History

1. **Position Opening/Increasing:**
   - `IncreasePositionEvent` - Standard (keeper-executed) position increases
   - `InstantIncreasePositionEvent` - Immediate position increases

2. **Position Closing/Decreasing:**
   - `DecreasePositionEvent` - Standard (keeper-executed) position decreases
   - `InstantDecreasePositionEvent` - Immediate position decreases

3. **Liquidations:**
   - `LiquidateFullPositionEvent` - Complete liquidations of positions

4. **Additional events for swap information (if needed):**
   - `IncreasePositionPreSwapEvent` - Preliminary swap when input token differs from collateral
   - `DecreasePositionPostSwapEvent` - Swap when closing a position with a different desired token

To get the most comprehensive view, you should filter these events by the user's wallet address in the `owner` field of the event data.

### Request vs. Execution Events

Jupiter Perpetuals uses a two-phase process for many operations:

1. **Request Creation Phase:**
   - When a user initiates an action, a "request" event is created:
     - `CreatePositionRequestEvent` - Created when a user initiates any position change
     - `ClosePositionRequestEvent` - Created when a user requests to close a position
   - These events mark when an order is **placed**

2. **Execution Phase:**
   - When the request is fulfilled (either by keepers or instantly), an "execution" event is emitted:
     - `IncreasePositionEvent` - When a position is increased by a keeper
     - `DecreasePositionEvent` - When a position is decreased by a keeper
     - `InstantIncreasePositionEvent` - When a position is increased instantly
     - `InstantDecreasePositionEvent` - When a position is decreased instantly
   - These events mark when an order is **executed**

For trade history tracking, the execution events contain the most critical information (prices, sizes, PnL, etc.). Request events provide additional context about when and how orders were placed.

### Field Enumerations

#### RequestType Field

Based on the Jupiter Perpetuals IDL, the `requestType` field represents:

- **Type 0**: Market - A market order execution
- **Type 1**: Trigger - A triggered order (take profit, stop loss, limit)

#### RequestChange Field

The `requestChange` field indicates the type of position change:

- **Type 0**: None - No change to position
- **Type 1**: Increase - Open or add to a position
- **Type 2**: Decrease - Close or reduce a position

#### Position Side Field

The `positionSide` field indicates whether the position is long or short:

- **Value 0**: Short position
- **Value 1**: Long position

### Order Type Identification

In execution events like `DecreasePositionEvent`, the `positionRequestType` field helps determine if the execution was from a market order, take profit, stop loss, or limit order.

Remember that an instant execution (Type 0) doesn't mean it's not a market order - it just means it was executed immediately rather than through the request-keeper system.

### Detailed Event Field Descriptions

#### IncreasePositionEvent Fields

This event is emitted when a position is increased through the request-based (keeper) execution model:

- `positionKey` (PublicKey): The unique identifier of the position
- `positionSide` (u8): 0 for short, 1 for long
- `positionCustody` (PublicKey): The custody account for the position's asset
- `positionCollateralCustody` (PublicKey): The custody account for the position's collateral
- `positionSizeUsd` (u64): Total size of the position in USD (6 decimal places)
- `positionMint` (PublicKey): The mint address of the position's asset
- `positionRequestKey` (PublicKey): The unique identifier of the position request
- `positionRequestMint` (PublicKey): The mint address used in the request
- `positionRequestChange` (u8): Type of change (0=None, 1=Increase, 2=Decrease)
- `positionRequestType` (u8): Type of order (0=Market, 1=Trigger)
- `positionRequestCollateralDelta` (u64): Change in collateral amount
- `owner` (PublicKey): The owner's wallet address
- `pool` (PublicKey): The pool used for the position
- `sizeUsdDelta` (u64): Amount the position size changed in USD (6 decimal places)
- `collateralUsdDelta` (u64): Amount the collateral changed in USD (6 decimal places)
- `collateralTokenDelta` (u64): Amount the collateral changed in token terms
- `price` (u64): Execution price in USD (6 decimal places)
- `priceSlippage` (Option<u64>): Price slippage incurred, if any
- `feeToken` (u64): Fees paid in token amount
- `feeUsd` (u64): Fees paid in USD (6 decimal places)
- `openTime` (i64): Unix timestamp of the position opening
- `referral` (Option<PublicKey>): Referral address, if applicable

#### InstantIncreasePositionEvent Fields

This event is emitted when a position is increased through the instant execution model:

- `positionKey` (PublicKey): The unique identifier of the position
- `positionSide` (u8): 0 for short, 1 for long
- `positionCustody` (PublicKey): The custody account for the position's asset
- `positionCollateralCustody` (PublicKey): The custody account for the position's collateral
- `positionSizeUsd` (u64): Total size of the position in USD (6 decimal places)
- `positionMint` (PublicKey): The mint address of the position's asset
- `owner` (PublicKey): The owner's wallet address
- `pool` (PublicKey): The pool used for the position
- `sizeUsdDelta` (u64): Amount the position size changed in USD (6 decimal places)
- `collateralUsdDelta` (u64): Amount the collateral changed in USD (6 decimal places)
- `collateralTokenDelta` (u64): Amount the collateral changed in token terms
- `price` (u64): Execution price in USD (6 decimal places)
- `priceSlippage` (u64): Price slippage incurred
- `feeToken` (u64): Fees paid in token amount
- `feeUsd` (u64): Fees paid in USD (6 decimal places)
- `openTime` (i64): Unix timestamp of the position opening
- `referral` (Option<PublicKey>): Referral address, if applicable

#### DecreasePositionEvent Fields

This event is emitted when a position is decreased through the request-based (keeper) execution model:

- `positionKey` (PublicKey): The unique identifier of the position
- `positionSide` (u8): 0 for short, 1 for long
- `positionCustody` (PublicKey): The custody account for the position's asset
- `positionCollateralCustody` (PublicKey): The custody account for the position's collateral
- `positionSizeUsd` (u64): Remaining size of the position in USD (6 decimal places)
- `positionMint` (PublicKey): The mint address of the position's asset
- `positionRequestKey` (PublicKey): The unique identifier of the position request
- `positionRequestMint` (PublicKey): The mint address used in the request
- `positionRequestChange` (u8): Type of change (0=None, 1=Increase, 2=Decrease)
- `positionRequestType` (u8): Type of order (0=Market, 1=Trigger)
- `hasProfit` (bool): Whether the position closed with profit (true) or loss (false)
- `pnlDelta` (u64): Profit and loss amount in USD (6 decimal places)
- `owner` (PublicKey): The owner's wallet address
- `pool` (PublicKey): The pool used for the position
- `sizeUsdDelta` (u64): Amount the position size changed in USD (6 decimal places)
- `transferAmountUsd` (u64): Amount transferred to the user in USD (6 decimal places)
- `transferToken` (Option<u64>): Amount transferred to the user in tokens, if applicable
- `price` (u64): Execution price in USD (6 decimal places)
- `priceSlippage` (Option<u64>): Price slippage incurred, if any
- `feeUsd` (u64): Fees paid in USD (6 decimal places)
- `openTime` (i64): Unix timestamp of the position opening
- `referral` (Option<PublicKey>): Referral address, if applicable

#### InstantDecreasePositionEvent Fields

This event is emitted when a position is decreased through the instant execution model:

- `positionKey` (PublicKey): The unique identifier of the position
- `positionSide` (u8): 0 for short, 1 for long
- `positionCustody` (PublicKey): The custody account for the position's asset
- `positionCollateralCustody` (PublicKey): The custody account for the position's collateral
- `positionSizeUsd` (u64): Remaining size of the position in USD (6 decimal places)
- `positionMint` (PublicKey): The mint address of the position's asset
- `desiredMint` (PublicKey): The mint address the user wants to receive
- `hasProfit` (bool): Whether the position closed with profit (true) or loss (false)
- `pnlDelta` (u64): Profit and loss amount in USD (6 decimal places)
- `owner` (PublicKey): The owner's wallet address
- `pool` (PublicKey): The pool used for the position
- `sizeUsdDelta` (u64): Amount the position size changed in USD (6 decimal places)
- `transferAmountUsd` (u64): Amount transferred to the user in USD (6 decimal places)
- `transferToken` (u64): Amount transferred to the user in tokens
- `price` (u64): Execution price in USD (6 decimal places)
- `priceSlippage` (u64): Price slippage incurred
- `feeUsd` (u64): Fees paid in USD (6 decimal places)
- `openTime` (i64): Unix timestamp of the position opening
- `referral` (Option<PublicKey>): Referral address, if applicable

#### LiquidateFullPositionEvent Fields

This event is emitted when a position is fully liquidated:

- `positionKey` (PublicKey): The unique identifier of the position
- `positionSide` (u8): 0 for short, 1 for long
- `positionCustody` (PublicKey): The custody account for the position's asset
- `positionCollateralCustody` (PublicKey): The custody account for the position's collateral
- `positionCollateralMint` (PublicKey): The mint address of the position's collateral
- `positionMint` (PublicKey): The mint address of the position's asset
- `positionSizeUsd` (u64): Size of the liquidated position in USD (6 decimal places)
- `hasProfit` (bool): Whether the position closed with profit (true) or loss (false)
- `pnlDelta` (u64): Profit and loss amount in USD (6 decimal places)
- `owner` (PublicKey): The owner's wallet address
- `pool` (PublicKey): The pool used for the position
- `transferAmountUsd` (u64): Amount transferred to the user in USD (6 decimal places)
- `transferToken` (u64): Amount transferred to the user in tokens
- `price` (u64): Liquidation price in USD (6 decimal places)
- `feeUsd` (u64): Fees paid in USD (6 decimal places)
- `liquidationFeeUsd` (u64): Liquidation penalty in USD (6 decimal places)
- `openTime` (i64): Unix timestamp of the position opening

#### IncreasePositionPreSwapEvent Fields

The `IncreasePositionPreSwapEvent` event captures details about token swaps that happen before increasing a position:

- `positionRequestKey` (PublicKey): The PDA of the position request
- `transferAmount` (u64): The amount of tokens transferred in the swap
- `collateralCustodyPreSwapAmount` (u64): The amount of collateral tokens received after the swap

This event is emitted when a user deposits Token A but wants to use Token B as collateral, requiring an intermediate swap.

#### DecreasePositionPostSwapEvent Fields

The `DecreasePositionPostSwapEvent` event captures details about token swaps that happen after decreasing a position:

- `positionRequestKey` (PublicKey): The PDA of the position request
- `swapAmount` (u64): The amount of tokens being swapped
- `jupiterMinimumOut` (Option<u64>): The minimum amount expected to receive from the swap (optional parameter)

This event is emitted when a user closes a position and requests to receive a different token than their collateral token (e.g., closing a SOL-collateralized position but requesting USDC).

#### CreatePositionRequestEvent Fields

This event is emitted when a user initiates a position request:

- `owner` (PublicKey): The owner's wallet address
- `pool` (PublicKey): The pool used for the position
- `positionKey` (PublicKey): The unique identifier of the position
- `positionSide` (u8): 0 for short, 1 for long
- `positionMint` (PublicKey): The mint address of the position's asset
- `positionCustody` (PublicKey): The custody account for the position's asset
- `positionCollateralMint` (PublicKey): The mint address of the position's collateral
- `positionCollateralCustody` (PublicKey): The custody account for the position's collateral
- `positionRequestKey` (PublicKey): The unique identifier of the position request
- `positionRequestMint` (PublicKey): The mint address used in the request
- `sizeUsdDelta` (u64): Amount the position size will change in USD (6 decimal places)
- `collateralDelta` (u64): Amount the collateral will change in token terms
- `priceSlippage` (u64): Price slippage limit
- `jupiterMinimumOut` (Option<u64>): Minimum amount expected from Jupiter swap, if applicable
- `preSwapAmount` (Option<u64>): Amount to be swapped before position change, if applicable
- `requestChange` (u8): Type of change (0=None, 1=Increase, 2=Decrease)
- `openTime` (i64): Unix timestamp of the request creation
- `referral` (Option<PublicKey>): Referral address, if applicable

#### ClosePositionRequestEvent Fields

This event is emitted when a user requests to close a position:

- `entirePosition` (Option<bool>): Whether the entire position is being closed
- `executed` (bool): Whether the request has been executed
- `requestChange` (u8): Type of change (0=None, 1=Increase, 2=Decrease)
- `requestType` (u8): Type of order (0=Market, 1=Trigger)
- `side` (u8): Position side (1=Long, 2=Short)
- `positionRequestKey` (PublicKey): The unique identifier of the position request
- `owner` (PublicKey): The owner's wallet address
- `mint` (PublicKey): The mint address involved in the request
- `amount` (u64): Token amount involved in the request

## Trade History Tracking Logic

To track and group Jupiter Perpetuals events into coherent trades, we employ a lifecycle-based approach that handles reused position PDAs and various trade scenarios.

### Trade Grouping Algorithm

1. **Chronological Processing**:
   - Sort all events by timestamp to process them in the order they occurred
   - Filter to include only execution events (IncreasePositionEvent, DecreasePositionEvent, etc.)

2. **Position Lifecycle Tracking**:
   - Maintain a "lifecycle counter" for each position key (PDA)
   - The unique trade ID is formed by combining: `${positionKey}-${lifecycleCounter}`
   - Increment the counter whenever a position is fully closed (positionSizeUsd = 0)

3. **Trade Boundaries**:
   - A trade begins with an IncreasePositionEvent where current size equals size delta (new position)
   - A trade ends with a DecreasePositionEvent where positionSizeUsd = 0 (fully closed)
   - A trade can also end with a LiquidateFullPositionEvent

4. **Position Updates**:
   - Track partial increases by checking if a position already exists in the active trades map
   - Track partial decreases by updating the position size without closing the trade
   - Only move trades to "completed" when they are fully closed or liquidated

### Scenarios Handled

The grouping logic handles these scenarios:

1. **Simple Open and Close**:
   - User opens a position (IncreasePositionEvent)
   - User closes entire position (DecreasePositionEvent with positionSizeUsd = $0.00)

2. **Partial Closes**:
   - User opens a position (IncreasePositionEvent)
   - User partially closes position (DecreasePositionEvent with positionSizeUsd > $0.00)
   - User closes remaining position (DecreasePositionEvent with positionSizeUsd = $0.00)

3. **Multiple Increases**:
   - User opens position (IncreasePositionEvent)
   - User adds to position (another IncreasePositionEvent)
   - User closes entire position (DecreasePositionEvent with positionSizeUsd = $0.00)

4. **Liquidation**:
   - User opens position (IncreasePositionEvent)
   - Position gets liquidated (LiquidateFullPositionEvent)

5. **Multiple Trading Cycles (Reused PDA)**:
   - User opens position (IncreasePositionEvent)
   - Closes position fully (DecreasePositionEvent with positionSizeUsd = $0.00)
   - Later opens new position with same PDA (IncreasePositionEvent)
   - These are tracked as separate trades with different lifecycle counters

### Code Implementation

The core logic is implemented in the `groupEventsIntoTrades` function which:

1. Sorts events chronologically
2. Filters for execution events
3. Processes each event according to its type (increase, decrease, liquidate)
4. Maintains state with lifecycle counters and active trades
5. Returns a complete list of trades sorted by recency

The implementation handles edge cases like:
- Calculating correct entry/exit prices
- Tracking PnL and profit/loss status

## References

- [Jupiter Perpetuals Position Account Documentation](https://dev.jup.ag/docs/perp-api/position-account)
- [Solana Web3.js Documentation](https://solana-labs.github.io/solana-web3.js/)

### Note on Documentation Sources

The meanings of the positionRequestType values and other field interpretations are derived from:
1. Analysis of the Jupiter Perpetuals codebase
2. Example implementations in this repository
3. Community documentation
4. Testing and verification with actual event data

These interpretations are not explicitly documented in the IDL itself, as the IDL only defines the data structure but not the semantic meaning of enum values. 