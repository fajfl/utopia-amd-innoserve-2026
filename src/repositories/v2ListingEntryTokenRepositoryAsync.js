const crypto = require('node:crypto');

async function findActiveToken(db, listingId) {
  return db.get(`SELECT token FROM listing_entry_tokens
    WHERE listing_id=? AND source_platform='591' AND status='active'
      AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
    ORDER BY id LIMIT 1`, [listingId]);
}

async function findOrCreateEntryToken(db, listingId) {
  const existing = await findActiveToken(db, listingId);
  if (existing) return existing.token;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const token = String(crypto.randomInt(0, 100000000)).padStart(8, '0');
    try {
      await db.run(`INSERT INTO listing_entry_tokens
        (public_id,listing_id,token,source_platform,status)
        VALUES (?, ?, ?, '591', 'active')`, [`entry-token-${crypto.randomUUID()}`, listingId, token]);
      return token;
    } catch (error) {
      if (!/UNIQUE|DUPLICATE/i.test(error.message)) throw error;
    }
  }
  throw new Error('Unable to allocate a unique LINE entry code.');
}

function findListingByEntryToken(db, token) {
  return db.get(`SELECT let.id entry_token_id, let.token, l.*
    FROM listing_entry_tokens let JOIN listings l ON l.id=let.listing_id
    WHERE let.token=? AND let.status='active'
      AND (let.expires_at IS NULL OR let.expires_at > CURRENT_TIMESTAMP)`, [token]);
}

module.exports = { findListingByEntryToken, findOrCreateEntryToken };
