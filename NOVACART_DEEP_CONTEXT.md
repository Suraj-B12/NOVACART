# NovaCart Deep Context — Architecture & CouchDB Reference

## 1. What Is NovaCart

NovaCart is a single-page e-commerce product catalog that talks directly to Apache CouchDB from the browser. There is no backend server, no framework, no build step. The entire application is three files — `index.html`, `styles.css`, `app.js` — served via `npx http-server . -p 3000 -c-1`. CouchDB runs on `localhost:5984` and is accessed via its native HTTP/REST API using Basic Auth (`admin:admin`).

**Stack:** HTML5 + CSS3 + Vanilla JS | CouchDB 3.x | `http-server`

---

## 2. CouchDB Core Concepts (As Used in NovaCart)

### 2.1 Database & Connection

| Property       | Value                                          |
|----------------|------------------------------------------------|
| Database name  | `ecommerce_catalog`                            |
| URL            | `http://127.0.0.1:5984/ecommerce_catalog`      |
| Auth           | Basic Auth — `admin:admin` (dev-only, not safe for production) |
| Access pattern | Direct browser → CouchDB (no proxy, no middleware) |

Every HTTP request goes through a single helper function:

```javascript
const DB_URL = 'http://127.0.0.1:5984/ecommerce_catalog';
const AUTH   = 'Basic ' + btoa('admin:admin');

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
  if (!res.ok) throw new Error(`CouchDB ${res.status}: ${await res.text()}`);
  const data = await res.json();
  logQuery(method, path, options.body ? JSON.parse(options.body) : null, res.status, duration);
  return data;
}
```

Key things `couchFetch` does:
- Adds `Authorization` and `Content-Type: application/json` to every request
- Measures round-trip time via `performance.now()`
- Feeds every request into the Dev Panel query log (method, path, body, status, duration)
- Throws on non-2xx responses with the raw CouchDB error text

### 2.2 Document Types

CouchDB is schemaless — all documents live in the same database. NovaCart uses a `type` field to distinguish them:

| Type       | Purpose                        | Key Fields |
|------------|--------------------------------|------------|
| `product`  | Catalog item                   | `name`, `category`, `subcategory`, `price`, `original_price`, `currency` (INR), `description`, `specs` (object), `colors`, `image`, `images`, `stock`, `rating`, `reviews_count`, `tags` (array: "bestseller", "new", "featured"), `created_at` |
| `category` | Navigation category            | `name`, `subcategories` (array of strings), `image` |
| `review`   | Customer review                | `product_id`, `user_name`, `rating` (1-5), `title`, `comment`, `date`, `verified` (boolean) |
| `order`    | Past order (for analytics)     | `status` ("delivered", "processing", etc.), `total`, other order fields |

**Flexible schema**: A smartphone product has `specs.RAM`, `specs.Display`, `specs.Storage`. A book has `specs.Pages`, `specs.Format`, `specs.Publisher`. There are no schema migrations — each document carries whatever fields it needs.

### 2.3 Design Document: `_design/catalog`

All MapReduce views live in a single design document at `ecommerce_catalog/_design/catalog`. CouchDB indexes these views lazily — the B-tree is built on first query and updated incrementally as documents change.

#### View: `all_products`
```javascript
// map
function(doc) { if (doc.type === 'product') emit(doc.name, null); }
```
Called with `?include_docs=true` to get full documents. Emitting `null` as the value keeps the index small — the actual data comes from `doc`.

#### View: `all_categories`
```javascript
function(doc) { if (doc.type === 'category') emit(doc.name, null); }
```
Same pattern — lightweight index, full doc via `include_docs`.

#### View: `reviews_by_product`
```javascript
function(doc) { if (doc.type === 'review') emit(doc.product_id, null); }
```
Keyed by `product_id` so you can query `?key="<product_id>"` to get reviews for a single product. The app currently fetches all reviews at init and filters client-side.

