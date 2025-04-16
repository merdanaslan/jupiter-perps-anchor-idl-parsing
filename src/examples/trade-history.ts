import { DISCRIMINATOR_SIZE, IdlEvents, utils } from "@coral-xyz/anchor";
import {
  JUPITER_PERPETUALS_PROGRAM,
  RPC_CONNECTION,
  USDC_DECIMALS,
} from "../constants";
import { PublicKey } from "@solana/web3.js";
import { Perpetuals } from "../idl/jupiter-perpetuals-idl";
import { inspect } from 'util';
import { BN } from "@coral-xyz/anchor";
import { BNToUSDRepresentation } from "../utils";

type AnchorIdlEvent<EventName extends keyof IdlEvents<Perpetuals>> = {
  name: EventName;
  data: IdlEvents<Perpetuals>[EventName];
};

// EventWithTx combines an event with its transaction data
type EventWithTx = {
  event: {
    name: string;
    data: any;
  } | null;
  tx: {
    signature: string;
    blockTime: string | null;
    slot?: number;
    fee: string;
    feeInLamports: number;
  };
} | null;  // Make nullable to match actual return type

// Trade represents a complete trade lifecycle
interface ITrade {
  id: string; // unique ID combining positionKey and lifecycle count
  positionKey: string;
  positionSide: string; // "Long" or "Short"
  status: "active" | "closed" | "liquidated";
  owner: string;
  asset?: string;
  entryPrice: number;
  exitPrice?: number;
  sizeUsd: number;
  collateralUsd: number;
  leverage: number;
  pnl?: number;
  roi?: number;
  openTime: string | null;
  closeTime?: string | null;
  events: EventWithTx[];
  hasProfit?: boolean;
}

// Helper function to format event data to make it human-readable
function formatEventData(event: any): any {
  if (!event) return null;
  
  const { name, data } = event;
  
  // Create a new clean object instead of modifying the original
  const cleanData: any = {};
  
  // Convert PublicKeys to strings and format numbers
  Object.keys(data).forEach(key => {
    const value = data[key];
    
    // Handle PublicKey objects
    if (value instanceof PublicKey) {
      cleanData[key] = value.toString();
    }
    // Handle BigNumbers (BN)
    else if (value instanceof BN) {
      if (key.includes('Usd') || key.includes('usd') || key.includes('Price') || key.includes('price') || key === 'pnlDelta') {
        cleanData[key] = `$${BNToUSDRepresentation(value, USDC_DECIMALS)}`;
      } else if (key.includes('Time')) {
        cleanData[key] = new Date(value.toNumber() * 1000).toISOString();
      } else {
        cleanData[key] = value.toString();
      }
    }
    // Handle arrays
    else if (Array.isArray(value)) {
      cleanData[key] = value;
    }
    // Handle side enum
    else if (key === 'positionSide') {
      cleanData[key] = value === 1 ? "Long" : "Short";
    }
    // Handle null values
    else if (value === null) {
      cleanData[key] = null;
    }
    // Handle regular values
    else {
      cleanData[key] = value;
    }
  });
  
  return {
    name,
    data: cleanData
  };
}

