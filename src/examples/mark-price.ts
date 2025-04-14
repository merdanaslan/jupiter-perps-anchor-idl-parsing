import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { IDL as DovesIDL } from "../idl/doves-idl";
import { CUSTODY_PUBKEY, RPC_CONNECTION } from "../constants";
import { BNToUSDRepresentation } from "../utils";

// Doves oracle program that provides mark prices
const DOVES_PROGRAM_ID = new PublicKey(
  "DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e"
);

// Create a program instance to interact with the Doves oracle
const dovesProgram = new Program(
  DovesIDL,
  DOVES_PROGRAM_ID,
  new AnchorProvider(RPC_CONNECTION, new Wallet(Keypair.generate()), {
    preflightCommitment: "processed",
  })
);

// The oracle accounts for each perp asset
const PERP_ORACLE_ACCOUNTS = {
  [CUSTODY_PUBKEY.SOL]: new PublicKey("39cWjvHrpHNz2SbXv6ME4NPhqBDBd4KsjUYv5JkHEAJU"),
  [CUSTODY_PUBKEY.ETH]: new PublicKey("5URYohbPy32nxK1t3jAHVNfdWY2xTubHiFvLrE3VhXEp"),
  [CUSTODY_PUBKEY.BTC]: new PublicKey("4HBbPx9QJdjJ7GUe6bsiJjGybvfpDhQMMPXP1UEa7VT5"),
};

// Define types for price data
interface MarkPrice {
  price: BN;
  priceUsd: string;
  timestamp: number;
  formattedTimestamp: string;
  expo: number;
}

type AssetMarkPrices = {
  [key: string]: MarkPrice;
};

/**
 * Fetch current mark prices for Jupiter perpetual assets (SOL, ETH, BTC)
 * @returns Object containing mark price data for each asset
 */
export async function fetchMarkPrices(): Promise<AssetMarkPrices> {
  try {
    // Only fetch prices for non-stablecoin assets (SOL, ETH, BTC)
    const oracleAccountsToFetch = [
      PERP_ORACLE_ACCOUNTS[CUSTODY_PUBKEY.SOL],
      PERP_ORACLE_ACCOUNTS[CUSTODY_PUBKEY.ETH],
      PERP_ORACLE_ACCOUNTS[CUSTODY_PUBKEY.BTC],
    ];
    
    const feeds = await dovesProgram.account.priceFeed.fetchMultiple(oracleAccountsToFetch);
    
    const markPrices: AssetMarkPrices = {};
    
    // Map each oracle account to its corresponding asset name
    const assetNames = ["SOL", "ETH", "BTC"];
    const custodyKeys = [CUSTODY_PUBKEY.SOL, CUSTODY_PUBKEY.ETH, CUSTODY_PUBKEY.BTC];
    
    feeds.forEach((feed, index) => {
      if (!feed) {
        console.error(`Failed to fetch oracle price for ${assetNames[index]}`);
        return;
      }
      
      const timestamp = feed.timestamp.toNumber();
      
      markPrices[custodyKeys[index]] = {
        price: feed.price,
        priceUsd: BNToUSDRepresentation(feed.price, Math.abs(feed.expo)),
        timestamp,
        formattedTimestamp: new Date(timestamp * 1000).toISOString(),
        expo: feed.expo,
      };
    });
    
    return markPrices;
  } catch (error) {
    console.error("Error fetching mark prices:", error);
    throw error;
  }
}

/**
 * Print mark prices to console in a readable format
 */
export async function printMarkPrices(): Promise<void> {
  try {
    const markPrices = await fetchMarkPrices();
    
    console.log("Jupiter Perp Mark Prices:");
    console.log("------------------------");
    
    Object.entries(markPrices).forEach(([custodyKey, priceData]) => {
      let assetName: string;
      
      switch (custodyKey) {
        case CUSTODY_PUBKEY.SOL:
          assetName = "SOL";
          break;
        case CUSTODY_PUBKEY.ETH:
          assetName = "ETH";
          break;
        case CUSTODY_PUBKEY.BTC:
          assetName = "BTC";
          break;
        default:
          assetName = "Unknown";
      }
      
      console.log(
        `${assetName}: $${priceData.priceUsd} (as of ${priceData.formattedTimestamp})`
      );
    });
  } catch (error) {
    console.error("Error printing mark prices:", error);
  }
}

/**
 * Example usage
 */
if (require.main === module) {
  printMarkPrices()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("Error in mark price example:", error);
      process.exit(1);
    });
} 