#### View: `category_stats` (with custom reduce)
```javascript
// map
function(doc) {
  if (doc.type === 'product') {
    emit(doc.category, { price: doc.price, rating: doc.rating, stock: doc.stock });
  }
}
// reduce — custom aggregation
function(keys, values, rereduce) {
  var result = { count: 0, total_price: 0, total_rating: 0, total_stock: 0 };
  if (rereduce) {
    values.forEach(function(v) {
      result.count += v.count;
      result.total_price += v.total_price;
      result.total_rating += v.total_rating;
      result.total_stock += v.total_stock;
    });
  } else {
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
Called with `?group=true` — CouchDB groups by the emitted key (category) and runs the reduce per group. Returns per-category: count, avg price, avg rating, total stock.

**Why `rereduce`?** CouchDB's B-tree stores intermediate reduce results at internal nodes. When combining two subtrees, it calls `reduce` with `rereduce=true` and the previously-reduced values — so the reduce function must handle both raw values (first pass) and pre-aggregated values (re-reduce).

#### View: `revenue_by_status` (built-in `_stats` reduce)
```javascript
// map
function(doc) { if (doc.type === 'order') emit(doc.status, doc.total); }
// reduce: _stats
```
CouchDB's built-in `_stats` reduce computes count, sum, min, max, sum-of-squares for each group key. With `?group=true`, this returns per-status revenue stats in a single query — no custom reduce code.

#### View: `low_stock_products`
```javascript
function(doc) {
  if (doc.type === 'product' && doc.stock < 30) {
    emit(doc.stock, { name: doc.name, category: doc.category, price: doc.price });
  }
}
```
Server-side filtering: only products with stock < 30 are indexed. The view is small regardless of total catalog size.

#### View: `bestsellers`
```javascript
function(doc) {
  if (doc.type === 'product' && doc.tags && doc.tags.indexOf('bestseller') !== -1) {
    emit(doc.reviews_count, { name: doc.name, category: doc.category, rating: doc.rating });
  }
}
```
Emits `reviews_count` as the key. Queried with `?descending=true` to get highest review counts first. CouchDB walks the B-tree in reverse — O(log n).

#### View: `products_on_sale`
```javascript
function(doc) {
  if (doc.type === 'product' && doc.original_price && doc.original_price > doc.price) {
    var discount = Math.round((1 - doc.price / doc.original_price) * 100);
    emit(discount, { name: doc.name, price: doc.price, original_price: doc.original_price });
  }
}
```
Computes discount percentage at index time. With `?descending=true`, the biggest discounts come first.

### 2.4 Mango Query System

CouchDB's Mango query engine provides MongoDB-style JSON selectors via `POST /_find`. NovaCart uses this for the filtered product grid.

#### Index Creation (at app init)

```javascript
async function ensureMangoIndexes() {
  const indexes = [
    { index: { fields: ['type', 'category', 'price'] }, name: 'idx-type-category-price', ddoc: 'mango-indexes' },
    { index: { fields: ['type', 'rating'] },            name: 'idx-type-rating',          ddoc: 'mango-indexes' },
    { index: { fields: ['type', 'name'] },              name: 'idx-type-name',            ddoc: 'mango-indexes' },
    { index: { fields: ['type', 'subcategory'] },       name: 'idx-type-subcategory',     ddoc: 'mango-indexes' }
  ];
  await Promise.all(indexes.map(idx =>
    couchFetch('/_index', { method: 'POST', body: JSON.stringify(idx) }).catch(() => {})
  ));
}
```

Four composite B-tree indexes, all prefixed with `type` so Mango only scans product documents. CouchDB stores these in the `mango-indexes` design document. Index creation is idempotent — if the index already exists, CouchDB returns 200 with `"result": "exists"`.

#### Building the Mango Selector

```javascript
function buildMangoSelector() {
  const selector = { type: 'product' };
  if (category)    selector.category = category;
  if (subcategory) selector.subcategory = subcategory;
  if (search)      selector.name = { '$regex': '(?i)' + escapedSearch };
  if (priceMin || priceMax) {
    selector.price = {};
    if (priceMin) selector.price['$gte'] = parseFloat(priceMin);
    if (priceMax) selector.price['$lte'] = parseFloat(priceMax);
  }
  if (rating) selector.rating = { '$gte': parseFloat(rating) };
  return selector;
}
```

Supported operators: `$regex` (case-insensitive name search), `$gte`/`$lte` (price range, minimum rating).

**Sort field requirement:** CouchDB Mango requires that the sort field exists in the selector. The code adds `{ '$gt': null }` for the sort field if it's not already there:

```javascript
if (sort.length) {
  const sortField = Object.keys(sort[0])[0];
  if (!selector[sortField]) selector[sortField] = { '$gt': null };
}
```

#### Query Execution

```javascript
const query = { selector, sort, limit: 100 };
const [results, explain] = await Promise.all([
  couchFetch('/_find',    { method: 'POST', body: JSON.stringify(query) }),
  couchFetch('/_explain', { method: 'POST', body: JSON.stringify(query) }).catch(() => null)
]);
```

Two parallel requests:
1. `POST /_find` — executes the query, returns `{ docs: [...] }`
2. `POST /_explain` — returns the query plan (which index, type, fields) without executing. Displayed in the Query Inspector UI.

If Mango fails (CouchDB down, index not ready), the app falls back to client-side filtering on `allProducts`:

```javascript
catch (err) {
  console.error('Mango query failed, falling back to client-side:', err);
  applyFiltersClientSide();
}
```

#### Query Inspector UI

The advanced filter panel has a collapsible "Query Inspector" that shows:
- The exact Mango selector JSON sent to `/_find`
- The index CouchDB picked (from `/_explain`): index name, type, ddoc, fields

This is an educational feature — it makes CouchDB's query planning visible.

### 2.5 Data Loading Flow

On `DOMContentLoaded`:

```
1. loadData()
   ├── GET /_design/catalog/_view/all_products?include_docs=true   → allProducts[]
   ├── GET /_design/catalog/_view/all_categories?include_docs=true → allCategories[]
   ├── GET /_design/catalog/_view/reviews_by_product?include_docs=true → allReviews[]
   └── POST /_index (×4, non-blocking)  → create Mango indexes
