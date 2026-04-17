# NovaCart - E-Commerce Product Catalog

## Project Overview

NovaCart is a CouchDB-powered e-commerce product catalog demonstrating NoSQL document database capabilities. It is styled after [evervessel.com](https://evervessel.com/) with a clean, minimal aesthetic (no border-radius). All prices are in INR. Products include luxury brands (Michael Kors, Chanel, Prada, Gucci, Nike, Levi's) alongside electronics, books, and home essentials.

**Stack:** HTML5 + CSS3 + Vanilla JS (no frameworks) | CouchDB (localhost:5984) | `npx http-server` (port 3000)

## File Structure

```
NGD/
  index.html        # Main page - hero, carousel, grids, modals, admin form, analytics
  styles.css         # Full design system - variables, responsive, animations
  app.js             # All logic - CouchDB API, rendering, cart, analytics, image handling
  .claude/
    launch.json      # Dev server config (npx http-server . -p 3000 -c-1)
    settings.local.json
```

## CouchDB Setup

- **Database:** `ecommerce_catalog` at `http://127.0.0.1:5984`
- **Auth:** Basic Auth (`admin:admin`)
- **Document types:** `product`, `category`, `review`, `order`
- **Design doc:** `_design/catalog` with views:
  - `all_products` / `all_categories` / `reviews_by_product`
  - `category_stats` (group=true) / `revenue_by_status` (group=true)
  - `low_stock_products` / `bestsellers` / `products_on_sale`

All API calls go through `couchFetch(path, options)` helper which adds auth headers.

## Running

```bash
npx http-server . -p 3000 -c-1
```

Or via Claude Preview: server name is `dev` in `.claude/launch.json`.

CouchDB must be running on port 5984 with the `ecommerce_catalog` database populated.

## Architecture & Key Patterns

### Image Handling

**Amazon hotlink workaround:** All images use `referrerpolicy="no-referrer"` on `<img>` tags plus `<meta name="referrer" content="no-referrer">` in the HTML head. This prevents Amazon CDN from blocking images loaded from localhost.

**Sequential preloader (app.js top):**
- `imageCache` Map stores successfully loaded URLs
- `preloadAllImages()` loads 3 images at a time (batched `Promise.all`)
- Each image gets one retry after 500ms on failure
- All preloading completes BEFORE DOM renders product cards

**Image URLs:** Most images are from `m.media-amazon.com`. Some from Apple Newsroom, Sony Scene7, Shopify CDNs, Gucci/Chanel official sites. Use raw `.jpg` URLs (no size suffixes like `_AC_SL1500_` which get blocked).

### Modal Image Background System

When a product card is clicked, `openProductModal(id)` renders a two-column modal: image left, details right.

**Three-tier detection determines the image background:**

1. **PNG detection** (URL-based): If image URL contains `.png`, the modal gets class `modal-image` only (no special class). Default white background, no blur.

2. **White-bg JPEG detection** (canvas-based): For non-PNG images, an async canvas analysis runs after modal opens:
   - Creates a new `Image` with `crossOrigin='anonymous'` + `referrerPolicy='no-referrer'`
   - Draws to offscreen canvas, samples 6 corner/edge pixels
   - If 4+ spots have RGB all > 235 -> adds class `white-bg`, removes `jpeg-bg`
   - Result: white background, blur div hidden

3. **Dark/colored JPEG** (fallback): Non-PNG images that fail the white-bg check keep class `jpeg-bg`. The `.modal-image-bg` div (same image, blurred + darkened) shows behind the product image.

**CSS layering:**
```
.modal-image           -> background: #fff (default for PNG + white-bg)
.modal-image-bg        -> display: none by default; display: block for .jpeg-bg
                          filter: blur(50px) brightness(0.5), inset: -40px, z-index: 0
.modal-image img       -> object-fit: contain, z-index: 1
.modal-details         -> background: #ededed (darker than white to contrast with image)
```

### Product Card Image Backgrounds

In the product grid/carousel, non-PNG product cards get `style="background:transparent"` to remove the default `var(--bg-light)` grey box. PNG products keep the light grey background.

```javascript
// In createProductCard():
<div class="product-card-image"${p.image && !p.image.match(/\.png/i) ? ' style="background:transparent"' : ''}>
```

### Cart System

- Stored in `localStorage` as `novacart_cart`
- Array of `{ id, name, price, image, qty }`
- Cart count badge updates in header
- Slide-in sidebar from right (`transform: translateX`)

### Page Navigation

Three "pages" toggled via `display: none` on sections:
- **Home:** Hero + carousel + text-image splits + categories + reviews + admin + newsletter
- **All Products:** Filtered/sorted grid with category dropdown
- **Analytics:** CouchDB stats dashboard with charts and tables

### Analytics Dashboard

Fetches 5 CouchDB MapReduce views in parallel:
- Category stats (count, avg price, avg rating, total stock)
- Revenue by order status
- Low stock alerts (< 30 units)
- Top-rated bestsellers
- Products on sale with discount %

## CSS Design System

```css
--brand: #2D3347        /* Dark blue-gray - buttons, headings */
--accent: #C45A34       /* Rust/terracotta - sale badges, CTAs */
--text: #2B2E2E         /* Body text */
--text-light: #6C6C6C   /* Secondary text */
--bg: #FFFFFF            /* Main background */
--bg-light: #F8F8F8     /* Section backgrounds */
--border: #EEEEEE       /* Dividers */
--radius: 0px            /* No border-radius - clean minimal look */
--font-heading: 'PT Serif', serif
--font-body: 'Lato', sans-serif
```

**Responsive breakpoints:** 1024px (tablet), 768px (mobile), 480px (small mobile)

**Key animations:**
- Promo bar: `gradientSlide` 6s infinite horizontal shift
- Product cards: `translateY(-4px)` hover lift
- Card images: `scale(1.05)` hover zoom
- Category images: `scale(1.08)` hover zoom
- Cart sidebar: `translateX` slide-in 0.3s
- Carousel: `scrollBy` smooth behavior

## Products in Catalog

**Electronics:** iPhone 16 Pro, Samsung Galaxy S24 Ultra, Sony WH-1000XM5, MacBook Pro 14 M4, iPad Air M2, Sony Alpha A7 IV, AirPods Pro 2, Dyson V15, Philips Hue, Nespresso Vertuo Plus

**Fashion:** Michael Kors Jet Set Tote, Prada Re-Nylon Backpack, Chanel No. 5, Gucci GG Marmont Belt, Nike Air Jordan 1 Retro High, Levi's 501, Zara Leather Jacket

**Books:** The Midnight Library, Atomic Habits, Sapiens, Psychology of Money, Ikigai, Rich Dad Poor Dad

**Home & Living:** Le Creuset Dutch Oven

## Known Constraints

- **CORS on canvas:** Amazon CDN images support CORS with `crossOrigin='anonymous'` + `no-referrer`. If a CDN blocks CORS, the white-bg canvas detection silently fails (try/catch), and the image falls back to `jpeg-bg` blur treatment.
- **PNG detection is URL-based:** Checks for `.png` in the URL string. URLs with `fmt=png-alpha` (Sony Scene7) or `.png?v=` query params also match. This is intentional.
- **No server-side rendering:** Everything is client-side. CouchDB is accessed directly from the browser via REST API with Basic Auth (development only, not production-safe).
- **Image preloader blocks render:** Products only appear after all images are preloaded in batches of 3. This prevents broken image flicker but adds initial load time.
