# Jupiter Perpetuals Trade Analyzer - Project Notes

## Overview

This project is a **comprehensive trade history analyzer** for Jupiter Perpetuals positions. It analyzes ALL possible position PDAs for a wallet and provides detailed trade information with flexible date range filtering.

## What This Tool Does

### Core Functionality
- **Multi-PDA Analysis**: Automatically generates and analyzes all 9 possible position PDAs per wallet:
  - 3 Long positions (SOL, BTC, ETH using same asset as collateral)
  - 6 Short positions (each asset with USDC or USDT collateral)
- **Date Range Filtering**: Analyze trades within specific time periods
- **Complete Trade Lifecycle**: Tracks position opening, modifications, TP/SL orders, and closing
- **Rate Limiting**: Built-in delays and retry logic to handle RPC rate limits
- **Detailed Event Analysis**: Shows every transaction event with formatted data

### What It Analyzes
- **Position Events**: Opening, closing, liquidations
- **TP/SL Orders**: Take profit and stop loss creation/updates
- **Swap Detection**: Identifies token swaps during position entry/exit
- **Fee Tracking**: Comprehensive fee analysis across all events
- **PnL Calculation**: Profit/loss analysis with ROI calculations

## Project History & Evolution

### Initial Problem
- Original script only analyzed one manually-specified position PDA at a time
- No date range functionality (only "go back X days from now")
- Rate limiting issues when fetching historical data

### Major Improvements Made

#### 1. Multi-PDA Analysis Implementation
**Problem**: Had to manually find and enter position PDAs one by one
**Solution**: 
- Imported PDA generation functions from existing codebase
- Created `generateAllPositionPdas()` function
- Automatically processes all 9 possible position types per wallet
- Sequential processing with rate limiting between PDAs

#### 2. Date Range Enhancement
**Problem**: Could only specify "how far back from now"
**Solution**:
- Added FROM_DATE (start date - older) and TO_DATE (end date - newer)
- Intuitive chronological order: "From April 13th to April 15th"
- Validation to ensure FROM_DATE is older than TO_DATE
- Support for undefined dates (defaults to 30 days ago / now)

#### 3. Rate Limiting Solutions
**Problem**: 429 rate limit errors, especially for historical data
**Solutions Implemented**:
- **5-second delays** between signature fetching batches
- **10-second delays** between PDA processing (reduced to 9s)
- **Exponential backoff retry** for both transactions and signatures
- **Retry wrappers**: `getSignaturesWithRetry()` and `fetchTransactionWithRetry()`
- **Safety limits**: Maximum 1000 transactions per PDA

#### 4. Enhanced Display & Analysis
- **Progress tracking**: Shows "Processing PDA 1/9", etc.
- **Comprehensive event display**: Raw events, trade summaries, detailed breakdowns
- **Token swap detection**: Multiple methods to identify swaps
- **TP/SL instruction parsing**: Extracts take profit/stop loss parameters
- **Active vs completed trade separation**

## Project Structure

### Standalone Project Setup
```
jupiter-perps-trade-analyzer/
├── package.json                 # Dependencies and scripts
├── tsconfig.json               # TypeScript configuration
├── README.md                   # Usage instructions
├── notes.md                    # This documentation file
├── .gitignore                  # Git ignore rules
├── src/
│   ├── analyze.ts              # Main analysis script
│   ├── constants.ts            # Jupiter Perpetuals constants
│   ├── utils.ts                # Utility functions
│   ├── types.ts                # Type definitions
│   └── idl/
│       ├── jupiter-perpetuals-idl.ts      # Program IDL
│       └── jupiter-perpetuals-idl-json.json
```

### Required Files to Copy
From the original jupiter-perps-anchor-idl-parsing project:

1. **Source Files**:
   - `src/examples/final_date.ts` → `src/analyze.ts`
   - `src/constants.ts` → `src/constants.ts`
   - `src/utils.ts` → `src/utils.ts`
   - `src/types.ts` → `src/types.ts`
   - `src/idl/jupiter-perpetuals-idl.ts` → `src/idl/jupiter-perpetuals-idl.ts`
   - `src/idl/jupiter-perpetuals-idl-json.json` → `src/idl/jupiter-perpetuals-idl-json.json`