2. preloadAllImages(allProducts)    → sequential batches of 3
3. renderFeaturedProducts()         → carousel
4. renderCategories()               → grid
5. renderReviews()                  → carousel
```

All product/category/review data is loaded once and cached in JS arrays. Navigation between views re-renders from the cached arrays. Only Mango queries (`/_find`) and analytics views hit CouchDB on subsequent navigations.

### 2.6 Analytics Dashboard — 5 Parallel View Queries

```javascript
const [catStats, revenue, lowStock, bestsellers, onSale] = await Promise.all([
  couchFetch('/_design/catalog/_view/category_stats?group=true'),
  couchFetch('/_design/catalog/_view/revenue_by_status?group=true'),
  couchFetch('/_design/catalog/_view/low_stock_products'),
  couchFetch('/_design/catalog/_view/bestsellers?descending=true'),
  couchFetch('/_design/catalog/_view/products_on_sale?descending=true')
]);
```

All five MapReduce views fire simultaneously. CouchDB handles them as independent HTTP requests. The analytics page renders:

| Card                   | Data Source               | What It Shows |
|------------------------|---------------------------|---------------|
| Overview               | Derived from JS arrays    | Total products, categories, reviews, revenue |
| Products by Category   | `category_stats`          | Bar chart + table: count, avg price, avg rating, total stock per category |
| Revenue by Status      | `revenue_by_status`       | Bar chart + table: order count, total, average per status |
| Low Stock Alert        | `low_stock_products`      | Table: products with stock < 30 |
| Top Rated Bestsellers  | `bestsellers`             | Table: product, category, rating, review count |
| Products on Sale       | `products_on_sale`        | Table: product, current price, was price, discount % |

### 2.7 Document Creation (Admin Form)

```javascript
async function addProduct(event) {
  const product = {
    type: 'product',
    name: ..., category: ..., subcategory: '',
    price: ..., currency: 'INR',
    description: ..., specs: {}, colors: [], color_names: [],
    image: ..., images: [],
    stock: ..., rating: 0, reviews_count: 0,
    tags: ['new'],
    created_at: new Date().toISOString()
  };
  const res = await couchFetch('', { method: 'POST', body: JSON.stringify(product) });
}
```

A `POST` to the database root creates a new document. CouchDB auto-generates `_id` and returns the initial `_rev`. After creation, the app reloads all data and re-renders.

---

## 3. Dev Panel — CouchDB Query Logger

The Dev Panel (`DEV` nav button) is an educational tool that logs every CouchDB request in real-time.

### Two Tabs:
- **Live Queries**: Every `couchFetch` call is logged with method, path, body summary, HTTP status, response time, and an educational explanation of what the query does and why.
- **Setup Queries**: Pre-defined list of the 8 queries that were used to initially set up the database (create DB, upload design doc, bulk insert seed data, create indexes).

### Query Explanations

Each CouchDB endpoint has a curated explanation:

| Path Pattern | Explanation |
|---|---|
| `/_design/catalog/_view/all_products` | Queries the all_products MapReduce view. With `include_docs=true`, CouchDB returns the full document for each row. |
| `/_design/catalog/_view/category_stats` | Uses a custom reduce function with `group=true` to compute per-category aggregates in a single query. |
| `/_design/catalog/_view/revenue_by_status` | Uses CouchDB's built-in `_stats` reduce function. Returns count, sum, min, max for each order status. |
| `/_find` | Uses CouchDB's Mango query engine. The selector uses MongoDB-style operators ($gte, $lte, $regex). CouchDB automatically picks the best index. |
| `/_explain` | Returns which index CouchDB would use for a given Mango selector, without executing the query. |
| `/_index` | Creates a secondary B-tree index. Stored in a design document and updated lazily on first query. |

HTTP method explanations are also shown:
- **GET**: Safe and idempotent — calling it twice gives the same result.
- **POST**: Sends data to create a new resource or execute a query. Used for document creation and Mango queries.
- **PUT**: Requires the current `_rev` for updates (optimistic concurrency).
- **DELETE**: Marks a document as `_deleted: true`. Revision history is preserved.

### Body Summarizer

Mango query bodies are formatted human-readably:
```
Filter: category = "Electronics", price >= 5000
Sort: price (asc)
Limit: 100
```

Index creation bodies show: `Fields: [type, category, price] / Name: idx-type-category-price`

New product bodies show: `New product: "Wireless Earbuds" (Electronics, ₹999)`

---

## 4. Database Setup (How to Seed)

The seed data includes ~24 products, 4 categories, 8 reviews, and 5 orders. The setup involves:

1. `PUT /ecommerce_catalog` — Create the database
2. `PUT /ecommerce_catalog/_design/catalog` — Upload design document with 8 MapReduce views
3. `POST /ecommerce_catalog/_bulk_docs` — Bulk insert all seed data (products, categories, reviews, orders)
4. `POST /ecommerce_catalog/_index` (×4) — Create Mango indexes

`_bulk_docs` inserts multiple documents in a single HTTP request — more efficient than individual POSTs since CouchDB batches writes into a single fsync.

---

## 5. CouchDB Concepts Demonstrated

| Concept | Where Used | Notes |
|---|---|---|
| **Document store** | All data | Schemaless JSON documents with `type` field discrimination |
| **REST API** | `couchFetch()` | Every operation is a standard HTTP request |
| **MapReduce views** | `_design/catalog` | 8 pre-computed views for different query patterns |
| **Custom reduce** | `category_stats` | Handles both reduce and rereduce for correct aggregation |
| **Built-in reduces** | `revenue_by_status` | `_stats` reduce — no custom code needed |
| **Server-side filtering** | `low_stock_products` | Map function filters at index time |
| **Emit key ordering** | `bestsellers`, `products_on_sale` | Queried with `descending=true` for top-N patterns |
| **Mango queries** | Product filtering | MongoDB-style `$regex`, `$gte`, `$lte` selectors |
| **Mango indexes** | 4 composite indexes | `type` prefix for efficient document-type filtering |
| **`_explain` endpoint** | Query Inspector | Reveals which index Mango picks for a query |
| **`_bulk_docs`** | Seeding | Batch insert for efficiency |
| **`include_docs=true`** | Data loading | Avoid double-lookup by fetching full docs with view results |
| **Optimistic concurrency** | Updates | `_rev` field prevents conflicting writes |
| **Revision tracking** | All documents | Every write creates a new revision |
| **Lazy indexing** | Views & Mango | Indexes are built on first access, updated incrementally |

---

## 6. Application State & Data Flow

```
CouchDB (localhost:5984)
  └── ecommerce_catalog
       ├── _design/catalog          → 8 MapReduce views
       ├── _design/mango-indexes    → 4 Mango indexes
       ├── product documents (24+)
       ├── category documents (4)
       ├── review documents (8+)
       └── order documents (5)

