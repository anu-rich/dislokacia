/*
 * Stalia — site & product settings. This is the ONLY file you edit to change
 * prices, contacts, payment links and licence keys. (RU: единственный файл настроек.)
 */
(function (root) {
  var config = {
    brand: 'Stalia',

    // Public address of the site, no trailing slash. Used in share links and printed footers.
    siteUrl: '',

    // Where customers write to you. Leave telegram empty if you do not use it.
    contactEmail: 'hello@example.com',
    telegram: '',

    // Prices shown on the pricing blocks. They are text only — the real charge is set in the checkout.
    pricing: {
      usd: { monthly: 19, yearly: 149 },
      kzt: { monthly: 9900, yearly: 79000 },
    },

    // Checkout links (Lemon Squeezy "Share" links of the two variants).
    // While they are empty, the Buy buttons open an e-mail to contactEmail instead.
    checkout: { monthlyUrl: '', yearlyUrl: '' },

    // Automatic licence keys issued by Lemon Squeezy at purchase.
    // Turn on only after filling storeId (Settings -> Stores) and the product id(s).
    lemonSqueezy: { enabled: false, storeId: '', productIds: [] },

    // Public keys that verify licence keys issued by tools/keygen (invoice / bank transfer sales).
    // Managed by "node tools/keygen.js init" — do not edit by hand.
    licensePublicKeys: /*KEYS-START*/[
      {"kty":"EC","crv":"P-256","x":"MjW50tm09YP5o6PzV_B_qmR8kqlEilw3khrtjykmNBo","y":"vRAYNDCr99lOHrIfefH1xZc8QBF5EimhHt88PjqQGFY"}
    ]/*KEYS-END*/,

    // Links to the store apps, once they are published (shown in "Install app" and on the site).
    apps: { android: '', ios: '' },

    // "From documents": the address of your reading server, e.g. 'https://stalia-reader.example.workers.dev'
    // (how to start one: server/README.md). While it is empty, pages can be added and blacked out, but not read.
    // maxPages must not be larger than MAX_PAGES of the server.
    // Without a server, reading still works for anyone who enters a Claude API key of their own in "From documents"
    // (the key stays in their browser). To hide that option, add  ownKey: false.
    ai: { endpoint: '', maxPages: 20 },

    // Limits of the free version.
    free: { maxSaved: 3, maxPorts: 2 },
  };

  if (typeof module === 'object' && module.exports) module.exports = config;
  else root.STALIA_CONFIG = config;
})(typeof globalThis !== 'undefined' ? globalThis : this);