// The Jupiter Perpetuals program emits events (via Anchor's CPI events: https://book.anchor-lang.com/anchor_in_depth/events.html)
// for most trade events. These events can be parsed and analyzed to track things like trades, executed TPSL requests, liquidations
// and so on.
// This function shows how to listen to these onchain events and parse / filter them.
export async function getPositionEvents() {
  // Use specific position PDA
  const positionPDA = new PublicKey("5dMxAFxqRSzjx8C3NbnDhyaJzj53QRXiGj4NCtQGkdqR");
  
  
  console.log("Getting signatures...");
  const confirmedSignatureInfos = await RPC_CONNECTION.getSignaturesForAddress(
    positionPDA,
    { limit: 10 } // Only fetch 10 transactions
  );

  if (!confirmedSignatureInfos || confirmedSignatureInfos.length === 0) {
    console.log("No transactions found for this position");
    return [];
  }
  
  console.log(`Found ${confirmedSignatureInfos.length} transactions`);
  
  // Process ONE transaction at a time with longer delays
  const allEvents = [];
  
  for (let i = 0; i < confirmedSignatureInfos.length; i++) {
    if (confirmedSignatureInfos[i].err) {
      console.log(`Skipping failed transaction: ${confirmedSignatureInfos[i].signature}`);
      continue;
    }
    
    // Add a 5 second delay between each transaction processing
    if (i > 0) {
      console.log(`Waiting 5 seconds before processing next transaction...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    try {
      console.log(`Processing transaction ${i+1}/${confirmedSignatureInfos.length}: ${confirmedSignatureInfos[i].signature}`);
      
      const tx = await RPC_CONNECTION.getTransaction(
        confirmedSignatureInfos[i].signature,
        { commitment: "confirmed", maxSupportedTransactionVersion: 0 }
      );
      
      if (!tx || !tx.meta || !tx.meta.innerInstructions) {
        console.log("No inner instructions found in transaction");
        continue;
      }
      
      const txEvents = tx.meta.innerInstructions.flatMap(ix => {
        return ix.instructions.map(iix => {
          try {
            const ixData = utils.bytes.bs58.decode(iix.data);
            const eventData = utils.bytes.base64.encode(
              ixData.subarray(DISCRIMINATOR_SIZE)
            );
            const decodedEvent = JUPITER_PERPETUALS_PROGRAM.coder.events.decode(eventData);
            
            // Format the event data for human readability
            const formattedEvent = formatEventData(decodedEvent);
            
            // Get transaction fee (safe because we already checked tx.meta != null)
            const feeInSOL = tx.meta!.fee / 1_000_000_000; // Convert lamports to SOL
            
            return {
              event: formattedEvent,
              tx: {
                signature: confirmedSignatureInfos[i].signature,
                blockTime: tx.blockTime 
                  ? new Date(tx.blockTime * 1000).toISOString()
                  : null,
                fee: `${feeInSOL} SOL`,
                feeInLamports: tx.meta!.fee
              }
            };
          } catch (error) {
            console.log("Failed to decode instruction data");
            return null;
          }
        }).filter(Boolean);
      });
      
      allEvents.push(...txEvents);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error processing transaction: ${errorMessage}`);
    }
  }
  
  console.log(`Found ${allEvents.length} total events`);
  
  // Filter to only return increase position events
  const filteredEvents = allEvents.filter(
    (data) =>
      data?.event?.name === "IncreasePositionEvent" ||
      data?.event?.name === "InstantIncreasePositionEvent" ||
      data?.event?.name === "DecreasePositionEvent" ||
      data?.event?.name === "InstantDecreasePositionEvent" ||
      data?.event?.name === "LiquidateFullPositionEvent" ||
      data?.event?.name === "IncreasePositionPreSwapEvent" ||
      data?.event?.name === "DecreasePositionPreSwapEvent" ||
      data?.event?.name === "InstantCreateTpslEvent" ||
      data?.event?.name === "InstantUpdateTpslEvent" 
  );
  
  console.log(`Found ${filteredEvents.length} relevant position events`);
  
  return filteredEvents;
}

/**
 * Helper function to parse USD value from string format
 */
function parseUsdValue(value: string): number {
  if (!value) return 0;
  return parseFloat(value.replace('$', '').replace(',', ''));
}

/**
 * Group events into trades based on position lifecycle
 */