Browser (app.js)
  ├── allProducts[]     ← loaded once from all_products view
  ├── allCategories[]   ← loaded once from all_categories view
  ├── allReviews[]      ← loaded once from reviews_by_product view
  ├── cart[]            ← localStorage('novacart_cart')
  ├── queryLog[]        ← every couchFetch call logged
  └── imageCache (Map)  ← preloaded image URLs
```

---

## 7. Product Catalog & Category Structure

### 7.1 Categories and Subcategories

Each category document (`type: "category"`) defines a `subcategories` array. Products reference both `category` and `subcategory` fields. The dropdown navigation renders subcategories dynamically from the category documents.

| Category | Subcategories | Products |
|---|---|---|
| **Electronics** | Smartphones, Laptops, Headphones, Accessories | 7 products |
| **Clothing** | Men, Women, Fragrance | 7 products |
| **Books** | Fiction, Non-Fiction | 6 products |
| **Home & Living** | Furniture, Kitchen, Decor, Appliances | 4 products |

### 7.2 Full Product Mapping

| Product | Category | Subcategory | Rationale |
|---|---|---|---|
| Apple iPhone 16 Pro | Electronics | Smartphones | Primary mobile device |
| Samsung Galaxy S24 Ultra | Electronics | Smartphones | Primary mobile device |
| Apple MacBook Pro 14 M4 Pro | Electronics | Laptops | Primary computing device |
| Sony WH-1000XM5 | Electronics | Headphones | Audio peripheral |
| Apple AirPods Pro 2 | Electronics | Headphones | Audio peripheral |
| iPad Air M2 | Electronics | Accessories | Tablet — companion device |
| Sony Alpha A7 IV | Electronics | Accessories | Camera — specialized device |
| Nike Air Jordan 1 Retro High | Clothing | Men | Men's sneakers |
| Levi's 501 Original Jeans | Clothing | Men | Men's denim |
| Zara Leather Jacket | Clothing | Men | Men's outerwear |
| Michael Kors Jet Set Tote | Clothing | Women | Women's handbag |
| Prada Re-Nylon Backpack | Clothing | Women | Women's luxury backpack |
| Gucci GG Marmont Belt | Clothing | Women | Women's belt |
| Chanel No. 5 Eau de Parfum | Clothing | Fragrance | Perfume — distinct from clothing but sold in fashion retail |
| The Midnight Library | Books | Fiction | Novel |
| Atomic Habits | Books | Non-Fiction | Self-improvement |
| Sapiens by Yuval Noah Harari | Books | Non-Fiction | History/anthropology |
| The Psychology of Money | Books | Non-Fiction | Finance |
| Ikigai by Hector Garcia | Books | Non-Fiction | Self-help/philosophy |
| Rich Dad Poor Dad | Books | Non-Fiction | Finance |
| Dyson V15 Detect Vacuum | Home & Living | Appliances | Home appliance (not kitchen-specific) |
| Le Creuset Dutch Oven | Home & Living | Kitchen | Cookware |
| Philips Hue Starter Kit | Home & Living | Decor | Smart lighting/ambiance |
| Nespresso Vertuo Plus | Home & Living | Appliances | Coffee machine — home appliance |

All prices are in INR. Products with `original_price > price` are considered "on sale". Products tagged "bestseller", "new", or "featured" appear in filtered views and the carousel.

**Note on "Clothing" vs "Fashion":** The category was renamed from "Fashion" to "Clothing" in the database to match the navigation dropdown. All 7 product documents were updated via `_bulk_docs` with their new `category` field. CouchDB's MapReduce views automatically reflected the change on next query — no index rebuild required, since views re-index changed documents incrementally.

---

## 8. Image Handling System

### Amazon Hotlink Workaround
Most product images are from `m.media-amazon.com`. Amazon blocks images loaded from `localhost` via the `Referer` header. The fix:
- `<meta name="referrer" content="no-referrer">` in HTML head
- `referrerpolicy="no-referrer"` on every `<img>` tag

This prevents the browser from sending a `Referer` header, so Amazon serves the image.

### Sequential Preloader
```
imageCache (Map) — stores URLs that loaded successfully

