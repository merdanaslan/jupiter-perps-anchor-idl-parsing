import { DISCRIMINATOR_SIZE, IdlEvents, utils } from "@coral-xyz/anchor";
import {
  JUPITER_PERPETUALS_PROGRAM,
  RPC_CONNECTION,
  USDC_DECIMALS,
  CUSTODY_PUBKEY,
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
  finalSize?: number; // Size before closing (for completed trades)
  maxSize?: number;   // Maximum size the position reached
  notionalSize?: number; // Amount of the asset (not USD)
  collateralUsd: number;
  leverage: number;
  pnl?: number;
  roi?: number;
  totalFees?: number; // Total fees paid for the position
  openTime: string | null;
  closeTime?: string | null;
  events: EventWithTx[];
  hasProfit?: boolean;
}

// First, update the discriminators to match the standard Anchor format
export const TPSL_INSTRUCTION_DISCRIMINATORS = {
  // For Anchor programs, the instruction discriminator is first 8 bytes of sha256 hash of the instruction name
  // Try different formats for the instruction name
  instantCreateTpsl: Buffer.from([117, 98, 66, 127, 30, 50, 73, 185]), // Known discriminator from our debug output
  instantUpdateTpsl: Buffer.from([215, 61, 230, 134, 70, 19, 40, 15])  // Placeholder - we'll update this if we find it
};

// Add discriminators for limit order instructions
export const LIMIT_ORDER_INSTRUCTION_DISCRIMINATORS = {
  instantCreateLimitOrder: Buffer.from([]), // Will be populated from debug if found
  instantUpdateLimitOrder: Buffer.from([])  // Will be populated from debug if found
};

// Remove the debug logging
// console.log("Create TPSL discriminator:", Array.from(TPSL_INSTRUCTION_DISCRIMINATORS.instantCreateTpsl));
// console.log("Update TPSL discriminator:", Array.from(TPSL_INSTRUCTION_DISCRIMINATORS.instantUpdateTpsl));

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

