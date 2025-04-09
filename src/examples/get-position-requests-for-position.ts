import { PublicKey } from "@solana/web3.js";
import { type IdlAccounts, BN } from "@coral-xyz/anchor";
import { Perpetuals } from "../idl/jupiter-perpetuals-idl";
import {
  JUPITER_PERPETUALS_PROGRAM,
  JUPITER_PERPETUALS_PROGRAM_ID,
  RPC_CONNECTION,
  USDC_DECIMALS,
} from "../constants";
import { BNToUSDRepresentation } from "../utils";

/**
 * This file retrieves all existing position requests for a given position PDA.
 * Position requests are used to open, modify, or close positions, and are fulfilled by keepers.
 * 
 * NOTE: This requires an RPC endpoint that supports getProgramAccounts.
 * Many public RPC endpoints have this disabled due to resource constraints.
 * Consider using a paid service like QuickNode, Alchemy, or Helius.
 * 
 * Example usage:
 * ts-node src/examples/get-position-requests-for-position.ts
 */

/**
 * Finds all existing position request accounts for a given position PDA
 * @param positionPda The position PDA to find requests for
 * @returns Array of decoded position request accounts with their public keys
 */
export async function getPositionRequestsForPosition(positionPda: string | PublicKey) {
  try {
    const positionPubkey = typeof positionPda === 'string' 
      ? new PublicKey(positionPda)
      : positionPda;
    
    console.log(`Finding position requests for position: ${positionPubkey.toBase58()}`);
    
    // Prepare the filter to find all position request accounts for this position
    const filters = [
      {
        memcmp: {
          offset: 8, // Skip the account discriminator (8 bytes)
          bytes: positionPubkey.toBase58() // Filter by position pubkey in the data
        }
      }
    ];
    
    try {
      // Use getProgramAccounts to find all matching accounts
      const accounts = await RPC_CONNECTION.getProgramAccounts(
        JUPITER_PERPETUALS_PROGRAM_ID,
        {
          filters: [
            { dataSize: 333 }, // Size of position request accounts (may need adjustment based on exact size)
            ...filters
          ]
        }
      );
      
      console.log(`Found ${accounts.length} position request accounts`);
      
      if (accounts.length === 0) {
        return [];
      }
      
      // Decode each account
      const decodedAccounts = accounts.map(account => {
        try {
          const decodedData = JUPITER_PERPETUALS_PROGRAM.coder.accounts.decode(
            "positionRequest",
            account.account.data
          ) as IdlAccounts<Perpetuals>["positionRequest"];
          
          // Create a readable representation with just the fields we know exist
          const readable = {
            position: decodedData.position.toBase58(),
            owner: decodedData.owner.toBase58(),
            requestType: decodedData.requestType.increase !== undefined ? "increase" : "decrease",
          };
          
          return {
            publicKey: account.pubkey,
            account: decodedData,
            readable
          };
        } catch (error) {
          console.error(`Failed to decode account ${account.pubkey.toBase58()}`, error);
          return null;
        }
      }).filter(account => account !== null);
      
      // Display the decoded accounts
      decodedAccounts.forEach((account, index) => {
        console.log(`\n${index + 1}. Position Request: ${account.publicKey.toBase58()}`);
        console.log(`   Position: ${account.readable.position}`);
        console.log(`   Owner: ${account.readable.owner}`);
        console.log(`   Type: ${account.readable.requestType}`);
        
        // Print all available fields from the raw account data for inspection
        console.log(`\n   Full Account Data:`);
        console.log(JSON.stringify(account.account, (key, value) => {
          // Handle BN and PublicKey conversion for JSON display
          if (value && typeof value === 'object' && 'toNumber' in value && typeof value.toNumber === 'function') {
            return value.toString();
          }
          if (value && typeof value === 'object' && 'toBase58' in value && typeof value.toBase58 === 'function') {
            return value.toBase58();
          }
          return value;
        }, 2));
      });
      
      return decodedAccounts;
    } catch (error: any) {
      if (error.message && typeof error.message === 'string' && error.message.includes("410 Gone")) {
        console.error(`
ERROR: The RPC endpoint does not support getProgramAccounts.
This method is often disabled on public RPC endpoints due to resource constraints.

To fix this:
1. Use a paid RPC service like QuickNode, Alchemy, or Helius
2. Set up your own Solana validator with the appropriate configuration
3. If you have an existing relationship with an RPC provider, request that they enable this method

For testing purposes, you can use other approaches like:
- Fetching known position request accounts one by one using getAccountInfo
- Using an explorer like Solana Explorer to view position requests manually
`);
      } else {
        console.error(`Error querying program accounts:`, error);
      }
      return [];
    }
  } catch (error) {
    console.error(`Failed to fetch position requests for position ${positionPda}`, error);
    return [];
  }
}

// Example: Get position requests for a specific position
// Using the Long SOL position PDA we saw earlier
const positionPda = "5BEUw4D4MQvgknkpG8uDTq5DgxJha6Fft4ei1QX5VGjK";
getPositionRequestsForPosition(positionPda); 