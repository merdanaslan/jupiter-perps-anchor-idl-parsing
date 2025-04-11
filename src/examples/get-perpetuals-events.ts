import { DISCRIMINATOR_SIZE, IdlEvents, utils } from "@coral-xyz/anchor";
import {
  JUPITER_PERPETUALS_PROGRAM,
  RPC_CONNECTION,
} from "../constants";
import { PublicKey } from "@solana/web3.js";
import { Perpetuals } from "../idl/jupiter-perpetuals-idl";
import { inspect } from 'util';

type AnchorIdlEvent<EventName extends keyof IdlEvents<Perpetuals>> = {
  name: EventName;
  data: IdlEvents<Perpetuals>[EventName];
};

// The Jupiter Perpetuals program emits events (via Anchor's CPI events: https://book.anchor-lang.com/anchor_in_depth/events.html)
// for most trade events. These events can be parsed and analyzed to track things like trades, executed TPSL requests, liquidations
// and so on.
// This function shows how to listen to these onchain events and parse / filter them.
export async function getPositionEvents() {
  // Use specific position PDA
  const positionPDA = new PublicKey("5dMxAFxqRSzjx8C3NbnDhyaJzj53QRXiGj4NCtQGkdqR");
  
  // Check if account exists first to avoid unnecessary RPC calls
  console.log("Checking if position exists...");
  try {
    const accountInfo = await RPC_CONNECTION.getAccountInfo(positionPDA);
    if (!accountInfo) {
      console.log("Position account not found");
      return [];
    }
    console.log("Position account exists, fetching transactions...");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error checking position:", errorMessage);
    return [];
  }
  
  // Add a delay before next RPC call
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Limit to only 5 most recent transactions
  console.log("Getting signatures...");
  const confirmedSignatureInfos = await RPC_CONNECTION.getSignaturesForAddress(
    positionPDA,
    { limit: 5 } // Further reduce to just 5 transactions
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
            return {
              event: JUPITER_PERPETUALS_PROGRAM.coder.events.decode(eventData),
              tx
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
      data?.event?.name === "InstantIncreasePositionEvent"
  );
  
  console.log(`Found ${increasePositionEvents.length} increase position events`);
  
  return increasePositionEvents;
}


getPositionEvents().then(events => {
  console.log(inspect(events, { depth: null, colors: true }));
});