// Update the getPositionEvents function to use fetchTransactionWithRetry
export async function getPositionEvents() {
  // Use specific position PDA
  const positionPDA = new PublicKey("PskXG6AudWfR419gHd96EDnmGtQWaeLrAYST1LrEua3");
  
  // Maximum transaction signatures to return (between 1 and 1,000).
  console.log("Getting signatures...");
  const confirmedSignatureInfos = await RPC_CONNECTION.getSignaturesForAddress(
    positionPDA,
    { limit: 10 } // Only fetch 10 transactions AND minContextSlot for custom timeinterval 
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
    
    // Add a delay between each transaction processing to avoid rate limits
    if (i > 0) {
      console.log(`Waiting 5 seconds before processing next transaction...`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    
    try {
      console.log(`Processing transaction ${i+1}/${confirmedSignatureInfos.length}: ${confirmedSignatureInfos[i].signature}`);
      
      // Use our retry function
      const tx = await fetchTransactionWithRetry(confirmedSignatureInfos[i].signature);
      
      if (!tx || !tx.meta || !tx.meta.innerInstructions) {
        console.log("No inner instructions found in transaction");
        continue;
      }
      
      const txEvents = tx.meta.innerInstructions.flatMap((ix: { instructions: any[] }) => {
        return ix.instructions.map((iix: { data: string }) => {
          try {
            const ixData = utils.bytes.bs58.decode(iix.data);
            const eventData = utils.bytes.base64.encode(
              ixData.subarray(DISCRIMINATOR_SIZE)
            );
            const decodedEvent = JUPITER_PERPETUALS_PROGRAM.coder.events.decode(eventData);
            
            // Debugging: Log event names
            if (decodedEvent) {
              console.log(`Found event: ${decodedEvent.name}`);
            }
            
            // Format the event data for human readability
            const formattedEvent = formatEventData(decodedEvent);
            
            // Get transaction fee (safe because we already checked tx.meta != null)
            const feeInSOL = tx.meta!.fee / 1_000_000_000; // Convert lamports to SOL
            
            const eventWithTx = {
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
            
            // For TP/SL events, fetch the instruction data immediately
            if (formattedEvent && (
                formattedEvent.name === 'InstantCreateTpslEvent' || 
                formattedEvent.name === 'InstantUpdateTpslEvent')
            ) {
              // We'll try to extract TP/SL parameters from the transaction
              let tpslData = null;
              try {
                // Get all instructions in the transaction - handle versioned transactions
                let instructions;
                let accountKeys;
                
                if ('message' in tx.transaction) {
                  const message = tx.transaction.message;
                  
                  // For versioned transactions
                  if ('version' in message) {
                    // For MessageV0
                    instructions = message.compiledInstructions;
                    try {
                      // For versioned transactions with lookup tables
                      if (tx.meta?.loadedAddresses) {
                        // Use staticAccountKeys and loaded addresses
                        const staticKeys = message.staticAccountKeys || [];
                        const writableKeys = tx.meta.loadedAddresses.writable || [];
                        const readonlyKeys = tx.meta.loadedAddresses.readonly || [];
                        accountKeys = [...staticKeys, ...writableKeys, ...readonlyKeys];
                      } else {
                        accountKeys = message.staticAccountKeys || [];
                      }
                    } catch (err) {
                      console.log("Error getting account keys, using static keys:", err);
                      accountKeys = message.staticAccountKeys || [];
                    }
                  } else {
                    // For legacy transactions
                    instructions = (message as any).instructions;
                    accountKeys = (message as any).accountKeys;
                  }
                }
                
                if (instructions && accountKeys) {
                  // Find the TP/SL instruction
                  for (const ix of instructions) {
                    // Skip if no programId index
                    if (ix.programIdIndex === undefined) continue;
                    
                    // Get program ID
                    const programId = accountKeys[ix.programIdIndex];
                    
                    // Check if this is a Jupiter Perpetuals instruction
                    if (programId.toString() === JUPITER_PERPETUALS_PROGRAM.programId.toString()) {
                      // Get the instruction data
                      const data = Buffer.from(ix.data);
                      
                      // Check for TP/SL instruction discriminators
                      const discriminator = data.slice(0, 8);
                      
                      const isCreateTpsl = Buffer.compare(discriminator, TPSL_INSTRUCTION_DISCRIMINATORS.instantCreateTpsl) === 0;
                      const isUpdateTpsl = Buffer.compare(discriminator, TPSL_INSTRUCTION_DISCRIMINATORS.instantUpdateTpsl) === 0;
                      
                      if (isCreateTpsl || isUpdateTpsl) {
                        console.log(`Found ${isCreateTpsl ? 'instantCreateTpsl' : 'instantUpdateTpsl'} instruction`);
                        
                        // Parse TP/SL parameters from buffer
                        const instructionDataBuffer = data.slice(8);
                        let offset = 0;
                        
                        // Read collateralUsdDelta (u64/BN)
                        const collateralUsdDelta = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                        offset += 8;
                        
                        // Read sizeUsdDelta (u64/BN)
                        const sizeUsdDelta = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                        offset += 8;
                        
                        // Read triggerPrice (u64/BN)
                        const triggerPrice = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                        offset += 8;
                        
                        // Read triggerAboveThreshold (bool) - 1 byte
                        const triggerAboveThreshold = instructionDataBuffer[offset] === 1;
                        offset += 1;
                        
                        // Read entirePosition (bool) - 1 byte
                        const entirePosition = instructionDataBuffer[offset] === 1;
                        offset += 1;
                        
                        // Read counter (u64/BN) if available
                        let counter = new BN(0);
                        if (offset + 8 <= instructionDataBuffer.length) {
                          counter = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                          offset += 8;
                        }
                        
                        // Read requestTime (i64/BN) if available
                        let requestTime = new BN(0);
                        if (offset + 8 <= instructionDataBuffer.length) {
                          requestTime = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                        }
                        
                        // Create the TPSL data object - if triggerAboveThreshold is true, it's a Take Profit
                        // If false, it's a Stop Loss
                        tpslData = {
                          instructionName: isCreateTpsl ? 'instantCreateTpsl' : 'instantUpdateTpsl',
                          params: {
                            collateralUsdDelta,
                            sizeUsdDelta,
                            triggerPrice,
                            triggerAboveThreshold,
                            entirePosition,
                            counter,
                            requestTime,
                            // For convenience, also include the interpreted values
                            takeProfitTriggerPrice: triggerAboveThreshold ? triggerPrice : null,
                            stopLossTriggerPrice: !triggerAboveThreshold ? triggerPrice : null,
                            takeProfitSizePct: entirePosition ? 10000 : 5000, // Default to 100% for entire position, 50% otherwise
                            stopLossSizePct: entirePosition ? 10000 : 5000
                          }
                        };
                        
                        // Add TP/SL data to the event
                        if (formattedEvent.data) {
                          // Add to the event data
                          if (triggerAboveThreshold) {
                            formattedEvent.data.takeProfitPrice = `$${BNToUSDRepresentation(triggerPrice, USDC_DECIMALS)}`;
                            formattedEvent.data.takeProfitSizePercent = entirePosition ? 10000 : 5000;
                          } else {
                            formattedEvent.data.stopLossPrice = `$${BNToUSDRepresentation(triggerPrice, USDC_DECIMALS)}`;
                            formattedEvent.data.stopLossSizePercent = entirePosition ? 10000 : 5000;
                          }
                          
                          // Add all raw instruction parameters to the event data
                          formattedEvent.data.tpslInstructionData = tpslData;
                          formattedEvent.data.tpslCollateralUsdDelta = `$${BNToUSDRepresentation(collateralUsdDelta, USDC_DECIMALS)}`;
                          formattedEvent.data.tpslSizeUsdDelta = `$${BNToUSDRepresentation(sizeUsdDelta, USDC_DECIMALS)}`;
                          formattedEvent.data.tpslTriggerPrice = `$${BNToUSDRepresentation(triggerPrice, USDC_DECIMALS)}`;
                          formattedEvent.data.tpslTriggerAboveThreshold = triggerAboveThreshold;
                          formattedEvent.data.tpslEntirePosition = entirePosition;
                          formattedEvent.data.tpslCounter = counter.toString();
                          formattedEvent.data.tpslRequestTime = new Date(requestTime.toNumber() * 1000).toISOString();
                        }
                        
                        break;
                      }
                    }
                  }
                }
              } catch (error) {
                console.error("Error extracting TP/SL instruction data:", error);
              }
            }
            
            return eventWithTx;
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
  
  // Filter to only return position events
  const filteredEvents = allEvents.filter(
    (data) =>
      data?.event?.name === "IncreasePositionEvent" ||
      data?.event?.name === "InstantIncreasePositionEvent" ||
      data?.event?.name === "DecreasePositionEvent" ||
      data?.event?.name === "InstantDecreasePositionEvent" ||
      data?.event?.name === "LiquidateFullPositionEvent" ||
      data?.event?.name === "IncreasePositionPreSwapEvent" ||
      data?.event?.name === "DecreasePositionPostSwapEvent" ||
      data?.event?.name === "InstantCreateTpslEvent" ||
      data?.event?.name === "InstantUpdateTpslEvent" ||
      data?.event?.name === "InstantCreateLimitOrderEvent" ||
      data?.event?.name === "InstantUpdateLimitOrderEvent" ||
      data?.event?.name === "PoolSwapEvent" ||
      data?.event?.name === "PoolSwapExactOutEvent"
  );
  
  console.log(`Found ${filteredEvents.length} relevant position events`);
  
  return filteredEvents;
}

// Implement exponential backoff for RPC requests
async function fetchTransactionWithRetry(signature: string, maxRetries = 5): Promise<any> {
  let retries = 0;
  let delay = 500; // Start with 500ms delay
  
  while (retries < maxRetries) {
    try {
      return await RPC_CONNECTION.getTransaction(
        signature,
        { 
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0
        }
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Check if it's a rate limit error
      if (errorMessage.includes("429") || errorMessage.includes("Too Many Requests")) {
        retries++;
        
        if (retries >= maxRetries) {
          console.log(`Maximum retries (${maxRetries}) reached. Giving up.`);
          throw error;
        }
        
        // Exponential backoff with jitter
        const jitter = Math.random() * 0.3 + 0.85; // Random between 0.85 and 1.15
        delay = Math.min(delay * 2 * jitter, 10000); // Cap at 10 seconds
        
        console.log(`Rate limited. Retry ${retries}/${maxRetries} after ${Math.round(delay)}ms delay...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      } else {
        // For non-rate-limit errors, just throw
        throw error;
      }
    }
  }
}

/**
 * Parse TP/SL instruction data from transaction
 * This function fetches the transaction that contains a TP/SL event and decodes the instruction data using the IDL
 */
async function getTpslInstructionData(txSignature: string): Promise<any> {
  try {
    // Fetch the transaction with retry
    console.log(`Fetching transaction ${txSignature} to decode TP/SL instruction data...`);
    const tx = await fetchTransactionWithRetry(txSignature);
    
    if (!tx || !tx.transaction) {
      console.log("Transaction not found or has no data");
      return null;
    }
    
    // Get all instructions in the transaction - handle versioned transactions
    let instructions;
    let accountKeys;
    
    if ('message' in tx.transaction) {
      const message = tx.transaction.message;
      
      // For versioned transactions
      if ('version' in message) {
        // For MessageV0
        instructions = message.compiledInstructions;
        try {
          // For versioned transactions with lookup tables
          if (tx.meta?.loadedAddresses) {
            // Use staticAccountKeys and loaded addresses
            const staticKeys = message.staticAccountKeys || [];
            const writableKeys = tx.meta.loadedAddresses.writable || [];
            const readonlyKeys = tx.meta.loadedAddresses.readonly || [];
            accountKeys = [...staticKeys, ...writableKeys, ...readonlyKeys];
          } else {
            accountKeys = message.staticAccountKeys || [];
          }
        } catch (err) {
          console.log("Error getting account keys, using static keys:", err);
          accountKeys = message.staticAccountKeys || [];
        }
      } else {
        // For legacy transactions
        instructions = (message as any).instructions;
        accountKeys = (message as any).accountKeys;
      }
    } else {
      console.log("Unexpected transaction format");
      return null;
    }
    
    if (!instructions || !accountKeys) {
      console.log("Could not extract instructions or account keys");
      return null;
    }
    
    console.log(`Found ${instructions.length} instructions in transaction`);
    
    // Enhanced debugging: print some transaction information
    console.log(`Transaction details: Slot ${tx.slot}, ${accountKeys.length} account keys`);
    
    // Find the TP/SL instruction
    for (let i = 0; i < instructions.length; i++) {
      const ix = instructions[i];
      // Skip if no programId index
      if (ix.programIdIndex === undefined) continue;
      
      // Get program ID
      const programId = accountKeys[ix.programIdIndex];
      const programIdStr = programId.toString();
      
      // Check if this is a Jupiter Perpetuals instruction
      if (programIdStr === JUPITER_PERPETUALS_PROGRAM.programId.toString()) {
        console.log(`Found Jupiter Perpetuals instruction #${i+1}`);
        
        try {
          // Get the instruction data
          const data = Buffer.from(ix.data);
          
          // Check the discriminator (first 8 bytes)
          const discriminator = data.slice(0, 8);
          console.log(`Instruction discriminator: [${Array.from(discriminator).join(', ')}]`);
          
          // Try all possible discriminator formats
          // Standard Anchor format without namespace
          const stdCreateDiscr = Buffer.from(utils.sha256.hash("instant_create_tpsl").slice(0, 8));
          const stdUpdateDiscr = Buffer.from(utils.sha256.hash("instant_update_tpsl").slice(0, 8));
          
          // With capital first letter (common convention)
          const capCreateDiscr = Buffer.from(utils.sha256.hash("Instant_create_tpsl").slice(0, 8));
          const capUpdateDiscr = Buffer.from(utils.sha256.hash("Instant_update_tpsl").slice(0, 8));
          
          // With camelCase (another common convention)
          const camelCreateDiscr = Buffer.from(utils.sha256.hash("instantCreateTpsl").slice(0, 8));
          const camelUpdateDiscr = Buffer.from(utils.sha256.hash("instantUpdateTpsl").slice(0, 8));
          
          // With snake_case (another common convention)
          const snakeCreateDiscr = Buffer.from(utils.sha256.hash("instant_create_tpsl").slice(0, 8));
          const snakeUpdateDiscr = Buffer.from(utils.sha256.hash("instant_update_tpsl").slice(0, 8));
          
          // Log all possible discriminators we're checking
          console.log("Checking against these discriminators:");
          console.log("Standard create:", Array.from(stdCreateDiscr));
          console.log("Standard update:", Array.from(stdUpdateDiscr));
          console.log("Capitalized create:", Array.from(capCreateDiscr));
          console.log("Capitalized update:", Array.from(capUpdateDiscr));
          console.log("CamelCase create:", Array.from(camelCreateDiscr));
          console.log("CamelCase update:", Array.from(camelUpdateDiscr));
          console.log("Snake_case create:", Array.from(snakeCreateDiscr));
          console.log("Snake_case update:", Array.from(snakeUpdateDiscr));
          
          // Check if the discriminator matches any of our possible formats
          const isCreateTpsl = 
            Buffer.compare(discriminator, stdCreateDiscr) === 0 ||
            Buffer.compare(discriminator, capCreateDiscr) === 0 ||
            Buffer.compare(discriminator, camelCreateDiscr) === 0 ||
            Buffer.compare(discriminator, snakeCreateDiscr) === 0;
            
          const isUpdateTpsl = 
            Buffer.compare(discriminator, stdUpdateDiscr) === 0 ||
            Buffer.compare(discriminator, capUpdateDiscr) === 0 ||
            Buffer.compare(discriminator, camelUpdateDiscr) === 0 ||
            Buffer.compare(discriminator, snakeUpdateDiscr) === 0;

          // Additional check - if the discriminator from the transaction matches what we saw
          // When we inspected the output
          const knownDiscriminator = Buffer.from([117, 98, 66, 127, 30, 50, 73, 185]);
          const isKnownDiscriminator = Buffer.compare(discriminator, knownDiscriminator) === 0;
          if (isKnownDiscriminator) {
            console.log("Found instruction with known discriminator - this might be our TP/SL instruction");
            
            // Try to parse it as if it were a TP/SL instruction
            try {
              // Assume it's a TP/SL instruction and try to parse the data
              const instructionDataBuffer = data.slice(8);
              console.log(`Instruction data length: ${instructionDataBuffer.length} bytes`);
              
              // Dump the entire instruction data for analysis
              console.log("Instruction data:", Array.from(instructionDataBuffer));
              
              // Attempt to decode it as a TP/SL instruction
              if (instructionDataBuffer.length >= 24) { // Enough data for our expected fields
                let offset = 0;
                
                // Try different structures
                
                // Attempt 1: Skip the first 16 bytes (assuming they're collateralUsdDelta and sizeUsdDelta)
                offset = 16;
                
                // Extract triggerPrice
                const triggerPrice = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                console.log(`Potential triggerPrice: ${triggerPrice.toString()} ($${BNToUSDRepresentation(triggerPrice, USDC_DECIMALS)})`);
                offset += 8;
                
                // Read a potential boolean value
                if (offset < instructionDataBuffer.length) {
                  const potentialBool1 = instructionDataBuffer[offset];
                  console.log(`Potential triggerAboveThreshold: ${potentialBool1} (${potentialBool1 === 1 ? 'true' : 'false'})`);
                  offset += 1;
                }
                
                // Read another potential boolean value
                if (offset < instructionDataBuffer.length) {
                  const potentialBool2 = instructionDataBuffer[offset];
                  console.log(`Potential entirePosition: ${potentialBool2} (${potentialBool2 === 1 ? 'true' : 'false'})`);
                }
                
                // Let's try a different approach - let's just log all potential price values 
                // in the buffer (assuming they're 8-byte BNs)
                console.log("All potential price values in the buffer:");
                for (let j = 0; j + 8 <= instructionDataBuffer.length; j += 8) {
                  const val = new BN(instructionDataBuffer.slice(j, j + 8), 'le');
                  const usdVal = BNToUSDRepresentation(val, USDC_DECIMALS);
                  console.log(`Offset ${j}: ${val.toString()} ($${usdVal})`);
                }
                
                // Construct a tpsl data object if we're confident
                if (offset >= 25 && instructionDataBuffer[24] <= 1 && instructionDataBuffer[25] <= 1) {
                  // Looks like we found a valid structure
                  const triggerAboveThreshold = instructionDataBuffer[24] === 1;
                  const entirePosition = instructionDataBuffer[25] === 1;
                  
                  return {
                    instructionName: 'instantCreateTpsl', // Assume create for now
                    params: {
                      takeProfitTriggerPrice: triggerAboveThreshold ? triggerPrice : null,
                      stopLossTriggerPrice: !triggerAboveThreshold ? triggerPrice : null,
                      takeProfitSizePct: entirePosition ? 10000 : 5000, // Default to 100% for entire position, 50% otherwise
                      stopLossSizePct: entirePosition ? 10000 : 5000
                    }
                  };
                }
              }
            } catch (e) {
              console.error(`Error parsing instruction with known discriminator: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          
          // Try the original discriminators as well
          if (isCreateTpsl || isUpdateTpsl) {
            // This is a TP/SL instruction
            console.log(`Found ${isCreateTpsl ? 'instantCreateTpsl' : 'instantUpdateTpsl'} instruction`);
            
            // Now we need to decode the instruction data using Anchor's IDL
            try {
              // Use Anchor's BorshCoder to decode the instruction data
              const ixName = isCreateTpsl ? "instantCreateTpsl" : "instantUpdateTpsl";
              let decoded;
              try {
                // Decode the instruction data after the discriminator
                const dataAfterDiscriminator = data.slice(8);
                const args = JUPITER_PERPETUALS_PROGRAM.coder.types.decode(
                  isCreateTpsl ? "InstantCreateTpslParams" : "InstantUpdateTpslParams", 
                  dataAfterDiscriminator
                );
                decoded = { name: ixName, data: args };
              } catch (err) {
                console.log(`Failed to decode ${ixName} instruction:`, err);
                continue;
              }
              
              // Format the params according to what we need
              let tpslParams = null;
              
              if (isCreateTpsl) {
                // Extract from decoded args
                const { triggerPrice, triggerAboveThreshold, entirePosition } = decoded.data;
                
                // Map to our format - take profit is triggerAboveThreshold=true, stop loss is triggerAboveThreshold=false
                tpslParams = {
                  instructionName: 'instantCreateTpsl',
                  params: {
                    takeProfitTriggerPrice: triggerAboveThreshold ? triggerPrice : null,
                    stopLossTriggerPrice: !triggerAboveThreshold ? triggerPrice : null,
                    takeProfitSizePct: entirePosition ? 10000 : decoded.data.sizeUsdDelta.toNumber(),  // 100% by default
                    stopLossSizePct: entirePosition ? 10000 : decoded.data.sizeUsdDelta.toNumber()     // 100% by default
                  }
                };
                
                console.log(`Extracted TP/SL data:`, tpslParams);
                return tpslParams;
              } 
              else if (isUpdateTpsl) {
                // Extract fields similarly
                const { triggerPrice, triggerAboveThreshold, entirePosition } = decoded.data;
                
                tpslParams = {
                  instructionName: 'instantUpdateTpsl',
                  params: {
                    takeProfitTriggerPrice: triggerAboveThreshold ? triggerPrice : null,
                    stopLossTriggerPrice: !triggerAboveThreshold ? triggerPrice : null,
                    takeProfitSizePct: entirePosition ? 10000 : decoded.data.sizeUsdDelta.toNumber(),
                    stopLossSizePct: entirePosition ? 10000 : decoded.data.sizeUsdDelta.toNumber()
                  }
                };
                
                console.log(`Extracted TP/SL data:`, tpslParams);
                return tpslParams;
              }
            } catch (error) {
              console.error(`Error decoding instruction data: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          
          // Return null if we didn't find a matching instruction
          return null;
        } catch (err) {
          console.log("Error parsing instruction data:", err);
          return null;
        }
      }
    }
    
    // If we didn't find the instruction in the main instructions, check inner instructions
    if (tx.meta?.innerInstructions && tx.meta.innerInstructions.length > 0) {
      console.log("Checking inner instructions...");
      
      for (let i = 0; i < tx.meta.innerInstructions.length; i++) {
        const innerIxSet = tx.meta.innerInstructions[i];
        
        for (let j = 0; j < innerIxSet.instructions.length; j++) {
          const innerIx = innerIxSet.instructions[j];
          
          try {
            // We need to convert base58 encoded data to Buffer
            const data = utils.bytes.bs58.decode(innerIx.data);
            
            // Skip if too short
            if (data.length < 8) continue;
            
            // Check discriminator
            const discriminator = data.slice(0, 8);
            const isCreateTpsl = Buffer.compare(discriminator, TPSL_INSTRUCTION_DISCRIMINATORS.instantCreateTpsl) === 0;
            const isUpdateTpsl = Buffer.compare(discriminator, TPSL_INSTRUCTION_DISCRIMINATORS.instantUpdateTpsl) === 0;
            
            if (isCreateTpsl || isUpdateTpsl) {
              console.log(`Found ${isCreateTpsl ? 'instantCreateTpsl' : 'instantUpdateTpsl'} in inner instructions`);
              
              try {
                // Try to decode using IDL
                const ixName = isCreateTpsl ? "instantCreateTpsl" : "instantUpdateTpsl";
                let decoded;
                try {
                  // Use the BorshCoder directly to decode the args
                  const dataAfterDiscriminator = data.slice(8);
                  const args = JUPITER_PERPETUALS_PROGRAM.coder.types.decode(
                    isCreateTpsl ? "InstantCreateTpslParams" : "InstantUpdateTpslParams",
                    dataAfterDiscriminator
                  );
                  
                  decoded = { name: ixName, data: args };
                } catch (err) {
                  console.log(`Failed to decode inner ${ixName} instruction:`, err);
                  continue;
                }
                
                // Create our format
                if (isCreateTpsl) {
                  const { triggerPrice, triggerAboveThreshold, entirePosition } = decoded.data;
                  
                  const tpslParams = {
                    instructionName: 'instantCreateTpsl',
                    params: {
                      takeProfitTriggerPrice: triggerAboveThreshold ? triggerPrice : null,
                      stopLossTriggerPrice: !triggerAboveThreshold ? triggerPrice : null,
                      takeProfitSizePct: entirePosition ? 10000 : decoded.data.sizeUsdDelta.toNumber(),
                      stopLossSizePct: entirePosition ? 10000 : decoded.data.sizeUsdDelta.toNumber()
                    }
                  };
                  
                  console.log(`Extracted inner TP/SL data:`, tpslParams);
                  return tpslParams;
                }
                else if (isUpdateTpsl) {
                  const { triggerPrice, triggerAboveThreshold, entirePosition } = decoded.data;
                  
                  const tpslParams = {
                    instructionName: 'instantUpdateTpsl',
                    params: {
                      takeProfitTriggerPrice: triggerAboveThreshold ? triggerPrice : null,
                      stopLossTriggerPrice: !triggerAboveThreshold ? triggerPrice : null,
                      takeProfitSizePct: entirePosition ? 10000 : decoded.data.sizeUsdDelta.toNumber(),
                      stopLossSizePct: entirePosition ? 10000 : decoded.data.sizeUsdDelta.toNumber()
                    }
                  };
                  
                  console.log(`Extracted inner TP/SL data:`, tpslParams);
                  return tpslParams;
                }
              } catch (error) {
                console.error(`Error decoding inner instruction: ${error instanceof Error ? error.message : String(error)}`);
                
                // Fallback to basic parsing for inner instructions too
                try {
                  const instructionDataBuffer = data.slice(8);
                  
                  let offset = 16; // Skip collateralUsdDelta and sizeUsdDelta
                  
                  // Extract triggerPrice
                  const triggerPrice = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                  offset += 8;
                  
                  // Extract triggerAboveThreshold
                  const triggerAboveThreshold = instructionDataBuffer[offset] === 1;
                  offset += 1;
                  
                  // Extract entirePosition
                  const entirePosition = instructionDataBuffer[offset] === 1;
                  
                  // Map to our format
                  const tpslParams = {
                    instructionName: isCreateTpsl ? 'instantCreateTpsl' : 'instantUpdateTpsl',
                    params: {
                      takeProfitTriggerPrice: triggerAboveThreshold ? triggerPrice : null,
                      stopLossTriggerPrice: !triggerAboveThreshold ? triggerPrice : null,
                      takeProfitSizePct: entirePosition ? 10000 : 5000, // Default to 100% for entire position, 50% otherwise
                      stopLossSizePct: entirePosition ? 10000 : 5000
                    }
                  };
                  
                  console.log(`Extracted inner TP/SL data (fallback):`, tpslParams);
                  return tpslParams;
                } catch (e) {
                  console.error(`Inner instruction fallback parsing failed: ${e instanceof Error ? e.message : String(e)}`);
                }
              }
            }
          } catch (err) {
            // Skip errors when trying to decode inner instructions
          }
        }
      }
    }
    
    console.log("No TP/SL instruction found in transaction");
    return null;
  } catch (err) {
    console.log("Error processing transaction:", err);
    return null;
  }
}

/**
 * Parse limit order instruction data from transaction
 * This function fetches the transaction that contains a limit order event and decodes the instruction data using the IDL
 */
async function getLimitOrderInstructionData(txSignature: string): Promise<any> {
  try {
    // Fetch the transaction with retry
    console.log(`Fetching transaction ${txSignature} to decode limit order instruction data...`);
    const tx = await fetchTransactionWithRetry(txSignature);
    
    if (!tx || !tx.transaction) {
      console.log("Transaction not found or has no data");
      return null;
    }
    
    // Get all instructions in the transaction - handle versioned transactions
    let instructions;
    let accountKeys;
    
    if ('message' in tx.transaction) {
      const message = tx.transaction.message;
      
      // For versioned transactions
      if ('version' in message) {
        // For MessageV0
        instructions = message.compiledInstructions;
        try {
          // For versioned transactions with lookup tables
          if (tx.meta?.loadedAddresses) {
            // Use staticAccountKeys and loaded addresses
            const staticKeys = message.staticAccountKeys || [];
            const writableKeys = tx.meta.loadedAddresses.writable || [];
            const readonlyKeys = tx.meta.loadedAddresses.readonly || [];
            accountKeys = [...staticKeys, ...writableKeys, ...readonlyKeys];
          } else {
            accountKeys = message.staticAccountKeys || [];
          }
        } catch (err) {
          console.log("Error getting account keys, using static keys:", err);
          accountKeys = message.staticAccountKeys || [];
        }
      } else {
        // For legacy transactions
        instructions = (message as any).instructions;
        accountKeys = (message as any).accountKeys;
      }
    } else {
      console.log("Unexpected transaction format");
      return null;
    }
    
    if (!instructions || !accountKeys) {
      console.log("Could not extract instructions or account keys");
      return null;
    }
    
    // Find the limit order instruction
    for (let i = 0; i < instructions.length; i++) {
      const ix = instructions[i];
      // Skip if no programId index
      if (ix.programIdIndex === undefined) continue;
      
      // Get program ID
      const programId = accountKeys[ix.programIdIndex];
      const programIdStr = programId.toString();
      
      // Check if this is a Jupiter Perpetuals instruction
      if (programIdStr === JUPITER_PERPETUALS_PROGRAM.programId.toString()) {
        // Get the instruction data
        const data = Buffer.from(ix.data);
        
        // Check the discriminator (first 8 bytes)
        const discriminator = data.slice(0, 8);
        
        // Log discriminator if we find events for debugging
        if (data.length > 8) {
          // Check for likely limit order instructions based on name patterns
          const possibleDiscriminatorNames = [
            "instant_create_limit_order",
            "instantCreateLimitOrder",
            "instant_update_limit_order",
            "instantUpdateLimitOrder"
          ];
          
          for (const name of possibleDiscriminatorNames) {
            const calculatedDiscr = Buffer.from(utils.sha256.hash(name).slice(0, 8));
            if (Buffer.compare(discriminator, calculatedDiscr) === 0) {
              console.log(`Found potential limit order instruction (${name}): [${Array.from(discriminator)}]`);
              
              // If we find a match, save it for future reference
              if (name.includes("create")) {
                LIMIT_ORDER_INSTRUCTION_DISCRIMINATORS.instantCreateLimitOrder = Buffer.from(discriminator);
              } else if (name.includes("update")) {
                LIMIT_ORDER_INSTRUCTION_DISCRIMINATORS.instantUpdateLimitOrder = Buffer.from(discriminator);
              }
            }
          }
        }
        
        // Check against known discriminators
        const isCreateLimitOrder = 
          LIMIT_ORDER_INSTRUCTION_DISCRIMINATORS.instantCreateLimitOrder.length > 0 && 
          Buffer.compare(discriminator, LIMIT_ORDER_INSTRUCTION_DISCRIMINATORS.instantCreateLimitOrder) === 0;
          
        const isUpdateLimitOrder = 
          LIMIT_ORDER_INSTRUCTION_DISCRIMINATORS.instantUpdateLimitOrder.length > 0 && 
          Buffer.compare(discriminator, LIMIT_ORDER_INSTRUCTION_DISCRIMINATORS.instantUpdateLimitOrder) === 0;
        
        if (isCreateLimitOrder || isUpdateLimitOrder) {
          // This is a limit order instruction
          console.log(`Found ${isCreateLimitOrder ? 'instantCreateLimitOrder' : 'instantUpdateLimitOrder'} instruction`);
          
          try {
            // Use Anchor's BorshCoder to decode the instruction data
            const ixName = isCreateLimitOrder ? "instantCreateLimitOrder" : "instantUpdateLimitOrder";
            const dataAfterDiscriminator = data.slice(8);
            
            try {
              // Decode the instruction data after the discriminator
              const args = JUPITER_PERPETUALS_PROGRAM.coder.types.decode(
                isCreateLimitOrder ? "InstantCreateLimitOrderParams" : "InstantUpdateLimitOrderParams", 
                dataAfterDiscriminator
              );
              
              // If we've made it here, decoding succeeded
              return {
                instructionName: ixName,
                params: args
              };
            } catch (err) {
              console.log(`Failed to decode ${ixName} instruction:`, err);
              
              // Fallback to binary parsing if needed
              // Structure of limit order params (based on IDL):
              // Price, size, etc.
              const instructionDataBuffer = data.slice(8);
              console.log("Instruction data (hex):", Buffer.from(instructionDataBuffer).toString('hex'));
              
              // Extract common fields we expect in limit orders
              let offset = 0;
              
              // Try to extract price (u64/BN)
              if (offset + 8 <= instructionDataBuffer.length) {
                const price = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                console.log(`Potential limit price: $${BNToUSDRepresentation(price, USDC_DECIMALS)}`);
                offset += 8;
              }
              
              // Try to extract size (u64/BN)
              if (offset + 8 <= instructionDataBuffer.length) {
                const size = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                console.log(`Potential size: $${BNToUSDRepresentation(size, USDC_DECIMALS)}`);
              }
            }
          } catch (error) {
            console.error(`Error processing limit order instruction: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
    
    // If we didn't find anything in the main instructions, check inner instructions
    if (tx.meta?.innerInstructions && tx.meta.innerInstructions.length > 0) {
      // Similar to TP/SL processing, look for limit order instructions in inner instructions
      // Implementation would be similar to the above code
    }
    
    return null;
  } catch (err) {
    console.log("Error processing transaction:", err);
    return null;
  }
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

  // Create an array of execution events (only the main position events)
  const positionEvents = sortedEvents.filter(evt => 
    evt.event?.name === 'IncreasePositionEvent' ||
    evt.event?.name === 'DecreasePositionEvent' ||
    evt.event?.name === 'InstantIncreasePositionEvent' ||
    evt.event?.name === 'InstantDecreasePositionEvent' ||
    evt.event?.name === 'LiquidateFullPositionEvent' ||
    evt.event?.name === 'FillLimitOrderEvent'  // Add FillLimitOrderEvent as a main event
  );

  // Create a map to associate auxiliary events (pre-swap, swap) with position events by timestamp
  const eventsByTimestamp: Map<string, EventWithTx[]> = new Map();
  
  // Group all events by their timestamp
  sortedEvents.forEach(evt => {
    if (evt.tx.blockTime) {
      const key = evt.tx.blockTime;
      if (!eventsByTimestamp.has(key)) {
        eventsByTimestamp.set(key, []);
      }
      eventsByTimestamp.get(key)?.push(evt);
    }
  });

  // Maps to track active trades and lifecycle counters
  const activeTrades: Map<string, ITrade> = new Map();
  const completedTrades: ITrade[] = [];
  const lifecycleCounters: Map<string, number> = new Map();

  // Process each execution event
  for (const eventWithTx of positionEvents) {
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

    // Get all events with the same timestamp to include auxiliary events
    const allEventsAtTimestamp = eventsByTimestamp.get(tx.blockTime || '') || [];

    // Process based on event type
    if (name === 'IncreasePositionEvent' || name === 'InstantIncreasePositionEvent') {
      const sizeUsdDelta = parseUsdValue(data.sizeUsdDelta);
      const positionSizeUsd = parseUsdValue(data.positionSizeUsd);
      const collateralUsdDelta = parseUsdValue(data.collateralUsdDelta);
      const price = parseUsdValue(data.price);
      const fee = parseUsdValue(data.feeUsd || '0');
      
      // Check if this is a new position (first increase) or adding to an existing position
      if (!activeTrade) {
        // Get asset symbol from the custody address
        const assetSymbol = getAssetNameFromCustody(data.positionCustody || "");
        
        // This is a new trade
        const newTrade: ITrade = {
          id: tradeId,
          positionKey,
          positionSide: data.positionSide,
          status: "active",
          owner: data.owner,
          asset: assetSymbol,
          entryPrice: price,
          sizeUsd: sizeUsdDelta,
          maxSize: sizeUsdDelta, // Initialize maxSize
          collateralUsd: collateralUsdDelta,
          leverage: sizeUsdDelta / collateralUsdDelta,
          totalFees: fee, // Track initial fee
          openTime: tx.blockTime,
          events: [],
        };
        
        // Add all events with the same timestamp (including preswap and swap events)
        newTrade.events = allEventsAtTimestamp;
        
        activeTrades.set(tradeId, newTrade);
      } else {
        // This is adding to an existing position
        const newCollateralUsd = activeTrade.collateralUsd + collateralUsdDelta;
        const newSizeUsd = activeTrade.sizeUsd + sizeUsdDelta;
        
        // Update the trade
        activeTrade.sizeUsd = newSizeUsd;
        activeTrade.maxSize = Math.max(newSizeUsd, activeTrade.maxSize || 0);
        activeTrade.collateralUsd = newCollateralUsd;
        activeTrade.leverage = newSizeUsd / newCollateralUsd;
        activeTrade.totalFees = (activeTrade.totalFees || 0) + fee; // Add to total fees
        
        // Add all events from this timestamp that aren't already in the trade's events
        allEventsAtTimestamp.forEach(evt => {
          if (evt && evt.event && evt.tx && evt.event.name) {
            // Check if this event is already in the trade's events
            const isDuplicate = activeTrade.events.some(existingEvt => 
              existingEvt?.tx.signature === evt.tx?.signature && 
              existingEvt?.event?.name === evt.event?.name
            );
            
            if (!isDuplicate) {
              activeTrade.events.push(evt);
            }
          }
        });
      }
    } else if (name === 'DecreasePositionEvent' || name === 'InstantDecreasePositionEvent') {
      const sizeUsdDelta = parseUsdValue(data.sizeUsdDelta);
      const positionSizeUsd = parseUsdValue(data.positionSizeUsd);
      const price = parseUsdValue(data.price);
      const pnlDelta = parseUsdValue(data.pnlDelta);
      const fee = parseUsdValue(data.feeUsd || '0');
      
      if (!activeTrade) {
        // We have a decrease event but no matching active trade
        console.error(`Error: Found decrease event for position ${positionKey} but no active trade was found. The opening event is likely missing from the data.`);
        continue;
      }
      
      // Add all events from this timestamp
      allEventsAtTimestamp.forEach(evt => {
        if (evt && evt.event && evt.tx && evt.event.name) {
          // Check if this event is already in the trade's events
          const isDuplicate = activeTrade.events.some(existingEvt => 
            existingEvt?.tx.signature === evt.tx?.signature && 
            existingEvt?.event?.name === evt.event?.name
          );
          
          if (!isDuplicate) {
            activeTrade.events.push(evt);
          }
        }
      });
      
      // Update the trade with the latest data
      activeTrade.exitPrice = price;
      activeTrade.pnl = (activeTrade.pnl || 0) + pnlDelta;
      activeTrade.hasProfit = data.hasProfit;
      activeTrade.totalFees = (activeTrade.totalFees || 0) + fee; // Add to total fees
      
      // Calculate ROI based on PnL and collateral
      if (activeTrade.pnl !== undefined) {
        activeTrade.roi = (activeTrade.pnl / activeTrade.collateralUsd) * 100;
      }
      
      // Check if position is fully closed
      if (positionSizeUsd === 0) {
        // Store the maximum size the position reached, not just the last decrease
        activeTrade.finalSize = activeTrade.maxSize || activeTrade.sizeUsd + sizeUsdDelta;
        
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
      const fee = parseUsdValue(data.feeUsd || '0');  // Extract fee from liquidation event
      const liquidationFee = parseUsdValue(data.liquidationFeeUsd || '0');
      
      if (!activeTrade) {
        // We have a liquidation event but no matching active trade
        console.error(`Error: Found liquidation event for position ${positionKey} but no active trade was found. The opening event is likely missing from the data.`);
        continue;
      }
      
      // Add all events from this timestamp
      allEventsAtTimestamp.forEach(evt => {
        if (evt && evt.event && evt.tx && evt.event.name) {
          // Check if this event is already in the trade's events
          const isDuplicate = activeTrade.events.some(existingEvt => 
            existingEvt?.tx.signature === evt.tx?.signature && 
            existingEvt?.event?.name === evt.event?.name
          );
          
          if (!isDuplicate) {
            activeTrade.events.push(evt);
          }
        }
      });
      
      // Update the trade with liquidation data
      activeTrade.status = "liquidated";
      activeTrade.exitPrice = price;
      activeTrade.closeTime = tx.blockTime;
      activeTrade.pnl = (activeTrade.pnl || 0) + pnlDelta;
      activeTrade.hasProfit = data.hasProfit;
      activeTrade.totalFees = (activeTrade.totalFees || 0) + fee + liquidationFee;  // Add liquidation fee to total
      
      // Store the maximum size the position reached
      activeTrade.finalSize = activeTrade.maxSize || activeTrade.sizeUsd;
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

  // Sort events chronologically within each trade
  const sortTradeEvents = (trade: ITrade) => {
    trade.events.sort((a, b) => {
      const aTime = a?.tx.blockTime ? new Date(a.tx.blockTime).getTime() : 0;
      const bTime = b?.tx.blockTime ? new Date(b.tx.blockTime).getTime() : 0;
      return aTime - bTime;
    });
    return trade;
  };

  // Convert maps to arrays for return
  const activeTradesArray = Array.from(activeTrades.values()).map(sortTradeEvents);
  
  // Sort completed trades by recency (newest first)
  completedTrades.sort((a, b) => {
    const aTime = a.closeTime ? new Date(a.closeTime).getTime() : 0;
    const bTime = b.closeTime ? new Date(b.closeTime).getTime() : 0;
    return bTime - aTime;
  });
  
  return {
    activeTrades: activeTradesArray,
    completedTrades: completedTrades.map(sortTradeEvents),
  };
}

// Enhance formatting for TP/SL instruction data when extracted from event
function formatTpslInstructionData(data: any): string {
  if (!data || !data.params) return "Not available";
  
  let output = [];
  
  if (data.params.takeProfitTriggerPrice) {
    const tpPrice = BNToUSDRepresentation(data.params.takeProfitTriggerPrice, USDC_DECIMALS);
    output.push(`Take Profit: $${tpPrice} (${data.params.takeProfitSizePct / 100}%)`);
  }
  
  if (data.params.stopLossTriggerPrice) {
    const slPrice = BNToUSDRepresentation(data.params.stopLossTriggerPrice, USDC_DECIMALS);
    output.push(`Stop Loss: $${slPrice} (${data.params.stopLossSizePct / 100}%)`);
  }
  
  return output.join(", ");
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
      
      // Special handling for TP/SL events - show the instruction data too
      if (evt.event.name === 'InstantCreateTpslEvent' || evt.event.name === 'InstantUpdateTpslEvent') {
        // Extract tpslInstructionData first so we can display it separately
        const { tpslInstructionData, ...eventData } = evt.event.data;
        
        // Display regular event data
        console.log("Event Data:", eventData);
        
        // Display TP/SL instruction data if available
        if (tpslInstructionData) {
          console.log("TP/SL Instruction Data:");
          console.log(`  Instruction: ${tpslInstructionData.instructionName}`);
          console.log(`  Collateral USD Delta: ${eventData.tpslCollateralUsdDelta || '$0.00'}`);
          console.log(`  Size USD Delta: ${eventData.tpslSizeUsdDelta || '$0.00'}`);
          console.log(`  Trigger Price: ${eventData.tpslTriggerPrice || 'N/A'}`);
          console.log(`  Trigger Above Threshold: ${eventData.tpslTriggerAboveThreshold ? 'Yes (Take Profit)' : 'No (Stop Loss)'}`);
          console.log(`  Entire Position: ${eventData.tpslEntirePosition ? 'Yes (100%)' : 'No (Partial)'}`);
          
          if (eventData.tpslCounter) console.log(`  Counter: ${eventData.tpslCounter}`);
          if (eventData.tpslRequestTime) console.log(`  Request Time: ${eventData.tpslRequestTime}`);
          
          // Add the interpreted TP/SL values for clarity
          console.log(`  Order Type: ${eventData.tpslTriggerAboveThreshold ? 'Take Profit' : 'Stop Loss'}`);
          
          if (eventData.tpslTriggerAboveThreshold) {
            console.log(`  Take Profit Price: ${eventData.tpslTriggerPrice}`);
            console.log(`  Take Profit Size: ${eventData.tpslEntirePosition ? '100%' : '50%'}`);
          } else {
            console.log(`  Stop Loss Price: ${eventData.tpslTriggerPrice}`);
            console.log(`  Stop Loss Size: ${eventData.tpslEntirePosition ? '100%' : '50%'}`);
          }
        } else {
          console.log("TP/SL Instruction Data: Fetching from transaction...");
          // Immediately fetch and display the instruction data
          getTpslInstructionData(evt.tx.signature).then(tpslData => {
            if (tpslData && tpslData.params) {
              console.log("Found TP/SL Instruction Data:");
              
              // Show all raw parameters
              console.log(`  Instruction: ${tpslData.instructionName}`);
              console.log(`  Collateral USD Delta: $${BNToUSDRepresentation(tpslData.params.collateralUsdDelta, USDC_DECIMALS)}`);
              console.log(`  Size USD Delta: $${BNToUSDRepresentation(tpslData.params.sizeUsdDelta, USDC_DECIMALS)}`);
              console.log(`  Trigger Price: $${BNToUSDRepresentation(tpslData.params.triggerPrice, USDC_DECIMALS)}`);
              console.log(`  Trigger Above Threshold: ${tpslData.params.triggerAboveThreshold ? 'Yes (Take Profit)' : 'No (Stop Loss)'}`);
              console.log(`  Entire Position: ${tpslData.params.entirePosition ? 'Yes (100%)' : 'No (Partial)'}`);
              
              if (tpslData.params.counter) 
                console.log(`  Counter: ${tpslData.params.counter.toString()}`);
              
              if (tpslData.params.requestTime) {
                const timestamp = new Date(tpslData.params.requestTime.toNumber() * 1000).toISOString();
                console.log(`  Request Time: ${timestamp}`);
              }
              
              // Show interpreted values
              console.log(`  Order Type: ${tpslData.params.triggerAboveThreshold ? 'Take Profit' : 'Stop Loss'}`);
              
              if (tpslData.params.triggerAboveThreshold && tpslData.params.takeProfitTriggerPrice) {
                const tpPrice = BNToUSDRepresentation(tpslData.params.takeProfitTriggerPrice, USDC_DECIMALS);
                console.log(`  Take Profit Price: $${tpPrice}`);
                console.log(`  Take Profit Size: ${tpslData.params.entirePosition ? '100%' : '50%'}`);
              } else if (!tpslData.params.triggerAboveThreshold && tpslData.params.stopLossTriggerPrice) {
                const slPrice = BNToUSDRepresentation(tpslData.params.stopLossTriggerPrice, USDC_DECIMALS);
                console.log(`  Stop Loss Price: $${slPrice}`);
                console.log(`  Stop Loss Size: ${tpslData.params.entirePosition ? '100%' : '50%'}`);
              }
            } else {
              console.log("  Failed to extract TP/SL instruction data from transaction");
            }
          }).catch(err => {
            console.log("  Error fetching TP/SL instruction data:", err.message);
          });
        }
      } 
      // Add handling for limit order events
      else if (evt.event.name === 'InstantCreateLimitOrderEvent' || evt.event.name === 'InstantUpdateLimitOrderEvent' || evt.event.name === 'FillLimitOrderEvent') {
        // Extract limit order instruction data first
        const { limitOrderInstructionData, ...eventData } = evt.event.data;
        
        // Display regular event data
        console.log("Event Data:", eventData);
        
        // Try to fetch and decode the limit order instruction data if not already available
        if (!limitOrderInstructionData) {
          console.log("Limit Order Instruction Data: Fetching from transaction...");
          
          // Fetch limit order data asynchronously
          getLimitOrderInstructionData(evt.tx.signature).then(orderData => {
            if (orderData) {
              console.log("Found Limit Order Instruction Data:");
              console.log(`  Instruction: ${orderData.instructionName}`);
              
              // Format and display parameters based on instruction type
              if (orderData.params) {
                // Create or Update limit order
                if (orderData.params.price) {
                  console.log(`  Limit Price: $${BNToUSDRepresentation(orderData.params.price, USDC_DECIMALS)}`);
                }
                
                if (orderData.params.size) {
                  console.log(`  Size: $${BNToUSDRepresentation(orderData.params.size, USDC_DECIMALS)}`);
                }
                
                // Add any other relevant fields
                if (orderData.params.orderType !== undefined) {
                  console.log(`  Order Type: ${orderData.params.orderType === 0 ? 'Buy' : 'Sell'}`);
                }
              }
            } else {
              console.log("  Failed to extract limit order instruction data");
            }
          }).catch(err => {
            console.log("  Error fetching limit order data:", err.message);
          });
        } else {
          // If we already have the data, display it
          console.log("Limit Order Instruction Data:");
          console.log(limitOrderInstructionData);
        }
      }
      // Add special handling for pool swap events
      else if (evt.event.name === 'PoolSwapEvent' || evt.event.name === 'PoolSwapExactOutEvent') {
        // Just display the raw data as fetched/parsed
        console.log("Event Data:", evt.event.data);
      }
      else {
        // Regular event display
        console.log("Data:", evt.event.data);
      }
    }
  });
  console.log("============================\n");
  
  // Group events into trades
  return groupEventsIntoTrades(events);
}

// Helper function to format limit order data
function formatLimitOrderData(data: any): string {
  if (!data || !data.params) return "Not available";
  
  let output = [];
  
  if (data.params.price) {
    const price = BNToUSDRepresentation(data.params.price, USDC_DECIMALS);
    output.push(`Limit Price: $${price}`);
  }
  
  if (data.params.size) {
    const size = BNToUSDRepresentation(data.params.size, USDC_DECIMALS);
    output.push(`Size: $${size}`);
  }
  
  // Add more fields as needed
  
  return output.join(", ");
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
    for (let i = 0; i < activeTrades.length; i++) {
      await printDetailedTradeInfo(activeTrades[i], i);
    }
  }
  
  if (completedTrades.length > 0) {
    console.log("\n------- COMPLETED TRADES -------");
    for (let i = 0; i < completedTrades.length; i++) {
      await printDetailedTradeInfo(completedTrades[i], i);
    }
  }
  
  console.log("===============================");
}

// Update the printDetailedTradeInfo function to better display TP/SL data and add limit order info
async function printDetailedTradeInfo(trade: ITrade, index: number) {
  const side = trade.positionSide;
  const status = trade.status === "liquidated" ? "LIQUIDATED" : (trade.status === "closed" ? "CLOSED" : "ACTIVE");
  const pnl = trade.pnl ? `$${trade.pnl.toFixed(2)}` : "N/A";
  const roi = trade.roi ? `${trade.roi.toFixed(2)}%` : "N/A";
  
  console.log(`\nTrade #${index + 1} (ID: ${trade.id}):`);
  
  // Replace Position field with Symbol
  if (trade.asset) {
    console.log(`Symbol: ${trade.asset}`);
  }
  
  // Show just Long or Short as Direction
  console.log(`Direction: ${side}`);
  
  console.log(`Status: ${status}`);
  console.log(`Entry Price: $${trade.entryPrice.toFixed(2)}`);
  
  if (trade.exitPrice) {
    console.log(`Exit Price: $${trade.exitPrice.toFixed(2)}`);
  }
  
  // Show finalSize for completed trades if available, otherwise show sizeUsd
  const displaySize = (trade.status !== "active" && trade.finalSize) ? 
    trade.finalSize : trade.sizeUsd;
  console.log(`Size: $${displaySize.toFixed(2)}`);
  
  // Calculate and display notional size
  if (trade.entryPrice > 0) {
    const notionalSize = displaySize / trade.entryPrice;
    console.log(`Notional Size: ${notionalSize.toFixed(6)} ${trade.asset || ''}`);
  }
  
  console.log(`Collateral: $${trade.collateralUsd.toFixed(2)}`);
  console.log(`Leverage: ${trade.leverage.toFixed(2)}x`);
  
  // Display total fees
  if (trade.totalFees !== undefined) {
    console.log(`Total Fees: $${trade.totalFees.toFixed(2)}`);
  }
  
  if (trade.pnl !== undefined) {
    console.log(`PnL: ${pnl} (${roi})`);
    console.log(`Profitable: ${trade.hasProfit ? "Yes" : "No"}`);
  }
  
  // Add token information for the position
  const firstEvent = trade.events.find(evt => 
    evt?.event?.name === 'IncreasePositionEvent' || 
    evt?.event?.name === 'InstantIncreasePositionEvent'
  );
  
  if (firstEvent?.event?.data) {
    const collateralCustody = firstEvent.event.data.positionCollateralCustody;
    console.log(`Collateral Token: ${getAssetNameFromCustody(collateralCustody)}`);
  }
  
  // Check for swaps in the trade
  const hasOpeningSwap = trade.events.some(evt => evt?.event?.name === 'IncreasePositionPreSwapEvent');
  const hasClosingSwap = trade.events.some(evt => evt?.event?.name === 'DecreasePositionPostSwapEvent');
  
  // Add token comparison detection for swaps
  const firstIncreaseEvent = trade.events.find(evt => 
    evt?.event?.name === 'IncreasePositionEvent' || 
    evt?.event?.name === 'InstantIncreasePositionEvent'
  );

  const lastDecreaseEvent = trade.events.find(evt => 
    (evt?.event?.name === 'DecreasePositionEvent' || 
    evt?.event?.name === 'InstantDecreasePositionEvent' ||
    evt?.event?.name === 'LiquidateFullPositionEvent') &&
    (trade.status !== "active")
  );

  let swapDetectedByTokens = false;
  let openingSwapByTokens = false;
  let closingSwapByTokens = false;

  // Check for opening swap by comparing tokens
  if (firstIncreaseEvent?.event?.data) {
    const data = firstIncreaseEvent.event.data;
    const collateralCustody = data.positionCollateralCustody;
    const requestMint = data.positionRequestMint;
    
    // Only compare if both values are defined
    if (collateralCustody && requestMint) {
      // For longs: if input token differs from collateral token
      // For shorts: if input token is not USDC/USDT
      if (data.positionSide === "Long") {
        // For longs, the collateral token and request mint should be the same if no swap
        openingSwapByTokens = getAssetNameFromCustody(collateralCustody) !== getSymbolFromMint(requestMint);
      } else {
        // For shorts, the request mint should be USDC or USDT if no swap
        const requestSymbol = getSymbolFromMint(requestMint);
        openingSwapByTokens = requestSymbol !== "USDC" && requestSymbol !== "USDT";
      }
    }
  }

  // Check for closing swap by comparing tokens
  if (lastDecreaseEvent?.event?.data) {
    const data = lastDecreaseEvent.event.data;
    const collateralCustody = data.positionCollateralCustody;
    const requestMint = data.positionRequestMint;
    
    if (collateralCustody && requestMint) {
      // If collateral custody differs from request mint, a swap occurred
      closingSwapByTokens = getAssetNameFromCustody(collateralCustody) !== getSymbolFromMint(requestMint);
    }
  }

  swapDetectedByTokens = openingSwapByTokens || closingSwapByTokens;

  // Combine both detection methods
  const swapsDetected = hasOpeningSwap || hasClosingSwap || swapDetectedByTokens;
  const openingSwaps = hasOpeningSwap || openingSwapByTokens;
  const closingSwaps = hasClosingSwap || closingSwapByTokens;

  if (swapsDetected) {
    console.log(`Swaps: ${openingSwaps ? 'Opening' : ''}${openingSwaps && closingSwaps ? ' and ' : ''}${closingSwaps ? 'Closing' : ''}`);
    
    // Additional debug info if tokens suggest swaps but events don't
    if (swapDetectedByTokens && !(hasOpeningSwap || hasClosingSwap)) {
      console.log(`  (Detected by token comparison)`);
      
      if (openingSwapByTokens && firstIncreaseEvent?.event?.data) {
        const data = firstIncreaseEvent.event.data;
        if (data.positionRequestMint && data.positionCollateralCustody) {
          console.log(`  Opening: ${getSymbolFromMint(data.positionRequestMint)} → ${getAssetNameFromCustody(data.positionCollateralCustody)}`);
        }
      }
      
      if (closingSwapByTokens && lastDecreaseEvent?.event?.data) {
        const data = lastDecreaseEvent.event.data;
        if (data.positionCollateralCustody && data.positionRequestMint) {
          console.log(`  Closing: ${getAssetNameFromCustody(data.positionCollateralCustody)} → ${getSymbolFromMint(data.positionRequestMint)}`);
        }
      }
    }
  }
  
  // Add payout information for closed/liquidated positions
  if (trade.status !== "active") {
    const lastEvent = trade.events.find(evt => 
      evt?.event?.name === 'DecreasePositionEvent' || 
      evt?.event?.name === 'InstantDecreasePositionEvent' ||
      evt?.event?.name === 'LiquidateFullPositionEvent'
    );
    
    if (lastEvent?.event?.data) {
      const data = lastEvent.event.data;
      
      if (data.transferAmountUsd) {
        console.log(`Payout (USD): $${parseUsdValue(data.transferAmountUsd).toFixed(2)}`);
      }
      
      if (data.transferToken) {
        const tokenAmount = Number(data.transferToken);
        const requestMint = data.positionRequestMint || data.desiredMint;
        let tokenSymbol = "Unknown";
        let decimals = 6; // Default to 6 decimals (USDC)
        
        // Try to determine token symbol and decimals
        if (requestMint) {
          // Known token addresses
          if (requestMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") {
            tokenSymbol = "USDC";
            decimals = 6;
          } else if (requestMint === "So11111111111111111111111111111111111111112") {
            tokenSymbol = "SOL";
            decimals = 9;
          } else if (requestMint === "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs") {
            tokenSymbol = "WETH";
            decimals = 8;
          }
        }
        
        const formattedAmount = (tokenAmount / Math.pow(10, decimals)).toFixed(decimals === 9 ? 6 : 2);
        console.log(`Payout (Token): ${formattedAmount} ${tokenSymbol}`);
        
        // If we have both USD and token amounts, calculate implied swap fee
        if (data.transferAmountUsd && parseUsdValue(data.transferAmountUsd) > 0) {
          const usdAmount = parseUsdValue(data.transferAmountUsd);
          const tokenInUsd = tokenAmount / Math.pow(10, decimals);
          
          // If there's a significant difference, it might indicate swap fees
          if (Math.abs(usdAmount - tokenInUsd) > 0.1 && tokenSymbol === "USDC") {
            const impliedFee = usdAmount - tokenInUsd;
            console.log(`Implied Swap Fee: $${impliedFee.toFixed(2)} (${(impliedFee/usdAmount*100).toFixed(2)}%)`);
          }
        }
      }
    }
  }
  
  console.log(`Opened: ${trade.openTime}`);
  
  if (trade.closeTime) {
    console.log(`Closed: ${trade.closeTime}`);
  }
  
  // Check for TP/SL events in the trade
  const hasTpslEvent = trade.events.some(evt => 
    evt?.event?.name === 'InstantCreateTpslEvent' || 
    evt?.event?.name === 'InstantUpdateTpslEvent'
  );

  if (hasTpslEvent) {
    // Find the most recent TP/SL event to show current values
    const tpslEvent = [...trade.events]
      .reverse()
      .find(evt => 
        evt?.event?.name === 'InstantCreateTpslEvent' || 
        evt?.event?.name === 'InstantUpdateTpslEvent'
      );
    
    if (tpslEvent?.event?.data) {
      const data = tpslEvent.event.data;
      
      // First check if we have instruction data directly in the event
      if (data.tpslInstructionData && data.tpslInstructionData.params) {
        const tpslData = data.tpslInstructionData;
        const isTP = data.tpslTriggerAboveThreshold;
        const isSL = !data.tpslTriggerAboveThreshold;
        
        console.log(`TP/SL Orders: ${isTP ? 'Take Profit' : ''}${isTP && isSL ? ' and ' : ''}${isSL ? 'Stop Loss' : ''}`);
        
        // Show all the TP/SL instruction parameters
        console.log(`  Instruction: ${tpslData.instructionName}`);
        console.log(`  Trigger Price: ${data.tpslTriggerPrice}`);
        console.log(`  Order Type: ${isTP ? 'Take Profit' : 'Stop Loss'}`);
        console.log(`  Size: ${data.tpslEntirePosition ? '100%' : '50%'} of position`);
        
        if (data.tpslCollateralUsdDelta && data.tpslCollateralUsdDelta !== '$0.00') 
          console.log(`  Collateral USD Delta: ${data.tpslCollateralUsdDelta}`);
        
        if (data.tpslSizeUsdDelta && data.tpslSizeUsdDelta !== '$0.00')
          console.log(`  Size USD Delta: ${data.tpslSizeUsdDelta}`);
        
        if (data.tpslCounter && data.tpslCounter !== '0')
          console.log(`  Counter: ${data.tpslCounter}`);
        
        if (data.tpslRequestTime)
          console.log(`  Request Time: ${data.tpslRequestTime}`);
      } 
      // ... rest of the existing function
    } else {
      console.log(`TP/SL Orders: Set`);
    }
  }
  
  // Check for limit order events in the trade
  const hasLimitOrderEvent = trade.events.some(evt => 
    evt?.event?.name === 'InstantCreateLimitOrderEvent' || 
    evt?.event?.name === 'InstantUpdateLimitOrderEvent' ||
    evt?.event?.name === 'FillLimitOrderEvent'
  );

  if (hasLimitOrderEvent) {
    // Find the most recent limit order event to show current values
    const limitOrderEvent = [...trade.events]
      .reverse()
      .find(evt => 
        evt?.event?.name === 'InstantCreateLimitOrderEvent' || 
        evt?.event?.name === 'InstantUpdateLimitOrderEvent' ||
        evt?.event?.name === 'FillLimitOrderEvent'
      );
    
    if (limitOrderEvent?.event?.data) {
      const data = limitOrderEvent.event.data;
      
      // First check if we have instruction data directly in the event
      if (data.limitOrderInstructionData && data.limitOrderInstructionData.params) {
        const orderData = data.limitOrderInstructionData;
        
        console.log(`Limit Order: Active`);
        
        // Show limit order parameters
        if (orderData.params.price) {
          console.log(`  Limit Price: $${BNToUSDRepresentation(orderData.params.price, USDC_DECIMALS)}`);
        }
        
        if (orderData.params.size) {
          console.log(`  Size: $${BNToUSDRepresentation(orderData.params.size, USDC_DECIMALS)}`);
        }
        
        // Add any other relevant fields
        if (orderData.params.orderType !== undefined) {
          console.log(`  Order Type: ${orderData.params.orderType === 0 ? 'Buy' : 'Sell'}`);
        }
      } else if (limitOrderEvent.event.name === 'FillLimitOrderEvent') {
        // For fill events, we can display information directly from the event
        console.log(`Limit Order: Filled`);
        if (data.price) {
          console.log(`  Fill Price: ${data.price}`);
        }
        if (data.size) {
          console.log(`  Size: ${data.size}`);
        }
      } else {
        console.log(`Limit Order: Set`);
      }
    } else {
      console.log(`Limit Order: Set`);
    }
  }
  
  console.log(`Events in trade: ${trade.events.length}`);
  
  // Enhanced events summary
  console.log("\nEvents:");
  trade.events.forEach((evt, i) => {
    if (evt && evt.event) {
      const eventData = evt.event.data;
      const eventType = evt.event.name;
      const eventTime = evt.tx.blockTime || "Unknown";
      
      // Special handling for PoolSwapEvent in trade events
      if (eventType === 'PoolSwapEvent' || eventType === 'PoolSwapExactOutEvent') {
        console.log(`  ${i+1}. ${eventType}`);
        console.log(`     Date: ${eventTime}`);
        
        // Get tokens by custody addresses
        const receivingCustody = eventData.receivingCustodyKey || 'Unknown';
        const dispensingCustody = eventData.dispensingCustodyKey || 'Unknown';
        
        const receivingSymbol = getAssetNameFromCustody(receivingCustody);
        const dispensingSymbol = getAssetNameFromCustody(dispensingCustody);
        
        // From user's perspective, the swap is reversed
        console.log(`     Swap: ${receivingSymbol} → ${dispensingSymbol}`);
        console.log(`     Pool: ${eventData.poolKey ? eventData.poolKey.substring(0, 8) + '...' : 'Unknown'}`);
        
        // Format amounts with appropriate decimals
        if (eventData.amountOut) {
          const amountOut = Number(eventData.amountOut);
          const formattedAmount = formatTokenAmount(amountOut, receivingSymbol);
          console.log(`     Amount In: ${formattedAmount} ${receivingSymbol}`);
        }
        
        if (eventData.amountIn) {
          const amountIn = Number(eventData.amountIn);
          const formattedAmount = formatTokenAmount(amountIn, dispensingSymbol);
          console.log(`     Amount Out: ${formattedAmount} ${dispensingSymbol}`);
        }
        
        if (eventData.swapUsdAmount) {
          console.log(`     Swap USD Amount: ${eventData.swapUsdAmount}`);
        }
        
        if (eventData.feeBps) {
          const feeBpsNum = Number(eventData.feeBps);
          console.log(`     Fee: ${feeBpsNum / 100}% (${feeBpsNum} bps)`);
          
          // Calculate actual fee amount if available
          if (eventData.amountOutAfterFees && eventData.amountOut) {
            const feeAmount = Number(eventData.amountOut) - Number(eventData.amountOutAfterFees);
            const formattedFee = formatTokenAmount(feeAmount, dispensingSymbol);
            console.log(`     Fee Amount: ${formattedFee} ${dispensingSymbol}`);
          }
        }
      }
      // For regular events (not pool swap)
      else {
        // Determine if buy or sell
        let action = "";
        if (eventType.includes('Increase')) {
          action = trade.positionSide === "Long" ? "Buy" : "Sell";
        } else if (eventType.includes('Decrease') || eventType.includes('Liquidate')) {
          action = trade.positionSide === "Long" ? "Sell" : "Buy";
        }
        
        // Determine if market or limit based on positionRequestType and event name
        let orderType = "Market"; // Default to Market
        if (eventType.includes('Instant')) {
          // All Instant events are market orders by definition
          orderType = "Market";
        } else if (eventType.includes('Increase') || eventType.includes('Decrease')) {
          // For non-Instant events, check positionRequestType if available
          if (eventData.positionRequestType !== undefined) {
            orderType = eventData.positionRequestType === 0 ? "Market" : "Limit";
          }
        } else if (eventType.includes('Liquidate')) {
          // Liquidations are always forced market orders
          orderType = "Market";
        }
        
        console.log(`  ${i+1}. ${eventType}`);
        console.log(`     Date: ${eventTime}`);
        console.log(`     Action: ${action}`);
        console.log(`     Type: ${orderType}`);
        
        // Display token information
        if (eventData.positionMint) {
          const symbol = getSymbolFromMint(eventData.positionMint);
          console.log(`     Trading: ${symbol}${eventData.positionMint ? ` (${eventData.positionMint.substring(0, 8)}...)` : ''}`);
        }
        
        if (eventData.positionRequestMint) {
          const symbol = getSymbolFromMint(eventData.positionRequestMint);
          console.log(`     Using: ${symbol}${eventData.positionRequestMint ? ` (${eventData.positionRequestMint.substring(0, 8)}...)` : ''}`);
        }
        
        // Get sizes - with special handling for liquidation events
        let sizeUsd = 0;
        if (eventType.includes('Liquidate')) {
          // For liquidation events, use positionSizeUsd instead of sizeUsdDelta
          sizeUsd = parseUsdValue(eventData.positionSizeUsd || "0");
        } else {
          sizeUsd = parseUsdValue(eventData.sizeUsdDelta || "0");
        }
        
        const price = parseUsdValue(eventData.price || "0");
        const notionalSize = price > 0 ? sizeUsd / price : 0;
        
        // Only show notional size for non-liquidation events
        if (!eventType.includes('Liquidate')) {
          console.log(`     Size (Notional): ${notionalSize.toFixed(6)} ${trade.asset || ''}`);
        }
        console.log(`     Size (USD): $${sizeUsd.toFixed(2)}`);
        console.log(`     Price: ${eventData.price || "N/A"}`);
        
        // Add payout information for decrease/liquidation events
        if (eventType.includes('Decrease') || eventType.includes('Liquidate')) {
          if (eventData.transferAmountUsd) {
            console.log(`     Payout (USD): $${parseUsdValue(eventData.transferAmountUsd).toFixed(2)}`);
          }
          
          if (eventData.transferToken) {
            const tokenAmount = Number(eventData.transferToken);
            const requestMint = eventData.positionRequestMint || eventData.desiredMint;
            let tokenSymbol = "Unknown";
            let decimals = 6; // Default to 6 decimals (USDC)
            
            // Try to determine token symbol and decimals
            if (requestMint) {
              // Known token addresses
              if (requestMint === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v") {
                tokenSymbol = "USDC";
                decimals = 6;
              } else if (requestMint === "So11111111111111111111111111111111111111112") {
                tokenSymbol = "SOL";
                decimals = 9;
              } else if (requestMint === "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs") {
                tokenSymbol = "WETH";
                decimals = 8;
              }
            }
            
            const formattedAmount = (tokenAmount / Math.pow(10, decimals)).toFixed(decimals === 9 ? 6 : 2);
            console.log(`     Payout (Token): ${formattedAmount} ${tokenSymbol}`);
          }
        }
        
        // Handle fees display - with special handling for liquidation events
        const fee = parseUsdValue(eventData.feeUsd || "0");
        console.log(`     Fee: $${fee.toFixed(2)}`);
        
        if (eventType.includes('Liquidate') && eventData.liquidationFeeUsd) {
          const liquidationFee = parseUsdValue(eventData.liquidationFeeUsd);
          console.log(`     Liquidation Fee: $${liquidationFee.toFixed(2)}`);
        }
        
        // Add collateral information for relevant events - simplified
        if (eventType.includes('Increase') || eventType.includes('Decrease')) {
          const collateralUsd = parseUsdValue(eventData.collateralUsdDelta || "0");
          console.log(`     Collateral (USD): $${collateralUsd.toFixed(2)}`);
        }
        
        // Show profit/loss information for decrease events
        if ((eventType.includes('Decrease') || eventType.includes('Liquidate')) && eventData.pnlDelta) {
          const pnlDelta = parseUsdValue(eventData.pnlDelta);
          console.log(`     PnL: $${pnlDelta.toFixed(2)} (${eventData.hasProfit ? 'Profit' : 'Loss'})`);
        }
      }
    }
  });
}

// Helper function to get token symbol from mint address
function getSymbolFromMint(mintAddress: string | undefined): string {
  // Check if mintAddress is undefined or null
  if (!mintAddress) {
    return "Unknown";
  }
  
  // Common token addresses
  switch(mintAddress) {
    case "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v":
      return "USDC";
    case "So11111111111111111111111111111111111111112":
      return "SOL";
    case "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs":
      return "WETH";
    case "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh":
      return "wBTC";
    default:
      return mintAddress.substring(0, 6) + "...";
  }
}

// Helper function to format token amounts with appropriate decimals
function formatTokenAmount(amount: number, tokenSymbol: string): string {
  // Get decimals based on token
  let decimals = 6; // Default (USDC, USDT)
  
  switch(tokenSymbol) {
    case "SOL":
      decimals = 9;
      break;
    case "ETH":
    case "WETH":
      decimals = 8;
      break;
    case "BTC":
    case "wBTC":
      decimals = 8;
      break;
    case "USDC":
    case "USDT":
      decimals = 6;
      break;
  }
  
  // Format the amount
  const formattedAmount = (amount / Math.pow(10, decimals)).toFixed(decimals === 9 ? 3 : 2);
  return formattedAmount;
}

// Add helper function to get asset name from custody pubkey if not already present
function getAssetNameFromCustody(custodyPubkey: string | undefined): string {
  if (!custodyPubkey) {
    return "Unknown";
  }
  
  switch(custodyPubkey) {
    case CUSTODY_PUBKEY.SOL:
      return "SOL";
    case CUSTODY_PUBKEY.ETH:
      return "ETH";
    case CUSTODY_PUBKEY.BTC:
      return "BTC";
    case CUSTODY_PUBKEY.USDC:
      return "USDC";
    case CUSTODY_PUBKEY.USDT:
      return "USDT";
    default:
      return "Unknown";
  }
}

// Run the example
analyzeTradeHistory().then(() => {
  console.log("Trade analysis complete");
}).catch(err => {
  console.error("Error analyzing trades:", err);
});