preloadAllImages(products):
  for every 3 products:
    Promise.all → load 3 images concurrently
    each image gets 1 retry after 500ms on failure
  ALL images preloaded BEFORE any DOM rendering
```

This prevents broken-image flicker at the cost of initial load time.

---

## 9. Page Architecture

Three virtual "pages" toggled via `display: none`:

| Page | Sections Visible | CouchDB Queries |
|---|---|---|
| **Home** | Hero, Carousel, Text-Image Splits, Categories Grid, Reviews, Admin Form, Newsletter | None (uses cached arrays) |
| **All Products** | Filtered/sorted product grid with Mango filters | `POST /_find` + `POST /_explain` on every filter change |
| **Analytics** | Stats dashboard | 5 parallel MapReduce view queries |
| **Dev Panel** | Query logger, CouchDB explainer | None (displays logged queries) |

---

## 10. Cart System

- Stored in `localStorage` as `novacart_cart`
- Array of `{ id, name, price, image, qty }`
- No CouchDB interaction — purely client-side
- Slide-in sidebar from right (`transform: translateX`)
- Cart count badge in header updates on every change

---

## 11. CouchDB — Deep Technical Reference

### 11.1 Why CouchDB Over Alternatives?

| Concern | CouchDB | MongoDB | PostgreSQL |
|---|---|---|---|
| **Access pattern** | Native HTTP/REST — any HTTP client works | Binary protocol — needs a driver | Binary protocol — needs a driver |
| **Schema** | Schemaless JSON documents | Schemaless BSON documents | Rigid schema with migrations |
| **Browser-direct** | Yes — Basic Auth + CORS | No — needs a backend proxy | No — needs a backend |
| **Query options** | MapReduce views + Mango queries | Aggregation pipeline + find | SQL |
| **Conflict handling** | MVCC with revision trees — no locks | Last-write-wins by default | Row-level locks |
| **Replication** | Built-in master-master | Replica sets (primary-secondary) | Streaming replication (primary-secondary) |
| **Offline-first** | PouchDB syncs with CouchDB natively | No built-in offline story | No built-in offline story |

**For NovaCart specifically:** CouchDB was chosen because the entire app runs in the browser with zero backend code. The REST API means `fetch()` is the only dependency. No Node.js, no Express, no ORM — just HTTP.

### 11.2 B-Tree Internals (How Views Work)

CouchDB stores each MapReduce view as a **B+ tree on disk**. Understanding this explains performance characteristics:

```
View: all_products (keyed by doc.name)

