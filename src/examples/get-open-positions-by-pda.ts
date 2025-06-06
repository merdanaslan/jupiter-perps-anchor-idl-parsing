import { PublicKey } from "@solana/web3.js";
import { type IdlAccounts, BN } from "@coral-xyz/anchor";
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
import { fetchMarkPrices } from "./mark-price";

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
    
    // All possible combinations of positions (9 total):
    // 1. Long SOL (using SOL as collateral)
    // 2. Long ETH (using ETH as collateral)
    // 3. Long BTC (using BTC as collateral)
    // 4. Short SOL (using USDC as collateral)
    // 5. Short SOL (using USDT as collateral)
    // 6. Short ETH (using USDC as collateral)
    // 7. Short ETH (using USDT as collateral)
    // 8. Short BTC (using USDC as collateral)
    // 9. Short BTC (using USDT as collateral)
    const positionPdas: PublicKey[] = [];
    const positionInfos: Array<{
      type: string;
      custody: string;
      collateralCustody: string;
      description: string;
    }> = [];
    
    // Loop through all custodies (SOL, BTC, ETH)
    for (let i = 0; i < 3; i++) {
      const assetCustody = CUSTODY_PUBKEYS[i];
      const assetName = getAssetNameFromCustody(assetCustody.toBase58());
      
      // Generate Long position PDA (using the asset itself as collateral)
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
        description: `Long ${assetName} (using ${assetName} as collateral)`,
      });
      
      // Generate Short positions with USDC and USDT as collateral
      for (let j = 3; j < 5; j++) { // USDC and USDT are at index 3 and 4
        const stableCustody = CUSTODY_PUBKEYS[j];
        const stableName = getAssetNameFromCustody(stableCustody.toBase58());
        
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
          description: `Short ${assetName} (using ${stableName} as collateral)`,
        });
      }
    }
    
    // Fetch all possible position accounts at once
    console.log(`Fetching ${positionPdas.length} possible positions for wallet ${walletAddress}...`);
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
            description: positionInfos[index].description,
            side: decodedPosition.side.long !== undefined ? "Long" : "Short",
            asset: assetName,
            collateral: collateralName,
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
      .filter((position): position is NonNullable<typeof position> => position !== null);
    
    // Separate into open and closed positions
    const openPositions = positions.filter(position => 
      position.account.sizeUsd.gtn(0)
    );
    
    const closedPositions = positions.filter(position => 
      !position.account.sizeUsd.gtn(0)
    );
    
    console.log(`Found ${positions.length} positions (${openPositions.length} open, ${closedPositions.length} closed)`);
    
    if (openPositions.length > 0) {
      console.log("\nOpen positions:");
      // Use for..of to handle async calls properly
      for (const pos of openPositions) {
        console.log(`\n- ${pos.readable.description}`);
        await displayPositionDetails(pos);
      }
    } else {
      console.log("\nNo open positions found.");
    }
    
    // No display for closed positions
    
    return { openPositions, closedPositions, allPositions: positions };
  } catch (error) {
    console.error(`Failed to fetch positions for wallet address ${walletAddress}`, error);
    return { openPositions: [], closedPositions: [], allPositions: [] };
  }
}

// Call the function with the specified wallet address
getPositionsByPda("6CpZQLKSx5LTo5p5bkUaonrUcLtraQwttJK8QRQpfiEp");

// market order is "coin- margined" (fartcoin, trumpcoin etc.) -> determine which one 
// limit order is "usd- margined" 
/*
According to Jupiter's design, when a position is completely closed, the realized PnL is settled and the account's realisedPnlUsd is reset to 0
Only partially closed positions maintain a non-zero realisedPnlUsd value
Completely closed positions (like the ones we see) have their PnL settled to the user and reset to 0
When a position's sizeUsd becomes 0, it's considered fully closed and its realisedPnlUsd is also reset to 0
The actual PnL from the trades would be recorded in on-chain events at the time of closing, but is not stored in the position account after full closure. This is a design choice to simplify accounting.
*/