export function groupEventsIntoTrades(events: EventWithTx[]): { activeTrades: ITrade[]; completedTrades: ITrade[] } {
  // Filter out null events first
  const nonNullEvents = events.filter((evt): evt is NonNullable<EventWithTx> => evt !== null);
  
  // Sort events chronologically
  const sortedEvents = [...nonNullEvents].sort((a, b) => {
    const aTime = a.tx.blockTime ? new Date(a.tx.blockTime).getTime() : 0;
    const bTime = b.tx.blockTime ? new Date(b.tx.blockTime).getTime() : 0;
    return aTime - bTime;
  });

  // Filter to keep only execution events (not request events or pre-swap events)
  const executionEvents = sortedEvents.filter(evt => 
    evt.event?.name === 'IncreasePositionEvent' ||
    evt.event?.name === 'DecreasePositionEvent' ||
    evt.event?.name === 'InstantIncreasePositionEvent' ||
    evt.event?.name === 'InstantDecreasePositionEvent' ||
    evt.event?.name === 'LiquidateFullPositionEvent'
  );

  // Maps to track active trades and lifecycle counters
  const activeTrades: Map<string, ITrade> = new Map();
  const completedTrades: ITrade[] = [];
  const lifecycleCounters: Map<string, number> = new Map();

  // Process each execution event
  for (const eventWithTx of executionEvents) {
    // Skip null events
    if (!eventWithTx.event) continue;
    
    const { event, tx } = eventWithTx;
    const { data, name } = event;
    
    // Get position key
    const positionKey = data.positionKey;
    
    // Initialize lifecycle counter if needed
    if (!lifecycleCounters.has(positionKey)) {
      lifecycleCounters.set(positionKey, 0);
    }
    
    const lifecycleCount = lifecycleCounters.get(positionKey) || 0;
    const tradeId = `${positionKey}-${lifecycleCount}`;

    // Check if we have an active trade for this position
    const activeTrade = activeTrades.get(tradeId);

    // Process based on event type
    if (name === 'IncreasePositionEvent' || name === 'InstantIncreasePositionEvent') {
      const sizeUsdDelta = parseUsdValue(data.sizeUsdDelta);
      const positionSizeUsd = parseUsdValue(data.positionSizeUsd);
      const collateralUsdDelta = parseUsdValue(data.collateralUsdDelta);
      const price = parseUsdValue(data.price);
      
      // Check if this is a new position (first increase) or adding to an existing position
      if (!activeTrade) {
        // This is a new trade
        const newTrade: ITrade = {
          id: tradeId,
          positionKey,
          positionSide: data.positionSide,
          status: "active",
          owner: data.owner,
          entryPrice: price,
          sizeUsd: sizeUsdDelta,
          collateralUsd: collateralUsdDelta,
          leverage: sizeUsdDelta / collateralUsdDelta,
          openTime: tx.blockTime,
          events: [eventWithTx],
        };
        
        activeTrades.set(tradeId, newTrade);
      } else {
        // This is adding to an existing position
        const newCollateralUsd = activeTrade.collateralUsd + collateralUsdDelta;
        const newSizeUsd = activeTrade.sizeUsd + sizeUsdDelta;
        
        // Update the trade
        activeTrade.sizeUsd = newSizeUsd;
        activeTrade.collateralUsd = newCollateralUsd;
        activeTrade.leverage = newSizeUsd / newCollateralUsd;
        activeTrade.events.push(eventWithTx);
      }
    } else if (name === 'DecreasePositionEvent' || name === 'InstantDecreasePositionEvent') {
      const sizeUsdDelta = parseUsdValue(data.sizeUsdDelta);
      const positionSizeUsd = parseUsdValue(data.positionSizeUsd);
      const price = parseUsdValue(data.price);
      const pnlDelta = parseUsdValue(data.pnlDelta);
      
      if (!activeTrade) {
        // We have a decrease event but no matching active trade
        console.error(`Error: Found decrease event for position ${positionKey} but no active trade was found. The opening event is likely missing from the data.`);
        continue;
      }
      
      // Add the event to the trade's events
      activeTrade.events.push(eventWithTx);
      
      // Update the trade with the latest data
      activeTrade.exitPrice = price;
      activeTrade.pnl = (activeTrade.pnl || 0) + pnlDelta;
      activeTrade.hasProfit = data.hasProfit;
      
      // Calculate ROI based on PnL and collateral
      if (activeTrade.pnl !== undefined) {
        activeTrade.roi = (activeTrade.pnl / activeTrade.collateralUsd) * 100;
      }
      
      // Check if position is fully closed
      if (positionSizeUsd === 0) {
        // This position is fully closed - move it to completed trades
        activeTrade.status = "closed";
        activeTrade.closeTime = tx.blockTime;
        activeTrade.sizeUsd = 0; // Set size to 0 as it's fully closed
        
        completedTrades.push({ ...activeTrade });
        activeTrades.delete(tradeId);
        
        // Increment lifecycle counter for this position
        lifecycleCounters.set(positionKey, lifecycleCount + 1);
      } else {
        // This is a partial decrease
        activeTrade.sizeUsd -= sizeUsdDelta;
      }
    } else if (name === 'LiquidateFullPositionEvent') {
      const price = parseUsdValue(data.price);
      const pnlDelta = parseUsdValue(data.pnlDelta);
      
      if (!activeTrade) {
        // We have a liquidation event but no matching active trade
        console.error(`Error: Found liquidation event for position ${positionKey} but no active trade was found. The opening event is likely missing from the data.`);
        continue;
      }
      
      // Update the trade with liquidation data
      activeTrade.events.push(eventWithTx);
      activeTrade.status = "liquidated";
      activeTrade.exitPrice = price;
      activeTrade.closeTime = tx.blockTime;
      activeTrade.pnl = (activeTrade.pnl || 0) + pnlDelta;
      activeTrade.hasProfit = data.hasProfit;
      activeTrade.sizeUsd = 0; // Set size to 0 as it's fully liquidated
      
      // Calculate ROI based on PnL and collateral
      if (activeTrade.pnl !== undefined) {
        activeTrade.roi = (activeTrade.pnl / activeTrade.collateralUsd) * 100;
      }
      
      // Move to completed trades
      completedTrades.push({ ...activeTrade });
      activeTrades.delete(tradeId);
      
      // Increment lifecycle counter for this position
      lifecycleCounters.set(positionKey, lifecycleCount + 1);
    }
  }

  // Convert maps to arrays for return
  const activeTradesArray = Array.from(activeTrades.values());
  
  // Sort completed trades by recency (newest first)
  completedTrades.sort((a, b) => {
    const aTime = a.closeTime ? new Date(a.closeTime).getTime() : 0;
    const bTime = b.closeTime ? new Date(b.closeTime).getTime() : 0;
    return bTime - aTime;
  });
  
  return {
    activeTrades: activeTradesArray,
    completedTrades: completedTrades,
  };
}

