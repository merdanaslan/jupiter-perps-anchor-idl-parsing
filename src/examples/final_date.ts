import { DISCRIMINATOR_SIZE, IdlEvents, utils } from "@coral-xyz/anchor";
import {
  JUPITER_PERPETUALS_PROGRAM,
  RPC_CONNECTION,
  USDC_DECIMALS,
  CUSTODY_PUBKEY,
  JLP_POOL_ACCOUNT_PUBKEY,
  JUPITER_PERPETUALS_PROGRAM_ID,
  CUSTODY_PUBKEYS,
} from "../constants";
import { PublicKey } from "@solana/web3.js";
import { Perpetuals } from "../idl/jupiter-perpetuals-idl";
import { BN } from "@coral-xyz/anchor";
import { BNToUSDRepresentation } from "../utils";

// Position PDA generation functions (imported from generate-position-and-position-request-pda.ts)
function generatePositionPda({
  custody,
  collateralCustody,
  walletAddress,
  side,
}: {
  custody: PublicKey;
  collateralCustody: PublicKey;
  walletAddress: PublicKey;
  side: "long" | "short";
}) {
  const [position, bump] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("position"),
      walletAddress.toBuffer(),
      JLP_POOL_ACCOUNT_PUBKEY.toBuffer(),
      custody.toBuffer(),
      collateralCustody.toBuffer(),
      // @ts-ignore
      side === "long" ? [1] : [2], // This is due to how the `Side` enum is structured in the contract
    ],
    JUPITER_PERPETUALS_PROGRAM_ID,
  );

  return { position, bump };
}

// Helper function to get asset name from custody pubkey
function getAssetNameFromCustodyPda(custodyPubkey: string): string {
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

// Generate all possible position PDAs for a wallet
function generateAllPositionPdas(walletAddress: string) {
  const walletPubkey = new PublicKey(walletAddress);
  
  // Results container
  const results: Array<{
    type: string;
    positionPda: PublicKey;
    description: string;
  }> = [];
  
  // Loop through all custodies (SOL, BTC, ETH)
  for (let i = 0; i < 3; i++) {
    const assetCustody = CUSTODY_PUBKEYS[i];
    const assetName = getAssetNameFromCustodyPda(assetCustody.toBase58());
    
    // Generate Long position PDA
    const longPosition = generatePositionPda({
      custody: assetCustody,
      collateralCustody: assetCustody, // For long, custody and collateralCustody are the same
      walletAddress: walletPubkey,
      side: "long",
    });
    
    results.push({
      type: "Long",
      positionPda: longPosition.position,
      description: `Long ${assetName} (using ${assetName} as collateral)`,
    });
    
    // Generate Short positions with USDC and USDT as collateral
    for (let j = 3; j < 5; j++) { // USDC and USDT are at index 3 and 4
      const stableCustody = CUSTODY_PUBKEYS[j];
      const stableName = getAssetNameFromCustodyPda(stableCustody.toBase58());
      
      const shortPosition = generatePositionPda({
        custody: assetCustody,
        collateralCustody: stableCustody,
        walletAddress: walletPubkey,
        side: "short",
      });
      
      results.push({
        type: "Short",
        positionPda: shortPosition.position,
        description: `Short ${assetName} (using ${stableName} as collateral)`,
      });
    }
  }
  
  return results;
}

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
  instantCreateTpsl: Buffer.from([117, 98, 66, 127, 30, 50, 73, 185]), // Known discriminator from our debug output
  instantUpdateTpsl: Buffer.from([144, 228, 114, 37, 165, 242, 111, 101])  // Found from debug output
};

// Add discriminators for limit order instructions
export const LIMIT_ORDER_INSTRUCTION_DISCRIMINATORS = {
  instantCreateLimitOrder: Buffer.from([]), // Will be populated from debug if found
  instantUpdateLimitOrder: Buffer.from([])  // Will be populated from debug if found
};


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

// Helper function to parse date in DD.MM.YYYY format
function parseDate(dateString: string): Date {
  const [day, month, year] = dateString.split('.').map(Number);
  return new Date(year, month - 1, day); // month is 0-indexed in JS Date
}

// Helper function to check if we should continue fetching based on date range
function shouldContinueFetching(blockTime: number | null, targetDate: Date): boolean {
  if (!blockTime) return true; // If no blockTime, continue fetching
  const txDate = new Date(blockTime * 1000);
  return txDate >= targetDate;
}

// Helper function to check if transaction is within date range
function isWithinDateRange(blockTime: number | null, fromDate: Date, toDate: Date): boolean {
  if (!blockTime) return false; // Skip transactions without blockTime
  const txDate = new Date(blockTime * 1000);
  return txDate <= fromDate && txDate >= toDate;
}

