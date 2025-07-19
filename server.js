// Clover POS API Integration for n8n
// This API provides endpoints to query Clover POS for inventory management

// Load environment variables from .env file
require('dotenv').config();

// Debug environment variables
console.log('🔧 Environment Variables Check:');
console.log('- NODE_ENV:', process.env.NODE_ENV || 'not set');
console.log('- PORT:', process.env.PORT || 'not set (will use 3000)');
console.log('- CLOVER_API_TOKEN:', process.env.CLOVER_API_TOKEN ? '✓ SET' : '❌ NOT SET');
console.log('- CLOVER_MERCHANT_ID:', process.env.CLOVER_MERCHANT_ID ? '✓ SET' : '❌ NOT SET');
console.log('- CLOVER_BASE_URL:', process.env.CLOVER_BASE_URL || 'not set (will use default)');
console.log('');

const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

console.log('🚀 Starting Clover POS API server...');
console.log(`📡 Will listen on port: ${PORT}`);

// Middleware
app.use(cors());
app.use(express.json());

// Basic rate limiting without external package
const requestCounts = new Map();
const rateLimiter = (req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 15 * 60 * 1000; // 15 minutes
  const maxRequests = 100;

  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, []);
  }

  const requests = requestCounts.get(ip);
  const validRequests = requests.filter(time => now - time < windowMs);
  
  if (validRequests.length >= maxRequests) {
    return res.status(429).json({
      success: false,
      error: 'Too many requests',
      retryAfter: Math.ceil(windowMs / 1000)
    });
  }

  validRequests.push(now);
  requestCounts.set(ip, validRequests);
  next();
};

app.use(rateLimiter);

// Clover API configuration
const CLOVER_BASE_URL = process.env.CLOVER_BASE_URL || 'https://apisandbox.dev.clover.com';
const CLOVER_API_TOKEN = process.env.CLOVER_API_TOKEN;
const MERCHANT_ID = process.env.CLOVER_MERCHANT_ID;

// Validation middleware
const validateCloverConfig = (req, res, next) => {
  if (!CLOVER_API_TOKEN || !MERCHANT_ID) {
    return res.status(500).json({
      success: false,
      error: 'Clover API configuration missing',
      message: 'Please set CLOVER_API_TOKEN and CLOVER_MERCHANT_ID environment variables'
    });
  }
  next();
};