B-tree:
         [iPad Air | MacBook Pro | Samsung]
        /          |             |          \
  [AirPods,    [iPhone,      [Nespresso,   [Sapiens,
   Atomic,      Ikigai,       Nike,         Sony A7,
   Chanel]      Levi's,       Philips,      Sony WH,
                MacBook]      Prada,        Zara]
                              Psychology,
                              Rich Dad]
```

- **Writes:** When a product document changes, CouchDB updates only the leaf node containing that key. The rest of the tree is untouched.
- **Reads:** `?descending=true` walks the tree right-to-left. `?startkey="M"&endkey="N"` traverses only the relevant subtree.
- **`include_docs=true`:** The leaf nodes store `(key, value, doc_id)`. With `include_docs`, CouchDB does a second lookup per row to fetch the full document from the main database file. This is why emitting `null` as the value is efficient — the index stays small.

### 11.3 MVCC and the `_rev` Field

Every CouchDB document has a `_rev` field (e.g., `"3-a1b2c3d4"`). The format is `{generation}-{hash}`.

```
Document lifecycle:
  POST /db              → creates  _rev: "1-abc123"   (generation 1)
  PUT  /db/id?rev=1-abc → updates  _rev: "2-def456"   (generation 2)
  PUT  /db/id?rev=2-def → updates  _rev: "3-ghi789"   (generation 3)
  PUT  /db/id?rev=1-abc → REJECTED (409 Conflict — stale rev)
