import { PublicKey } from "@solana/web3.js";
import { type IdlAccounts } from "@coral-xyz/anchor";
import { Perpetuals } from "../idl/jupiter-perpetuals-idl";
import {
  CUSTODY_PUBKEY,
  CUSTODY_PUBKEYS,
  JLP_POOL_ACCOUNT_PUBKEY,
  JUPITER_PERPETUALS_PROGRAM,
  JUPITER_PERPETUALS_PROGRAM_ID,
  RPC_CONNECTION,
  USDC_DECIMALS,
} from "../constants";
import { generatePositionPda } from "./generate-position-and-position-request-pda";
import { BNToUSDRepresentation } from "../utils";

// Helper function to get asset name from custody pubkey
function getAssetNameFromCustody(custodyPubkey: string): string {
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
        
        const decodedPosition = JUPITER_PERPETUALS_PROGRAM.coder.accounts.decode(
          "position",
          account.data
        ) as IdlAccounts<Perpetuals>["position"];
        
        const assetName = getAssetNameFromCustody(positionInfos[index].custody);
        const collateralName = getAssetNameFromCustody(positionInfos[index].collateralCustody);
        
        return {
          publicKey: positionPdas[index],
          positionInfo: positionInfos[index],
          account: decodedPosition,
          readable: {
            side: decodedPosition.side.long !== undefined ? "Long" : "Short",
            asset: assetName,
            collateral: collateralName,
            positionType: decodedPosition.side.long !== undefined 
              ? `Long ${assetName}` 
              : `Short ${assetName} with ${collateralName}`,
            openTime: new Date(decodedPosition.openTime.toNumber() * 1000).toISOString(),
            updateTime: new Date(decodedPosition.updateTime.toNumber() * 1000).toISOString(),
            price: BNToUSDRepresentation(decodedPosition.price, USDC_DECIMALS),
            sizeUsd: BNToUSDRepresentation(decodedPosition.sizeUsd, USDC_DECIMALS),
            collateralUsd: BNToUSDRepresentation(decodedPosition.collateralUsd, USDC_DECIMALS),
            realisedPnlUsd: BNToUSDRepresentation(decodedPosition.realisedPnlUsd, USDC_DECIMALS),
            rawPrice: decodedPosition.price.toString(),
            rawRealisedPnl: decodedPosition.realisedPnlUsd.toString(),
          }
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
    console.log("Open positions:", openPositions.map(pos => pos.readable));
    console.log("Closed positions:", closedPositions.map(pos => pos.readable));
    
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
/*
According to Jupiter's design, when a position is completely closed, the realized PnL is settled and the account's realisedPnlUsd is reset to 0
Only partially closed positions maintain a non-zero realisedPnlUsd value
Completely closed positions (like the ones we see) have their PnL settled to the user and reset to 0
When a position's sizeUsd becomes 0, it's considered fully closed and its realisedPnlUsd is also reset to 0
The actual PnL from the trades would be recorded in on-chain events at the time of closing, but is not stored in the position account after full closure. This is a design choice to simplify accounting.
*/ 