export async function getPositionEvents(targetDateString?: string, walletAddress?: string, fromDateString?: string) {
  // Default wallet address if not provided
  const defaultWalletAddress = "CZKPYBkGXg1G6W8EXLxHDLRwsYtMz8TBk1qfPgCMzxG1";
  const wallet = walletAddress || defaultWalletAddress;
  
  // Generate all possible position PDAs for the wallet
  console.log(`\nGenerating position PDAs for wallet: ${wallet}`);
  const positionPdas = generateAllPositionPdas(wallet);
  
  console.log(`Found ${positionPdas.length} possible position PDAs:`);
  positionPdas.forEach((pda, index) => {
    console.log(`  ${index + 1}. ${pda.description}`);
    console.log(`     PDA: ${pda.positionPda.toBase58()}`);
  });
  
  // Parse target date (default to 30 days ago if not provided)
  const targetDate = targetDateString 
    ? parseDate(targetDateString)
    : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
  
  // Parse from date (default to "now" if not provided)
  const fromDate = fromDateString 
    ? parseDate(fromDateString)
    : new Date(); // Current moment
  
  // Validate date range
  if (fromDate <= targetDate) {
    throw new Error(`FROM_DATE (${fromDate.toLocaleDateString('en-GB')}) must be newer than TO_DATE (${targetDate.toLocaleDateString('en-GB')})`);
  }
  
  console.log(`\nGetting signatures from ${fromDate.toLocaleDateString('en-GB')} back to ${targetDate.toLocaleDateString('en-GB')}...`);
  
  // Collect all events from all PDAs
  const allEvents: any[] = [];
  
  // Process each PDA
  for (let pdaIndex = 0; pdaIndex < positionPdas.length; pdaIndex++) {
    const currentPda = positionPdas[pdaIndex];
    console.log(`\n=== Processing PDA ${pdaIndex + 1}/${positionPdas.length}: ${currentPda.description} ===`);
    
    // Add delay between PDA processing to avoid rate limits
    if (pdaIndex > 0) {
      console.log(`Waiting 10 seconds before processing next PDA to avoid rate limits...`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
    
    const allSignatures: any[] = [];
    let beforeSignature: string | undefined = undefined;
    let hasMoreTransactions = true;
    let totalFetched = 0;
    
    // Fetch transactions in batches until we reach the target date
    while (hasMoreTransactions && totalFetched < 1000) { // Safety limit of 1000 transactions per PDA
      const options: any = { limit: 100 }; // Fetch 100 at a time for better performance
      if (beforeSignature) {
        options.before = beforeSignature;
      }
      
      const confirmedSignatureInfos = await getSignaturesWithRetry(currentPda.positionPda, options);

      if (!confirmedSignatureInfos || confirmedSignatureInfos.length === 0) {
        console.log(`No more transactions found for ${currentPda.description}`);
        break;
      }
      
      totalFetched += confirmedSignatureInfos.length;
      console.log(`Fetched ${confirmedSignatureInfos.length} signatures (total: ${totalFetched} for this PDA)`);
      
      // Add delay between signature fetching batches to avoid rate limits
      if (confirmedSignatureInfos.length === 100) {
        console.log(`Waiting 5 seconds before fetching next batch of signatures...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      
      // Check if we've reached our target date and filter by date range
      for (const sigInfo of confirmedSignatureInfos) {
        const blockTime = sigInfo.blockTime ?? null;
        
        // Stop fetching if we've gone past the target date
        if (!shouldContinueFetching(blockTime, targetDate)) {
          console.log(`Reached target date ${targetDate.toLocaleDateString('en-GB')} for ${currentPda.description}, stopping fetch`);
          hasMoreTransactions = false;
          break;
        }
        
        // Only include transactions within the specified date range
        if (isWithinDateRange(blockTime, fromDate, targetDate)) {
          allSignatures.push(sigInfo);
        }
      }
      
      // Set up for next batch
      if (hasMoreTransactions && confirmedSignatureInfos.length === 100) {
        beforeSignature = confirmedSignatureInfos[confirmedSignatureInfos.length - 1].signature;
      } else {
        hasMoreTransactions = false;
      }
    }

    if (allSignatures.length === 0) {
      console.log(`No transactions found for ${currentPda.description} in the specified date range`);
      continue; // Move to next PDA
    }
    
    console.log(`Found ${allSignatures.length} transactions for ${currentPda.description} within date range`);
    
    // Process transactions for this PDA
    for (let i = 0; i < allSignatures.length; i++) {
      if (allSignatures[i].err) {
        console.log(`Skipping failed transaction: ${allSignatures[i].signature}`);
        continue;
      }
      
      // Add a delay between each transaction processing to avoid rate limits
      if (i > 0) {
        console.log(`Waiting 5 seconds before processing next transaction...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      
      try {
        console.log(`Processing transaction ${i+1}/${allSignatures.length} for ${currentPda.description}: ${allSignatures[i].signature}`);
        
        // Use our retry function
        const tx = await fetchTransactionWithRetry(allSignatures[i].signature);
        
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
                  signature: allSignatures[i].signature,
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
                          
                          let collateralUsdDelta, sizeUsdDelta, triggerPrice, triggerAboveThreshold, entirePosition, counter, requestTime;
                          
                          if (isCreateTpsl) {
                            // InstantCreateTpsl structure (7 fields)
                            collateralUsdDelta = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                            offset += 8;
                            
                            sizeUsdDelta = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                            offset += 8;
                            
                            triggerPrice = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                            offset += 8;
                            
                            triggerAboveThreshold = instructionDataBuffer[offset] === 1;
                            offset += 1;
                            
                            entirePosition = instructionDataBuffer[offset] === 1;
                            offset += 1;
                            
                            // Pad to 8-byte boundary for counter
                            offset = Math.ceil(offset / 8) * 8;
                            
                            counter = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                            offset += 8;
                            
                            requestTime = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                          } else {
                            // InstantUpdateTpsl structure (3 fields only)
                            // Set defaults for fields not in update
                            collateralUsdDelta = new BN(0);
                            counter = new BN(0);
                            
                            // Read the actual fields
                            sizeUsdDelta = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                            offset += 8;
                            
                            triggerPrice = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                            offset += 8;
                            
                            requestTime = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
                            
                            // For update events, determine triggerAboveThreshold from trigger price analysis
                            // This is a best-effort approach - could be improved with more context
                            // triggerAboveThreshold not available in InstantUpdateTpslParams IDL - will be retrieved from original create event
                            triggerAboveThreshold = false; // Placeholder
                            
                            // Set default for entirePosition - will be updated from original create event
                            entirePosition = false;
                          }

                          tpslData = {
                            instructionName: isCreateTpsl ? 'instantCreateTpsl' : 'instantUpdateTpsl',
                            params: {
                              collateralUsdDelta,
                              sizeUsdDelta,
                              triggerPrice,
                              triggerAboveThreshold,
                              entirePosition,
                              counter,
                              requestTime
                            }
                          };

                          // Store original create event data for linking
                          if (isCreateTpsl) {
                            // For create events, we have the complete data including size percentage
                            console.log(`Found instantCreateTpsl instruction with entirePosition: ${entirePosition}`);
                          } else {
                            // For update events, we only have the limited fields from the IDL
                            console.log(`Found instantUpdateTpsl instruction - size percentage should come from original create event`);
                          }
                          
                          // Add the instruction data to the event data
                          formattedEvent.data.tpslInstructionData = tpslData;
                          
                          // Add parsed fields to event data for easy access
                          formattedEvent.data.tpslCollateralUsdDelta = `$${BNToUSDRepresentation(collateralUsdDelta, USDC_DECIMALS)}`;
                          formattedEvent.data.tpslSizeUsdDelta = `$${BNToUSDRepresentation(sizeUsdDelta, USDC_DECIMALS)}`;
                          formattedEvent.data.tpslTriggerPrice = `$${BNToUSDRepresentation(triggerPrice, USDC_DECIMALS)}`;
                          formattedEvent.data.tpslTriggerAboveThreshold = triggerAboveThreshold;
                          formattedEvent.data.tpslEntirePosition = entirePosition;
                          formattedEvent.data.tpslCounter = counter.toString();
                          formattedEvent.data.tpslRequestTime = requestTime.toNumber() !== 0 ? 
                            new Date(requestTime.toNumber() * 1000).toISOString() : 
                            null;
                          
                          break; // Exit the loop once we find the instruction
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
  }
  
  console.log(`\n=== SUMMARY ===`);
  console.log(`Total events found across all PDAs: ${allEvents.length}`);
  
  // Sort all events chronologically before returning
  allEvents.sort((a, b) => {
    const aTime = a?.tx.blockTime ? new Date(a.tx.blockTime).getTime() : 0;
    const bTime = b?.tx.blockTime ? new Date(b.tx.blockTime).getTime() : 0;
    return aTime - bTime;
  });
  
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
      data?.event?.name === "InstantCreateTpslEvent" || // Add TP/SL events
      data?.event?.name === "InstantUpdateTpslEvent" || // Add TP/SL events
      data?.event?.name === "FillLimitOrderEvent"  // Add FillLimitOrderEvent as a main event
  );
  
  console.log(`Found ${filteredEvents.length} relevant position events across all PDAs`);
  
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

// Add retry wrapper for getSignaturesForAddress to handle rate limits during signature fetching
async function getSignaturesWithRetry(positionPda: any, options: any, maxRetries = 5): Promise<any> {
  let retries = 0;
  let delay = 500; // Start with 500ms delay
  
  while (retries < maxRetries) {
    try {
      return await RPC_CONNECTION.getSignaturesForAddress(positionPda, options);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Check if it's a rate limit error
      if (errorMessage.includes("429") || errorMessage.includes("Too Many Requests")) {
        retries++;
        
        if (retries >= maxRetries) {
          console.log(`Maximum retries (${maxRetries}) reached for signature fetching. Giving up.`);
          throw error;
        }
        
        // Exponential backoff with jitter
        const jitter = Math.random() * 0.3 + 0.85; // Random between 0.85 and 1.15
        delay = Math.min(delay * 2 * jitter, 15000); // Cap at 15 seconds for signature fetching
        
        console.log(`Signature fetch rate limited. Retry ${retries}/${maxRetries} after ${Math.round(delay)}ms delay...`);
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
        try {
          // Get the instruction data
          const data = Buffer.from(ix.data);
          
          // Check the discriminator (first 8 bytes)
          const discriminator = data.slice(0, 8);
          
          const isCreateTpsl = Buffer.compare(discriminator, TPSL_INSTRUCTION_DISCRIMINATORS.instantCreateTpsl) === 0;
          const isUpdateTpsl = Buffer.compare(discriminator, TPSL_INSTRUCTION_DISCRIMINATORS.instantUpdateTpsl) === 0;
          
          if (isCreateTpsl || isUpdateTpsl) {
            console.log(`Found ${isCreateTpsl ? 'instantCreateTpsl' : 'instantUpdateTpsl'} instruction`);
            
            // Parse TP/SL parameters from buffer
            const instructionDataBuffer = data.slice(8);
            let offset = 0;
            
            let collateralUsdDelta, sizeUsdDelta, triggerPrice, triggerAboveThreshold, entirePosition, counter, requestTime;
            
            if (isCreateTpsl) {
              // InstantCreateTpsl structure (7 fields)
              collateralUsdDelta = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
              offset += 8;
              
              sizeUsdDelta = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
              offset += 8;
              
              triggerPrice = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
              offset += 8;
              
              triggerAboveThreshold = instructionDataBuffer[offset] === 1;
              offset += 1;
              
              entirePosition = instructionDataBuffer[offset] === 1;
              offset += 1;
              
              // Pad to 8-byte boundary for counter
              offset = Math.ceil(offset / 8) * 8;
              
              counter = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
              offset += 8;
              
              requestTime = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
            } else {
              // InstantUpdateTpsl structure (3 fields only)
              // Set defaults for fields not in update
              collateralUsdDelta = new BN(0);
              counter = new BN(0);
              
              // Read the actual fields
              sizeUsdDelta = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
              offset += 8;
              
              triggerPrice = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
              offset += 8;
              
              requestTime = new BN(instructionDataBuffer.slice(offset, offset + 8), 'le');
              
              // For update events, determine triggerAboveThreshold from trigger price analysis
              // This is a best-effort approach - could be improved with more context
              // triggerAboveThreshold not available in InstantUpdateTpslParams IDL - will be retrieved from original create event
                          triggerAboveThreshold = false; // Placeholder
              
              // Set default for entirePosition - will be updated from original create event
              entirePosition = false;
            }

            const tpslData = {
              instructionName: isCreateTpsl ? 'instantCreateTpsl' : 'instantUpdateTpsl',
              params: {
                collateralUsdDelta,
                sizeUsdDelta,
                triggerPrice,
                triggerAboveThreshold,
                entirePosition,
                counter,
                requestTime
              }
            };

            // Store original create event data for linking
            if (isCreateTpsl) {
              // For create events, we have the complete data including size percentage
              console.log(`Found instantCreateTpsl instruction with entirePosition: ${entirePosition}`);
            } else {
              // For update events, we only have the limited fields from the IDL
              console.log(`Found instantUpdateTpsl instruction - size percentage should come from original create event`);
            }
            
            return {
              instructionName: isCreateTpsl ? 'instantCreateTpsl' : 'instantUpdateTpsl',
              params: {
                collateralUsdDelta,
                sizeUsdDelta,
                triggerPrice,
                triggerAboveThreshold,
                entirePosition,
                counter,
                requestTime
              }
            };
          }
        } catch (err) {
          console.log("Error parsing instruction data:", err);
          return null;
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
    evt.event?.name === 'IncreasePositionPreSwapEvent' ||
    evt.event?.name === 'DecreasePositionPostSwapEvent' ||
    evt.event?.name === 'InstantCreateTpslEvent' || // Add TP/SL events
    evt.event?.name === 'InstantUpdateTpslEvent' || // Add TP/SL events
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
    // Handle TP/SL events
    else if (name === 'InstantCreateTpslEvent' || name === 'InstantUpdateTpslEvent') {
      // For TP/SL events, we need to find the active trade for this position
      if (!activeTrade) {
        console.error(`Error: Found TP/SL event for position ${positionKey} but no active trade was found.`);
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
    }
  }

  // Sort events chronologically within each trade
  const sortTradeEvents = (trade: ITrade) => {
    trade.events.sort((a, b) => {
      const aTime = a?.tx.blockTime ? new Date(a.tx.blockTime).getTime() : 0;
      const bTime = b?.tx.blockTime ? new Date(b.tx.blockTime).getTime() : 0;
      
      // If timestamps are the same, use event type to determine order
      if (aTime === bTime) {
        // Prioritize decrease position events over pool swap events
        if (a?.event?.name === 'DecreasePositionEvent' && b?.event?.name === 'PoolSwapEvent') {
          return -1; // a comes before b
        }
        if (a?.event?.name === 'PoolSwapEvent' && b?.event?.name === 'DecreasePositionEvent') {
          return 1; // b comes before a
        }
        
        // Same logic for instant decrease position events
        if (a?.event?.name === 'InstantDecreasePositionEvent' && b?.event?.name === 'PoolSwapEvent') {
          return -1;
        }
        if (a?.event?.name === 'PoolSwapEvent' && b?.event?.name === 'InstantDecreasePositionEvent') {
          return 1;
        }
      }
      
      // Default to sorting by timestamp
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

// Helper function to find the original create event for an update event
function findOriginalCreateTpslEvent(events: EventWithTx[], updateEvent: any): any | null {
  const updateRequestKey = updateEvent.event.data.positionRequestKey;
  if (!updateRequestKey) return null;
  
  // Find the most recent create event with the same positionRequestKey
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.event?.name === 'InstantCreateTpslEvent' && 
        event.event.data.positionRequestKey === updateRequestKey &&
        event.event.data.tpslInstructionData) {
      return event.event.data.tpslInstructionData;
    }
  }
  return null;
}

/**
 * Get the complete trade history for all position PDAs of a wallet with optional date filtering
 */
export async function getPositionTradeHistory(targetDateString?: string, walletAddress?: string, fromDateString?: string): Promise<{ activeTrades: ITrade[]; completedTrades: ITrade[] }> {
  // Get all events for the wallet's position PDAs with date filtering
  const events = await getPositionEvents(targetDateString, walletAddress, fromDateString);
  
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
          
          // For update events, try to find the original create event to get correct values
          let actualEntirePosition = eventData.tpslEntirePosition;
          let actualSizePercentage = "Size from original create event";
          let actualTriggerAboveThreshold = eventData.tpslTriggerAboveThreshold;
          
          if (tpslInstructionData.instructionName === 'instantUpdateTpsl') {
            const originalCreateData = findOriginalCreateTpslEvent(events, evt);
            if (originalCreateData && originalCreateData.params) {
              actualEntirePosition = originalCreateData.params.entirePosition;
              actualTriggerAboveThreshold = originalCreateData.params.triggerAboveThreshold;
              actualSizePercentage = actualEntirePosition ? '100%' : 'Partial position';
            }
          } else if (tpslInstructionData.instructionName === 'instantCreateTpsl') {
            // For create events, use the values directly from the event
            actualSizePercentage = actualEntirePosition ? '100%' : 'Partial position';
          }
          
          // Only show collateral delta for create events
          if (tpslInstructionData.instructionName === 'instantCreateTpsl') {
            console.log(`  Collateral USD Delta: ${eventData.tpslCollateralUsdDelta || '$0.00'}`);
          }
          
          console.log(`  Size USD Delta: ${eventData.tpslSizeUsdDelta || '$0.00'}`);
          console.log(`  Trigger Price: ${eventData.tpslTriggerPrice || 'N/A'}`);
          console.log(`  Trigger Above Threshold: ${actualTriggerAboveThreshold ? 'Yes (Take Profit)' : 'No (Stop Loss)'}`);
          console.log(`  Entire Position: ${actualEntirePosition ? 'Yes (100%)' : 'No (Partial)'}`);
          
          if (eventData.tpslCounter && eventData.tpslCounter !== '0') console.log(`  Counter: ${eventData.tpslCounter}`);
          if (eventData.tpslRequestTime && eventData.tpslRequestTime !== '1970-01-01T00:00:00.000Z') console.log(`  Request Time: ${eventData.tpslRequestTime}`);
          
          // Add the interpreted TP/SL values for clarity
          console.log(`  Order Type: ${actualTriggerAboveThreshold ? 'Take Profit' : 'Stop Loss'}`);
          
          if (actualTriggerAboveThreshold) {
            console.log(`  Take Profit Price: ${eventData.tpslTriggerPrice}`);
            console.log(`  Take Profit Size: ${actualSizePercentage}`);
          } else {
            console.log(`  Stop Loss Price: ${eventData.tpslTriggerPrice}`);
            console.log(`  Stop Loss Size: ${actualSizePercentage}`);
          }
        } else {
          console.log("TP/SL Instruction Data: Fetching from transaction...");
          // Immediately fetch and display the instruction data
          getTpslInstructionData(evt.tx.signature).then(tpslData => {
            if (tpslData && tpslData.params) {
              console.log("Found TP/SL Instruction Data:");
              
              // Show all raw parameters
              console.log(`  Instruction: ${tpslData.instructionName}`);
              
              // For update events, try to find the original create event to get correct values
              let actualEntirePosition = tpslData.params.entirePosition;
              let actualSizePercentage = "Size from original create event";
              let actualTriggerAboveThreshold = tpslData.params.triggerAboveThreshold;
              
              if (tpslData.instructionName === 'instantUpdateTpsl') {
                const originalCreateData = findOriginalCreateTpslEvent(events, evt);
                if (originalCreateData && originalCreateData.params) {
                  actualEntirePosition = originalCreateData.params.entirePosition;
                  actualTriggerAboveThreshold = originalCreateData.params.triggerAboveThreshold;
                  actualSizePercentage = actualEntirePosition ? '100%' : 'Partial position';
                }
              } else if (tpslData.instructionName === 'instantCreateTpsl') {
                // For create events, use the values directly from the event
                actualSizePercentage = actualEntirePosition ? '100%' : 'Partial position';
              }
              
              // Only show collateral delta for create events
              if (tpslData.instructionName === 'instantCreateTpsl') {
                console.log(`  Collateral USD Delta: $${BNToUSDRepresentation(tpslData.params.collateralUsdDelta, USDC_DECIMALS)}`);
              }
              
              console.log(`  Size USD Delta: $${BNToUSDRepresentation(tpslData.params.sizeUsdDelta, USDC_DECIMALS)}`);
              console.log(`  Trigger Price: $${BNToUSDRepresentation(tpslData.params.triggerPrice, USDC_DECIMALS)}`);
              console.log(`  Trigger Above Threshold: ${actualTriggerAboveThreshold ? 'Yes (Take Profit)' : 'No (Stop Loss)'}`);
              console.log(`  Entire Position: ${actualEntirePosition ? 'Yes (100%)' : 'No (Partial)'}`);
              
              if (tpslData.params.counter && tpslData.params.counter.toString() !== '0') 
                console.log(`  Counter: ${tpslData.params.counter.toString()}`);
              
              if (tpslData.params.requestTime && tpslData.params.requestTime.toNumber() !== 0) {
                const timestamp = new Date(tpslData.params.requestTime.toNumber() * 1000).toISOString();
                console.log(`  Request Time: ${timestamp}`);
              }
              
              // Show interpreted values
              console.log(`  Order Type: ${actualTriggerAboveThreshold ? 'Take Profit' : 'Stop Loss'}`);
              
              if (actualTriggerAboveThreshold) {
                const tpPrice = BNToUSDRepresentation(tpslData.params.triggerPrice, USDC_DECIMALS);
                console.log(`  Take Profit Price: $${tpPrice}`);
                console.log(`  Take Profit Size: ${actualSizePercentage}`);
              } else {
                const slPrice = BNToUSDRepresentation(tpslData.params.triggerPrice, USDC_DECIMALS);
                console.log(`  Stop Loss Price: $${slPrice}`);
                console.log(`  Stop Loss Size: ${actualSizePercentage}`);
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
 * Example usage with date support and wallet address
 */
async function analyzeTradeHistory(targetDateString?: string, walletAddress?: string, fromDateString?: string) {
  const { activeTrades, completedTrades } = await getPositionTradeHistory(targetDateString, walletAddress, fromDateString);
  
  console.log(`\n======== TRADE SUMMARY ========`);
  if (targetDateString && fromDateString) {
    console.log(`Date range: From ${fromDateString} to ${targetDateString}`);
  } else if (targetDateString) {
    console.log(`Date range: From now back to ${targetDateString}`);
  } else {
    console.log(`Date range: Last 30 days (default)`);
  }
  if (walletAddress) {
    console.log(`Wallet: ${walletAddress}`);
  } else {
    console.log(`Wallet: CZKPYBkGXg1G6W8EXLxHDLRwsYtMz8TBk1qfPgCMzxG1 (default)`);
  }
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
  // Debug - Check if InstantCreateTpslEvent is in the events array
  
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
  
  // Show max size if it's different from current size (indicating multiple increases)
  if (trade.maxSize && trade.maxSize !== displaySize) {
    console.log(`Max Size: $${trade.maxSize.toFixed(2)}`);
  }
  
  // Calculate and display notional size using the display size (current/final size)
  if (trade.entryPrice > 0) {
    const notionalSize = displaySize / trade.entryPrice;
    console.log(`Notional Size: ${notionalSize.toFixed(6)} ${trade.asset || ''}`);
    
    // Also show max notional size if different
    if (trade.maxSize && trade.maxSize !== displaySize) {
      const maxNotionalSize = trade.maxSize / trade.entryPrice;
      console.log(`Max Notional Size: ${maxNotionalSize.toFixed(6)} ${trade.asset || ''}`);
    }
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
        
        // For UPDATE events, retrieve triggerAboveThreshold from original CREATE event
        let actualTriggerAboveThreshold = data.tpslTriggerAboveThreshold;
        if (tpslData.instructionName === 'instantUpdateTpsl') {
          const originalCreateData = findOriginalCreateTpslEvent(trade.events, tpslEvent);
          if (originalCreateData && originalCreateData.params) {
            actualTriggerAboveThreshold = originalCreateData.params.triggerAboveThreshold;
          }
        }
        
        const isTP = actualTriggerAboveThreshold;
        const isSL = !actualTriggerAboveThreshold;
        
        // For update events, try to find the original create event to get correct values
        let actualEntirePosition = data.tpslEntirePosition;
        let actualSizePercentage = calculateTpslSizePercentage(
          actualEntirePosition,
          data.tpslSizeUsdDelta || '$0.00',
          trade.sizeUsd
        );
        
        if (tpslData.instructionName === 'instantUpdateTpsl') {
          const originalCreateData = findOriginalCreateTpslEvent(trade.events, tpslEvent);
          if (originalCreateData && originalCreateData.params) {
            actualEntirePosition = originalCreateData.params.entirePosition;
            // For UPDATE events, we need to get the size from the original CREATE event
            const originalSizeUsdDelta = originalCreateData.data?.tpslSizeUsdDelta || '$0.00';
            actualSizePercentage = calculateTpslSizePercentage(
              actualEntirePosition,
              originalSizeUsdDelta,
              trade.sizeUsd
            );
          }
        } else if (tpslData.instructionName === 'instantCreateTpsl') {
          // For create events, use the values directly from the event
          actualSizePercentage = calculateTpslSizePercentage(
            actualEntirePosition,
            data.tpslSizeUsdDelta || '$0.00',
            trade.sizeUsd
          );
        }
        
        console.log(`TP/SL Orders: ${isTP ? 'Take Profit' : ''}${isTP && isSL ? ' and ' : ''}${isSL ? 'Stop Loss' : ''}`);
        
        // Show all the TP/SL instruction parameters
        console.log(`  Instruction: ${tpslData.instructionName}`);
        console.log(`  Trigger Price: ${data.tpslTriggerPrice}`);
        console.log(`  Order Type: ${isTP ? 'Take Profit' : 'Stop Loss'}`);
        console.log(`  Size: ${actualSizePercentage} of position`);
        
        if (data.tpslCollateralUsdDelta && data.tpslCollateralUsdDelta !== '$0.00') 
          console.log(`  Collateral USD Delta: ${data.tpslCollateralUsdDelta}`);
        
        if (data.tpslSizeUsdDelta && data.tpslSizeUsdDelta !== '$0.00')
          console.log(`  Size USD Delta: ${data.tpslSizeUsdDelta}`);
        
        if (data.tpslCounter && data.tpslCounter !== '0')
          console.log(`  Counter: ${data.tpslCounter}`);
        
        if (data.tpslRequestTime)
          console.log(`  Request Time: ${data.tpslRequestTime}`);
      }
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
        
        // Show the swap direction based on custody keys
        console.log(`     Swap: ${receivingSymbol} → ${dispensingSymbol}`);
        console.log(`     Pool: ${eventData.poolKey ? eventData.poolKey.substring(0, 8) + '...' : 'Unknown'}`);
        
        // Format amounts with appropriate decimals - match amountIn with receivingCustody (token going in)
        if (eventData.amountIn) {
          const amountIn = Number(eventData.amountIn);
          const formattedAmount = formatTokenAmount(amountIn, receivingSymbol);
          console.log(`     Amount In: ${formattedAmount} ${receivingSymbol}`);
        }
        
        // Match amountOut with dispensingCustody (token coming out)
        if (eventData.amountOut) {
          const amountOut = Number(eventData.amountOut);
          const formattedAmount = formatTokenAmount(amountOut, dispensingSymbol);
          console.log(`     Amount Out: ${formattedAmount} ${dispensingSymbol}`);
        }
        
        // Show amount out after fees
        if (eventData.amountOutAfterFees) {
          const amountOutAfterFees = Number(eventData.amountOutAfterFees);
          const formattedAmount = formatTokenAmount(amountOutAfterFees, dispensingSymbol);
          console.log(`     Amount Out After Fees: ${formattedAmount} ${dispensingSymbol}`);
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
      // Special handling for TP/SL events
      else if (eventType === 'InstantCreateTpslEvent' || eventType === 'InstantUpdateTpslEvent') {
        console.log(`  ${i+1}. ${eventType}`);
        console.log(`     Date: ${eventTime}`);
        console.log(`     TP/SL Setting:`);
        
        // For UPDATE events, retrieve triggerAboveThreshold from original CREATE event
        let actualTriggerAboveThreshold = eventData.tpslTriggerAboveThreshold;
        if (eventType === 'InstantUpdateTpslEvent') {
          const originalCreateData = findOriginalCreateTpslEvent(trade.events, evt);
          if (originalCreateData && originalCreateData.params) {
            actualTriggerAboveThreshold = originalCreateData.params.triggerAboveThreshold;
          }
        }
        
        // Determine if Take Profit or Stop Loss
        const isTakeProfit = actualTriggerAboveThreshold === true;
        const orderType = isTakeProfit ? "Take Profit" : "Stop Loss";
        console.log(`     Order Type: ${orderType}`);
        
        // Show trigger price
        if (eventData.tpslTriggerPrice) {
          console.log(`     Trigger Price: ${eventData.tpslTriggerPrice}`);
        }
        
        // For update events, try to find the original create event to get correct values
        let actualEntirePosition = eventData.tpslEntirePosition;
        let actualSizePercentage = calculateTpslSizePercentage(
          actualEntirePosition,
          eventData.tpslSizeUsdDelta || '$0.00',
          trade.sizeUsd
        );
        
        if (eventType === 'InstantUpdateTpslEvent') {
          const originalCreateData = findOriginalCreateTpslEvent(trade.events, evt);
          if (originalCreateData && originalCreateData.params) {
            actualEntirePosition = originalCreateData.params.entirePosition;
            // For UPDATE events, we need to get the size from the original CREATE event
            const originalSizeUsdDelta = originalCreateData.data?.tpslSizeUsdDelta || '$0.00';
            actualSizePercentage = calculateTpslSizePercentage(
              actualEntirePosition,
              originalSizeUsdDelta,
              trade.sizeUsd
            );
          }
        } else if (eventType === 'InstantCreateTpslEvent') {
          // For create events, use the values directly from the event
          actualSizePercentage = calculateTpslSizePercentage(
            actualEntirePosition,
            eventData.tpslSizeUsdDelta || '$0.00',
            trade.sizeUsd
          );
        }
        
        // Show size percentage
        console.log(`     Size: ${actualSizePercentage} of position`);
        
        // Show specific TP/SL values if available (legacy support)
        if (isTakeProfit && eventData.takeProfitPrice) {
          console.log(`     Take Profit Price: ${eventData.takeProfitPrice}`);
          if (eventData.takeProfitSizePercent) {
            console.log(`     Take Profit Size: ${eventData.takeProfitSizePercent / 100}% of position`);
          }
        } else if (!isTakeProfit && eventData.stopLossPrice) {
          console.log(`     Stop Loss Price: ${eventData.stopLossPrice}`);
          if (eventData.stopLossSizePercent) {
            console.log(`     Stop Loss Size: ${eventData.stopLossSizePercent / 100}% of position`);
          }
        }
      }
      // For regular events (not pool swap or TP/SL)
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
        
        // Only show notional size for increase events (not for decrease events)
        if (eventType.includes('Increase')) {
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
      // Return a shortened version of the pubkey for unknown custody addresses
      return `${custodyPubkey.substring(0, 6)}...`;
  }
}

/**
 * Jupiter Perpetuals Trade History Analyzer with Date Range Support and Multi-PDA Analysis
 * 
 * To analyze trades across all position PDAs for a wallet within a specific date range:
 * 1. Update the TO_DATE variable with your desired end date (how far back to go) in DD.MM.YYYY format
 * 2. Update the FROM_DATE variable with your desired start date (where to begin from) in DD.MM.YYYY format
 * 3. Set FROM_DATE to undefined to start from "now" (current moment)
 * 4. Set TO_DATE to undefined to use default (30 days ago from FROM_DATE)
 * 5. Update the WALLET_ADDRESS to analyze a different wallet's trades
 * 
 * Examples:
 * - FROM_DATE = "20.04.2025", TO_DATE = "15.04.2025" - Fetch transactions between April 20th and April 15th, 2025
 * - FROM_DATE = undefined, TO_DATE = "01.04.2025" - Fetch from now back to April 1st, 2025
 * - FROM_DATE = undefined, TO_DATE = undefined - Fetch transactions from the last 30 days (default)
 * 
 * Note: FROM_DATE must be newer (later) than TO_DATE since we're going backwards in time
 */

// ====== CONFIGURATION ======
const TO_DATE = "13.04.2025"; // End date - how far back to go (older date)
const FROM_DATE = "15.04.2025"; // Start date - where to begin from (newer date), set to undefined to start from "now"
const WALLET_ADDRESS = "BNDvcP8rVZrNn7xDBHN8jxUh9RKpMB4TFMc42ia3wZvt"; // Wallet to analyze
// ============================

// Run the example with date support and wallet address
analyzeTradeHistory(TO_DATE, WALLET_ADDRESS, FROM_DATE).then(() => {
  console.log("Trade analysis complete");
}).catch(err => {
  console.error("Error analyzing trades:", err);
});

// Helper function to calculate TP/SL size percentage
function calculateTpslSizePercentage(
  entirePosition: boolean,
  sizeUsdDelta: string,
  positionSizeUsd: number
): string {
  if (entirePosition) {
    return "100%";
  }
  
  // For partial positions, calculate actual percentage
  const deltaUsd = parseUsdValue(sizeUsdDelta);
  if (deltaUsd > 0 && positionSizeUsd > 0) {
    const percentage = (deltaUsd / positionSizeUsd) * 100;
    return `${percentage.toFixed(1)}%`;
  }
  
  // Fallback if we can't calculate
  return "Partial position";
}