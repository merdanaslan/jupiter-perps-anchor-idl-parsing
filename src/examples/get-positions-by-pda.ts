import { PublicKey } from "@solana/web3.js";
import { type IdlAccounts } from "@coral-xyz/anchor";
import { Perpetuals } from "../idl/jupiter-perpetuals-idl";
import {
  CUSTODY_PUBKEYS,
  JLP_POOL_ACCOUNT_PUBKEY,
  JUPITER_PERPETUALS_PROGRAM,
  JUPITER_PERPETUALS_PROGRAM_ID,
  RPC_CONNECTION,
} from "../constants";
import { generatePositionPda } from "./generate-position-and-position-request-pda";

// This function fetches all possible positions for a wallet by generating PDAs directly
export async function getPositionsByPda(walletAddress: string) {
  try {
    const walletPubkey = new PublicKey(walletAddress);
    
    // All possible combinations of positions
    // For each asset (SOL, BTC, ETH):
    // - Long positions use the asset as both custody and collateral
    // - Short positions use the asset as custody and USDC/USDT as collateral
    const positionPdas: PublicKey[] = [];
    const positionInfos: Array<{
      type: string;
      custody: string;
      collateralCustody: string;
    }> = [];
    
    // Loop through all custodies (SOL, BTC, ETH)
    for (let i = 0; i < 3; i++) {
      const assetCustody = CUSTODY_PUBKEYS[i];
      
      // Generate Long position PDA
      const longPosition = generatePositionPda({
        custody: assetCustody,
        collateralCustody: assetCustody, // For long, custody and collateralCustody are the same
        walletAddress: walletPubkey,
        side: "long",
      });
      
      positionPdas.push(longPosition.position);
      positionInfos.push({
        type: "Long",
        custody: assetCustody.toBase58(),
        collateralCustody: assetCustody.toBase58(),
      });
      
      // Generate Short positions with USDC and USDT as collateral
      for (let j = 3; j < 5; j++) { // USDC and USDT are at index 3 and 4
        const stableCustody = CUSTODY_PUBKEYS[j];
        
        const shortPosition = generatePositionPda({
          custody: assetCustody,
          collateralCustody: stableCustody,
          walletAddress: walletPubkey,
          side: "short",
        });
        
        positionPdas.push(shortPosition.position);
        positionInfos.push({
          type: "Short",
          custody: assetCustody.toBase58(),
          collateralCustody: stableCustody.toBase58(),
        });
      }
    }
    
    // Fetch all possible position accounts at once
    console.log(`Fetching ${positionPdas.length} possible positions for wallet ${walletAddress}...`);
    // Use getMultipleAccountsInfo instead of getMultipleAccounts
    const accounts = await RPC_CONNECTION.getMultipleAccountsInfo(positionPdas);
    
    // Process and decode the accounts that exist
    const positions = accounts
      .map((account, index: number) => {
        if (!account) {
          return null; // Account doesn't exist
        }
        
        return {
          publicKey: positionPdas[index],
          positionInfo: positionInfos[index],
          account: JUPITER_PERPETUALS_PROGRAM.coder.accounts.decode(
            "position",
            account.data
          ) as IdlAccounts<Perpetuals>["position"],
        };
      })
      .filter((position): position is NonNullable<typeof position> => position !== null); // Remove null entries
    
    // Separate into open and closed positions
    const openPositions = positions.filter(position => 
      position.account.sizeUsd.gtn(0)
    );
    
    const closedPositions = positions.filter(position => 
      !position.account.sizeUsd.gtn(0)
    );
    
    console.log(`Found ${positions.length} positions (${openPositions.length} open, ${closedPositions.length} closed)`);
    console.log("Open positions:", openPositions);
    console.log("Closed positions:", closedPositions);
    
    return { openPositions, closedPositions, allPositions: positions };
  } catch (error) {
    console.error(
      `Failed to fetch positions for wallet address ${walletAddress}`,
      error
    );
    return { openPositions: [], closedPositions: [], allPositions: [] };
  }
}

// Call the function with the specified wallet address
getPositionsByPda("4qXroAUadM5akVdBrt6ZNL3iRLVE3YboCF5TiKkFsZSp"); 



// market order is "coin- margined" (fartcoin, trumpcoin etc.) -> determine which one 
// limit order is "usd- margined" 