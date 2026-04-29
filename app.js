/* ============================================
   NovaCart — CouchDB E-Commerce Frontend
   ============================================ */

// CouchDB URL — auto-detect localhost vs tunnel
const IS_LOCAL = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
let COUCH_BASE, DB_URL;
if (IS_LOCAL) {
  COUCH_BASE = 'http://127.0.0.1:5984';
} else {
  COUCH_BASE = localStorage.getItem('couchdb_tunnel') || '';
  if (!COUCH_BASE) {
    // Auto-prompt for CouchDB tunnel URL on first remote access
    const url = prompt('Enter the CouchDB Cloudflare tunnel URL\n(e.g. https://xxx.trycloudflare.com):');
    if (url && url.trim()) {
      COUCH_BASE = url.trim().replace(/\/+$/, '');
      localStorage.setItem('couchdb_tunnel', COUCH_BASE);
    } else {
      COUCH_BASE = 'http://127.0.0.1:5984'; // fallback (won't work remotely)
    }
  }
}
DB_URL = COUCH_BASE + '/ecommerce_catalog';
const AUTH = 'Basic ' + btoa('admin:admin');

// State
let allProducts = [];
let allCategories = [];
let allReviews = [];
let cart = [];
try { cart = JSON.parse(localStorage.getItem('novacart_cart') || '[]'); } catch (e) { cart = []; }

// --- Query Log (shared via CouchDB) ---
const queryLog = [];       // local cache for current session
let activeDevTab = 'live';
let devPollInterval = null;
let devAutoScroll = true;
let devLastTs = 0;         // latest ts from last successful poll
let devNewCount = 0;
let devConnected = false;

// --- INR Formatter ---
function formatINR(num) {
  return Number(num).toLocaleString('en-IN');
}

// --- CouchDB API Helper ---
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

  // Log the query
  logQuery(method, path, options.body ? JSON.parse(options.body) : null, res.status, duration);

  return data;
}

// --- Image Preloader (sequential with cache) ---
const imageCache = new Map();

async function preloadImage(url) {
  if (!url || imageCache.has(url)) return;
  return new Promise((resolve) => {
    const img = new Image();
    img.referrerPolicy = 'no-referrer';
    img.onload = () => { imageCache.set(url, true); resolve(); };
    img.onerror = () => {
      // Retry once
      const retry = new Image();
      retry.referrerPolicy = 'no-referrer';
      retry.onload = () => { imageCache.set(url, true); resolve(); };
      retry.onerror = () => resolve();
      setTimeout(() => { retry.src = url; }, 500);
    };
    img.src = url;
  });
}

async function preloadAllImages(products) {
  // Load 3 at a time to avoid overwhelming the browser
  for (let i = 0; i < products.length; i += 3) {
    const batch = products.slice(i, i + 3);
    await Promise.all(batch.map(p => preloadImage(p.image)));
  }
}

// --- Init ---
document.addEventListener('DOMContentLoaded', async () => {
  updateCartCount();
  setupDropdowns();
  await loadData();
  // Preload all product images sequentially before rendering
  await preloadAllImages(allProducts);
  renderFeaturedProducts();
  renderCategories();
  renderReviews();
});

// --- Load All Data ---
async function loadData() {
  try {
    // Fetch all products
    const productsRes = await couchFetch('/_design/catalog/_view/all_products?include_docs=true');
    allProducts = productsRes.rows.map(r => r.doc);

    // Fetch all categories
    const catsRes = await couchFetch('/_design/catalog/_view/all_categories?include_docs=true');
    allCategories = catsRes.rows.map(r => r.doc);

    // Fetch all reviews
    const reviewsRes = await couchFetch('/_design/catalog/_view/reviews_by_product?include_docs=true');
    allReviews = reviewsRes.rows.map(r => r.doc);

    // Populate dropdown categories
    const catList = document.getElementById('dropdown-categories-list');
    catList.innerHTML = allCategories.map(c =>
      `<a href="#" onclick="filterByCategory('${c.name}'); closeDropdowns()">${c.name}</a>`
    ).join('');

    // Categories dropdown
    const catDropdown = document.getElementById('categories-dropdown-content');
    catDropdown.innerHTML = allCategories.map(c => `
      <div class="dropdown-col">
        <h4>${c.name}</h4>
        ${c.subcategories.map(s => `<a href="#" onclick="filterBySubcategory('${c.name}','${s}'); closeDropdowns()">${s}</a>`).join('')}
      </div>
    `).join('');

    // Create Mango indexes (non-blocking)
    ensureMangoIndexes().catch(() => {});
  } catch (err) {
    console.error('Failed to load data:', err);
    const hero = document.getElementById('hero-section');
    if (hero) {
      const banner = document.createElement('div');
      banner.style.cssText = 'background:#fee2e2;color:#991b1b;padding:16px 24px;text-align:center;font-size:14px;border-bottom:1px solid #fca5a5;';
      banner.textContent = 'Unable to connect to CouchDB. Please ensure the database is running on localhost:5984.';
      hero.parentElement.insertBefore(banner, hero);
    }
  }
}

// --- Dropdowns ---
function setupDropdowns() {
  const prodBtn = document.getElementById('nav-products-btn');
  const catBtn = document.getElementById('nav-categories-btn');
  const prodDrop = document.getElementById('dropdown-products');
  const catDrop = document.getElementById('dropdown-categories');

  prodBtn.addEventListener('click', () => {
    const isOpen = prodDrop.classList.contains('open');
    closeDropdowns();
    if (!isOpen) { prodDrop.classList.add('open'); prodBtn.classList.add('active'); }
  });

  catBtn.addEventListener('click', () => {
    const isOpen = catDrop.classList.contains('open');
    closeDropdowns();
    if (!isOpen) { catDrop.classList.add('open'); catBtn.classList.add('active'); }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.header')) closeDropdowns();
  });
}

function closeDropdowns() {
  document.querySelectorAll('.dropdown-menu').forEach(d => d.classList.remove('open'));
  document.querySelectorAll('.nav-link').forEach(n => n.classList.remove('active'));
}

// --- Render Featured Products ---
function renderFeaturedProducts() {
  const carousel = document.getElementById('product-carousel');
  const featured = allProducts.filter(p => p.tags && (p.tags.includes('bestseller') || p.tags.includes('featured')));
  const products = featured.length ? featured : allProducts.slice(0, 8);

  carousel.innerHTML = products.map(p => createProductCard(p)).join('');
}

function createProductCard(p) {
  const hasDiscount = p.original_price && p.original_price > p.price;
  const discount = hasDiscount ? Math.round((1 - p.price / p.original_price) * 100) : 0;
  const badge = p.tags?.includes('new') ? '<span class="product-badge">New</span>' :
                hasDiscount ? `<span class="product-badge sale">-${discount}%</span>` : '';

  return `
    <div class="product-card" onclick="openProductModal('${p._id}')">
      <div class="product-card-image" style="background:transparent">
        <img src="${p.image || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=400'}" alt="${p.name}" loading="lazy" referrerpolicy="no-referrer">
        ${badge}
      </div>
      <div class="product-card-info">
        <div class="product-card-name">${p.name}</div>
        <div class="product-card-price">
          ₹${formatINR(p.price)}
          ${hasDiscount ? `<span class="original-price">₹${formatINR(p.original_price)}</span>` : ''}
        </div>
        <div class="product-card-meta">${p.category} · ★ ${p.rating}</div>
      </div>
    </div>
  `;
}

// --- Carousel Scroll ---
function scrollCarousel(dir) {
  const carousel = document.getElementById('product-carousel');
  carousel.scrollBy({ left: dir * 320, behavior: 'smooth' });
}

function scrollReviewCarousel(dir) {
  const carousel = document.getElementById('review-carousel');
  carousel.scrollBy({ left: dir * 350, behavior: 'smooth' });
}

