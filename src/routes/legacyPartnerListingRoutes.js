const express = require('express');
const db = require('../db');
const router = express.Router();

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

router.get('/cases/:caseId/listings', (req, res) => {
  const rows = db.prepare(`SELECT id,case_id,source,url,price,title,address,rooms,type,floor,
    amenities,description,raw_listing_json,detail_items_json,image_urls_json,
    contact_info_json,nearby_json,partner_metadata_json,created_at
    FROM rental_listings WHERE case_id=@caseId ORDER BY id DESC`).all({ caseId:req.params.caseId });
  res.json(rows.map(row => ({ id:row.id,case_id:row.case_id,source:row.source,url:row.url,
    price:row.price,title:row.title,address:row.address,rooms:row.rooms,type:row.type,floor:row.floor,
    amenities:parseJson(row.amenities,[]),description:row.description,
    detailItems:parseJson(row.detail_items_json,{}),imageUrls:parseJson(row.image_urls_json,[]),
    contactInfo:parseJson(row.contact_info_json,{}),nearby:parseJson(row.nearby_json,[]),
    partnerMetadata:parseJson(row.partner_metadata_json,{}),rawListing:parseJson(row.raw_listing_json,null),
    created_at:row.created_at })));
});

module.exports = router;