type PositionWithInfo = {
  publicKey: PublicKey;
  positionInfo: {
    type: string;
    custody: string;
    collateralCustody: string;
    description: string;
  };
  account: IdlAccounts<Perpetuals>["position"];
  readable: {
    description: string;
    side: string;
    asset: string;
    collateral: string;
    openTime: string;
    updateTime: string;
    price: string;
    sizeUsd: string;
    collateralUsd: string;
    realisedPnlUsd: string;
    rawPrice: string;
    rawRealisedPnl: string;
  };
};

// Make displayPositionDetails async for mark price fetching
async function displayPositionDetails(position: PositionWithInfo) {
  try {
    // Get asset symbols
    const assetSymbol = getAssetNameFromCustody(position.account.custody.toString());
    const collateralSymbol = getAssetNameFromCustody(position.account.collateralCustody.toString());
    
    // Calculate leverage
    let leverage = 0;
    if (!position.account.collateralUsd.isZero() && !position.account.sizeUsd.isZero()) {
      leverage = position.account.sizeUsd.mul(new BN(1_000_000)).div(position.account.collateralUsd).toNumber() / 1_000_000;
    }
    
    // Calculate notional size (amount of the asset)
    const notionalSize = position.account.price.isZero() ? 
      0 : 
      position.account.sizeUsd.mul(new BN(1_000_000)).div(position.account.price).toNumber() / 1_000_000;
    
    // Fetch current mark price
    const markPrices = await fetchMarkPrices(true);
    const assetCustodyStr = position.account.custody.toString();
    const markPriceData = markPrices[assetCustodyStr];
    
    if (!markPriceData) {
      throw new Error(`Mark price not available for ${assetSymbol}`);
    }
    
    // Convert prices to the same scale for comparison
    const currentPrice = parseFloat(markPriceData.priceUsd);
    const entryPrice = parseFloat(BNToUSDRepresentation(position.account.price, USDC_DECIMALS));
    
    // Calculate unrealized PnL using the proper formula
    let unrealizedPnl;
    if (position.account.side.long) {
      // For LONG: (Current Price - Entry Price) × Notional Size
      unrealizedPnl = (currentPrice - entryPrice) * notionalSize;
    } else {
      // For SHORT: (Entry Price - Current Price) × Notional Size
      unrealizedPnl = (entryPrice - currentPrice) * notionalSize;
    }
    
    // Calculate ROI
    const collateralUsd = parseFloat(BNToUSDRepresentation(position.account.collateralUsd, USDC_DECIMALS));
    const unrealizedRoi = collateralUsd > 0 ? (unrealizedPnl / collateralUsd) * 100 : 0;
    
    // Display position information
    console.log(`Position PDA: ${position.publicKey.toString()}`);
    console.log(`  Owner: ${position.account.owner.toString()}`);
    console.log(`  Asset: ${assetSymbol}`);
    console.log(`  Collateral: ${collateralSymbol}`);
    console.log(`  Side: ${position.account.side.long ? "Long" : "Short"}`);
    console.log(`  Entry Price: $${BNToUSDRepresentation(position.account.price, USDC_DECIMALS)}`);
    console.log(`  Current Price: $${markPriceData.priceUsd}`);
    console.log(`  Position Size (USD): $${BNToUSDRepresentation(position.account.sizeUsd, USDC_DECIMALS)}`);
    console.log(`  Notional Size: ${notionalSize.toFixed(6)} ${assetSymbol}`);
    console.log(`  Collateral: $${BNToUSDRepresentation(position.account.collateralUsd, USDC_DECIMALS)}`);
    console.log(`  Leverage: ${leverage.toFixed(2)}x`);
    console.log(`  Realized PnL: $${BNToUSDRepresentation(position.account.realisedPnlUsd, USDC_DECIMALS)}`);
    console.log(`  Unrealized PnL: $${unrealizedPnl.toFixed(2)} (${unrealizedRoi.toFixed(2)}%)`);
    console.log(`  Open Time: ${new Date(position.account.openTime.toNumber() * 1000).toISOString()}`);
    console.log(`  Last Update Time: ${new Date(position.account.updateTime.toNumber() * 1000).toISOString()}`);
  } catch (error: unknown) {
    console.error(`Error displaying position details: ${(error as Error).message}`);
  }
}