require('dotenv').config();
const Shopify = require('shopify-api-node');
const axios = require('axios');
const csv = require('csv-parser');

// Setup Shopify client
const shopify = new Shopify({
  shopName: process.env.SHOPIFY_SHOP_NAME,
  accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
});

// Download and process CSV directly from the URL (without saving to file)
async function downloadCSV() {
  try {
    console.log("Starting CSV download...");

    const response = await axios.get(
      'https://www.btswholesaler.com/generatefeedbts?user_id=1318121&pass=MiNNi800HyG201&format=csv&language_code=en-gb',
      { responseType: 'stream' }
    );

    const products = [];

    // Process CSV data directly from the stream (without saving it to a file)
    response.data
      .pipe(csv({ separator: ';' }))  // Parse CSV directly from stream
      .on('data', (row) => {
        console.log('Row received:', row); // Log each row for debugging

        const ean = row.ean;
        const stock = parseInt(row.stock, 10);

        if (!ean || isNaN(stock)) {
          console.warn(`⚠️ Skipping row: invalid EAN or stock - EAN: ${ean}, Stock: ${row.stock}`);
          return;
        }

        products.push({ ean, stock });
      })
      .on('end', async () => {
        console.log(`✅ CSV file processed with ${products.length} rows`);

        // Call the processInBatches function
        await processInBatches(products);
      })
      .on('error', (error) => {
        console.error('❌ Error processing CSV stream:', error.message);
      });

  } catch (error) {
    console.error('❌ Error downloading CSV:', error.message);
  }
}

// Helper: wait with a rate limit and jitter
function delay(ms) {
  // Add a small random variation to the delay time
  const jitter = Math.floor(Math.random() * 200); // Adds up to 200ms of jitter
  return new Promise(resolve => setTimeout(resolve, ms + jitter));
}

// Sync stock by looking up product by barcode
async function syncStockByBarcode(ean, stock, attempt = 1) {
  try {
    console.log(`📦 Syncing stock for EAN: ${ean}, Stock: ${stock}`);

    const products = await shopify.product.list({ barcode: ean });

    if (!products.length) {
      console.warn(`⚠️ No product found with barcode: ${ean}`);
      return;
    }

    const product = products[0];
    const inventoryItemId = product.variants[0]?.inventory_item_id;

    if (!inventoryItemId) {
      console.warn(`⚠️ No valid inventory_item_id found for product with barcode: ${ean}`);
      return;
    }

    await shopify.inventoryLevel.set({
      location_id: process.env.SHOPIFY_LOCATION_ID,
      inventory_item_id: String(inventoryItemId),
      available: stock,
    });

    console.log(`✅ Stock updated for EAN ${ean} -> ${stock}`);

    // Add delay here to respect Shopify's API rate limit (2 calls per second)
    await delay(1000);  // 1 second delay between calls

  } catch (error) {
    if (error.code === 'ECONNRESET' && attempt <= 3) {
      console.warn(`🔁 ECONNRESET on EAN ${ean}, retrying in 3s (Attempt ${attempt})`);
      await delay(3000);
      return syncStockByBarcode(ean, stock, attempt + 1);
    }

    if (error.response?.data) {
      console.error(`❌ Error updating stock for EAN ${ean}:`, error.response.data);
    } else if (error.response?.body) {
      console.error(`❌ Error updating stock for EAN ${ean}:`, error.response.body);
    } else {
      console.error(`❌ Error updating stock for EAN ${ean}:`, error.message);
    }
  }
}

// Process products in batches to respect rate limit
async function processInBatches(products) {
  const batchSize = 2;  // Send 2 requests per second
  let batch = [];
  let i = 0;

  while (i < products.length) {
    batch.push(products[i]);
    i++;

    if (batch.length === batchSize || i === products.length) {
      // Process this batch
      for (const product of batch) {
        await syncStockByBarcode(product.ean, product.stock);
      }

      // Add a delay of 1 second after processing each batch
      console.log(`🕐 Waiting for the next batch...`);
      await delay(1000);  // 1 second delay between batches
      batch = [];  // Reset the batch
    }
  }
}

// Start the process
downloadCSV();