```

This is **optimistic concurrency control**:
- No locks are ever held
- Two clients can read the same document simultaneously
- The first to write succeeds; the second gets a 409 and must re-read + retry
- Old revisions are kept until compaction runs

**In NovaCart:** The admin form uses `POST` (auto-generates `_id`), so conflicts don't arise for creation. The `_bulk_docs` updates for category reassignment included each document's current `_rev` to prevent stale writes.

### 11.4 Mango vs MapReduce — When to Use Which

| Aspect | MapReduce Views | Mango Queries |
|---|---|---|
| **When to use** | Known query patterns, aggregations, complex transformations | Ad-hoc filtering, user-driven search, dynamic criteria |
| **Index definition** | JavaScript map/reduce functions in design docs | JSON field lists via `POST /_index` |
| **Query flexibility** | Fixed — the map function defines what's queryable | Dynamic — any combination of indexed fields |
| **Aggregation** | Yes — reduce functions can compute sums, averages, counts | No — Mango only filters and sorts |
| **Performance** | Pre-computed on write — reads are instant B-tree lookups | Computed on read — scans the index for matches |
| **Learning curve** | Higher — requires understanding map/reduce/rereduce | Lower — JSON selectors feel like MongoDB |

**In NovaCart:**
- **MapReduce** powers the analytics dashboard (category_stats, revenue_by_status, low_stock, bestsellers, on_sale) — these are known aggregation patterns that benefit from pre-computation.
- **Mango** powers the product search/filter — users combine category, subcategory, price range, rating, and text search in unpredictable ways. Mango handles this dynamic filtering naturally.

### 11.5 CouchDB HTTP API Patterns

CouchDB's API follows REST conventions with CouchDB-specific semantics:

| Operation | Method | URL Pattern | Body | Returns |
|---|---|---|---|---|
| Create database | PUT | `/db_name` | — | `{"ok": true}` |
| Create document (auto-ID) | POST | `/db_name` | JSON document | `{"ok": true, "id": "...", "rev": "1-..."}` |
| Create/update document | PUT | `/db_name/doc_id` | JSON document with `_rev` | `{"ok": true, "id": "...", "rev": "2-..."}` |
| Read document | GET | `/db_name/doc_id` | — | Full JSON document |
| Delete document | DELETE | `/db_name/doc_id?rev=...` | — | `{"ok": true}` (adds `_deleted: true`) |
| Bulk operations | POST | `/db_name/_bulk_docs` | `{"docs": [...]}` | Array of results |
| Query a view | GET | `/db_name/_design/ddoc/_view/name` | — | `{"rows": [...]}` |
| Mango query | POST | `/db_name/_find` | `{"selector": {...}}` | `{"docs": [...]}` |
| Create index | POST | `/db_name/_index` | `{"index": {"fields": [...]}}` | `{"result": "created"}` |
| Explain query | POST | `/db_name/_explain` | Same as `_find` | Query plan JSON |

**Key distinction:** `POST /db` auto-generates `_id`. `PUT /db/id` requires you to specify the ID. For updates, `PUT` requires the current `_rev` in the document body — this is how CouchDB enforces optimistic concurrency.

### 11.6 Lazy Indexing

CouchDB indexes (both MapReduce and Mango) are **not updated on every write**. Instead:

1. A document is written to the main database file immediately
2. The view indexes are **not updated** at write time
3. On the next **query** to that view, CouchDB checks which documents changed since the last index update
4. Only the changed documents are re-processed through the map function
5. The B-tree is updated incrementally (not rebuilt from scratch)

This means:
- Writes are fast (no index overhead at write time)
- The first query after many writes may be slow (catching up)
- Subsequent queries are fast (index is up to date)
- You can force an index update with `?stale=update_after` (return stale results, trigger background rebuild)

---

## 12. UI Fixes and Workarounds

### 12.1 Rupee Symbol (₹) Rendering Fix

PT Serif (the heading font) doesn't render the ₹ glyph correctly at 36px in the analytics overview stats. The fix is a DOM post-processing step after the analytics HTML is set:

```javascript
grid.querySelectorAll('.stat-number').forEach(el => {
  el.innerHTML = el.innerHTML.replace(/₹/g,
    '<span style="font-family:Lato,sans-serif">₹</span>');
});
```

This wraps each ₹ in a span that forces the body font (Lato), which has proper rupee glyph support. The rest of the number stays in PT Serif.

### 12.2 Category Dropdown Spacing Fix

The Products dropdown dynamically populates category links via `loadData()`. The links are `<a>` tags injected into `#dropdown-categories-list` — a plain `<div>` inside `.dropdown-col`. Since `.dropdown-col` has `display: flex; flex-direction: column; gap: 10px;` but that only applies to direct children, the nested div needed its own flex layout:

