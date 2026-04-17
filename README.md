# NovaCart — CouchDB Deep Dive

A comprehensive technical reference for how NovaCart uses Apache CouchDB as its sole backend. This document covers every HTTP call, every MapReduce view, every Mango query, and the reasoning behind each architectural decision.

---

## Table of Contents

1. [Why CouchDB?](#1-why-couchdb)
2. [Architecture Overview](#2-architecture-overview)
3. [Connection & Authentication](#3-connection--authentication)
4. [The `couchFetch` Helper](#4-the-couchfetch-helper)
5. [Document Model](#5-document-model)
6. [HTTP Methods Used](#6-http-methods-used)
7. [Design Documents & MapReduce Views](#7-design-documents--mapreduce-views)
8. [Mango Query System](#8-mango-query-system)
9. [CRUD Operations](#9-crud-operations)
10. [Analytics Dashboard](#10-analytics-dashboard)
11. [Application Startup Flow](#11-application-startup-flow)
12. [Dev Panel & Query Logging](#12-dev-panel--query-logging)
13. [Every CouchDB Call (Master Reference)](#13-every-couchdb-call-master-reference)
14. [CouchDB Version & Constraints](#14-couchdb-version--constraints)

---

## 1. Why CouchDB?

CouchDB is a document-oriented NoSQL database that exposes its entire API over HTTP/REST. This makes it uniquely suitable for NovaCart's architecture:

- **No backend needed.** The browser talks directly to CouchDB via `fetch()`. No Express server, no GraphQL layer, no ORM. The database *is* the API.
- **Schemaless documents.** A smartphone product has `specs.RAM` and `specs.Display`. A book has `specs.Pages` and `specs.Publisher`. No schema migrations, no ALTER TABLE. Each document carries exactly the fields it needs.
- **Built-in MapReduce.** CouchDB indexes data using JavaScript map/reduce functions stored in design documents. These are pre-computed B-tree indexes — not ad-hoc queries. This is fundamentally different from SQL indexes.
- **HTTP-native.** Every operation is a standard HTTP verb: `GET` to read, `PUT` to create/update, `POST` to create, `DELETE` to remove. No proprietary wire protocol.
- **MVCC concurrency.** Every document has a `_rev` (revision) field. Updates require the current `_rev`, preventing silent overwrites (optimistic locking).

---

## 2. Architecture Overview

```
Browser (localhost:3000)          CouchDB (localhost:5984)
┌─────────────────────┐           ┌──────────────────────┐
│  index.html         │           │  ecommerce_catalog   │
│  styles.css         │  HTTP     │  ├─ _design/catalog  │
│  app.js             │◄────────►│  │  └─ 8 views       │
│                     │  REST    │  ├─ _design/mango-idx │
│  couchFetch()       │           │  │  └─ 4 indexes     │
│  rawCouchFetch()    │           │  ├─ 24 products      │
│                     │           │  ├─ 4 categories     │
│  No framework       │           │  ├─ 8 reviews        │
│  No build step      │           │  └─ 5 orders         │
│  No server-side     │           │                      │
└─────────────────────┘           └──────────────────────┘
     http-server                    Apache CouchDB 3.x
```

**Zero middleware.** `app.js` constructs HTTP requests, sends them to CouchDB, parses JSON responses, and renders HTML. That's the entire backend.

---

## 3. Connection & Authentication

### URL Detection

```javascript
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
let COUCH_BASE, DB_URL;

if (IS_LOCAL) {
  COUCH_BASE = 'http://127.0.0.1:5984';
} else {
  // Remote access: read Cloudflare tunnel URL from localStorage
  COUCH_BASE = localStorage.getItem('couchdb_tunnel') || '';
  if (!COUCH_BASE) {
    const url = prompt('Enter the CouchDB Cloudflare tunnel URL:');
    if (url && url.trim()) {
      COUCH_BASE = url.trim().replace(/\/+$/, '');
      localStorage.setItem('couchdb_tunnel', COUCH_BASE);
    } else {
      COUCH_BASE = 'http://127.0.0.1:5984'; // fallback
    }
  }
}

DB_URL = COUCH_BASE + '/ecommerce_catalog';
```

- **Local:** Hardcoded `http://127.0.0.1:5984`
- **Remote:** Prompts for a Cloudflare tunnel URL on first visit, persists in `localStorage`

### Authentication

```javascript
const AUTH = 'Basic ' + btoa('admin:admin');
// Result: 'Basic YWRtaW46YWRtaW4='
```

Every HTTP request includes this header. CouchDB validates credentials before processing the request. This is **development-only** — production would use session cookies, JWT, or a proxy layer.

---

## 4. The `couchFetch` Helper

All CouchDB communication flows through one function:

```javascript
async function couchFetch(path, options = {}) {
  const method = (options.method || 'GET').toUpperCase();
  const startTime = performance.now();

  const res = await fetch(`${DB_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': AUTH,
      ...(options.headers || {})
    }
  });

  const duration = Math.round(performance.now() - startTime);

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CouchDB ${res.status}: ${text}`);
  }

  const data = await res.json();
  logQuery(method, path, options.body ? JSON.parse(options.body) : null, res.status, duration);
  return data;
}
```

**What it does:**
1. Prepends `DB_URL` to the path (e.g., `/_find` becomes `http://127.0.0.1:5984/ecommerce_catalog/_find`)
2. Injects `Content-Type: application/json` and `Authorization: Basic ...` on every request
3. Measures round-trip time with `performance.now()`
4. Throws on non-2xx responses, including CouchDB's error text
5. Parses JSON response automatically
6. Logs every query to the Dev Panel (method, path, body, status, duration)

There's also `rawCouchFetch()` — identical logic but **without** the `logQuery()` call. This exists to prevent infinite loops when the Dev Panel itself queries CouchDB for logs.

---

## 5. Document Model

CouchDB is schemaless. All documents live in a single database (`ecommerce_catalog`). A `type` field distinguishes them:

### Product Document
```json
{
  "_id": "auto-generated-by-couchdb",
  "_rev": "1-abc123...",
  "type": "product",
  "name": "iPhone 16 Pro",
  "brand": "Apple",
  "category": "Electronics",
  "subcategory": "Smartphones",
  "price": 134900,
  "original_price": 144900,
  "currency": "INR",
  "description": "...",
  "specs": {
    "Display": "6.3-inch Super Retina XDR",
    "Chip": "A18 Pro",
    "RAM": "8GB",
    "Storage": "256GB"
  },
  "colors": ["#4B4F54", "#F5F0EB", "#C1A882", "#3C3C40"],
  "color_names": ["Black Titanium", "White Titanium", "Desert Titanium", "Natural Titanium"],
  "image": "https://m.media-amazon.com/images/I/...",
  "images": ["url1", "url2"],
  "stock": 45,
  "rating": 4.8,
  "reviews_count": 2847,
  "tags": ["bestseller", "featured"],
  "created_at": "2024-01-15T10:30:00.000Z"
}
```

**Flexible schema:** A book product has `specs.Pages`, `specs.Format`, `specs.Publisher` instead of RAM/Storage. No migrations needed.

### Category Document
```json
{
  "type": "category",
  "name": "Electronics",
  "subcategories": ["Smartphones", "Headphones", "Laptops", "Cameras"],
  "image": "https://..."
}
```

### Review Document
```json
{
  "type": "review",
  "product_id": "abc123...",
  "user_name": "Priya S.",
  "rating": 5,
  "title": "Excellent camera",
  "comment": "...",
  "date": "2024-02-10",
  "verified": true
}
```

### Order Document
```json
{
  "type": "order",
  "status": "delivered",
  "total": 189900,
  "items": [...]
}
```

### Why `_id` and `_rev` matter

- **`_id`**: Unique document identifier. CouchDB auto-generates UUIDs when you `POST` to the database root. Used for direct lookups (`GET /ecommerce_catalog/{_id}`).
- **`_rev`**: Revision string (e.g., `"1-967a00dff5e02add41819138abb3284d"`). CouchDB uses MVCC (Multi-Version Concurrency Control) — every update MUST include the current `_rev`. If two clients try to update the same document simultaneously, one gets a `409 Conflict`. This is optimistic locking.

---

## 6. HTTP Methods Used

CouchDB maps CRUD operations to standard HTTP verbs:

| Method | CouchDB Meaning | NovaCart Usage |
|--------|-----------------|----------------|
| **GET** | Read a document or query a view | Fetch products, categories, reviews via MapReduce views |
| **POST** | Create a new document (auto-ID) or execute a query | Add products, create Mango indexes, run `_find`/`_explain` queries |
| **PUT** | Create or replace a document at a specific ID | Create database, upload design documents, update documents (requires `_rev`) |
| **DELETE** | Delete a document | Soft-delete via `_bulk_docs` with `_deleted: true` |

### Why POST vs PUT?

- `POST /ecommerce_catalog` — CouchDB generates the `_id`. Used when you don't care about the ID (new products, log entries).
- `PUT /ecommerce_catalog/{id}` — You specify the `_id`. Used for design documents (`_design/catalog`) and updates (must include `_rev`).

### Why POST for queries?

CouchDB uses `POST` for `_find` and `_explain` because the query body (JSON selector) can be large and complex. GET requests would require encoding the entire selector in the URL query string.

---

## 7. Design Documents & MapReduce Views

### What is a Design Document?

A design document is a special CouchDB document (prefixed `_design/`) that contains application logic — specifically, MapReduce view definitions. NovaCart uses one design document: `_design/catalog`.

```
PUT /ecommerce_catalog/_design/catalog
Body: { "views": { ...8 view definitions... } }
```

### How MapReduce Works in CouchDB

Unlike SQL databases that build indexes on columns, CouchDB indexes are defined by JavaScript functions:

1. **Map phase**: A JavaScript function runs against every document in the database. It calls `emit(key, value)` to produce index entries.
2. **Index storage**: CouchDB stores the emitted key-value pairs in a B-tree, sorted by key.
3. **Reduce phase** (optional): A reduce function aggregates values across matching keys.
4. **Lazy indexing**: Views are built on first query and updated incrementally as documents change. CouchDB only re-indexes changed documents, not the whole database.

### The 8 Views

#### 1. `all_products` — Simple index, no reduce

```javascript
// map
function(doc) {
  if (doc.type === 'product') emit(doc.name, null);
}
```

**Query:** `GET /_design/catalog/_view/all_products?include_docs=true`

**How it works:**
- The map function scans every document. If `type === 'product'`, it emits the product name as the key and `null` as the value.
- Emitting `null` keeps the index small — the actual data comes from `include_docs=true`, which tells CouchDB to attach the full document to each row.
- Result: `{ rows: [{ key: "AirPods Pro 2", value: null, doc: { ...full product... } }, ...] }`

**Why not just `GET /_all_docs`?** Because `_all_docs` returns ALL documents (products, categories, reviews, orders). This view filters to only products.

---

#### 2. `all_categories` — Same pattern

```javascript
function(doc) {
  if (doc.type === 'category') emit(doc.name, null);
}
```

**Query:** `GET /_design/catalog/_view/all_categories?include_docs=true`

Filters to category documents only. Same lightweight-index-with-include_docs pattern.

---

#### 3. `reviews_by_product` — Keyed by product ID

```javascript
function(doc) {
  if (doc.type === 'review') emit(doc.product_id, null);
}
```

**Query:** `GET /_design/catalog/_view/reviews_by_product?include_docs=true`

**Key design choice:** The emit key is `product_id`. This means you *could* query `?key="abc123"` to get reviews for a single product. NovaCart fetches all reviews at startup and filters client-side — but the index supports per-product queries for future optimization.

---

#### 4. `category_stats` — Custom reduce aggregation

```javascript
// map
function(doc) {
  if (doc.type === 'product') {
    emit(doc.category, { price: doc.price, rating: doc.rating, stock: doc.stock });
  }
}

// reduce
function(keys, values, rereduce) {
  var result = { count: 0, total_price: 0, total_rating: 0, total_stock: 0 };
  if (rereduce) {
    // Combining pre-aggregated subtree results
    values.forEach(function(v) {
      result.count += v.count;
      result.total_price += v.total_price;
      result.total_rating += v.total_rating;
      result.total_stock += v.total_stock;
    });
  } else {
    // First pass: aggregating raw emitted values
    result.count = values.length;
    values.forEach(function(v) {
      result.total_price += v.price;
      result.total_rating += v.rating;
      result.total_stock += v.stock;
    });
  }
  result.avg_price = result.total_price / result.count;
  result.avg_rating = result.total_rating / result.count;
  return result;
}
```

**Query:** `GET /_design/catalog/_view/category_stats?group=true`

**How `group=true` works:**
- Without `group`, reduce runs across ALL rows and returns a single aggregated result.
- With `group=true`, CouchDB groups by the emitted key (category name) and runs reduce per group.
- Result: One row per category, each with `{ count, avg_price, avg_rating, total_stock }`.

**Why `rereduce`?**
CouchDB's B-tree stores intermediate reduce results at internal nodes. When combining two subtrees, it calls the reduce function with `rereduce=true` and the previously-reduced values. The function must handle both:
- **`rereduce=false`**: Raw emitted values (e.g., `{ price: 134900, rating: 4.8, stock: 45 }`)
- **`rereduce=true`**: Pre-aggregated values (e.g., `{ count: 5, total_price: 450000, ... }`)

This is what makes CouchDB reduce functions incrementally updatable — they don't need to re-scan all documents when one changes.

---

#### 5. `revenue_by_status` — Built-in `_stats` reduce

```javascript
// map
function(doc) {
  if (doc.type === 'order') emit(doc.status, doc.total);
}
// reduce: _stats (built-in)
```

**Query:** `GET /_design/catalog/_view/revenue_by_status?group=true`

**CouchDB built-in reduces:**
- `_count` — counts rows
- `_sum` — sums values
- `_stats` — computes count, sum, min, max, sumsqr (sum of squares)

Using `_stats` with `group=true` gives per-status revenue statistics in a single query, with zero custom code.

**Result:**
```json
{
  "rows": [
    { "key": "delivered", "value": { "sum": 489700, "count": 3, "min": 89900, "max": 234900, "sumsqr": ... } },
    { "key": "processing", "value": { "sum": 134900, "count": 1, ... } }
  ]
}
```

---

#### 6. `low_stock_products` — Server-side filtering

```javascript
function(doc) {
  if (doc.type === 'product' && doc.stock < 30) {
    emit(doc.stock, { name: doc.name, category: doc.category, price: doc.price });
  }
}
```

**Query:** `GET /_design/catalog/_view/low_stock_products`

**Key insight:** The filtering happens inside the map function. Only products with `stock < 30` enter the index. The view stays small regardless of total catalog size. This is CouchDB's equivalent of a SQL `WHERE stock < 30` index.

Emit key is `doc.stock`, so results come back sorted by stock level (ascending by default — lowest stock first).

---

#### 7. `bestsellers` — Tag-based filtering + sorted by reviews

```javascript
function(doc) {
  if (doc.type === 'product' && doc.tags && doc.tags.indexOf('bestseller') !== -1) {
    emit(doc.reviews_count, { name: doc.name, category: doc.category, rating: doc.rating });
  }
}
```

**Query:** `GET /_design/catalog/_view/bestsellers?descending=true`

**How `descending=true` works:** CouchDB stores B-tree entries in ascending key order. `descending=true` walks the tree in reverse. Since the key is `reviews_count`, you get highest review counts first. This is an O(log n) operation — no sorting in memory.

---

#### 8. `products_on_sale` — Computed keys

```javascript
function(doc) {
  if (doc.type === 'product' && doc.original_price && doc.original_price > doc.price) {
    var discount = Math.round((1 - doc.price / doc.original_price) * 100);
    emit(discount, { name: doc.name, price: doc.price, original_price: doc.original_price });
  }
}
```

**Query:** `GET /_design/catalog/_view/products_on_sale?descending=true`

**Key insight:** The discount percentage is **computed at index time**, not at query time. The map function does arithmetic (`Math.round(...)`) and emits the result as the key. This means:
- Sorting by discount is free (B-tree walk)
- No computation happens at query time
- The index updates incrementally when a product's price changes

---

## 8. Mango Query System

CouchDB 2.0+ includes Mango — a MongoDB-style JSON query engine accessed via `POST /_find`.

### Index Creation

NovaCart creates 4 Mango indexes at startup:

```javascript
async function ensureMangoIndexes() {
  const indexes = [
    { index: { fields: ['type', 'category', 'price'] }, name: 'idx-type-category-price', ddoc: 'mango-indexes' },
    { index: { fields: ['type', 'rating'] },            name: 'idx-type-rating',          ddoc: 'mango-indexes' },
    { index: { fields: ['type', 'name'] },              name: 'idx-type-name',            ddoc: 'mango-indexes' },
    { index: { fields: ['type', 'subcategory'] },       name: 'idx-type-subcategory',     ddoc: 'mango-indexes' }
  ];
  for (const idx of indexes) {
    try {
      await couchFetch('/_index', { method: 'POST', body: JSON.stringify(idx) });
    } catch (e) { /* silently ignore — indexes may already exist */ }
  }
}
```

**Why `type` is always the first field:** Every index starts with `type` to efficiently filter only product documents. CouchDB's query planner uses leftmost-prefix matching (like SQL composite indexes).

**Design doc:** All indexes stored in `_design/mango-indexes` (separate from the MapReduce design doc).

### Query Building

```javascript
function buildMangoSelector() {
  const selector = { type: 'product' };
  if (category) selector.category = category;
  if (subcategory) selector.subcategory = subcategory;
  if (search) selector.name = { '$regex': '(?i)' + escapedSearch };
  if (priceMin || priceMax) {
    selector.price = {};
    if (priceMin) selector.price['$gte'] = parseFloat(priceMin);
    if (priceMax) selector.price['$lte'] = parseFloat(priceMax);
  }
  if (rating) selector.rating = { '$gte': parseFloat(rating) };
  return selector;
}
```

**Operators used:**
| Operator | Meaning | Example |
|----------|---------|---------|
| `$regex` | Regular expression match | `{ name: { "$regex": "(?i)iphone" } }` |
| `$gte` | Greater than or equal | `{ price: { "$gte": 50000 } }` |
| `$lte` | Less than or equal | `{ price: { "$lte": 100000 } }` |

### Query Execution

```javascript
const query = { selector, sort, limit: 100 };

// Execute the query
const results = await couchFetch('/_find', { method: 'POST', body: JSON.stringify(query) });

// Get the query plan (which index was used)
const explain = await couchFetch('/_explain', { method: 'POST', body: JSON.stringify(query) });
```

**Two endpoints:**
- `POST /_find` — Executes the query, returns `{ docs: [...], execution_stats: { total_docs_examined, execution_time_ms, ... } }`
- `POST /_explain` — Returns the query plan without executing. Shows which index CouchDB selected.

**CouchDB quirk:** Sort fields must exist in the selector. NovaCart handles this:
```javascript
if (sort.length) {
  const sortField = Object.keys(sort[0])[0];
  if (!selector[sortField]) selector[sortField] = { '$gt': null };
}
```

### MapReduce Views vs Mango Queries

| Feature | MapReduce Views | Mango Queries |
|---------|----------------|---------------|
| **Defined in** | Design documents (JavaScript functions) | Ad-hoc JSON selectors |
| **Index type** | Pre-computed B-tree | JSON indexes (also B-tree) |
| **Query language** | URL parameters (`key=`, `group=`, `descending=`) | MongoDB-style JSON (`$gte`, `$regex`, `$lte`) |
| **Aggregation** | Yes (reduce functions) | No |
| **Best for** | Fixed, performance-critical queries | Dynamic, user-driven filtering |
| **NovaCart usage** | Initial data load + analytics | Filtered product grid |

---

## 9. CRUD Operations

### Create — Adding a Product

```javascript
// POST to database root — CouchDB auto-generates _id
const res = await couchFetch('', {
  method: 'POST',
  body: JSON.stringify({
    type: 'product',
    name: '...',
    category: '...',
    price: 59999,
    currency: 'INR',
    stock: 100,
    rating: 0,
    reviews_count: 0,
    tags: ['new'],
    created_at: new Date().toISOString()
    // ... other fields
  })
});
// Response: { ok: true, id: "auto-uuid", rev: "1-abc123..." }
```

### Read — Fetching Data

**Via MapReduce views (primary pattern):**
```javascript
const productsRes = await couchFetch('/_design/catalog/_view/all_products?include_docs=true');
const products = productsRes.rows.map(r => r.doc);
```

**Via Mango query (dynamic filtering):**
```javascript
const results = await couchFetch('/_find', {
  method: 'POST',
  body: JSON.stringify({
    selector: { type: 'product', category: 'Electronics', price: { '$lte': 100000 } },
    sort: [{ price: 'asc' }],
    limit: 100
  })
});
const products = results.docs;
```

### Update — Bulk Operations

CouchDB requires the current `_rev` for updates (optimistic locking):

```javascript
// Bulk update via _bulk_docs
await couchFetch('/_bulk_docs', {
  method: 'POST',
  body: JSON.stringify({
    docs: [
      { _id: 'doc1', _rev: '3-xyz...', category: 'Updated Category', /* ...rest of doc */ },
      { _id: 'doc2', _rev: '2-abc...', category: 'Updated Category', /* ...rest of doc */ }
    ]
  })
});
```

If `_rev` doesn't match the current revision, CouchDB returns `409 Conflict` for that document.

### Delete — Soft Delete via `_deleted`

CouchDB deletes are actually updates with `_deleted: true`:

```javascript
// Fetch documents to get current _id and _rev
const data = await rawCouchFetch('/_find', {
  method: 'POST',
  body: JSON.stringify({
    selector: { type: 'query_log' },
    fields: ['_id', '_rev'],
    limit: 500
  })
});

// Bulk delete
const deleteDocs = data.docs.map(d => ({ _id: d._id, _rev: d._rev, _deleted: true }));
await rawCouchFetch('/_bulk_docs', {
  method: 'POST',
  body: JSON.stringify({ docs: deleteDocs })
});
```

**Why fetch before delete?** CouchDB requires the current `_rev` for deletion. You can't delete by query alone — you must first get the `_id` and `_rev` of each document.

---

## 10. Analytics Dashboard

The analytics page fires 5 MapReduce view queries sequentially:

```javascript
const catStats   = await couchFetch('/_design/catalog/_view/category_stats?group=true');
const revenue    = await couchFetch('/_design/catalog/_view/revenue_by_status?group=true');
const lowStock   = await couchFetch('/_design/catalog/_view/low_stock_products');
const bestsellers = await couchFetch('/_design/catalog/_view/bestsellers?descending=true');
const onSale     = await couchFetch('/_design/catalog/_view/products_on_sale?descending=true');
```

### Data Flow: CouchDB Response to HTML

| View | Response Shape | Rendered As |
|------|---------------|-------------|
| `category_stats` | `rows[].key` = category name, `rows[].value` = `{ count, avg_price, avg_rating, total_stock }` | Bar chart (width = count/maxCount * 100%) + stats table |
| `revenue_by_status` | `rows[].key` = status, `rows[].value` = `{ count, sum, min, max }` (from `_stats`) | Bar chart (width = sum/totalRevenue * 100%) + revenue table |
| `low_stock_products` | `rows[].key` = stock level, `rows[].value` = `{ name, category, price }` | Alert table (stock count in red) |
| `bestsellers` | `rows[].key` = review count, `rows[].value` = `{ name, category, rating }` | Ranked table |
| `products_on_sale` | `rows[].key` = discount %, `rows[].value` = `{ name, price, original_price }` | Discount table (with strikethrough original price) |

All aggregation happens server-side in CouchDB. The browser receives pre-computed results and only does rendering.

---

## 11. Application Startup Flow

```
DOMContentLoaded
    │
    ├── updateCartCount()         ← Read cart from localStorage
    ├── setupDropdowns()          ← Wire up navigation event listeners
    │
    ├── loadData()                ← BLOCKING: fetch from CouchDB
    │   ├── GET all_products      ← MapReduce view query
    │   ├── GET all_categories    ← MapReduce view query
    │   ├── GET all_reviews       ← MapReduce view query
    │   ├── Populate nav dropdowns
    │   └── ensureMangoIndexes()  ← NON-BLOCKING: POST /_index x4
    │
    ├── preloadAllImages()        ← BLOCKING: batch-load images (3 at a time)
    │
    ├── renderFeaturedProducts()  ← Build carousel from allProducts
    ├── renderCategories()        ← Build category grid from allCategories
    └── renderReviews()           ← Build review carousel from allReviews
```

**Error handling:** If CouchDB is unreachable, `loadData()` catches the error and inserts a red banner:
> "Unable to connect to CouchDB. Please ensure the database is running on localhost:5984."

The app renders with empty data — no retry logic.

---

## 12. Dev Panel & Query Logging

### How Logging Works

Every `couchFetch()` call automatically logs to the Dev Panel:

```javascript
// Inside couchFetch():
logQuery(method, path, body, status, duration);
```

`logQuery()` creates an entry with:
- HTTP method, path, body summary
- Response status code
- Round-trip duration (ms)
- Human-readable explanation (from `QUERY_EXPLANATIONS` lookup table)
- IST timestamp

### Cross-Browser Log Sync

Query logs are also written to CouchDB as documents:

```javascript
function writeLogToDb(entry) {
  fetch(`${DB_URL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': AUTH },
    body: JSON.stringify({ type: 'query_log', ...entry, ts: Date.now() })
  }).catch(() => {});  // fire-and-forget
}
```

The Dev Panel polls for these logs from other browser instances:

```javascript
const res = await fetch(`${DB_URL}/_find`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': AUTH },
  body: JSON.stringify({
    selector: { type: 'query_log', ts: { '$gt': 0 } },
    sort: [{ ts: 'desc' }],
    limit: 50
  })
});
```

This enables viewing queries made on a phone (via Cloudflare tunnel) from the desktop Dev Panel.

---

## 13. Every CouchDB Call (Master Reference)

| Location | Method | Endpoint | Purpose | Query Params / Body |
|----------|--------|----------|---------|-------------------|
| `loadData()` | GET | `/_design/catalog/_view/all_products` | Load all products | `?include_docs=true` |
| `loadData()` | GET | `/_design/catalog/_view/all_categories` | Load all categories | `?include_docs=true` |
| `loadData()` | GET | `/_design/catalog/_view/reviews_by_product` | Load all reviews | `?include_docs=true` |
| `loadAnalytics()` | GET | `/_design/catalog/_view/category_stats` | Per-category aggregates | `?group=true` |
| `loadAnalytics()` | GET | `/_design/catalog/_view/revenue_by_status` | Revenue by order status | `?group=true` |
| `loadAnalytics()` | GET | `/_design/catalog/_view/low_stock_products` | Products with stock < 30 | (none) |
| `loadAnalytics()` | GET | `/_design/catalog/_view/bestsellers` | Top reviewed products | `?descending=true` |
| `loadAnalytics()` | GET | `/_design/catalog/_view/products_on_sale` | Discounted products | `?descending=true` |
| `addProduct()` | POST | `/` (db root) | Create new product | JSON product document |
| `ensureMangoIndexes()` | POST | `/_index` | Create Mango indexes (x4) | JSON index definition |
| `applyMangoFilters()` | POST | `/_find` | Execute Mango query | JSON selector + sort + limit |
| `applyMangoFilters()` | POST | `/_explain` | Get query plan | JSON selector + sort + limit |
| `writeLogToDb()` | POST | `/` (db root) | Write query log entry | JSON log document |
| `pollDevLog()` | POST | `/_find` | Poll logs from other browsers | `{ type: 'query_log', ts: { $gt: 0 } }` |
| `clearQueryLog()` | POST | `/_find` | Find log docs for deletion | `{ type: 'query_log' }` |
| `clearQueryLog()` | POST | `/_bulk_docs` | Bulk delete log docs | `{ docs: [{ _deleted: true }] }` |
| Script init | POST | `/_index` | Create query_log index | `{ fields: ['type', 'ts'] }` |

---

## 14. CouchDB Version & Constraints

### Version

**CouchDB 3.x** — inferred from features used:
- MapReduce views (all versions)
- Mango queries with `_find` and `_explain` (CouchDB 2.0+)
- `_stats` built-in reduce (all versions)
- `_bulk_docs` (all versions)

### Constraints

- **No server-side rendering.** Everything is client-side. CouchDB is accessed directly from the browser via REST API with Basic Auth. This is a development-only pattern.
- **CORS.** CouchDB must have CORS enabled for `localhost:3000`. This is configured in CouchDB's `local.ini`.
- **No transactions.** CouchDB has no multi-document transactions. Each document write is atomic, but there's no way to atomically update two documents together.
- **View build time.** MapReduce views are built lazily on first query. After seeding data, the first page load triggers all 8 view builds. Subsequent loads are fast (incremental updates only).
- **No real-time push.** The app doesn't use CouchDB's `_changes` feed. Data is fetched once at startup and cached in memory. The Dev Panel uses polling (not WebSockets) for cross-browser log sync.
- **Credentials in frontend.** `admin:admin` is hardcoded in JavaScript. Production would require a reverse proxy or CouchDB's cookie-based session authentication.

---

## Running

```bash
# CouchDB must be running on port 5984 with ecommerce_catalog database populated
npx http-server . -p 3000 -c-1
```

Open `http://localhost:3000` in the browser. The app will connect to CouchDB, fetch all data, and render the catalog.

---

*Built with Apache CouchDB 3.x — the database that speaks HTTP.*