// --- Render Categories ---
function renderCategories() {
  const grid = document.getElementById('categories-grid');
  const productCounts = {};
  allProducts.forEach(p => { productCounts[p.category] = (productCounts[p.category] || 0) + 1; });

  grid.innerHTML = allCategories.map(c => `
    <div class="category-card" onclick="filterByCategory('${c.name}')">
      <img src="${c.image || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600'}" alt="${c.name}" loading="lazy" referrerpolicy="no-referrer">
      <div class="category-card-overlay">
        <div class="category-card-name">${c.name}</div>
        <div class="category-card-count">${productCounts[c.name] || 0} Products</div>
      </div>
    </div>
  `).join('');
}

// --- Render Reviews ---
function renderReviews() {
  const carousel = document.getElementById('review-carousel');
  const summary = document.getElementById('reviews-rating-summary');

  if (allReviews.length) {
    const avgRating = (allReviews.reduce((s, r) => s + r.rating, 0) / allReviews.length).toFixed(2);
    summary.innerHTML = `<strong>${avgRating}</strong>/5 — Based on ${allReviews.length} reviews`;
  }

  carousel.innerHTML = allReviews.map(r => `
    <div class="review-card">
      <div class="review-stars">${'★'.repeat(r.rating)}${'☆'.repeat(5 - r.rating)}</div>
      <div class="review-title">${r.title}</div>
      <div class="review-body">${r.comment}</div>
      <div class="review-author">
        <div class="review-avatar">👤</div>
        <div>
          <div style="font-weight:600;color:var(--text)">${r.user_name}</div>
          <div>${new Date(r.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</div>
        </div>
      </div>
      ${r.verified ? '<div class="review-verified">✓ Verified Purchase</div>' : ''}
    </div>
  `).join('');
}

// --- Product Modal ---
function openProductModal(id) {
  const p = allProducts.find(pr => pr._id === id);
  if (!p) return;

  const hasDiscount = p.original_price && p.original_price > p.price;
  const discount = hasDiscount ? Math.round((1 - p.price / p.original_price) * 100) : 0;
  const productReviews = allReviews.filter(r => r.product_id === p._id);

  const specsHtml = p.specs ? Object.entries(p.specs).map(([k, v]) =>
    `<div class="spec-row"><span>${k.replace(/_/g, ' ')}</span><span>${v}</span></div>`
  ).join('') : '';

  const isPng = p.image && /\.png/i.test(p.image);
  document.getElementById('modal-body').innerHTML = `
    <div class="modal-image${!isPng ? ' jpeg-bg' : ''}">
      <div class="modal-image-bg" style="background-image: url('${p.image}')"></div>
      <img src="${p.image}" alt="${p.name}" referrerpolicy="no-referrer">
    </div>
    <div class="modal-details">
      <div class="modal-category">${p.category} / ${p.subcategory}</div>
      <div class="modal-name">${p.name}</div>
      <div class="modal-price">
        ₹${formatINR(p.price)}
        ${hasDiscount ? `<span class="original-price">₹${formatINR(p.original_price)}</span><span class="discount-badge">-${discount}%</span>` : ''}
      </div>
      <div class="modal-rating">
        <span class="stars">${'★'.repeat(Math.round(p.rating))}${'☆'.repeat(5 - Math.round(p.rating))}</span>
        ${p.rating} (${p.reviews_count} reviews)
      </div>
      <div class="modal-desc">${p.description}</div>
      ${specsHtml ? `
        <div class="modal-specs">
          <h4>Specifications</h4>
          ${specsHtml}
        </div>
      ` : ''}
      <div class="modal-stock ${p.stock < 30 ? 'low' : ''}">
        ${p.stock < 30 ? `Only ${p.stock} left in stock!` : `In Stock (${p.stock} available)`}
      </div>
      <div class="modal-actions">
        <button class="btn-primary" onclick="addToCart('${p._id}')">Add to Cart</button>
        <button class="btn-secondary" onclick="closeModal()">Continue Shopping</button>
        <button class="btn-delete" onclick="deleteProduct('${p._id}')" title="Delete this product from CouchDB">🗑 Delete</button>
      </div>
    </div>
  `;

  document.getElementById('product-modal').classList.add('open');
  document.body.style.overflow = 'hidden';

  // Known cover-color overrides (for images where CORS blocks canvas sampling)
  const coverColors = {
    'The Psychology of Money': 'rgb(108,140,112)',
    'Ikigai by Hector Garcia': 'linear-gradient(to bottom, rgb(166,212,225), rgb(255,255,255))'
  };
  if (!isPng && coverColors[p.name]) {
    const el = document.querySelector('.modal-image');
    if (el) {
      el.classList.remove('jpeg-bg');
      el.style.background = coverColors[p.name];
    }
  }
  // Canvas corner sampling for other non-PNG images
  else if (!isPng && p.image) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.referrerPolicy = 'no-referrer';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const w = img.naturalWidth, h = img.naturalHeight;
        const px = (x, y) => ctx.getImageData(x, y, 1, 1).data;
        const avg = (...samples) => samples[0].map((_, i) =>
          Math.round(samples.reduce((s, d) => s + d[i], 0) / samples.length)
        );
        const top = avg(px(2, 2), px(w - 3, 2), px(Math.floor(w / 2), 2));
        const bot = avg(px(2, h - 3), px(w - 3, h - 3), px(Math.floor(w / 2), h - 3));
        const isWhite = ([r, g, b]) => r > 235 && g > 235 && b > 235;
        const el = document.querySelector('.modal-image');
        if (!el) return;
        if (isWhite(top) && isWhite(bot)) {
          el.classList.add('white-bg');
          el.classList.remove('jpeg-bg');
        } else {
          el.classList.remove('jpeg-bg');
          const tc = `rgb(${top[0]},${top[1]},${top[2]})`;
          const bc = `rgb(${bot[0]},${bot[1]},${bot[2]})`;
          el.style.background = tc === bc ? tc : `linear-gradient(to bottom, ${tc}, ${bc})`;
        }
      } catch(e) {}
    };
    img.src = p.image;
  }
}

function closeModal() {
  document.getElementById('product-modal').classList.remove('open');
  document.body.style.overflow = '';
}

// --- Cart ---
function addToCart(productId) {
  const p = allProducts.find(pr => pr._id === productId);
  if (!p) return;

  const existing = cart.find(item => item.id === productId);
  if (existing) {
    existing.qty += 1;
  } else {
    cart.push({ id: productId, name: p.name, price: p.price, image: p.image, qty: 1 });
  }
  localStorage.setItem('novacart_cart', JSON.stringify(cart));
  updateCartCount();
  closeModal();
  showCart();
}

// --- Delete Product from CouchDB ---
async function deleteProduct(productId) {
  const p = allProducts.find(pr => pr._id === productId);
  if (!p) return;
  if (!confirm(`Delete "${p.name}" permanently from the database?`)) return;

  try {
    // Step 1: GET the document to fetch its latest _rev (CouchDB requires _rev for deletion)
    const doc = await couchFetch(`/${productId}`);

    // Step 2: DELETE the document using _rev for optimistic concurrency control
    await couchFetch(`/${productId}?rev=${doc._rev}`, { method: 'DELETE' });

    // Remove from local arrays
    allProducts = allProducts.filter(pr => pr._id !== productId);
    cart = cart.filter(item => item.id !== productId);
    localStorage.setItem('novacart_cart', JSON.stringify(cart));
    updateCartCount();

    closeModal();
    renderFeaturedProducts();
    renderCategories();

    // If on All Products page, re-render
    if (document.getElementById('all-products-page').style.display !== 'none') {
      applyMangoFilters();
    }
  } catch (err) {
    alert('Delete failed: ' + err.message);
  }
}

