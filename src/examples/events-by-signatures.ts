import { DISCRIMINATOR_SIZE, IdlEvents, utils } from "@coral-xyz/anchor";
import {
  JUPITER_PERPETUALS_PROGRAM,
  RPC_CONNECTION,
  USDC_DECIMALS,
} from "../constants";
import { Finality, PublicKey } from "@solana/web3.js";
import { Perpetuals } from "../idl/jupiter-perpetuals-idl";
import { inspect } from 'util';
import { BN } from "@coral-xyz/anchor";
import { BNToUSDRepresentation } from "../utils";

type AnchorIdlEvent<EventName extends keyof IdlEvents<Perpetuals>> = {
  name: EventName;
  data: IdlEvents<Perpetuals>[EventName];
};

// Define event types for easier filtering
export type EventType = 
  | 'IncreasePositionEvent'
  | 'DecreasePositionEvent'
  | 'InstantIncreasePositionEvent'
  | 'InstantDecreasePositionEvent'
  | 'LiquidateFullPositionEvent'
  | 'InstantCreateTpslEvent'
  | 'InstantUpdateTpslEvent'
  | 'CreatePositionRequestEvent'
  | 'AllEvents'; // Special type to include all events

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

/**
 * Fetches and parses events for the specified transaction signatures
 * 
 * @param signatures Array of transaction signatures to fetch events for
 * @param eventTypes Array of event types to filter for (or 'AllEvents' to include all)
 * @param options Additional options for the request
 * @returns Promise resolving to an array of formatted events
 */
export async function getEventsBySignatures(
  signatures: string[],
  eventTypes: EventType[] = ['AllEvents'],
  options: {
    commitment?: Finality,
    maxSupportedTransactionVersion?: number,
    delayBetweenRequests?: number
  } = {}
) {
  const {
    commitment = 'confirmed',
    maxSupportedTransactionVersion = 0,
    delayBetweenRequests = 500 // Default delay of 500ms between requests
  } = options;

  if (!signatures || signatures.length === 0) {
    console.log("No signatures provided");
    return [];
  }
  
  console.log(`Processing ${signatures.length} transaction signatures...`);
  
  const allEvents = [];
  
  for (let i = 0; i < signatures.length; i++) {
    // Add a delay between requests to avoid rate limiting
    if (i > 0 && delayBetweenRequests > 0) {
      await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
    }
    
    try {
      console.log(`Processing transaction ${i+1}/${signatures.length}: ${signatures[i]}`);
      
      const tx = await RPC_CONNECTION.getTransaction(
        signatures[i],
        { 
          commitment, 
          maxSupportedTransactionVersion 
        }
      );
      
      if (!tx || !tx.meta || !tx.meta.innerInstructions) {
        console.log(`No inner instructions found in transaction ${signatures[i]}`);
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
            
            // Get transaction fee
            const feeInSOL = tx.meta!.fee / 1_000_000_000; // Convert lamports to SOL
            
            return {
              event: formattedEvent,
              tx: {
                signature: signatures[i],
                blockTime: tx.blockTime 
                  ? new Date(tx.blockTime * 1000).toISOString()
                  : null,
                slot: tx.slot,
                fee: `${feeInSOL} SOL`,
                feeInLamports: tx.meta!.fee
              }
            };
          } catch (error) {
            // Silently skip non-event instructions
            return null;
          }
        }).filter(Boolean);
      });
      
      allEvents.push(...txEvents);
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Error processing transaction ${signatures[i]}: ${errorMessage}`);
    }
  }
  
  console.log(`Found ${allEvents.length} total events across ${signatures.length} transactions`);
  
  // Filter events by type if specified
  if (eventTypes.includes('AllEvents')) {
    return allEvents;
  } else {
    const filteredEvents = allEvents.filter(
      (data) => data?.event && eventTypes.includes(data.event.name as EventType)
    );
    
    console.log(`Filtered to ${filteredEvents.length} events of types: ${eventTypes.join(', ')}`);
    return filteredEvents;
  }
}

/**
 * Example usage
 */
if (require.main === module) {
  // Example signature(s) to fetch events for
  const signatures = [
    '3LCzyaERWwBS16q24WZkdrqz48box8Vaq8ZQi7TB5e1aQNqv8UcdwwprPRNjUB9MDmmHEkjuyvEsNz5DmGFav6C'
  ];

  // Example event types to filter for (or use 'AllEvents' to include all)
  const eventTypes: EventType[] = ['AllEvents', 'IncreasePositionEvent', 'DecreasePositionEvent', 'InstantIncreasePositionEvent', 'InstantDecreasePositionEvent'];
  
  // Fetch and display events
  getEventsBySignatures(signatures, eventTypes)
    .then(events => {
      console.log(inspect(events, { depth: null, colors: true }));
    })
    .catch(error => {
      console.error("Error fetching events:", error);
    });
} 