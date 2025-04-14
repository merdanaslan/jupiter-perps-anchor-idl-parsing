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
  
  // Limit to only 5 most recent transactions
  console.log("Getting signatures...");
  const confirmedSignatureInfos = await RPC_CONNECTION.getSignaturesForAddress(
    positionPDA,
    { limit: 5 } // Only fetch 5 transactions
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
    
    // Add a 3 second delay between each transaction processing
    if (i > 0) {
      console.log(`Waiting 3 seconds before processing next transaction...`);
      await new Promise(resolve => setTimeout(resolve, 3000));
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
  const increasePositionEvents = allEvents.filter(
    (data) =>
      data?.event?.name === "IncreasePositionEvent" ||
      data?.event?.name === "InstantIncreasePositionEvent" ||
      data?.event?.name === "DecreasePositionEvent" ||
      data?.event?.name === "InstantDecreasePositionEvent"
  );
  
  console.log(`Found ${increasePositionEvents.length} increase position events`);
  
  return increasePositionEvents;
}


getPositionEvents().then(events => {
  console.log(inspect(events, { depth: null, colors: true }));
});