function removeFromCart(productId) {
  cart = cart.filter(item => item.id !== productId);
  localStorage.setItem('novacart_cart', JSON.stringify(cart));
  updateCartCount();
  renderCart();
}

function updateCartCount() {
  const count = cart.reduce((s, item) => s + item.qty, 0);
  document.getElementById('cart-count').textContent = count;
}

function showCart() {
  renderCart();
  document.getElementById('cart-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCart() {
  document.getElementById('cart-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

function renderCart() {
  const itemsEl = document.getElementById('cart-items');
  const footerEl = document.getElementById('cart-footer');

  if (cart.length === 0) {
    itemsEl.innerHTML = '<div class="cart-empty">Your cart is empty</div>';
    footerEl.innerHTML = '';
    return;
  }

  itemsEl.innerHTML = cart.map(item => `
    <div class="cart-item">
      <img class="cart-item-img" src="${item.image}" alt="${item.name}" referrerpolicy="no-referrer">
      <div class="cart-item-info">
        <div class="cart-item-name">${item.name}</div>
        <div class="cart-item-price">₹${formatINR(item.price)} × ${item.qty}</div>
        <span class="cart-item-remove" onclick="removeFromCart('${item.id}')">Remove</span>
      </div>
    </div>
  `).join('');

  const total = cart.reduce((s, item) => s + item.price * item.qty, 0);
  footerEl.innerHTML = `
    <div class="cart-total">
      <span>Total</span>
      <span>₹${formatINR(total)}</span>
    </div>
    <button class="btn-primary" style="width:100%" onclick="openCheckout()">Checkout</button>
  `;
}

// --- Checkout ---

function openCheckout() {
  if (cart.length === 0) return;
  closeCart();
  renderCheckoutSummary();
  document.getElementById('checkout-status').textContent = '';
  document.getElementById('checkout-status').className = 'checkout-status';
  document.getElementById('checkout-overlay').classList.add('open');
  document.body.style.overflow = 'hidden';
}

function closeCheckout() {
  document.getElementById('checkout-overlay').classList.remove('open');
  document.body.style.overflow = '';
}

function renderCheckoutSummary() {
  const summaryEl = document.getElementById('checkout-summary');
  const subtotal = cart.reduce((s, item) => s + item.price * item.qty, 0);
  const shipping = subtotal >= 4999 ? 0 : 99;
  const total = subtotal + shipping;

  const itemsHtml = cart.map(item => `
    <div class="checkout-summary-row">
      <span>${item.name} × ${item.qty}</span>
      <span>₹${formatINR(item.price * item.qty)}</span>
    </div>
  `).join('');

  summaryEl.innerHTML = `
    <div class="checkout-section-title">Order Summary</div>
    ${itemsHtml}
    <div class="checkout-summary-divider"></div>
    <div class="checkout-summary-row">
      <span>Subtotal</span>
      <span>₹${formatINR(subtotal)}</span>
    </div>
    <div class="checkout-summary-row">
      <span>Shipping</span>
      <span>${shipping === 0 ? 'FREE' : '₹' + formatINR(shipping)}</span>
    </div>
    <div class="checkout-summary-divider"></div>
    <div class="checkout-summary-total">
      <span>Total</span>
      <span>₹${formatINR(total)}</span>
    </div>
  `;
}

function formatCardNumber(input) {
  let v = input.value.replace(/\D/g, '').slice(0, 16);
  input.value = v.replace(/(\d{4})(?=\d)/g, '$1 ');
}

function formatExpiry(input) {
  let v = input.value.replace(/\D/g, '').slice(0, 4);
  if (v.length >= 3) v = v.slice(0, 2) + '/' + v.slice(2);
  input.value = v;
}

async function submitOrder(event) {
  event.preventDefault();

  const submitBtn = document.getElementById('checkout-submit');
  const statusEl = document.getElementById('checkout-status');

  submitBtn.disabled = true;
  submitBtn.textContent = 'Placing Order...';
  statusEl.textContent = '';
  statusEl.className = 'checkout-status';

  const subtotal = cart.reduce((s, item) => s + item.price * item.qty, 0);
  const shipping = subtotal >= 4999 ? 0 : 99;
  const total = subtotal + shipping;

  const order = {
    _id: 'order:' + Date.now(),
    type: 'order',
    user_name: document.getElementById('ck-name').value.trim(),
    user_email: document.getElementById('ck-email').value.trim(),
    user_phone: document.getElementById('ck-phone').value.trim(),
    items: cart.map(item => ({
      product_id: item.id,
      name: item.name,
      quantity: item.qty,
      price: item.price
    })),
    subtotal,
    shipping_cost: shipping,
    total,
    status: 'pending',
    payment_method: 'Credit Card',
    shipping_address: [
      document.getElementById('ck-address').value.trim(),
      document.getElementById('ck-city').value.trim(),
      document.getElementById('ck-pincode').value.trim()
    ].filter(Boolean).join(', '),
    ordered_at: new Date().toISOString(),
    currency: 'INR'
  };

  try {
    const res = await couchFetch('', { method: 'POST', body: JSON.stringify(order) });
    if (!res.ok) throw new Error(res.reason || 'Failed to save order');

    // Clear cart
    cart = [];
    localStorage.setItem('novacart_cart', JSON.stringify(cart));
    updateCartCount();

    // Show success state
    const body = document.getElementById('checkout-body');
    body.innerHTML = `
      <div class="checkout-success">
        <div class="checkout-success-icon">✓</div>
        <h4>Order Placed Successfully</h4>
        <p>Thank you, ${order.user_name.split(' ')[0]}. Your order is confirmed.</p>
        <p>A confirmation has been sent to <strong>${order.user_email}</strong>.</p>
        <div class="order-id">${order._id}</div>
        <p style="margin-top:24px;">
          <button class="btn-primary" onclick="closeCheckout(); showHome();">Continue Shopping</button>
        </p>
      </div>
    `;
  } catch (err) {
    statusEl.textContent = 'Could not place order: ' + err.message;
    statusEl.className = 'checkout-status error';
    submitBtn.disabled = false;
    submitBtn.textContent = 'Place Order';
  }
}

// --- Page Navigation ---
function showHome() {
  document.getElementById('all-products-page').style.display = 'none';
  document.getElementById('analytics-page').style.display = 'none';
  document.getElementById('hero-section').style.display = '';
  document.getElementById('featured-section').style.display = '';
  document.querySelectorAll('.text-image-split, .categories-section, .reviews-section, .admin-section, .newsletter-section').forEach(el => el.style.display = '');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function showAllProducts() {
  document.getElementById('hero-section').style.display = 'none';
  document.getElementById('featured-section').style.display = 'none';
  document.querySelectorAll('.text-image-split, .categories-section, .reviews-section, .admin-section, .newsletter-section').forEach(el => el.style.display = 'none');
  document.getElementById('analytics-page').style.display = 'none';
  document.getElementById('all-products-page').style.display = '';
  document.getElementById('products-page-label').textContent = 'ALL PRODUCTS';
  document.getElementById('products-page-heading').textContent = 'Our Collection';
  document.getElementById('filter-category').value = '';
  document.getElementById('filter-subcategory').innerHTML = '<option value="">All Subcategories</option>';
  document.getElementById('filter-sort').value = 'name';
  document.getElementById('mango-results-info').style.display = 'none';
  const mangoPanel = document.getElementById('mango-filter-panel');
  if (mangoPanel) mangoPanel.style.display = 'none';
  const toggleBtn = document.querySelector('.filter-toggle-btn');
  if (toggleBtn) toggleBtn.classList.remove('active');
  applyMangoFilters();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function filterByCategory(category) {
  showAllProducts();
  document.getElementById('filter-category').value = category;
  document.getElementById('products-page-label').textContent = category.toUpperCase();
  document.getElementById('products-page-heading').textContent = category;
  updateSubcategoryOptions();
  applyMangoFilters();
}

function filterBySubcategory(category, subcategory) {
  showAllProducts();
  document.getElementById('products-page-label').textContent = `${category} / ${subcategory}`.toUpperCase();
  document.getElementById('products-page-heading').textContent = subcategory;
  document.getElementById('filter-category').value = category;
  updateSubcategoryOptions();
  document.getElementById('filter-subcategory').value = subcategory;
  applyMangoFilters();
}

function filterProducts(type) {
  showAllProducts();
  let filtered;
  if (type === 'bestseller') {
    document.getElementById('products-page-label').textContent = 'CURATED';
    document.getElementById('products-page-heading').textContent = 'Bestsellers';
    filtered = allProducts.filter(p => p.tags?.includes('bestseller'));
  } else if (type === 'new') {
    document.getElementById('products-page-label').textContent = 'LATEST';
    document.getElementById('products-page-heading').textContent = 'New Arrivals';
    filtered = allProducts.filter(p => p.tags?.includes('new'));
  } else if (type === 'sale') {
    document.getElementById('products-page-label').textContent = 'SAVINGS';
    document.getElementById('products-page-heading').textContent = 'On Sale';
    filtered = allProducts.filter(p => p.original_price && p.original_price > p.price);
  }
  renderProductsGrid(filtered || allProducts);
}

function applyFilters() {
  applyMangoFilters();
}

function renderProductsGrid(products) {
  const grid = document.getElementById('products-grid');
  grid.innerHTML = products.length ?
    products.map(p => createProductCard(p)).join('') :
    '<p style="grid-column:1/-1;text-align:center;color:var(--text-light);padding:60px 0;">No products found.</p>';
}

// --- Analytics ---
async function showAnalytics() {
  document.getElementById('hero-section').style.display = 'none';
  document.getElementById('featured-section').style.display = 'none';
  document.querySelectorAll('.text-image-split, .categories-section, .reviews-section, .admin-section, .newsletter-section').forEach(el => el.style.display = 'none');
  document.getElementById('all-products-page').style.display = 'none';
  document.getElementById('analytics-page').style.display = '';
  window.scrollTo({ top: 0, behavior: 'smooth' });

  const grid = document.getElementById('analytics-grid');
  grid.innerHTML = '<p style="text-align:center;grid-column:1/-1;padding:40px;color:var(--text-light)">Loading analytics from CouchDB...</p>';

  try {
    // Sequential — so each query appears one-by-one in the Dev log
    const catStats = await couchFetch('/_design/catalog/_view/category_stats?group=true');
    const revenue = await couchFetch('/_design/catalog/_view/revenue_by_status?group=true');
    const lowStock = await couchFetch('/_design/catalog/_view/low_stock_products');
    const bestsellers = await couchFetch('/_design/catalog/_view/bestsellers?descending=true');
    const onSale = await couchFetch('/_design/catalog/_view/products_on_sale?descending=true');

    const totalProducts = allProducts.length;
    const totalCategories = allCategories.length;
    const totalReviews = allReviews.length;
    const totalRevenue = revenue.rows.reduce((s, r) => s + r.value.sum, 0);

    // Find max product count for bar scaling
    const maxCount = Math.max(...catStats.rows.map(r => r.value.count));

    grid.innerHTML = `
      <!-- Overview Stats -->
      <div class="analytics-card" style="grid-column: 1 / -1;">
        <h3>Overview</h3>
        <div class="stat-row">
          <div><div class="stat-number">${totalProducts}</div><div class="stat-label">Products</div></div>
          <div><div class="stat-number">${totalCategories}</div><div class="stat-label">Categories</div></div>
          <div><div class="stat-number">${totalReviews}</div><div class="stat-label">Reviews</div></div>
          <div><div class="stat-number">₹${formatINR(totalRevenue)}</div><div class="stat-label">Total Revenue</div></div>
        </div>
      </div>

      <!-- Category Stats -->
      <div class="analytics-card">
        <h3>Products by Category</h3>
        <div class="bar-chart">
          ${catStats.rows.map(r => `
            <div class="bar-row">
              <div class="bar-label">${r.key}</div>
              <div class="bar-track">
                <div class="bar-fill" style="width: ${(r.value.count / maxCount * 100)}%">${r.value.count}</div>
              </div>
            </div>
          `).join('')}
        </div>
        <table style="margin-top:24px">
          <thead><tr><th>Category</th><th>Avg Price</th><th>Avg Rating</th><th>Stock</th></tr></thead>
          <tbody>
            ${catStats.rows.map(r => `
              <tr>
                <td><strong>${r.key}</strong></td>
                <td>₹${formatINR(Math.round(r.value.avg_price))}</td>
                <td>★ ${r.value.avg_rating.toFixed(2)}</td>
                <td>${r.value.total_stock}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Revenue by Order Status -->
      <div class="analytics-card">
        <h3>Revenue by Order Status</h3>
        <div class="bar-chart" style="margin-bottom:24px">
          ${revenue.rows.map((r, i) => `
            <div class="bar-row">
              <div class="bar-label" style="text-transform:capitalize">${r.key}</div>
              <div class="bar-track">
                <div class="bar-fill ${i % 2 ? 'accent' : ''}" style="width: ${(r.value.sum / totalRevenue * 100)}%">₹${formatINR(r.value.sum)}</div>
              </div>
            </div>
          `).join('')}
        </div>
        <table>
          <thead><tr><th>Status</th><th>Orders</th><th>Total</th><th>Average</th></tr></thead>
          <tbody>
            ${revenue.rows.map(r => `
              <tr>
                <td style="text-transform:capitalize"><strong>${r.key}</strong></td>
                <td>${r.value.count}</td>
                <td>₹${formatINR(r.value.sum)}</td>
                <td>₹${formatINR(Math.round(r.value.sum / r.value.count))}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- Low Stock Alert -->
      <div class="analytics-card">
        <h3>Low Stock Alert (&lt;30)</h3>
        ${lowStock.rows.length ? `
          <table>
            <thead><tr><th>Product</th><th>Category</th><th>Stock</th><th>Price</th></tr></thead>
            <tbody>
              ${lowStock.rows.map(r => `
                <tr>
                  <td><strong>${r.value.name}</strong></td>
                  <td>${r.value.category}</td>
                  <td style="color:var(--accent);font-weight:700">${r.key}</td>
                  <td>₹${formatINR(r.value.price)}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        ` : '<p style="color:var(--text-light)">All products well stocked!</p>'}
      </div>

      <!-- Bestsellers -->
      <div class="analytics-card">
        <h3>Top Rated Bestsellers</h3>
        <table>
          <thead><tr><th>Product</th><th>Category</th><th>Rating</th><th>Reviews</th></tr></thead>
          <tbody>
            ${bestsellers.rows.map(r => `
              <tr>
                <td><strong>${r.value.name}</strong></td>
                <td>${r.value.category}</td>
                <td>★ ${r.value.rating}</td>
                <td>${r.key}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      <!-- On Sale -->
      <div class="analytics-card">
        <h3>Products on Sale</h3>
        <table>
          <thead><tr><th>Product</th><th>Price</th><th>Was</th><th>Discount</th></tr></thead>
          <tbody>
            ${onSale.rows.map(r => `
              <tr>
                <td><strong>${r.value.name}</strong></td>
                <td>₹${formatINR(r.value.price)}</td>
                <td style="text-decoration:line-through;color:var(--text-light)">₹${formatINR(r.value.original_price)}</td>
                <td style="color:var(--accent);font-weight:700">-${r.key}%</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;

    // DOM fix: PT Serif doesn't render ₹ correctly at large sizes
    grid.querySelectorAll('.stat-number').forEach(el => {
      el.innerHTML = el.innerHTML.replace(/₹/g, '<span style="font-family:Lato,sans-serif">₹</span>');
    });
  } catch (err) {
    grid.innerHTML = `<p style="color:var(--error);grid-column:1/-1;text-align:center;padding:40px">Error loading analytics: ${err.message}</p>`;
  }
}

// --- Add Product ---
async function addProduct(event) {
  event.preventDefault();
  const status = document.getElementById('form-status');
  status.textContent = 'Saving...';
  status.style.color = 'var(--text-light)';

  const product = {
    type: 'product',
    name: document.getElementById('f-name').value,
    category: document.getElementById('f-category').value,
    subcategory: '',
    price: parseFloat(document.getElementById('f-price').value),
    currency: 'INR',
    description: document.getElementById('f-desc').value,
    specs: {},
    colors: [],
    color_names: [],
    image: document.getElementById('f-image').value || 'https://images.unsplash.com/photo-1523275335684-37898b6baf30?w=600',
    images: [],
    stock: parseInt(document.getElementById('f-stock').value),
    rating: 0,
    reviews_count: 0,
    tags: ['new'],
    created_at: new Date().toISOString()
  };

  try {
    const res = await couchFetch('', { method: 'POST', body: JSON.stringify(product) });
    if (res.ok) {
      status.textContent = '✓ Product added successfully!';
      status.style.color = 'var(--success)';
      document.getElementById('add-product-form').reset();
      // Reload data
      await loadData();
      renderFeaturedProducts();
      renderCategories();
    } else {
      throw new Error(res.reason || 'Failed to save');
    }
  } catch (err) {
    status.textContent = '✗ Error: ' + err.message;
    status.style.color = 'var(--error)';
  }
}

// --- Mango Query System ---

async function ensureMangoIndexes() {
  const indexes = [
    { index: { fields: ['type', 'category', 'price'] }, name: 'idx-type-category-price', ddoc: 'mango-indexes' },
    { index: { fields: ['type', 'rating'] }, name: 'idx-type-rating', ddoc: 'mango-indexes' },
    { index: { fields: ['type', 'name'] }, name: 'idx-type-name', ddoc: 'mango-indexes' },
    { index: { fields: ['type', 'subcategory'] }, name: 'idx-type-subcategory', ddoc: 'mango-indexes' }
  ];
  // Sequential — so each index creation appears one-by-one in the Dev log
  for (const idx of indexes) {
    try { await couchFetch('/_index', { method: 'POST', body: JSON.stringify(idx) }); } catch (e) {}
  }
}

function toggleAdvancedFilters() {
  const panel = document.getElementById('mango-filter-panel');
  const btn = document.querySelector('.filter-toggle-btn');
  if (!panel) return;
  const isHidden = panel.style.display === 'none';
  panel.style.display = isHidden ? 'block' : 'none';
  if (btn) btn.classList.toggle('active', isHidden);
}

function updateSubcategoryOptions() {
  const catVal = document.getElementById('filter-category').value;
  const subSel = document.getElementById('filter-subcategory');
  if (!subSel) return;
  const currentSub = subSel.value; // preserve current selection
  subSel.innerHTML = '<option value="">All Subcategories</option>';
  if (catVal) {
    const cat = allCategories.find(c => c.name === catVal);
    if (cat && cat.subcategories) {
      cat.subcategories.forEach(s => {
        subSel.innerHTML += `<option value="${s}">${s}</option>`;
      });
    }
  }
  // Restore selection if still valid
  if (currentSub && subSel.querySelector(`option[value="${currentSub}"]`)) {
    subSel.value = currentSub;
  }
}

function buildMangoSelector() {
  const selector = { type: 'product' };
  const category = document.getElementById('filter-category').value;
  const subcategory = document.getElementById('filter-subcategory')?.value;
  const search = document.getElementById('mango-search')?.value?.trim();
  const priceMin = document.getElementById('mango-price-min')?.value;
  const priceMax = document.getElementById('mango-price-max')?.value;
  const rating = document.getElementById('mango-rating')?.value;

  if (category) selector.category = category;
  if (subcategory) selector.subcategory = subcategory;
  if (search) selector.name = { '$regex': '(?i)' + search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
  if (priceMin || priceMax) {
    selector.price = {};
    if (priceMin) selector.price['$gte'] = parseFloat(priceMin);
    if (priceMax) selector.price['$lte'] = parseFloat(priceMax);
  }
  if (rating) selector.rating = { '$gte': parseFloat(rating) };
  return selector;
}

function buildMangoSort() {
  const sortVal = document.getElementById('filter-sort').value;
  if (sortVal === 'price-asc') return [{ 'price': 'asc' }];
  if (sortVal === 'price-desc') return [{ 'price': 'desc' }];
  if (sortVal === 'rating') return [{ 'rating': 'desc' }];
  return [{ 'name': 'asc' }];
}

async function applyMangoFilters() {
  updateSubcategoryOptions();
  // Restore subcategory selection if it was set before updateSubcategoryOptions rebuilt the list
  const selector = buildMangoSelector();
  const sort = buildMangoSort();

  // CouchDB requires sort fields to be present in the selector
  if (sort.length) {
    const sortField = Object.keys(sort[0])[0];
    if (!selector[sortField]) selector[sortField] = { '$gt': null };
  }

  const query = { selector, sort, limit: 100 };

  // Update query inspector
  const queryJsonEl = document.getElementById('mango-query-json');
  if (queryJsonEl) queryJsonEl.textContent = JSON.stringify(query, null, 2);

  try {
    // Sequential — so each query appears one-by-one in the Dev log
    const results = await couchFetch('/_find', { method: 'POST', body: JSON.stringify(query) });
    const explain = await couchFetch('/_explain', { method: 'POST', body: JSON.stringify(query) }).catch(() => null);

    const products = results.docs || [];

    // Show results info
    const resultsInfo = document.getElementById('mango-results-info');
    const resultsCount = document.getElementById('mango-results-count');
    if (resultsInfo) resultsInfo.style.display = 'flex';
    if (resultsCount) {
      const hasFilters = Object.keys(selector).length > 2; // more than {type, sortField}
      resultsCount.innerHTML = hasFilters
        ? `<strong>${products.length}</strong> product${products.length !== 1 ? 's' : ''} found via <em>Mango Query</em>`
        : `Showing all <strong>${products.length}</strong> products`;
    }

    // Show explain info
    const explainEl = document.getElementById('mango-explain-json');
    if (explainEl && explain) {
      const indexInfo = explain.index || {};
      explainEl.textContent = JSON.stringify({
        index: indexInfo.name || 'unknown',
        type: indexInfo.type || 'unknown',
        ddoc: indexInfo.ddoc || null,
        fields: (indexInfo.def?.fields || []).map(f => typeof f === 'object' ? Object.keys(f)[0] : f)
      }, null, 2);
    }

    renderProductsGrid(products);
  } catch (err) {
    console.error('Mango query failed, falling back to client-side:', err);
    applyFiltersClientSide();
  }
}

function applyFiltersClientSide() {
  let filtered = [...allProducts];
  const category = document.getElementById('filter-category').value;
  const subcategory = document.getElementById('filter-subcategory')?.value;
  const sort = document.getElementById('filter-sort').value;
  const search = document.getElementById('mango-search')?.value?.trim()?.toLowerCase();
  const priceMin = parseFloat(document.getElementById('mango-price-min')?.value) || 0;
  const priceMax = parseFloat(document.getElementById('mango-price-max')?.value) || Infinity;
  const rating = parseFloat(document.getElementById('mango-rating')?.value) || 0;

  if (category) filtered = filtered.filter(p => p.category === category);
  if (subcategory) filtered = filtered.filter(p => p.subcategory === subcategory);
  if (search) filtered = filtered.filter(p => p.name.toLowerCase().includes(search));
  filtered = filtered.filter(p => p.price >= priceMin && p.price <= priceMax);
  if (rating) filtered = filtered.filter(p => p.rating >= rating);

  if (sort === 'price-asc') filtered.sort((a, b) => a.price - b.price);
  else if (sort === 'price-desc') filtered.sort((a, b) => b.price - a.price);
  else if (sort === 'rating') filtered.sort((a, b) => b.rating - a.rating);
  else filtered.sort((a, b) => a.name.localeCompare(b.name));

  renderProductsGrid(filtered);
}

let mangoSearchTimeout;
function debounceMangoSearch() {
  clearTimeout(mangoSearchTimeout);
  mangoSearchTimeout = setTimeout(() => applyMangoFilters(), 400);
}

function clearMangoFilters() {
  document.getElementById('filter-category').value = '';
  document.getElementById('filter-subcategory').innerHTML = '<option value="">All Subcategories</option>';
  document.getElementById('filter-sort').value = 'name';
  const search = document.getElementById('mango-search');
  if (search) search.value = '';
  const pmin = document.getElementById('mango-price-min');
  if (pmin) pmin.value = '';
  const pmax = document.getElementById('mango-price-max');
  if (pmax) pmax.value = '';
  const rating = document.getElementById('mango-rating');
  if (rating) rating.value = '';
  document.getElementById('products-page-label').textContent = 'ALL PRODUCTS';
  document.getElementById('products-page-heading').textContent = 'Our Collection';
  applyMangoFilters();
}

function toggleQueryInspector() {
  const el = document.getElementById('mango-query-inspector');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// --- Dev Panel (Live via CouchDB shared log) ---

// Raw fetch that bypasses couchFetch logging (prevents infinite loop)
async function rawCouchFetch(path, options = {}) {
  const res = await fetch(`${DB_URL}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'Authorization': AUTH, ...(options.headers || {}) }
  });
  if (!res.ok) throw new Error(`CouchDB ${res.status}`);
  return res.json();
}

// Write query log entry to CouchDB (fire-and-forget, no loop)
function writeLogToDb(entry) {
  fetch(`${DB_URL}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': AUTH },
    body: JSON.stringify({ type: 'query_log', ...entry, ts: Date.now() })
  }).catch(() => {});
}

const QUERY_EXPLANATIONS = {
  '/_design/catalog/_view/all_products': {
    short: 'Fetch all products',
    detail: 'Queries the <strong>all_products</strong> MapReduce view. With <code>include_docs=true</code>, CouchDB returns the full document for each row, avoiding a second lookup.'
  },
  '/_design/catalog/_view/all_categories': {
    short: 'Fetch all categories',
    detail: 'Queries the <strong>all_categories</strong> MapReduce view to load category names, images, and subcategory lists for navigation dropdowns.'
  },
  '/_design/catalog/_view/reviews_by_product': {
    short: 'Fetch all reviews',
    detail: 'Queries the <strong>reviews_by_product</strong> view. Reviews are keyed by <code>product_id</code>, enabling efficient lookup of reviews for any specific product.'
  },
  '/_design/catalog/_view/category_stats': {
    short: 'Aggregate category statistics',
    detail: 'Uses a <strong>custom reduce function</strong> with <code>group=true</code> to compute per-category aggregates: product count, average price, average rating, and total stock — all in a single query.'
  },
  '/_design/catalog/_view/revenue_by_status': {
    short: 'Aggregate revenue by order status',
    detail: 'Uses CouchDB\'s built-in <strong>_stats</strong> reduce function with <code>group=true</code>. Returns count, sum, min, max, and sum-of-squares for each order status — no custom reduce code needed.'
  },
  '/_design/catalog/_view/low_stock_products': {
    short: 'Find low-stock products',
    detail: 'The map function emits only products where <code>stock &lt; 30</code>. This server-side filtering means CouchDB only returns matching documents, not the full catalog.'
  },
  '/_design/catalog/_view/bestsellers': {
    short: 'Get top-rated bestsellers',
    detail: 'Queries with <code>descending=true</code> to sort by review count (the emit key). CouchDB B-tree indexes make this a O(log n) operation regardless of dataset size.'
  },
  '/_design/catalog/_view/products_on_sale': {
    short: 'Get discounted products',
    detail: 'The map function calculates discount percentage at index time and emits it as the key. With <code>descending=true</code>, biggest discounts appear first.'
  },
  '/_find': {
    short: 'Mango query — find products',
    detail: 'Uses CouchDB\'s <strong>Mango query engine</strong> (<code>POST /_find</code>). The selector is a JSON object with MongoDB-style operators ($gte, $lte, $regex). CouchDB automatically picks the best index.'
  },
  '/_explain': {
    short: 'Explain Mango query plan',
    detail: 'Returns which <strong>index</strong> CouchDB would use for a given Mango selector, without executing the query. Useful for debugging slow queries and verifying index coverage.'
  },
  '/_index': {
    short: 'Create Mango index',
    detail: 'Creates a secondary index for Mango queries. CouchDB builds a B-tree on the specified fields. Indexes are stored in a design document and updated lazily on first query.'
  },
  '/': {
    short: 'Create new document',
    detail: 'A <strong>POST</strong> to the database root creates a new document. CouchDB auto-generates the <code>_id</code> and returns the first <code>_rev</code> (revision) for the new document.'
  },
  '/:doc_id:GET': {
    short: 'Fetch single document by ID',
    detail: 'A <strong>GET</strong> to <code>/db/doc_id</code> retrieves one document by its unique <code>_id</code>. Returns the full document including its current <code>_rev</code> (revision token), which is required for updates or deletions.'
  },
  '/:doc_id:DELETE': {
    short: 'Delete document by ID',
    detail: 'A <strong>DELETE</strong> to <code>/db/doc_id?rev=_rev</code> marks the document as deleted. CouchDB doesn\'t physically remove it — it adds a <strong>tombstone</strong> (<code>_deleted: true</code>) so the deletion replicates to other nodes. The <code>?rev=</code> parameter enforces <strong>optimistic concurrency</strong> — you must know the latest revision to delete.'
  }
};

const METHOD_EXPLANATIONS = {
  GET: 'Retrieves data without modifying anything. Safe and idempotent — calling it twice gives the same result.',
  POST: 'Sends data to create a new resource or execute a query. Used for document creation and Mango queries.',
  PUT: 'Creates or replaces a resource at a specific URL. Requires the current <code>_rev</code> for updates (optimistic concurrency).',
  DELETE: 'Marks a document as deleted by adding <code>_deleted: true</code>. The revision history is preserved.'
};

// Setup queries — pre-defined list of queries used during database setup
const SETUP_QUERIES = [
  { method: 'PUT', path: '/ecommerce_catalog', body: null, explain: 'Create the database', detail: 'Creates the <strong>ecommerce_catalog</strong> database. CouchDB databases are created explicitly via PUT. Returns 201 on success, 412 if it already exists.' },
  { method: 'PUT', path: '/_design/catalog', body: '{ views: { all_products, all_categories, reviews_by_product, category_stats, revenue_by_status, low_stock_products, bestsellers, products_on_sale } }', explain: 'Upload design document with 8 MapReduce views', detail: 'Design documents (prefixed <code>_design/</code>) contain view definitions. Each view has a <strong>map</strong> function and an optional <strong>reduce</strong> function. Views are indexed lazily on first query.' },
  { method: 'POST', path: '/_bulk_docs', body: '{ docs: [ ...24 products, 4 categories, 8 reviews, 5 orders ] }', explain: 'Bulk insert all seed data', detail: '<strong>_bulk_docs</strong> inserts multiple documents in a single HTTP request. More efficient than individual POSTs — CouchDB batches the writes into a single fsync operation.' },
  { method: 'POST', path: '/_index', body: '{ fields: ["type","category","price"], name: "idx-type-category-price" }', explain: 'Create Mango index for category + price filtering', detail: 'Creates a composite B-tree index on three fields. CouchDB\'s query planner can use this for any query that filters by type + category, type + category + price, or just type.' },
  { method: 'POST', path: '/_index', body: '{ fields: ["type","rating"], name: "idx-type-rating" }', explain: 'Create Mango index for rating filtering', detail: 'A two-field index optimized for queries like "products rated 4.5 and above". The <code>type</code> field ensures only product documents are scanned.' },
  { method: 'POST', path: '/_index', body: '{ fields: ["type","name"], name: "idx-type-name" }', explain: 'Create Mango index for name sorting and search', detail: 'Enables efficient sort-by-name queries. CouchDB can walk this index in order instead of sorting results in memory.' },
  { method: 'POST', path: '/_index', body: '{ fields: ["type","subcategory"], name: "idx-type-subcategory" }', explain: 'Create Mango index for subcategory filtering', detail: 'Allows filtering products by subcategory (e.g., "Headphones", "Women", "Fiction") without scanning the full dataset.' },
  { method: 'POST', path: '/_bulk_docs', body: '{ docs: [ ...updated products with new categories ] }', explain: 'Bulk update product categories and subcategories', detail: 'Uses <strong>_bulk_docs</strong> for batch updates. Each document includes its current <code>_rev</code> — CouchDB rejects updates with stale revisions (optimistic locking).' }
];

function logQuery(method, path, body, status, duration) {
  const now = new Date();
  const istTime = now.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const istDate = now.toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short' });

  // Detect single-document operations (GET /doc_id, DELETE /doc_id?rev=...)
  const cleanPath = path.split('?')[0];
  const isSingleDoc = cleanPath.length > 1 && !cleanPath.startsWith('/_') && !cleanPath.startsWith('/_design');
  let pathKey, info;
  if (isSingleDoc && method === 'GET') {
    pathKey = '/:doc_id:GET';
    info = QUERY_EXPLANATIONS[pathKey] || { short: 'Fetch document by ID', detail: '' };
  } else if (isSingleDoc && method === 'DELETE') {
    pathKey = '/:doc_id:DELETE';
    info = QUERY_EXPLANATIONS[pathKey] || { short: 'Delete document', detail: '' };
  } else {
    pathKey = Object.keys(QUERY_EXPLANATIONS).find(k => path.startsWith(k)) || path;
    info = QUERY_EXPLANATIONS[pathKey] || { short: path, detail: '' };
  }

  const entry = {
    method, path,
    bodySummary: body ? (typeof body === 'string' ? body : summarizeBody(body)) : null,
    status, duration,
    time: `${istDate} ${istTime}`,
    timestamp: now.toISOString(),
    explain: info.short,
    detail: info.detail,
    methodExplain: METHOD_EXPLANATIONS[method] || ''
  };

  queryLog.push(entry);

  // Write to CouchDB so other browser instances (phone via tunnel) can see it
  writeLogToDb(entry);
}

function showDevPanel() {
  document.getElementById('hero-section').style.display = 'none';
  document.getElementById('featured-section').style.display = 'none';
  document.querySelectorAll('.text-image-split, .categories-section, .reviews-section, .admin-section, .newsletter-section').forEach(el => el.style.display = 'none');
  document.getElementById('all-products-page').style.display = 'none';
  document.getElementById('analytics-page').style.display = 'none';
  document.getElementById('dev-page').style.display = '';
  devAutoScroll = true;
  devNewCount = 0;
  updateDevBadge();
  showTunnelConfigIfNeeded();
  renderDevLog();
  startDevPolling();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

let devPollTimer = null;
let devPollActive = false;
let devLastPollTime = 0;

function stopDevPolling() {
  devPollActive = false;
  if (devPollTimer) { clearTimeout(devPollTimer); devPollTimer = null; }
  if (devPollInterval) { clearInterval(devPollInterval); devPollInterval = null; }
}

function startDevPolling() {
  stopDevPolling();
  devPollActive = true;
  doPoll(); // immediate first poll
}

// Recursive setTimeout — immune to mobile throttling unlike setInterval
async function doPoll() {
  if (!devPollActive) return;
  await pollDevLog();
  if (!devPollActive) return;
  // Schedule next poll — use setTimeout recursion (mobile-safe)
  devPollTimer = setTimeout(doPoll, 2000);
}

async function pollDevLog() {
  const statusEl = document.getElementById('dev-connection-status');
  const lastUpdEl = document.getElementById('dev-last-updated');
  try {
    const res = await fetch(`${DB_URL}/_find`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': AUTH },
      body: JSON.stringify({
        selector: { type: 'query_log', ts: { '$gt': 0 } },
        sort: [{ ts: 'desc' }],
        limit: 50
      })
    });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();

    devConnected = true;
    devLastPollTime = Date.now();
    if (statusEl) { statusEl.className = 'dev-conn connected'; statusEl.textContent = '● Live'; }
    if (lastUpdEl) {
      const t = new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true, hour: '2-digit', minute: '2-digit', second: '2-digit' });
      lastUpdEl.textContent = 'Polled: ' + t;
    }

    const docs = (data.docs || []).reverse();

    // Always replace and always re-render — no conditions
    queryLog.length = 0;
    docs.forEach(d => queryLog.push(d));

    // ALWAYS render — the whole point is live updates
    renderDevLog();

  } catch (e) {
    devConnected = false;
    if (statusEl) {
      statusEl.className = 'dev-conn disconnected';
      statusEl.textContent = '○ Disconnected';
    }
    if (lastUpdEl) lastUpdEl.textContent = 'Poll failed — retrying...';
    // Still render whatever we have
    renderDevLog();
  }
}

function updateDevBadge() {
  const badge = document.getElementById('dev-new-badge');
  if (!badge) return;
  if (devNewCount > 0 && !devAutoScroll) {
    badge.textContent = `${devNewCount} new`;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

function devLogTapped() {
  // no-op — always keep auto-updating
}

function devResumeScroll() {
  renderDevLog();
  const container = document.getElementById('dev-log-entries');
  if (container) container.scrollTop = 0;
}

function switchDevTab(tab) {
  activeDevTab = tab;
  document.querySelectorAll('.dev-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.dev-tab').forEach(t => {
    if ((tab === 'live' && t.textContent === 'Live Queries') || (tab === 'setup' && t.textContent === 'Setup Queries'))
      t.classList.add('active');
  });
  if (tab === 'live') { startDevPolling(); }
  else { stopDevPolling(); }
  renderDevLog();
}

async function clearQueryLog() {
  if (activeDevTab === 'live') {
    // Delete all query_log docs from CouchDB
    try {
      const data = await rawCouchFetch('/_find', {
        method: 'POST',
        body: JSON.stringify({ selector: { type: 'query_log' }, fields: ['_id', '_rev'], limit: 500 })
      });
      if (data.docs.length) {
        const deleteDocs = data.docs.map(d => ({ _id: d._id, _rev: d._rev, _deleted: true }));
        await rawCouchFetch('/_bulk_docs', { method: 'POST', body: JSON.stringify({ docs: deleteDocs }) });
      }
    } catch (e) {}
    queryLog.length = 0;
    devLastTs = 0;
    devNewCount = 0;
    devLastFingerprint = '0-0';
    devStaggerNext = true;  // next batch of entries should reveal one-by-one
    devRevealQueue = [];
    if (devRevealTimer) { clearTimeout(devRevealTimer); devRevealTimer = null; }
    updateDevBadge();
  }
  renderDevLog();
}

let devLastFingerprint = '';
let devRevealQueue = [];    // entries waiting to be revealed
let devRevealTimer = null;  // timer for staggered reveal
let devStaggerNext = false; // true after clear — next batch should stagger

function renderEntryHTML(e, isNew) {
  return `<div class="dev-entry${isNew ? ' dev-entry-new' : ''}">
      <div class="dev-entry-header">
        <span class="dev-entry-method ${e.method.toLowerCase()}">${e.method}</span>
        <span class="dev-entry-path">${e.path}</span>
        <span class="dev-entry-time">${e.time}${e.duration != null ? ` · ${e.duration}ms` : ''}</span>
      </div>
      <div class="dev-entry-explain">${e.explain}${e.detail ? ` — ${e.detail}` : ''}</div>
      <div class="dev-entry-explain"><strong>${e.method}</strong>: ${e.methodExplain}</div>
      ${e.bodySummary ? `<div class="dev-entry-detail">${e.bodySummary}</div>` : ''}
    </div>`;
}

function processRevealQueue() {
  const container = document.getElementById('dev-log-entries');
  if (!container || devRevealQueue.length === 0) {
    devRevealTimer = null;
    return;
  }
  const entry = devRevealQueue.shift();
  container.insertAdjacentHTML('afterbegin', renderEntryHTML(entry, true));
  // Schedule next reveal
  if (devRevealQueue.length > 0) {
    devRevealTimer = setTimeout(processRevealQueue, 600);
  } else {
    devRevealTimer = null;
  }
}

function renderDevLog() {
  const container = document.getElementById('dev-log-entries');
  if (!container) return;

  const entries = activeDevTab === 'live' ? queryLog : SETUP_QUERIES.map(q => ({
    method: q.method, path: q.path, bodySummary: q.body,
    status: 200, duration: null, time: 'Setup', ts: 0,
    explain: q.explain, detail: q.detail,
    methodExplain: METHOD_EXPLANATIONS[q.method] || ''
  }));

  if (entries.length === 0) {
    if (devLastFingerprint === '0-0') return; // already showing empty
    devLastFingerprint = '0-0';
    // Clear any pending reveal queue
    devRevealQueue = [];
    if (devRevealTimer) { clearTimeout(devRevealTimer); devRevealTimer = null; }
    container.innerHTML = `<div class="dev-log-empty">${activeDevTab === 'live'
      ? '<div class="dev-live-indicator"></div>Listening for CouchDB queries...<br><small>Navigate the site in any browser to see queries appear here in real-time.</small>'
      : 'No setup queries defined.'}</div>`;
    return;
  }

  const displayEntries = activeDevTab === 'live' ? [...entries].reverse() : entries;

  // Fingerprint: count + newest timestamp — skip re-render if nothing changed
  const fp = displayEntries.length + '-' + (displayEntries[0]?.ts || 0);
  if (fp === devLastFingerprint) return;

  const prevCount = devLastFingerprint ? parseInt(devLastFingerprint.split('-')[0]) || 0 : 0;
  const newCount = displayEntries.length - prevCount;
  devLastFingerprint = fp;

  const shouldStagger = activeDevTab === 'live' && newCount > 0 && (prevCount > 0 || devStaggerNext);

  if (!shouldStagger) {
    // Setup tab, first page load, or no new entries — show everything at once
    container.innerHTML = displayEntries.map(e => renderEntryHTML(e, false)).join('');
    return;
  }

  // Live tab with new entries — render old entries, then stagger-reveal new ones
  devStaggerNext = false;
  const newEntries = displayEntries.slice(0, newCount);   // newest are first (reversed)
  const oldEntries = displayEntries.slice(newCount);

  // Render old entries immediately (no animation)
  container.innerHTML = oldEntries.map(e => renderEntryHTML(e, false)).join('');

  // Queue new entries for staggered reveal (oldest new first → newest new last)
  const toReveal = [...newEntries].reverse();
  devRevealQueue.push(...toReveal);

  // Start revealing if not already running
  if (!devRevealTimer) {
    devRevealTimer = setTimeout(processRevealQueue, 300);
  }
}

function summarizeBody(body) {
  if (!body) return '';
  // Summarize Mango selectors nicely
  if (body.selector) {
    const parts = [];
    for (const [k, v] of Object.entries(body.selector)) {
      if (k === 'type') continue;
      if (typeof v === 'string') parts.push(`${k} = "${v}"`);
      else if (v.$regex) parts.push(`${k} matches /${v.$regex}/`);
      else if (v.$gte !== undefined && v.$lte !== undefined) parts.push(`${k}: ${v.$gte} to ${v.$lte}`);
      else if (v.$gte !== undefined) parts.push(`${k} >= ${v.$gte}`);
      else if (v.$lte !== undefined) parts.push(`${k} <= ${v.$lte}`);
      else if (v.$gt !== undefined) parts.push(`${k}: any (sort field)`);
      else parts.push(`${k}: ${JSON.stringify(v)}`);
    }
    let summary = parts.length ? `Filter: ${parts.join(', ')}` : 'Filter: all products';
    if (body.sort) {
      const sortField = Object.keys(body.sort[0])[0];
      const sortDir = body.sort[0][sortField];
      summary += `\nSort: ${sortField} (${sortDir})`;
    }
    if (body.limit) summary += `\nLimit: ${body.limit}`;
    return summary;
  }
  // Summarize index creation
  if (body.index?.fields) {
    return `Fields: [${body.index.fields.join(', ')}]\nName: ${body.name || 'auto'}`;
  }
  // Summarize product creation
  if (body.type === 'product') {
    return `New product: "${body.name}" (${body.category}, ₹${body.price})`;
  }
  // Fallback — compact JSON
  const str = JSON.stringify(body, null, 2);
  return str.length > 300 ? str.substring(0, 300) + '...' : str;
}

// Resume polling when phone tab becomes visible again (mobile browsers freeze JS in background)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && devPollActive) {
    // Tab just became visible — do an immediate poll
    pollDevLog();
  }
});

// Also use focus event as backup for mobile browsers
window.addEventListener('focus', () => {
  if (devPollActive) pollDevLog();
});

// Hide dev page and stop polling when navigating away
const _origShowHome = showHome;
showHome = function() { stopDevPolling(); document.getElementById('dev-page').style.display = 'none'; _origShowHome(); };
const _origShowAllProducts = showAllProducts;
showAllProducts = function() { stopDevPolling(); document.getElementById('dev-page').style.display = 'none'; _origShowAllProducts(); };
const _origShowAnalytics = showAnalytics;
showAnalytics = async function() { stopDevPolling(); document.getElementById('dev-page').style.display = 'none'; await _origShowAnalytics(); };

// Show tunnel config on Dev page if not localhost
function showTunnelConfigIfNeeded() {
  const el = document.getElementById('dev-tunnel-config');
  if (!el) return;
  if (!IS_LOCAL) {
    el.style.display = 'block';
    const input = document.getElementById('dev-tunnel-url');
    if (input) input.value = localStorage.getItem('couchdb_tunnel') || '';
    const status = document.getElementById('dev-tunnel-status');
    if (status && COUCH_BASE !== 'http://127.0.0.1:5984') {
      status.textContent = 'Connected to: ' + COUCH_BASE;
      status.style.color = 'var(--success)';
    }
  }
}

function saveTunnelUrl() {
  const url = document.getElementById('dev-tunnel-url')?.value?.trim();
  if (url) {
    localStorage.setItem('couchdb_tunnel', url);
    window.location.reload();
  }
}

// Create Mango index for query_log polling
rawCouchFetch('/_index', {
  method: 'POST',
  body: JSON.stringify({ index: { fields: ['type', 'ts'] }, name: 'idx-query-log', ddoc: 'mango-indexes' })
}).catch(() => {});
