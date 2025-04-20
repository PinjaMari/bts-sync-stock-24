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
    console.log("📥 Starting CSV download...");

    const response = await axios.get(
      `https://www.btswholesaler.com/generatefeedbts?user_id=${process.env.BTS_USER_ID}&pass=${process.env.BTS_PASSWORD}&format=csv&language_code=en-gb`,
      { responseType: 'stream' }
    );

    const products = [];

    response.data
      .pipe(csv({ separator: ';' }))
      .on('data', (row) => {
        const ean = row.ean;
        const stock = parseInt(row.stock, 10);

        if (!ean || isNaN(stock)) {
          console.warn(`⚠️ Skipping invalid row - EAN: ${ean}, Stock: ${row.stock}`);
          return;
        }

        products.push({ ean, stock });
      })
      .on('end', async () => {
        console.log(`✅ Processed ${products.length} products from CSV`);

        for (const product of products) {
          await syncStockByBarcode(product.ean, product.stock);
          await delay(600 + Math.floor(Math.random() * 200)); // ← Safer delay
        }
      })
      .on('error', (error) => {
        console.error('❌ Error processing CSV stream:', error.message);
      });

  } catch (error) {
    console.error('❌ Error downloading CSV:', error.message);
  }
}

// Helper: wait
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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
      console.warn(`⚠️ No inventory_item_id for product with EAN: ${ean}`);
      return;
    }

    await shopify.inventoryLevel.set({
      location_id: process.env.SHOPIFY_LOCATION_ID,
      inventory_item_id: String(inventoryItemId),
      available: stock,
    });

    console.log(`✅ Stock updated for EAN ${ean} → ${stock}`);
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

// Start
downloadCSV();
