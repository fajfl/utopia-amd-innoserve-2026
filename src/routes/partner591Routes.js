const express = require('express');

const { create591V2Intake } = require('../services/v2Partner591IntakeService');

const router = express.Router();
const jsonParser = express.json({ limit: '1mb' });

function allowDemoCors(req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

router.options('/api/partner/591/intake', allowDemoCors);

router.post('/api/partner/591/intake', allowDemoCors, jsonParser, async (req, res) => {
  try {
    const listing = req.body?.listing || {};
    const extAmenities = listing.amenities;
    const rawListing = listing.rawListing || {};
    const facilityFromCtx = (rawListing.service && rawListing.service.facility) || rawListing.facility || rawListing.facilities;
    console.log(`[591 intake diag] ext amenities type=${typeof extAmenities} isArray=${Array.isArray(extAmenities)} length=${Array.isArray(extAmenities) ? extAmenities.length : 'N/A'} value=${JSON.stringify(extAmenities)}`);
    console.log(`[591 intake diag] rawListing keys=${Object.keys(rawListing).join(',')}`);
    console.log(`[591 intake diag] rawListing.service exists=${!!rawListing.service} facility exists=${!!facilityFromCtx} facility count=${Array.isArray(facilityFromCtx) ? facilityFromCtx.length : 'N/A'}`);
    if (Array.isArray(facilityFromCtx) && facilityFromCtx.length > 0) {
      console.log(`[591 intake diag] facility[0]=${JSON.stringify(facilityFromCtx[0])}`);
      console.log(`[591 intake diag] facility active flags: ${facilityFromCtx.map(f => `${f.name||f.label}:${f.active}`).join(', ')}`);
    }
    res.json(await create591V2Intake(req.body || {}));
  } catch (error) {
    res.status(error.statusCode || 500).json({
      ok: false,
      error: error.message || '591 partner intake failed'
    });
  }
});

module.exports = router;