```css
#dropdown-categories-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
```

Without this, the inline `<a>` tags rendered as "BooksClothingElectronicsHome & Living" with no spacing.

---

## 13. Known Constraints

- **No server-side rendering**: Everything is client-side. CouchDB is accessed directly from the browser via REST API with Basic Auth. Not production-safe.
- **CORS**: CouchDB must have CORS enabled for `localhost:3000`. Amazon CDN images support CORS with `crossOrigin='anonymous'` + `no-referrer`. Some third-party image hosts block CORS entirely.
- **Image preloader blocks render**: Products only appear after all images are preloaded in batches of 3. Adds initial load time.
- **All data loaded at init**: The app fetches every product, category, and review on page load. Fine for ~30 documents, would need pagination for larger catalogs.
- **Single design document**: All 8 MapReduce views live in `_design/catalog`. Updating any view causes CouchDB to rebuild all of them (they share a B-tree group).
- **Mango `$regex` performance**: The `$regex` operator for name search cannot use a B-tree index efficiently — it falls back to scanning all documents that match the other selector fields. For large catalogs, a full-text search engine (like CouchDB's Lucene integration) would be better.
- **No `validate_doc_update`**: There is no server-side validation. Any well-formed JSON document can be inserted. A production system would add a validation function to the design document to enforce required fields, data types, and business rules.