// Clover API request helper
const cloverRequest = async (endpoint, method = 'GET', data = null) => {
  try {
    const config = {
      method,
      url: `${CLOVER_BASE_URL}/v3/merchants/${MERCHANT_ID}${endpoint}`,
      headers: {
        'Authorization': `Bearer ${CLOVER_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000 // 10 second timeout
    };

    if (data && (method === 'POST' || method === 'PUT')) {
      config.data = data;
    }

    const response = await axios(config);
    return response.data;
  } catch (error) {
    console.error('Clover API Error:', error.response?.data || error.message);
    throw {
      status: error.response?.status || 500,
      message: error.response?.data?.message || 'Clover API request failed',
      details: error.response?.data
    };
  }
};

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    config: {
      hasToken: !!CLOVER_API_TOKEN,
      hasMerchantId: !!MERCHANT_ID,
      baseUrl: CLOVER_BASE_URL
    }
  });
});

// API Routes

// Get all inventory items with pagination
app.get('/api/inventory', validateCloverConfig, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 1000, 1000); // Max 1000 per Clover API
    const offset = parseInt(req.query.offset) || 0;
    const filter = req.query.filter;
    const getAllPages = req.query.all === 'true'; // New parameter to get all items
    
    let endpoint = `/items?limit=${limit}&offset=${offset}`;
    if (filter) {
      endpoint += `&filter=${encodeURIComponent(filter)}`;
    }

    if (getAllPages) {
      // Get all items across all pages
      const allItems = [];
      let currentOffset = 0;
      let hasMore = true;
      let totalFetched = 0;
      let pageCount = 0;
      
      console.log('📦 Fetching all inventory items (1000 per batch)...');
      
      while (hasMore) {
        const pageEndpoint = `/items?limit=1000&offset=${currentOffset}` + 
          (filter ? `&filter=${encodeURIComponent(filter)}` : '');
        
        const data = await cloverRequest(pageEndpoint);
        const items = data.elements || [];
        
        allItems.push(...items);
        totalFetched += items.length;
        pageCount++;
        
        console.log(`📄 Batch ${pageCount}: ${items.length} items (total: ${totalFetched})`);
        
        hasMore = data.hasMore && items.length === 1000;
        currentOffset += 1000;
        
        // Safety break to prevent infinite loops
        if (currentOffset > 50000) {
          console.warn('⚠️ Stopped at 50,000 items for safety');
          break;
        }
        
        // Small delay between requests
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      console.log(`✅ Finished fetching ${totalFetched} total items in ${pageCount} batches`);
      
      return res.json({
        success: true,
        data: allItems,
        total: totalFetched,
        batches: pageCount,
        estimatedTotal: totalFetched,
        isComplete: !hasMore,
        message: `Retrieved all ${totalFetched} items across ${pageCount} batches of 1000`
      });
    } else {
      // Single page request
      const data = await cloverRequest(endpoint);
      
      return res.json({
        success: true,
        data: data.elements || [],
        total: data.elements?.length || 0,
        hasMore: data.hasMore || false,
        pagination: { 
          limit, 
          offset,
          nextOffset: data.hasMore ? offset + limit : null
        },
        message: data.hasMore ? `Batch ${Math.floor(offset/limit) + 1} of results (${data.elements?.length || 0} items). Use ?all=true to get all items.` : 'Last batch'
      });
    }
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
});

// Get all inventory items (optimized for large inventories)
app.get('/api/inventory/all', validateCloverConfig, async (req, res) => {
  try {
    const filter = req.query.filter;
    const includeStock = req.query.includeStock === 'true';
    const batchSize = Math.min(parseInt(req.query.batchSize) || 1000, 1000); // Max 1000 per Clover
    
    const allItems = [];
    let currentOffset = 0;
    let hasMore = true;
    let totalFetched = 0;
    let batchCount = 0;
    
    console.log(`📦 Starting full inventory fetch (batchSize: ${batchSize}, includeStock: ${includeStock})...`);
    const startTime = Date.now();
    
    while (hasMore) {
      let endpoint = `/items?limit=${batchSize}&offset=${currentOffset}`;
      
      if (filter) {
        endpoint += `&filter=${encodeURIComponent(filter)}`;
      }
      
      if (includeStock) {
        endpoint += '&expand=itemStock';
      }
      
      const data = await cloverRequest(endpoint);
      const items = data.elements || [];
      
      allItems.push(...items);
      totalFetched += items.length;
      batchCount++;
      
      console.log(`📄 Batch ${batchCount}: ${items.length} items (total: ${totalFetched})`);
      
      hasMore = data.hasMore && items.length === batchSize;
      currentOffset += batchSize;
      
      // Safety break
      if (currentOffset > 50000) {
        console.warn('⚠️ Stopped at 50,000 items for safety');
        break;
      }
      
      // Small delay to be nice to Clover's API
      if (hasMore) {
        await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
      }
    }
    
    const endTime = Date.now();
    const duration = (endTime - startTime) / 1000;
    
    console.log(`✅ Fetched ${totalFetched} items in ${duration}s across ${batchCount} batches`);
    
    res.json({
      success: true,
      data: allItems,
      total: totalFetched,
      batches: batchCount,
      batchSize: batchSize,
      duration: `${duration}s`,
      includeStock,
      isComplete: !hasMore,
      estimatedTotal: totalFetched,
      message: `Retrieved all ${totalFetched} items in ${duration} seconds using ${batchCount} batches of ${batchSize}`
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
});
app.get('/api/inventory/:itemId', validateCloverConfig, async (req, res) => {
  try {
    const itemId = req.params.itemId;
    
    if (!itemId || itemId === 'undefined') {
      return res.status(400).json({
        success: false,
        error: 'Valid item ID is required'
      });
    }
    
    const data = await cloverRequest(`/items/${itemId}`);
    
    res.json({
      success: true,
      data: data
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
});

// Get inventory item stock
app.get('/api/inventory/:itemId/stock', validateCloverConfig, async (req, res) => {
  try {
    const itemId = req.params.itemId;
    
    if (!itemId || itemId === 'undefined') {
      return res.status(400).json({
        success: false,
        error: 'Valid item ID is required'
      });
    }
    
    const data = await cloverRequest(`/item_stocks/${itemId}`);
    
    res.json({
      success: true,
      data: {
        itemId: itemId,
        quantity: data.quantity || 0, // Use quantity instead of stockCount
        stockCount: data.stockCount || 0, // Deprecated but still returned
        lowStock: (data.quantity || 0) < 10
      }
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
});

// Get low stock items (optimized for large inventories)
app.get('/api/inventory/alerts/low-stock', validateCloverConfig, async (req, res) => {
  try {
    const threshold = parseInt(req.query.threshold) || 10;
    const useFilter = req.query.useFilter !== 'false'; // Default to using filter
    
    if (useFilter) {
      // Efficient approach: Use Clover's built-in filter
      console.log(`🔍 Using filter method for low stock (threshold: ${threshold})`);
      
      const filter = `itemStock.quantity<=${threshold}`;
      let allLowStockItems = [];
      let currentOffset = 0;
      let hasMore = true;
      let batchCount = 0;
      
      while (hasMore) {
        const endpoint = `/items?filter=${encodeURIComponent(filter)}&expand=itemStock&limit=1000&offset=${currentOffset}`;
        const data = await cloverRequest(endpoint);
        const items = data.elements || [];
        
        const processedItems = items.map(item => ({
          ...item,
          quantity: item.itemStock?.quantity || 0,
          stockCount: item.itemStock?.stockCount || 0
        }));
        
        allLowStockItems.push(...processedItems);
        batchCount++;
        
        hasMore = data.hasMore && items.length === 1000;
        currentOffset += 1000;
        
        console.log(`📄 Low stock batch ${batchCount}: ${items.length} items (total found: ${allLowStockItems.length})`);
        
        if (currentOffset > 10000) break; // Safety break
        
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      res.json({
        success: true,
        data: allLowStockItems,
        threshold: threshold,
        count: allLowStockItems.length,
        batchesChecked: batchCount,
        method: 'filter',
        message: `Found ${allLowStockItems.length} items with stock <= ${threshold} using filter method`
      });
      
    } else {
      // Fallback approach: Get all items and check manually
      console.log(`🔍 Using manual check method for low stock (threshold: ${threshold})`);
      
      const allItems = [];
      let currentOffset = 0;
      let hasMore = true;
      let batchCount = 0;
      
      // Get all items with stock info
      while (hasMore) {
        const endpoint = `/items?expand=itemStock&limit=1000&offset=${currentOffset}`;
        const data = await cloverRequest(endpoint);
        const items = data.elements || [];
        
        allItems.push(...items);
        batchCount++;
        
        hasMore = data.hasMore && items.length === 1000;
        currentOffset += 1000;
        
        console.log(`📄 Checking batch ${batchCount}: ${items.length} items (total: ${allItems.length})`);
        
        if (currentOffset > 20000) break; // Safety break
        
        if (hasMore) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      // Filter for low stock items
      const lowStockItems = allItems
        .filter(item => {
          const quantity = item.itemStock?.quantity || 0;
          return quantity <= threshold;
        })
        .map(item => ({
          ...item,
          quantity: item.itemStock?.quantity || 0,
          stockCount: item.itemStock?.stockCount || 0
        }));
      
      res.json({
        success: true,
        data: lowStockItems,
        threshold: threshold,
        count: lowStockItems.length,
        totalChecked: allItems.length,
        batchesChecked: batchCount,
        method: 'manual',
        message: `Checked ${allItems.length} items in ${batchCount} batches, found ${lowStockItems.length} with stock <= ${threshold}`
      });
    }
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
});

// Update inventory item
app.put('/api/inventory/:itemId', validateCloverConfig, async (req, res) => {
  try {
    const itemId = req.params.itemId;
    const updateData = req.body;
    
    if (!itemId || itemId === 'undefined') {
      return res.status(400).json({
        success: false,
        error: 'Valid item ID is required'
      });
    }
    
    const data = await cloverRequest(`/items/${itemId}`, 'PUT', updateData);
    
    res.json({
      success: true,
      data: data,
      message: 'Item updated successfully'
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
});

// Update inventory stock
app.put('/api/inventory/:itemId/stock', validateCloverConfig, async (req, res) => {
  try {
    const itemId = req.params.itemId;
    const quantity = req.body.quantity; // Use quantity instead of stockCount
    
    if (!itemId || itemId === 'undefined') {
      return res.status(400).json({
        success: false,
        error: 'Valid item ID is required'
      });
    }
    
    if (typeof quantity !== 'number' || quantity < 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid quantity. Must be a non-negative number. Supports decimals.'
      });
    }
    
    const data = await cloverRequest(`/item_stocks/${itemId}`, 'PUT', {
      quantity: quantity // Use quantity field instead of stockCount
    });
    
    res.json({
      success: true,
      data: data,
      message: 'Stock updated successfully'
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
});

// Create new inventory item
app.post('/api/inventory', validateCloverConfig, async (req, res) => {
  try {
    const itemData = req.body;
    
    // Validate required fields
    if (!itemData.name) {
      return res.status(400).json({
        success: false,
        error: 'Item name is required'
      });
    }
    
    const data = await cloverRequest('/items', 'POST', itemData);
    
    res.status(201).json({
      success: true,
      data: data,
      message: 'Item created successfully'
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
});

// Get inventory categories
app.get('/api/categories', validateCloverConfig, async (req, res) => {
  try {
    const data = await cloverRequest('/categories');
    
    res.json({
      success: true,
      data: data.elements || []
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
});

// Get items by category
app.get('/api/categories/:categoryId/items', validateCloverConfig, async (req, res) => {
  try {
    const categoryId = req.params.categoryId;
    
    if (!categoryId || categoryId === 'undefined') {
      return res.status(400).json({
        success: false,
        error: 'Valid category ID is required'
      });
    }
    
    const data = await cloverRequest(`/categories/${categoryId}/items`);
    
    res.json({
      success: true,
      data: data.elements || []
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
});

// Search inventory items
app.get('/api/inventory/search', validateCloverConfig, async (req, res) => {
  try {
    const query = req.query.q;
    const category = req.query.category;
    const priceMin = req.query.priceMin;
    const priceMax = req.query.priceMax;
    
    if (!query) {
      return res.status(400).json({
        success: false,
        error: 'Search query parameter "q" is required'
      });
    }
    
    // Build filter for search
    let filter = `name LIKE '%${query}%'`;
    if (category) {
      filter += ` AND categories.id='${category}'`;
    }
    if (priceMin) {
      filter += ` AND price>=${parseFloat(priceMin) * 100}`; // Clover uses cents
    }
    if (priceMax) {
      filter += ` AND price<=${parseFloat(priceMax) * 100}`;
    }
    
    const data = await cloverRequest(`/items?filter=${encodeURIComponent(filter)}`);
    
    res.json({
      success: true,
      data: data.elements || [],
      query: query,
      filters: { category, priceMin, priceMax }
    });
  } catch (error) {
    res.status(error.status || 500).json({
      success: false,
      error: error.message,
      details: error.details
    });
  }
});

// Webhook endpoint for Clover notifications
app.post('/api/webhooks/clover', express.raw({type: 'application/json'}), (req, res) => {
  try {
    const payload = JSON.parse(req.body.toString());
    
    console.log('Clover webhook received:', {
      type: payload.type,
      objectId: payload.objectId,
      timestamp: new Date().toISOString()
    });
    
    // Handle different webhook types
    switch (payload.type) {
      case 'CREATE':
      case 'UPDATE':
      case 'DELETE':
        console.log(`Inventory ${payload.type.toLowerCase()}: ${payload.objectId}`);
        break;
      default:
        console.log('Unhandled webhook type:', payload.type);
    }
    
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook error:', error);
    res.status(400).json({ error: 'Invalid webhook payload' });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler - this should be last
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.originalUrl,
    method: req.method,
    availableEndpoints: [
      'GET /health',
      'GET /api/inventory (pagination: ?limit=1000&offset=0&all=true)',
      'GET /api/inventory/all (get all items: ?includeStock=true&batchSize=1000)',
      'GET /api/inventory/count (get total count: ?method=estimate|exact)',
      'GET /api/inventory/:itemId',
      'GET /api/inventory/:itemId/stock',
      'GET /api/inventory/alerts/low-stock (?threshold=10&useFilter=true)',
      'PUT /api/inventory/:itemId',
      'PUT /api/inventory/:itemId/stock',
      'POST /api/inventory',
      'GET /api/categories',
      'GET /api/categories/:categoryId/items',
      'GET /api/inventory/search',
      'POST /api/webhooks/clover'
    ]
  });
});

// Start server
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Clover POS API server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🌐 In Codespaces: https://${process.env.CODESPACE_NAME}-${PORT}.${process.env.GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN || 'app.github.dev'}/health`);
  console.log(`📝 Configuration check: CLOVER_API_TOKEN=${!!CLOVER_API_TOKEN}, MERCHANT_ID=${!!MERCHANT_ID}`);
});

// Handle server errors
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`❌ Port ${PORT} is already in use`);
    console.log('💡 Try a different port: PORT=3001 npm run dev');
  } else {
    console.error('❌ Server error:', error);
  }
  process.exit(1);
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});

module.exports = app;