/**
 * Get the complete trade history for a specific position PDA
 */
export async function getPositionTradeHistory(): Promise<{ activeTrades: ITrade[]; completedTrades: ITrade[] }> {
  // Get all events for the position
  const events = await getPositionEvents();
  
  // Display raw events first
  console.log("\n======== RAW EVENTS ========");
  events.forEach((evt, i) => {
    if (evt && evt.event) {
      console.log(`\nEvent ${i+1}:`);
      console.log(`Type: ${evt.event.name}`);
      console.log(`Transaction: ${evt.tx.signature}`);
      console.log(`Time: ${evt.tx.blockTime}`);
      console.log("Data:", evt.event.data);
    }
  });
  console.log("============================\n");
  
  // Group events into trades
  return groupEventsIntoTrades(events);
}

/**
 * Example usage
 */
async function analyzeTradeHistory() {
  const { activeTrades, completedTrades } = await getPositionTradeHistory();
  
  console.log(`\n======== TRADE SUMMARY ========`);
  console.log(`Active trades: ${activeTrades.length}`);
  console.log(`Completed trades: ${completedTrades.length}`);
  
  // Print detailed trade information
  if (activeTrades.length > 0) {
    console.log("\n------- ACTIVE TRADES -------");
    activeTrades.forEach((trade, index) => {
      printDetailedTradeInfo(trade, index);
    });
  }
  
  if (completedTrades.length > 0) {
    console.log("\n------- COMPLETED TRADES -------");
    completedTrades.forEach((trade, index) => {
      printDetailedTradeInfo(trade, index);
    });
  }
  
  console.log("===============================");
}

// Add a new function to print detailed trade information
function printDetailedTradeInfo(trade: ITrade, index: number) {
  const side = trade.positionSide;
  const status = trade.status === "liquidated" ? "LIQUIDATED" : (trade.status === "closed" ? "CLOSED" : "ACTIVE");
  const pnl = trade.pnl ? `$${trade.pnl.toFixed(2)}` : "N/A";
  const roi = trade.roi ? `${trade.roi.toFixed(2)}%` : "N/A";
  
  console.log(`\nTrade #${index + 1} (ID: ${trade.id}):`);
  console.log(`Position: ${side} ${status}`);
  console.log(`Owner: ${trade.owner}`);
  console.log(`Entry Price: $${trade.entryPrice.toFixed(2)}`);
  
  if (trade.exitPrice) {
    console.log(`Exit Price: $${trade.exitPrice.toFixed(2)}`);
  }
  
  console.log(`Size: $${trade.sizeUsd.toFixed(2)}`);
  console.log(`Collateral: $${trade.collateralUsd.toFixed(2)}`);
  console.log(`Leverage: ${trade.leverage.toFixed(2)}x`);
  
  if (trade.pnl !== undefined) {
    console.log(`PnL: ${pnl} (${roi})`);
    console.log(`Profitable: ${trade.hasProfit ? "Yes" : "No"}`);
  }
  
  console.log(`Opened: ${trade.openTime}`);
  
  if (trade.closeTime) {
    console.log(`Closed: ${trade.closeTime}`);
  }
  
  console.log(`Events in trade: ${trade.events.length}`);
  
  // Print a summary of events in this trade
  console.log("\nEvents:");
  trade.events.forEach((evt, i) => {
    if (evt && evt.event) {
      console.log(`  ${i+1}. ${evt.event.name} at ${evt.tx.blockTime}`);
      
      // For increase events, show size and collateral
      if (evt.event.name.includes('Increase')) {
        console.log(`     Size: ${evt.event.data.sizeUsdDelta}`);
        console.log(`     Collateral: ${evt.event.data.collateralUsdDelta}`);
        console.log(`     Price: ${evt.event.data.price}`);
      }
      // For decrease events, show size and pnl
      else if (evt.event.name.includes('Decrease')) {
        console.log(`     Size: ${evt.event.data.sizeUsdDelta}`);
        console.log(`     PnL: ${evt.event.data.pnlDelta}`);
        console.log(`     Price: ${evt.event.data.price}`);
      }
      // For liquidation events
      else if (evt.event.name.includes('Liquidate')) {
        console.log(`     PnL: ${evt.event.data.pnlDelta}`);
        console.log(`     Price: ${evt.event.data.price}`);
      }
    }
  });
}

// Run the example
analyzeTradeHistory().then(() => {
  console.log("Trade analysis complete");
}).catch(err => {
  console.error("Error analyzing trades:", err);
});