2. **Configuration Files** (create manually):
   - `package.json` - Dependencies and npm scripts
   - `tsconfig.json` - TypeScript compiler configuration

## Setup Instructions

### Step 1: Create Project Structure
```bash
mkdir jupiter-perps-trade-analyzer
cd jupiter-perps-trade-analyzer
mkdir -p src/idl
```

### Step 2: Create package.json
```json
{
  "name": "jupiter-perps-trade-analyzer",
  "version": "1.0.0",
  "description": "Jupiter Perpetuals Trade History Analyzer",
  "main": "src/analyze.ts",
  "scripts": {
    "analyze": "ts-node src/analyze.ts",
    "dev": "ts-node-dev --respawn --transpile-only src/analyze.ts"
  },
  "dependencies": {
    "@coral-xyz/anchor": "^0.29.0",
    "@solana/spl-token": "^0.4.9",
    "@solana/web3.js": "^1.95.3"
  },
  "devDependencies": {
    "@types/node": "^20.10.5",
    "ts-node": "^10.9.1",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.3.3"
  }
}
```

### Step 3: Create tsconfig.json
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "lib": ["ES2020"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Step 4: Install Dependencies
```bash
npm install
```

### Step 5: Copy Source Files
Copy all the files listed above from the original project.

### Step 6: Update Import Paths
In `analyze.ts`, ensure imports are correct:
```typescript
import { JUPITER_PERPETUALS_PROGRAM, RPC_CONNECTION, ... } from "./constants";
import { BNToUSDRepresentation } from "./utils";
import { Perpetuals } from "./idl/jupiter-perpetuals-idl";
```

## How to Use

### Configuration
Edit the configuration section in `src/analyze.ts`:

```typescript
// ====== CONFIGURATION ======
const FROM_DATE = "09.04.2025"; // Start date (older date)
const TO_DATE = "06.06.2025";   // End date (newer date), undefined for "now"
const WALLET_ADDRESS = "BNDvcP8rVZrNn7xDBHN8jxUh9RKpMB4TFMc42ia3wZvt";
// ============================
```

### Date Format
- **Format**: DD.MM.YYYY (e.g., "13.04.2025")
- **FROM_DATE**: Starting point (older date)
- **TO_DATE**: Ending point (newer date) or undefined for "now"
- **Validation**: FROM_DATE must be older than TO_DATE

### Running the Analyzer
```bash
# Run once
npm run analyze

# Run with auto-restart on file changes (development)
npm run dev

# Direct execution
npx ts-node src/analyze.ts
```

## Technical Details

### PDA Generation Logic
The tool generates 9 position PDAs using this pattern:
- **Long positions**: 3 assets (SOL, BTC, ETH) using same asset as collateral
- **Short positions**: 3 assets × 2 stable collaterals (USDC, USDT) = 6 positions

### Rate Limiting Strategy
1. **Between PDAs**: 9-second delay
2. **Between signature batches**: 5-second delay
3. **Between transaction processing**: 5-second delay
4. **Retry logic**: Exponential backoff up to 15 seconds
5. **Safety limits**: Max 1000 transactions per PDA

### Event Processing Flow
1. **Signature Fetching**: Get all transaction signatures for each PDA
2. **Date Filtering**: Filter signatures by date range
3. **Transaction Processing**: Fetch and decode each transaction
4. **Event Extraction**: Extract Jupiter Perpetuals events
5. **Trade Grouping**: Group events into complete trade lifecycles
6. **Analysis & Display**: Calculate PnL, fees, and format output

### Supported Event Types
- **Position Events**: Increase, Decrease, Liquidation
- **TP/SL Events**: Create/Update take profit and stop loss orders
- **Swap Events**: Pre-swap and post-swap pool operations
- **Limit Orders**: Create, update, and fill events

## Output Format

### Trade Summary
Shows overview of active and completed trades with date range and wallet info.

### Detailed Trade Information
For each trade:
- **Basic Info**: Symbol, Direction, Status, Entry/Exit prices
- **Size & Leverage**: Current size, max size, notional size, collateral, leverage
- **Financial**: PnL, ROI, total fees, profitability
- **Additional**: Collateral token, swaps detected, TP/SL orders, timestamps
- **Event List**: Complete chronological list of all events

### Event Details
Each event shows:
- **Type & Timestamp**: Event name and execution time
- **Action**: Buy/Sell/Market/Limit classification
- **Amounts**: Size (USD and notional), prices, fees
- **Token Info**: Trading and collateral tokens
- **Special Data**: TP/SL parameters, swap details, payout information

## Troubleshooting

### Common Issues

#### Rate Limit Errors (429)
- **Symptoms**: "Too Many Requests" errors
- **Solutions**: 
  - Increase delays between requests
  - Reduce date range (shorter time periods)
  - Use different RPC endpoint if available

#### Missing Events
- **Symptoms**: Trades appear incomplete
- **Causes**: 
  - Date range too narrow
  - RPC connection issues
  - Missing transaction data
- **Solutions**: Expand date range, retry analysis

#### Memory Issues
- **Symptoms**: Out of memory errors
- **Causes**: Too many transactions in date range
- **Solutions**: Reduce date range, increase Node.js memory limit

### Performance Tips
- **Narrow Date Ranges**: Use specific date ranges rather than large periods
- **Test with Recent Data**: Start with recent dates (less historical data)
- **Monitor Rate Limits**: Watch console output for delay messages
- **Use Stable RPC**: Ensure reliable RPC endpoint connection

## Key Features Explained

### Multi-PDA Analysis
Instead of manually finding position PDAs, the tool:
1. Takes a wallet address
2. Generates all 9 possible position PDA combinations
3. Checks each PDA for historical transactions
4. Combines results into a complete trade history

### Date Range Flexibility
- **Specific Periods**: "From April 13th to April 15th"
- **Open Ended**: "From April 1st to now"
- **Default**: "Last 30 days" if no dates specified
- **Validation**: Prevents invalid date ranges

### Intelligent Trade Grouping
Events are grouped into trades based on:
- **Position Key**: Links events to same position
- **Lifecycle Tracking**: Tracks complete open→modify→close cycles
- **Event Ordering**: Chronological ordering within trades
- **Status Determination**: Active, closed, or liquidated

### Comprehensive Fee Analysis
Tracks all fees including:
- **Trading Fees**: Entry and exit fees
- **Liquidation Fees**: Additional fees for liquidated positions
- **Swap Fees**: Fees from token conversions
- **Total Accumulation**: Sum of all fees per trade

## Future Enhancements

### Potential Improvements
- **Export Functionality**: CSV/JSON export for external analysis
- **Performance Metrics**: Win rate, average trade duration, etc.
- **Historical Price Data**: Enhanced PnL calculations with historical prices
- **Portfolio Analysis**: Multi-wallet analysis
- **Real-time Monitoring**: Live position tracking
- **Notification System**: Alerts for position changes

### Code Structure Improvements
- **Modular Design**: Split into separate modules/classes
- **Configuration File**: External config file instead of hardcoded values
- **Logging System**: Structured logging with different levels
- **Error Handling**: More robust error handling and recovery
- **Testing Suite**: Unit tests for core functionality

## Important Notes

### Data Accuracy
- **RPC Dependency**: Analysis quality depends on RPC data availability
- **Historical Limits**: Some RPC providers limit historical data access
- **Event Completeness**: Missing events can affect trade accuracy

### Rate Limiting
- **Conservative Delays**: Current delays are conservative to avoid issues
- **RPC Variability**: Different RPC providers have different limits
- **Monitoring Required**: Watch for rate limit warnings in output

### Date Handling
- **Timezone**: All dates are processed in UTC
- **Format Validation**: Strict DD.MM.YYYY format required
- **Range Logic**: FROM_DATE must be chronologically before TO_DATE

This tool provides comprehensive insights into Jupiter Perpetuals trading activity and serves as a foundation for more advanced trading analysis and strategy development. 